// Node completion evaluation over current observations and input sets. Pure.
import { KernelError } from './errors.js';
import { dependencyCardinalityMismatch } from './graph-lint.js';
import { cardinalityPass, evaluatePredicate } from './predicates.js';
import type {
  CompletionEdge, CompletionNode, CompletionObservation, EvaluationResult, WorkInputSetEvaluationSnapshot,
} from './types.js';

export function evaluateNodes(
  nodes: CompletionNode[], edges: CompletionEdge[], observations: CompletionObservation[],
  inputSets: WorkInputSetEvaluationSnapshot[],
) {
  const byId = new Map(nodes.map((node) => [node.item_id, node]));
  const dependencies = new Map(nodes.map((node) => [node.item_id, [] as string[]]));
  for (const edge of edges) dependencies.get(edge.from_item_id)?.push(edge.to_item_id);
  const inputSetByNode = new Map(inputSets.map((inputSet) => [inputSet.node_item_id, inputSet]));
  const upstreamCache = new Map<string, WorkInputSetEvaluationSnapshot[]>();
  const upstreamInputSets = (nodeId: string) => {
    const cached = upstreamCache.get(nodeId);
    if (cached) return cached;
    const found = new Map<string, WorkInputSetEvaluationSnapshot>();
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const dependencyId of dependencies.get(id) ?? []) {
        const inputSet = inputSetByNode.get(dependencyId);
        if (inputSet) found.set(inputSet.node_item_id, inputSet);
        walk(dependencyId);
      }
    };
    walk(nodeId);
    const result = [...found.values()].sort((left, right) => left.node_item_id.localeCompare(right.node_item_id));
    upstreamCache.set(nodeId, result);
    return result;
  };
  const observationMatchesMembership = (
    observation: CompletionObservation, required: WorkInputSetEvaluationSnapshot[],
  ) => {
    if (required.length === 0) return true;
    const raw = observation.payload.ctx_input_sets;
    if (!Array.isArray(raw)) return false;
    const snapshots = raw.filter((entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === 'object' && !Array.isArray(entry));
    return required.every((inputSet) => snapshots.some((entry) =>
      entry.node_item_id === inputSet.node_item_id
      && Number(entry.revision) === Number(inputSet.revision)
      && entry.member_hash === inputSet.member_hash));
  };
  const evaluated = new Map<string, {
    result: EvaluationResult; count: number; refs: string[]; explanation: string;
  }>();
  const visiting = new Set<string>();

  const visit = (node: CompletionNode) => {
    const prior = evaluated.get(node.item_id);
    if (prior) return prior;
    if (visiting.has(node.item_id)) throw new KernelError(409, 'stored completion graph contains a cycle');
    visiting.add(node.item_id);
    const dependencyResults = (dependencies.get(node.item_id) ?? []).map((id) => {
      const dependency = byId.get(id);
      if (!dependency) throw new KernelError(409, 'stored completion graph has a dangling dependency');
      return visit(dependency);
    });
    const dependencyMismatch = node.predicate.op === 'dependencies_satisfied'
      ? dependencyCardinalityMismatch(
        node.cardinality_mode, node.target_count, dependencyResults.length,
      )
      : null;
    let result: EvaluationResult;
    let count = 0;
    let refs: string[] = [];
    let explanation: string;
    if (node.policy === 'waived') {
      result = 'waived';
      explanation = 'requirement is explicitly waived';
    } else if (dependencyMismatch) {
      result = 'blocked';
      explanation = dependencyMismatch;
    } else if (dependencyResults.some((dependency) => !['satisfied', 'waived'].includes(dependency.result))) {
      result = 'blocked';
      explanation = 'one or more dependencies are not satisfied';
    } else if (node.predicate.op === 'dependencies_satisfied') {
      count = dependencyResults.length;
      refs = [...(dependencies.get(node.item_id) ?? [])].sort();
      result = 'satisfied';
      explanation = `all ${count} dependencies are satisfied or waived; no node observation is required`;
    } else if (node.kind === 'verification_gate'
        && (node.evaluator === 'ctx.work-run-artifact'
          || node.predicate.op !== 'observation_count'
          || node.predicate.observation_kind !== 'verification_receipt')) {
      // Defense in depth for graphs stored before the stricter shape schema:
      // executor artifacts are delivery evidence, never independent verification.
      result = 'blocked';
      explanation = 'verification gate is misconfigured; it must consume authoritative verification receipts';
    } else if (node.kind === 'input_set') {
      const inputSet = inputSetByNode.get(node.item_id);
      count = inputSet?.members.length ?? 0;
      refs = inputSet?.members.map((member) => member.resource_item_id) ?? [];
      const passed = count > 0 && (node.cardinality_mode === 'dynamic'
        || node.cardinality_mode === 'exact' && count === node.target_count
        || node.cardinality_mode === 'at_least' && count >= node.target_count);
      result = passed ? 'satisfied' : 'ready';
      explanation = inputSet
        ? `${count} current input member${count === 1 ? '' : 's'} at membership revision ${inputSet.revision}`
        : 'input membership projection is missing';
    } else {
      const requiredInputSets = upstreamInputSets(node.item_id);
      const allNodeObservations = observations.filter((observation) => observation.node_item_id === node.item_id);
      const nodeObservations = allNodeObservations.filter((observation) =>
        observationMatchesMembership(observation, requiredInputSets));
      const predicate = evaluatePredicate(node.predicate, nodeObservations);
      count = predicate.count;
      refs = predicate.refs;
      let passed = cardinalityPass(node, predicate);
      let membershipExplanation = '';
      if (node.kind === 'verification_gate' && requiredInputSets.length > 0
          && node.predicate.op === 'observation_count'
          && node.predicate.observation_kind === 'verification_receipt') {
        const expected = [...new Set(requiredInputSets.flatMap((inputSet) =>
          inputSet.members.map((member) => member.resource_item_id)))];
        const accepted = new Set(predicate.evidenceRefs);
        count = expected.filter((resourceId) => accepted.has(resourceId)).length;
        passed = expected.length > 0 && count === expected.length;
        membershipExplanation = `; ${count}/${expected.length} current input members have matching verifier receipts`;
      }
      const exactOverflow = node.predicate.op === 'observation_count'
        && node.cardinality_mode === 'exact' && predicate.count > node.target_count;
      if (passed) result = 'satisfied';
      else result = predicate.failed || exactOverflow ? 'failed' : 'ready';
      const cardinality = node.predicate.op === 'observation_count'
        ? `; ${node.cardinality_mode} cardinality target ${node.target_count}` : '';
      const staleCount = allNodeObservations.length - nodeObservations.length;
      const stale = staleCount > 0
        ? `; ${staleCount} observation${staleCount === 1 ? '' : 's'} retained for superseded input membership`
        : '';
      explanation = `${predicate.explanation}${cardinality}${membershipExplanation}${stale}`;
    }
    visiting.delete(node.item_id);
    const output = { result, count, refs, explanation };
    evaluated.set(node.item_id, output);
    return output;
  };
  for (const node of nodes) visit(node);
  return evaluated;
}
