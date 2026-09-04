import { describe, expect, it } from 'vitest';
import { evaluatePredicate } from '../src/predicates.js';
import type { CompletionObservation } from '../src/types.js';

const predicate = { op: 'observation_count', observation_kind: 'verification_receipt', min_count: 1 };
const receipt = (id: string, passed: boolean, extra: Record<string, unknown> = {}): CompletionObservation => ({
  id, node_item_id: 'lane', kind: 'verification_receipt', evidence_item_id: null,
  source: 'connector:trusted-verifier:browser', observed_at: new Date().toISOString(),
  expires_at: null, spec_revision: 1,
  payload: { verifier_id: 'browser', passed, ...extra },
});
describe('current verifier truth', () => {
  it('withdraws a historical pass when the same check later fails', () => {
    const value = evaluatePredicate(predicate, [receipt('pass', true), receipt('fail', false)]);
    expect(value.passed).toBe(false);
    expect(value.failed).toBe(true);
    expect(value.refs).not.toContain('pass');
  });
  it('allows a successful remediation to supersede the failed check', () => {
    const value = evaluatePredicate(predicate, [receipt('fail', false), receipt('pass', true)]);
    expect(value.passed).toBe(true);
    expect(value.failed).toBe(false);
    expect(value.refs).toEqual(['pass']);
  });
  it('does not count rechecks of the same writer twice', () => {
    expect(evaluatePredicate({ ...predicate, min_count: 2 }, [receipt('a', true), receipt('b', true)]).passed).toBe(false);
  });
  it('withdraws a pass while a recheck is pending without declaring failure', () => {
    const value = evaluatePredicate(predicate, [receipt('pass', true), receipt('pending', false, { pending: true })]);
    expect(value.passed).toBe(false);
    expect(value.failed).toBe(false);
  });
});
