// Bounded evidence-predicate language v1: validation and evaluation. Pure.
import { z } from 'zod';
import { stable } from '@ctx/contracts';
import { KernelError } from './errors.js';
import type { CompletionNode, CompletionObservation, PredicateEvaluation } from './types.js';

export const PredicateObject = z.record(z.string(), z.unknown()).refine(
  (value) => JSON.stringify(value).length <= 16 * 1024,
  'predicate must be at most 16KB',
);

const MAX_PREDICATE_DEPTH = 5;
const MAX_PREDICATE_CONDITIONS = 20;

export function validatePredicate(raw: Record<string, unknown>, depth = 0): void {
  if (depth > MAX_PREDICATE_DEPTH) throw new KernelError(422, 'predicate nesting exceeds five levels');
  const op = raw.op;
  if (op === 'observation_count') {
    const parsed = z.object({
      op: z.literal('observation_count'),
      observation_kind: z.enum(['fact', 'artifact', 'action_receipt', 'verification_receipt']).optional(),
      min_count: z.number().int().min(0).max(10000).default(1),
      matches: z.array(z.object({
        path: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/),
        operator: z.enum(['eq', 'neq', 'exists', 'includes']),
        value: z.unknown().optional(),
      })).max(12).default([]),
    }).strict().parse(raw);
    for (const match of parsed.matches) {
      if (match.operator !== 'exists' && match.value === undefined) {
        throw new KernelError(422, `predicate match ${match.path} requires a value`);
      }
    }
    return;
  }
  if (op === 'manual_confirmation') {
    z.object({ op: z.literal('manual_confirmation') }).strict().parse(raw);
    return;
  }
  if (op === 'dependencies_satisfied') {
    if (depth > 0) throw new KernelError(422, 'dependencies_satisfied must be the top-level predicate');
    z.object({ op: z.literal('dependencies_satisfied') }).strict().parse(raw);
    return;
  }
  if (op === 'all' || op === 'any') {
    const parsed = z.object({
      op: z.enum(['all', 'any']),
      conditions: z.array(PredicateObject).min(1).max(MAX_PREDICATE_CONDITIONS),
    }).strict().parse(raw);
    for (const condition of parsed.conditions) validatePredicate(condition, depth + 1);
    return;
  }
  throw new KernelError(422,
    'predicate op must be observation_count, manual_confirmation, dependencies_satisfied, all, or any');
}

function currentValue(payload: Record<string, unknown>, path: string) {
  let value: unknown = payload;
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || !(part in value)) return { exists: false, value: undefined };
    value = (value as Record<string, unknown>)[part];
  }
  return { exists: true, value };
}

function valuesEqual(a: unknown, b: unknown) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

export function observationMatches(observation: CompletionObservation, matches: Array<Record<string, unknown>>) {
  return matches.every((raw) => {
    const path = String(raw.path);
    const operator = String(raw.operator);
    const actual = currentValue(observation.payload, path);
    if (operator === 'exists') return actual.exists === (raw.value === undefined ? true : Boolean(raw.value));
    if (!actual.exists) return false;
    if (operator === 'eq') return valuesEqual(actual.value, raw.value);
    if (operator === 'neq') return !valuesEqual(actual.value, raw.value);
    if (operator === 'includes') {
      if (Array.isArray(actual.value)) return actual.value.some((entry) => valuesEqual(entry, raw.value));
      return typeof actual.value === 'string' && typeof raw.value === 'string' && actual.value.includes(raw.value);
    }
    return false;
  });
}

export function evaluatePredicate(
  raw: Record<string, unknown>, observations: CompletionObservation[],
): PredicateEvaluation {
  const op = raw.op;
  if (op === 'observation_count') {
    const kind = typeof raw.observation_kind === 'string' ? raw.observation_kind : null;
    const min = typeof raw.min_count === 'number' ? raw.min_count : 1;
    const matches = Array.isArray(raw.matches) ? raw.matches as Array<Record<string, unknown>> : [];
    const candidates = observations.filter((observation) => !kind || observation.kind === kind);
    // A failed trusted check remains durable input and therefore makes a gate
    // failed rather than ready, but it can never satisfy even a loosely written
    // verification_receipt count predicate.
    // An artifact claim counts only when it names a retained evidence item
    // (record_artifacts / connector projection). A bare executor self-report
    // through report_work_observation is a claim about work, not the work, and
    // must never satisfy an artifact requirement on its own.
    const passCandidates = kind === 'verification_receipt'
      ? candidates.filter((observation) => observation.payload.passed === true)
      : kind === 'artifact'
        ? candidates.filter((observation) => observation.evidence_item_id !== null)
        : candidates;
    const unattributed = kind === 'artifact'
      ? candidates.length - passCandidates.length : 0;
    const accepted = passCandidates.filter((observation) => observationMatches(observation, matches));
    // Re-verification is append-only, so one canonical evidence resource can
    // legitimately have many receipts. Cardinality describes distinct work
    // inputs, not the number of times a connector was polled.
    const distinct = new Map(accepted.map((observation) => [
      observation.evidence_item_id ? `evidence:${observation.evidence_item_id}` : `observation:${observation.id}`,
      observation,
    ]));
    const counted = [...distinct.values()];
    const identityMatches = matches.filter((match) => match.path !== 'passed');
    const relevant = candidates.filter((observation) =>
      observationMatches(observation, identityMatches));
    const latestRelevant = new Map(relevant.map((observation) => [
      observation.evidence_item_id
        ? `evidence:${observation.evidence_item_id}`
        : `receipt:${observation.source}:${String(observation.payload.verifier_id
          ?? observation.payload.verifier ?? '')}`,
      observation,
    ]));
    const explicitlyFailed = kind === 'verification_receipt'
      && [...latestRelevant.values()].some((observation) => observation.payload.passed === false
        && observation.payload.pending !== true);
    return {
      passed: counted.length >= min,
      failed: explicitlyFailed,
      count: counted.length,
      refs: counted.map((observation) => observation.id),
      evidenceRefs: counted.flatMap((observation) => observation.evidence_item_id ? [observation.evidence_item_id] : []),
      explanation: `${counted.length} distinct matching ${kind ?? 'observation'} receipt${counted.length === 1 ? '' : 's'}; requires ${min}${
        unattributed > 0 ? `; ${unattributed} unattributed artifact claim${unattributed === 1 ? '' : 's'} ignored` : ''}`,
    };
  }
  if (op === 'manual_confirmation') {
    // A manual gate is deliberately not satisfiable by an executor/MCP receipt.
    // App observations are authenticated by Access and server timestamped; the
    // latest attestation wins so reopening remains append-only and auditable.
    const attestations = observations.filter((observation) =>
      observation.kind === 'action_receipt'
      && observation.source.startsWith('app:')
      && observation.payload.manual === true
      && (observation.payload.state === 'done' || observation.payload.state === 'open'));
    const latest = attestations.at(-1);
    const passed = latest?.payload.state === 'done';
    return {
      passed,
      failed: false,
      count: passed ? 1 : 0,
      refs: latest ? [latest.id] : [],
      evidenceRefs: latest?.evidence_item_id ? [latest.evidence_item_id] : [],
      explanation: latest
        ? passed
          ? `confirmed by ${latest.source.slice(4)}`
          : `reopened by ${latest.source.slice(4)}; awaiting user confirmation`
        : 'awaiting user confirmation; no automated verifier is configured',
    };
  }
  const conditions = Array.isArray(raw.conditions) ? raw.conditions as Array<Record<string, unknown>> : [];
  const parts = conditions.map((condition) => evaluatePredicate(condition, observations));
  const passed = op === 'all' ? parts.every((part) => part.passed) : parts.some((part) => part.passed);
  return {
    passed,
    failed: !passed && (op === 'all'
      ? parts.some((part) => part.failed)
      : parts.length > 0 && parts.every((part) => part.failed)),
    count: parts.reduce((sum, part) => sum + part.count, 0),
    refs: [...new Set(parts.flatMap((part) => part.refs))],
    evidenceRefs: [...new Set(parts.flatMap((part) => part.evidenceRefs))],
    explanation: `${op === 'all' ? 'all' : 'one'} of ${parts.length} predicate conditions ${passed ? 'passed' : 'did not pass'}`,
  };
}

export function cardinalityPass(node: CompletionNode, evaluated: PredicateEvaluation) {
  if (node.predicate.op !== 'observation_count') return evaluated.passed;
  if (node.cardinality_mode === 'exact') return evaluated.passed && evaluated.count === node.target_count;
  return evaluated.passed && evaluated.count >= node.target_count;
}
