import { describe, expect, it } from 'vitest';
import { extractObligationIR } from '../src/obligations.js';
import { lowerObligations } from '../src/lowering.js';
import { evaluatePredicate } from '../src/predicates.js';
describe('green CI is an independent obligation', () => {
  it('a retained artifact alone cannot satisfy either parallel software lane', () => {
    const ir = extractObligationIR('Open PRs in zackproser/ctx and zackproser/ctx-cli in parallel. Done when both have green CI. Do not merge.');
    const graph = lowerObligations(ir, { hasGithubResources: false });
    expect(ir.checks.filter((check) => check.kind === 'github_checks')).toHaveLength(2);
    const lanes = graph.nodes.filter((node) => node.kind === 'artifact_requirement');
    expect(lanes).toHaveLength(2);
    for (const lane of lanes) {
      expect(lane.evaluator).toBe('ctx.declarative');
      expect(evaluatePredicate(lane.predicate, [{ id: 'artifact', node_item_id: lane.key,
        kind: 'artifact', evidence_item_id: 'retained', payload: {}, source: 'mcp:executor',
        observed_at: new Date().toISOString(), expires_at: null, spec_revision: 1 }]).passed).toBe(false);
    }
  });
  it('does not silently weaken unsupported CI merge conditions', () => {
    const ir = extractObligationIR('Merge zackproser/ctx PR #1 only if CI is green.');
    expect(lowerObligations(ir, { hasGithubResources: true }).coverage)
      .toContainEqual(expect.objectContaining({ code: 'ci_obligation_uncovered', severity: 'error' }));
  });
});
