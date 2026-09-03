import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ObligationIR, normalizePrompt, validateObligationIR } from '../src/obligation-ir.js';
import { extractObligationIR, mergeObligations, sentenceSpans } from '../src/obligations.js';

const prompt = 'Complete zackproser/ctx#301 across the CTX server and ctx-cli. Two lanes may run independently, but CTX must join them after both deliveries exist.';

describe('obligation IR schema and validation', () => {
  it('normalizes the prompt so spans index into one canonical text', () => {
    const normalized = normalizePrompt('  A\r\nBÅ  ');
    expect(normalized).toBe('A\nBÅ');
    expect(sentenceSpans('First one. Second; third!\nFourth').map((s) => s.text)).toEqual(['First one.', 'Second;', 'third!', 'Fourth']);
  });

  it('extracts a span-attributed deterministic IR whose spans point at the normalized prompt', () => {
    const ir = extractObligationIR(prompt);
    expect(ObligationIR.parse(ir)).toBeTruthy();
    expect(validateObligationIR(ir, normalizePrompt(prompt))).toEqual([]);
    expect(ir.repositories.map((r) => r.id)).toEqual(['zackproser/ctx', 'zackproser/ctx-cli']);
    for (const entry of [...ir.repositories, ...ir.deliverables, ...ir.checks]) expect(entry.provenance.length).toBeGreaterThan(0);
    expect(ir.source).toBe('deterministic');
  });

  it('rejects malformed model output structurally, not by luck', () => {
    const malformed = JSON.parse(readFileSync(resolve('test/corpus/compiler/malformed_model.json'), 'utf8'));
    expect(ObligationIR.safeParse(malformed).success).toBe(false);
    const cyclic = {
      ...extractObligationIR('In zackproser/ctx implement the feature and then deploy it.'),
      deliverables: [
        { key: 'a', kind: 'artifact', repository: 'zackproser/ctx', summary: 'a', provenance: [{ start: 0, end: 1, text: 'I' }] },
        { key: 'b', kind: 'artifact', repository: 'zackproser/ctx', summary: 'b', provenance: [{ start: 0, end: 1, text: 'I' }] },
      ],
      ordering: [{ before: 'a', after: ['b'] }, { before: 'b', after: ['a'] }],
    } as const;
    expect(validateObligationIR(cyclic as never).some((error) => error.startsWith('ordering cycle'))).toBe(true);
    expect(validateObligationIR({ ...cyclic, ordering: [{ before: 'a', after: ['zzz'] }] } as never)).toContain('ordering names unknown key zzz');
  });

  it('merges a model proposal as wording only: the floor owns lanes, checks, ordering and questions', () => {
    const det = extractObligationIR(prompt);
    const lane = det.deliverables[0]!;
    const model = {
      ...det, source: 'model' as const,
      repositories: [
        { id: 'zackproser/ctx', role: 'deployable' as const, provenance: det.repositories[0]!.provenance },
        { id: 'evil/other', role: 'unknown' as const, provenance: det.repositories[0]!.provenance },
      ],
      deliverables: [
        { ...lane, summary: `${lane.summary} Refined by the model with more detail.` },
        { key: 'unit_test_commit', kind: 'commit' as const, repository: 'zackproser/ctx', summary: 'tests', provenance: lane.provenance },
        { key: 'request_review_message', kind: 'message' as const, repository: null, summary: 'ask for review', provenance: lane.provenance },
        { key: 'docs', kind: 'document' as const, repository: 'evil/other', summary: 'x', provenance: det.repositories[0]!.provenance },
      ],
      checks: [{ kind: 'browser_smoke' as const, target: 'zackproser/ctx', provenance: det.repositories[0]!.provenance }],
      ordering: [{ before: 'unit_test_commit', after: [lane.key] }],
      questions: [{ text: 'Which branch?', provenance: det.repositories[0]!.provenance }],
      parallel_requested: true,
    };
    const merged = mergeObligations(det, model);
    expect(merged.source).toBe('merged');
    expect(merged.repositories.map((r) => r.id)).toEqual(det.repositories.map((r) => r.id));
    // No receipt in the floor: a model "deployable" role is noise.
    expect(merged.repositories[0]!.role).toBe(det.repositories[0]!.role);
    expect(merged.deliverables.map((d) => d.key)).toEqual(det.deliverables.map((d) => d.key));
    expect(merged.deliverables[0]!.summary).toContain('Refined by the model');
    expect(merged.checks).toEqual(det.checks);
    expect(merged.ordering).toEqual(det.ordering);
    expect(merged.questions).toEqual([]);
    expect(merged.parallel_requested).toBe(det.parallel_requested);
    expect(mergeObligations(det, null)).toEqual(det);
  });

  it('keeps a model repository role only when a receipt needs a lane to attach to', () => {
    const det = extractObligationIR('Fix the parser in zackproser/ctx; complete once the release is deployed and verified in the browser.');
    expect(det.checks.map((c) => c.kind)).toContain('deployment_release');
    const model = { ...det, source: 'model' as const, repositories: [{ ...det.repositories[0]!, role: 'deployable' as const }] };
    expect(mergeObligations({ ...det, repositories: [{ ...det.repositories[0]!, role: 'unknown' as const }] }, model).repositories[0]!.role).toBe('deployable');
  });

  it('splits sentences at terminators followed by whitespace only, never inside file paths', () => {
    const spans = sentenceSpans('Re-check config/packages.lock.json weekly. Write docs/integrity-runbook.md; do not merge.');
    expect(spans.map((s) => s.text)).toEqual(['Re-check config/packages.lock.json weekly.', 'Write docs/integrity-runbook.md;', 'do not merge.']);
  });

  it('never binds a file path as a repository', () => {
    const ir = extractObligationIR('In zackproser/pi-harness, re-check config/packages.lock.json and write docs/integrity-runbook.md. Deliver a PR.');
    expect(ir.repositories.map((r) => r.id)).toEqual(['zackproser/pi-harness']);
    expect(extractObligationIR('Update src/lib/webflow.ts and config/site.json; ship a PR.').repositories).toEqual([]);
  });
});

describe('round 2 floor rules (battery 2026-09-03)', () => {
  const known = ['zackproser/ctx', 'zackproser/ctx-cli', 'zackproser/pi-harness'];
  it('strips list markers and treats every line as a sentence boundary', () => {
    expect(sentenceSpans('1. book dentist\n2. renew passport\n- call the accountant').map((s) => s.text))
      .toEqual(['book dentist', 'renew passport', 'call the accountant']);
    const spans = sentenceSpans('In zackproser/ctx:\n- add a flag\nOpen one PR.');
    for (const span of spans) expect('In zackproser/ctx:\n- add a flag\nOpen one PR.'.slice(span.start, span.end)).toBe(span.text);
  });
  it('snaps a typo of a retained repository to it and never invents the misspelling', () => {
    const ir = extractObligationIR('Add retry to the gateway call in zackproser/ctx-clii and open a PR.', known);
    expect(ir.repositories.map((r) => r.id)).toEqual(['zackproser/ctx-cli']);
    expect(extractObligationIR('Fix zackproser/ctx2 and open a PR.', known).repositories.map((r) => r.id)).toEqual(['zackproser/ctx2']);
  });
  it('binds a short bare name only in repository position and never through a domain name', () => {
    expect(extractObligationIR('Bump the version: a PR in each of ctx, ctx-cli and pi-harness.', known).repositories.map((r) => r.id))
      .toEqual(['zackproser/ctx', 'zackproser/ctx-cli', 'zackproser/pi-harness']);
    expect(extractObligationIR('ctx-cli: add `ctx todo snooze` and open a PR.', known).repositories.map((r) => r.id)).toEqual(['zackproser/ctx-cli']);
    const chore = extractObligationIR('Renew the domain for ctx.zackproser.com, then fix the cert cron in zackproser/ctx and open a PR.', known);
    expect(chore.deliverables.map((d) => [d.kind, d.repository])).toEqual([['pull_request', 'zackproser/ctx'], ['artifact', null]]);
    expect(chore.checks).toEqual([expect.objectContaining({ kind: 'owner_attestation', target: chore.deliverables[1]!.key })]);
  });
  it('reads deploy intent without the word deploy, and ignores failure context, owner first person and past-tense merges', () => {
    const live = extractObligationIR("Land the ledger change in zackproser/ctx and make sure it's live on prod before EOD.", known);
    expect(live.checks.map((c) => c.kind)).toEqual(['deployment_release']);
    expect(live.repositories[0]!.role).toBe('deployable');
    const failed = extractObligationIR('The deploy run https://github.com/zackproser/ctx/actions/runs/1 failed on the schema job; fix the cause in zackproser/ctx and open a PR.', known);
    expect(failed.checks).toEqual([]);
    expect(failed.repositories.map((r) => r.id)).toEqual(['zackproser/ctx']);
    const owner = extractObligationIR('zackproser/ctx: fix the migration ordering bug in a PR. No deploy from you; I deploy after I review.', known);
    expect(owner.checks).toEqual([]);
    const merged = extractObligationIR('zackproser/ctx#366 already merged; verify the deploy of it actually went out and the /app preview no longer shows placeholder spans. No new code.', known);
    expect(merged.checks.map((c) => c.kind).sort()).toEqual(['browser_smoke', 'deployment_release']);
    expect(merged.deliverables.map((d) => d.repository)).toEqual(['zackproser/ctx']);
  });
  it('orders lanes from explicit phrases and resolves the unnamed side of a two-lane prompt', () => {
    for (const prompt of [
      'After the schema PR lands in zackproser/ctx, then update ctx-cli to send the new field. Block the CLI work on the server change.',
      'Update ctx-cli to send the new field, but only after the schema change in zackproser/ctx has landed — the CLI PR depends on the server PR.',
      'Add the column in zackproser/ctx and expose it in ctx-cli; make sure the server side is on prod before the CLI release.',
    ]) {
      const ir = extractObligationIR(prompt, known);
      expect(ir.ordering, prompt).toEqual([{ before: 'lane_ctx_cli', after: ['lane_ctx'] }]);
    }
    const doc = extractObligationIR('Research how other MCP servers do tool pagination, write a short comparison doc, then implement cursor pagination for list_todos in zackproser/ctx.', known);
    expect(doc.deliverables.map((d) => d.kind)).toEqual(['pull_request', 'document']);
    expect(doc.ordering).toEqual([{ before: 'lane_ctx', after: [doc.deliverables[1]!.key] }]);
  });
  it('makes a join gate, not an artifact lane, when no proof is named', () => {
    const gate = extractObligationIR('Two PRs: one in zackproser/ctx-cli adding snooze, one in zackproser/ctx accepting it. Done when both are open.', known);
    expect(gate.join_requested).toBe(true);
    expect(gate.deliverables.map((d) => d.key)).toEqual(['lane_ctx_cli', 'lane_ctx']);
    const proof = extractObligationIR('Rename it in zackproser/ctx and in ctx-cli; close only once both PRs exist and the CLI e2e passes.', known);
    expect(proof.deliverables.map((d) => d.key)).toContain('joined_proof');
  });
  it('folds model spans only where they overlap the lane, dedupes, and lets the first proposal own the summary', () => {
    const floor = extractObligationIR('1. ctx-cli: add snooze\n2. zackproser/ctx: accept the snooze field\nSeparate PRs.', known);
    const marker = { start: 0, end: 2, text: '1.' };
    const cliSpan = floor.deliverables[0]!.provenance[0]!;
    const model: typeof floor = {
      ...floor, source: 'model',
      deliverables: [
        { key: 'lane_ctx', kind: 'pull_request', repository: 'zackproser/ctx', summary: 'First summary for the ctx lane.', provenance: [marker, cliSpan] },
        { key: 'issue', kind: 'artifact', repository: 'zackproser/ctx', summary: 'Second summary must not win here.', provenance: [floor.deliverables[1]!.provenance[0]!] },
      ],
    };
    const merged = mergeObligations(floor, model);
    const ctxLane = merged.deliverables.find((d) => d.key === 'lane_ctx')!;
    expect(ctxLane.summary).toBe('First summary for the ctx lane.');
    expect(ctxLane.provenance).toEqual(floor.deliverables[1]!.provenance);
    expect(merged.deliverables[0]!.provenance).toEqual(floor.deliverables[0]!.provenance);
  });
});
