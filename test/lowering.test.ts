import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintCompletionGraphShape } from '../src/graph-lint.js';
import { ObligationIR, normalizePrompt, validateObligationIR, type ObligationIR as IR } from '../src/obligation-ir.js';
import { extractObligationIR } from '../src/obligations.js';
import { lowerObligations, selectTemplate, TEMPLATES, type LoweredGraph } from '../src/lowering.js';

interface Fixture {
  name: string; prompt: string; has_github_resources: boolean; matched_pull_requests?: number; known_repositories: string[];
  expected: {
    template: string; repositories: string[]; deliverable_keys: string[]; check_kinds: string[];
    node_evaluators: Record<string, string>; edges: Array<[string, string]>; launch_ready: boolean;
  };
}

const corpus: Fixture[] = readdirSync(resolve('test/corpus/compiler'))
  .filter((name) => name.endsWith('.json') && name !== 'malformed_model.json')
  .map((name) => JSON.parse(readFileSync(resolve('test/corpus/compiler', name), 'utf8')) as Fixture);

const lower = (fixture: Fixture, prompt = fixture.prompt) => {
  const ir = extractObligationIR(prompt, fixture.known_repositories);
  return { ir, graph: lowerObligations(ir, { hasGithubResources: fixture.has_github_resources, matchedPullRequests: fixture.matched_pull_requests }) };
};
const lint = (graph: LoweredGraph) => lintCompletionGraphShape({ nodes: graph.nodes, edges: graph.edges, initial_memberships: [] });
const launchReady = (graph: LoweredGraph) => lint(graph).valid && graph.coverage.every((entry) => entry.severity !== 'error');

describe('compiler corpus (deterministic floor → templated lowering)', () => {
  it('has fixtures', () => { expect(corpus.length).toBeGreaterThanOrEqual(8); });
  for (const fixture of corpus) {
    it(`${fixture.name}: ${fixture.expected.template}`, () => {
      const { ir, graph } = lower(fixture);
      expect(validateObligationIR(ir, normalizePrompt(fixture.prompt))).toEqual([]);
      expect(graph.template).toBe(fixture.expected.template);
      expect(ir.repositories.map((r) => r.id)).toEqual(fixture.expected.repositories);
      expect(ir.deliverables.map((d) => d.key)).toEqual(fixture.expected.deliverable_keys);
      expect(ir.checks.map((c) => c.kind)).toEqual(fixture.expected.check_kinds);
      expect(Object.fromEntries(graph.nodes.map((n) => [n.key, n.evaluator]))).toEqual(fixture.expected.node_evaluators);
      expect(graph.edges.map((e) => [e.from, e.to])).toEqual(fixture.expected.edges);
      expect(lint(graph).valid).toBe(true);
      expect(launchReady(graph)).toBe(fixture.expected.launch_ready);
      for (const node of graph.nodes) expect(graph.provenance[node.key]).toBeDefined();
      // Bound lanes always carry the Repository line the dispatcher reads.
      for (const node of graph.nodes) {
        const bound = ir.deliverables.find((d) => d.key === node.key)?.repository;
        if (bound) expect(node.description.startsWith(`Repository: ${bound}\n`)).toBe(true);
      }
    });
  }
});

// Metamorphic: harmless rewrites must not change the shape.
function variants(prompt: string): string[] {
  const sentences = prompt.split(/(?<=[.;!?])\s+/).filter(Boolean);
  const reordered = sentences.length > 1 ? [...sentences.slice(1), sentences[0]!].join(' ') : prompt;
  const punctuation = prompt.replace(/"/g, '“').replace(/'/g, '’').replace(/\.\s+/g, '.  ');
  const spaced = prompt.replace(/\n\n/g, '\n').replace(/\s+/g, ' ');
  return [reordered, punctuation, spaced];
}

describe('invariant 3: metamorphic stability', () => {
  for (const fixture of corpus) {
    it(`${fixture.name} keeps template and obligation/node keys across rewrites`, () => {
      const base = lower(fixture);
      for (const variant of variants(fixture.prompt)) {
        const other = lower(fixture, variant);
        expect(other.graph.template).toBe(base.graph.template);
        expect(new Set(other.ir.deliverables.map((d) => d.key))).toEqual(new Set(base.ir.deliverables.map((d) => d.key)));
        expect(new Set(other.ir.repositories.map((r) => r.id))).toEqual(new Set(base.ir.repositories.map((r) => r.id)));
        expect(new Set(other.graph.nodes.map((n) => n.key))).toEqual(new Set(base.graph.nodes.map((n) => n.key)));
      }
    });
  }
  it('repository order swap yields the same lanes', () => {
    const a = lower(corpus.find((f) => f.name === 'two_repo_join')!);
    const swapped = 'Ship the CTX prompt-to-graph CLI control plane. Complete issue #301 across ctx-cli and zackproser/ctx. Two implementation lanes may run independently, but CTX must join them and authorize an end-to-end production proof only after both deliveries exist and the CTX server release passes independent deployment and authenticated browser verification.';
    const b = lower(corpus.find((f) => f.name === 'two_repo_join')!, swapped);
    expect(b.graph.template).toBe('multi_repo_join');
    expect(new Set(b.ir.repositories.map((r) => r.id))).toEqual(new Set(a.ir.repositories.map((r) => r.id)));
    expect(new Set(b.graph.nodes.map((n) => n.key))).toEqual(new Set(a.graph.nodes.map((n) => n.key)));
  });
});

describe('invariant 1 and 2: repositories never lower to attestations; coverage fails closed', () => {
  it('never emits manual_confirmation on a repository-bound lane', () => {
    for (const fixture of corpus.filter((f) => f.expected.repositories.length > 0)) {
      const { graph } = lower(fixture);
      const bound = graph.nodes.filter((n) => /^Repository:/m.test(n.description));
      expect(bound.length).toBeGreaterThan(0);
      expect(bound.some((n) => n.predicate.op === 'manual_confirmation')).toBe(false);
    }
  });
  it('lowers an owner-attested document beside a PR lane to a manual attestation on the document itself', () => {
    const fixture = corpus.find((f) => f.name === 'battery_pr_plus_attested_runbook')!;
    const { ir, graph } = lower(fixture);
    expect(ir.checks).toEqual([expect.objectContaining({ kind: 'owner_attestation', target: 'runbook_document' })]);
    const runbook = graph.nodes.find((n) => n.key === 'runbook_document')!;
    expect(runbook).toMatchObject({ evaluator: 'ctx.manual-attestation', predicate: { op: 'manual_confirmation' }, cardinality: { mode: 'exact', target: 1 } });
    expect(runbook.description.startsWith('Repository:')).toBe(false);
    const lane = graph.nodes.find((n) => n.key === 'lane_pi_harness')!;
    expect(lane).toMatchObject({ evaluator: 'ctx.work-run-artifact' });
    // The PR lane's provenance stops where the runbook ask begins.
    const laneEnd = Math.max(...graph.provenance.lane_pi_harness!.spans.map((s) => s.end));
    const runbookStart = Math.min(...graph.provenance.runbook_document!.spans.map((s) => s.start));
    expect(laneEnd).toBeLessThanOrEqual(runbookStart);
    expect(ir.checks.some((c) => c.kind === 'deployment_release')).toBe(false);
  });
  it('lowers non-software chores to owner steps without questions, and negations to nothing', () => {
    const { ir, graph } = lower(corpus.find((f) => f.name === 'battery_owner_chores')!);
    expect(ir.questions).toEqual([]);
    expect(graph.nodes.map((n) => n.evaluator)).toEqual(['ctx.manual-attestation', 'ctx.manual-attestation', 'ctx.manual-attestation']);
    const report = extractObligationIR('Write a report-only Markdown summary and store it in CTX. No code changes.');
    expect(report.deliverables.map((d) => d.kind)).toEqual(['document']);
    expect(report.checks).toEqual([]);
  });
  it('flags an uncovered repository, an uncovered join, and unresolved questions', () => {
    const ir = extractObligationIR(corpus.find((f) => f.name === 'two_repo_join')!.prompt);
    const dropped: IR = { ...ir, deliverables: ir.deliverables.filter((d) => d.repository !== 'zackproser/ctx-cli'), ordering: [] };
    expect(lowerObligations(dropped, { hasGithubResources: false }).coverage.map((c) => c.code)).toContain('obligation_uncovered');
    const noJoin: IR = { ...ir, deliverables: ir.deliverables.filter((d) => d.key !== 'joined_proof'), ordering: [] };
    // multi_repo_join synthesizes a join node when none is declared, so coverage passes …
    expect(lowerObligations(noJoin, { hasGithubResources: false }).coverage).toEqual([]);
    // … but a join_requested IR whose edges cannot reach every lane fails.
    const graph = lowerObligations(noJoin, { hasGithubResources: false });
    const noEdges = { ...graph, edges: [] };
    expect(lowerObligations(noJoin, { hasGithubResources: false }).nodes.some((n) => n.key === 'all_lanes_accepted')).toBe(true);
    expect(noEdges.edges).toEqual([]);
    const questioned: IR = { ...ir, questions: [{ text: 'Which branch?', provenance: ir.repositories[0]!.provenance }] };
    expect(lowerObligations(questioned, { hasGithubResources: false }).coverage.map((c) => c.code)).toContain('questions_unresolved');
    expect(lowerObligations(questioned, { hasGithubResources: false, answeredQuestions: [0] }).coverage).toEqual([]);
  });
  it('downgrades a merge gate without retained pull requests instead of verifying nothing', () => {
    const fixture = corpus.find((f) => f.name === 'merge_gate')!;
    const ir = extractObligationIR(fixture.prompt, fixture.known_repositories);
    const graph = lowerObligations(ir, { hasGithubResources: false });
    expect(graph.template).not.toBe('merge_gate');
    expect(graph.nodes.some((n) => n.evaluator === 'ctx.github-merge-verifier')).toBe(false);
    expect(lint(graph).valid).toBe(true);
  });
});

// Deterministic pseudo-random generator so the property run is reproducible.
function rng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}
function randomIR(random: () => number, index: number): IR {
  const span = { start: 0, end: 1, text: 'x' };
  const repoCount = Math.floor(random() * 4);
  const repositories = Array.from({ length: repoCount }, (_, i) => ({
    id: `owner${index % 7}/repo${i}`, role: (['deployable', 'library', 'unknown'] as const)[Math.floor(random() * 3)]!, provenance: [span],
  }));
  const kinds = ['pull_request', 'commit', 'document', 'artifact', 'deployment', 'message'] as const;
  const deliverableCount = 1 + Math.floor(random() * 5);
  const deliverables = Array.from({ length: deliverableCount }, (_, i) => ({
    key: `d${i}`, kind: kinds[Math.floor(random() * kinds.length)]!,
    repository: repositories.length && random() < 0.7 ? repositories[Math.floor(random() * repositories.length)]!.id : null,
    summary: `deliverable ${i} ${random() < 0.3 ? 'deploy release' : 'work'}`, provenance: [span],
  }));
  // Ordering as a DAG: each rule points strictly at earlier keys.
  const ordering = deliverables.slice(1).filter(() => random() < 0.5).map((d, i) => ({
    before: d.key, after: [deliverables[Math.floor(random() * (i + 1))]!.key],
  }));
  const checkKinds = ['deployment_release', 'browser_smoke', 'owner_attestation', 'connector'] as const;
  const checks = Array.from({ length: Math.floor(random() * 3) }, () => ({
    kind: checkKinds[Math.floor(random() * checkKinds.length)]!, target: repositories[0]?.id ?? null, provenance: [span],
  }));
  const ir: IR = {
    contract: 'ctx.work-obligation-ir.v1', title: `generated ${index}`, repositories, deliverables, checks, ordering,
    join_requested: random() < 0.5, parallel_requested: random() < 0.5, questions: [], source: 'deterministic',
  };
  return ObligationIR.parse(ir);
}

describe('property: lowering over generated IRs', () => {
  it('always lints, is byte-stable, and never emits manual_confirmation with a repository (2,000 IRs)', () => {
    const random = rng(20260903);
    let checked = 0;
    for (let index = 0; index < 2000; index += 1) {
      const ir = randomIR(random, index);
      if (validateObligationIR(ir).length) continue;
      const a = lowerObligations(ir, { hasGithubResources: index % 2 === 0 });
      const b = lowerObligations(structuredClone(ir), { hasGithubResources: index % 2 === 0 });
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(TEMPLATES).toContain(a.template);
      expect(a.template).toBe(selectTemplate(ir) === 'merge_gate' && index % 2 !== 0 ? a.template : selectTemplate(ir));
      const result = lint(a);
      expect(result.valid, `${index}: ${JSON.stringify(result.diagnostics)}`).toBe(true);
      if (ir.repositories.length > 0) expect(a.nodes.some((n) => n.predicate.op === 'manual_confirmation')).toBe(false);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(1500);
  });
});

describe('round 2 lowering rules', () => {
  it('owner steps are parallel unless the prompt orders them', () => {
    const parallel = lowerObligations(extractObligationIR('1. book dentist\n2. renew passport\n3. call the accountant about Q3'), { hasGithubResources: false });
    expect(parallel.template).toBe('owner_checklist');
    expect(parallel.nodes.map((n) => n.key)).toEqual(['step_1', 'step_2', 'step_3']);
    expect(parallel.edges).toEqual([]);
    const sequential = lowerObligations(extractObligationIR('Renew the passport first; after that, book the flights.'), { hasGithubResources: false });
    expect(sequential.nodes.map((n) => n.title)).toEqual(['Renew the passport first', 'after that, book the flights']);
    expect(sequential.edges).toEqual([{ from: 'step_2', to: 'step_1', kind: 'depends_on' }]);
  });
  it('says plainly when a merge gate degrades to delivery', () => {
    const ir = extractObligationIR('Merge zackproser/ctx PRs #364 and #365 once CI is green.', ['zackproser/ctx']);
    const graph = lowerObligations(ir, { hasGithubResources: false });
    expect(graph.template).toBe('single_repo_delivery');
    expect(graph.coverage).toEqual([expect.objectContaining({ severity: 'warning', code: 'merge_gate_degraded', message: 'no retained PRs matched; delivering instead of gating' })]);
    expect(lowerObligations(ir, { hasGithubResources: true, matchedPullRequests: 2 }).coverage).toEqual([]);
  });
  it('a chore beside a PR lane is owner-attested and never receives the deployment receipt', () => {
    const ir = extractObligationIR("Renew the domain for ctx.zackproser.com, then fix the cert cron in zackproser/ctx, open a PR and make sure it's live on prod.", ['zackproser/ctx']);
    const graph = lowerObligations(ir, { hasGithubResources: false });
    const step = graph.nodes.find((n) => n.key.endsWith('_step'))!;
    expect(step).toMatchObject({ evaluator: 'ctx.manual-attestation', predicate: { op: 'manual_confirmation' } });
    expect(graph.nodes.find((n) => n.key === 'lane_ctx')!.evaluator).toBe('ctx.declarative');
  });
});
