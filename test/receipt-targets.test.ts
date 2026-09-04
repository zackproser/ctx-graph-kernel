import { describe, expect, it } from 'vitest';
import { coverageDiagnostics, lowerObligations } from '../src/lowering.js';
import { extractObligationIR, mergeObligations } from '../src/obligations.js';
import type { ObligationIR } from '../src/obligation-ir.js';

const prompt = 'Ship the prompt-to-graph CLI control plane: work in zackproser/ctx-cli and zackproser/ctx as separate lanes, then have CTX join both and run an end-to-end production proof after the CTX server release passes independent deployment and authenticated browser verification.';
const deployment = 'ctx.deployment-release-verifier';
const browser = 'ctx.browser-smoke-verifier';
const fixture = () => {
  const floor = extractObligationIR(prompt);
  return mergeObligations(floor, { ...floor, source: 'model',
    repositories: floor.repositories.map(repo => ({ ...repo, role: 'deployable' })) });
};
const lower = (ir: ObligationIR) => lowerObligations(ir, { hasGithubResources: false });
const receipts = (graph: ReturnType<typeof lower>) => Object.fromEntries(graph.nodes.map(node => [node.key,
  [deployment, browser].filter(id => JSON.stringify(node.predicate).includes(id))]));
const errors = (graph: ReturnType<typeof lower>) => graph.coverage.filter(diagnostic => diagnostic.severity === 'error');

describe('deployment and browser receipt targets', () => {
  it('keeps explicit server checks on the server when a model labels both repositories deployable', () => {
    const ir = fixture();
    expect(ir.repositories.map(repo => repo.role)).toEqual(['deployable', 'deployable']);
    expect(ir.checks.map(check => check.target)).toEqual(['zackproser/ctx', 'zackproser/ctx']);
    const graph = lower(ir);
    expect(receipts(graph)).toEqual({ lane_ctx_cli: [], lane_ctx: [deployment, browser], joined_proof: [] });
    expect(errors(graph)).toEqual([]);
    expect(graph.edges).toEqual(expect.arrayContaining([
      { from: 'joined_proof', to: 'lane_ctx_cli', kind: 'depends_on' },
      { from: 'joined_proof', to: 'lane_ctx', kind: 'depends_on' },
    ]));
  });

  it('preserves target identity across repository order, lane order, casing, and model role changes', () => {
    const ir = fixture();
    const expected = receipts(lower(ir));
    ir.repositories.reverse();
    ir.deliverables.reverse();
    ir.repositories = ir.repositories.map(repo => ({ ...repo, role: 'library' }));
    ir.checks = ir.checks.map(check => ({ ...check, target: 'ZackProser/CTX' }));
    expect(receipts(lower(ir))).toEqual(expected);
    expect(errors(lower(ir))).toEqual([]);
  });

  it('routes different check kinds independently and deduplicates repeated requirements', () => {
    const ir = fixture();
    ir.checks[1]!.target = 'lane_ctx_cli';
    ir.checks.push({ ...ir.checks[0]! });
    const graph = lower(ir);
    expect(receipts(graph)).toEqual({ lane_ctx_cli: [browser], lane_ctx: [deployment], joined_proof: [] });
    const server = graph.nodes.find(node => node.key === 'lane_ctx')!;
    expect((server.predicate.conditions as unknown[])).toHaveLength(2);
    expect(errors(graph)).toEqual([]);
  });

  it.each(['missing/repository', 'joined_proof'])('blocks an explicit target without an eligible executor lane: %s', target => {
    const ir = fixture();
    ir.checks = [{ ...ir.checks[0]!, target }];
    const graph = lower(ir);
    expect(Object.values(receipts(graph)).flat()).toEqual([]);
    expect(errors(graph)).toEqual([expect.objectContaining({ code: 'receipt_obligation_uncovered' })]);
  });

  it('requires a lane key when a repository has multiple eligible deliverables', () => {
    const ir = fixture();
    const server = ir.deliverables.find(lane => lane.key === 'lane_ctx')!;
    ir.deliverables.push({ ...server, key: 'second_server_lane' });
    expect(errors(lower(ir))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'receipt_obligation_uncovered' }),
    ]));
    ir.checks = ir.checks.map(check => ({ ...check, target: 'lane_ctx' }));
    expect(receipts(lower(ir)).lane_ctx).toEqual([deployment, browser]);
    expect(errors(lower(ir)).some(diagnostic => diagnostic.code === 'receipt_obligation_uncovered')).toBe(false);
  });

  it('keeps verification on a repository lane even when a non-executable owner-attestation aside names it', () => {
    const ir = fixture();
    ir.checks.push({ ...ir.checks[0]!, kind: 'owner_attestation', target: 'lane_ctx' });
    const graph = lower(ir);
    expect(receipts(graph).lane_ctx).toEqual([deployment, browser]);
    expect(graph.nodes.find(node => node.key === 'lane_ctx')!.evaluator).toBe('ctx.declarative');
    expect(errors(graph)).toEqual([]);
  });

  it('accepts an untargeted check only when one eligible lane exists', () => {
    const ir = extractObligationIR('Fix zackproser/ctx and verify the deployed release in the browser.');
    ir.checks = ir.checks.map(check => ({ ...check, target: null }));
    expect(receipts(lower(ir)).lane_ctx).toEqual([deployment, browser]);
    expect(errors(lower(ir))).toEqual([]);
    const ambiguous = fixture();
    ambiguous.checks = ambiguous.checks.map(check => ({ ...check, target: null }));
    expect(Object.values(receipts(lower(ambiguous))).flat()).toEqual([]);
    expect(errors(lower(ambiguous)).filter(diagnostic => diagnostic.code === 'receipt_obligation_uncovered')).toHaveLength(2);
  });

  it('coverage rejects receipts placed on the wrong lane or lacking a passing requirement', () => {
    const ir = fixture(), graph = lower(ir);
    const server = graph.nodes.find(node => node.key === 'lane_ctx')!;
    const cli = graph.nodes.find(node => node.key === 'lane_ctx_cli')!;
    [server.predicate, cli.predicate] = [cli.predicate, server.predicate];
    expect(coverageDiagnostics(ir, graph.nodes, graph.edges).filter(d => d.code === 'receipt_obligation_uncovered')).toHaveLength(2);
    [server.predicate, cli.predicate] = [cli.predicate, server.predicate];
    server.predicate = { op: 'observation_count', observation_kind: 'verification_receipt', min_count: 1,
      matches: [{ path: 'verifier_id', operator: 'eq', value: deployment }] };
    expect(coverageDiagnostics(ir, graph.nodes, graph.edges).filter(d => d.code === 'receipt_obligation_uncovered')).toHaveLength(2);
  });
});
