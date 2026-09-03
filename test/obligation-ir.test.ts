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
