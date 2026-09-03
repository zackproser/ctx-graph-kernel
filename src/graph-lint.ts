// Structural lint and DAG checks for completion-graph shapes. Pure.
import { KernelError } from './errors.js';
import type {
  CardinalityMode, CompletionGraphDiagnostic, CompletionGraphLint, CompletionGraphShapeLike, CompletionNodeKind,
} from './types.js';

export function dependencyCardinalityMismatch(mode: CardinalityMode, target: number, count: number) {
  if (count === 0) return 'dependencies_satisfied requires at least one dependency edge';
  if (mode === 'exact' && count !== target) {
    return `dependencies_satisfied exact cardinality requires ${target} dependency edges; received ${count}`;
  }
  if (mode === 'at_least' && count < target) {
    return `dependencies_satisfied at_least cardinality requires at least ${target} dependency edges; received ${count}`;
  }
  // Dynamic joins derive their current target from all declared dependency
  // edges, so the only malformed dynamic shape is an empty join.
  return null;
}

const GENERIC_NODE_TITLE = /^(?:plan(?:ning)?|implement(?:ation)?|execut(?:e|ion)|verify|verification|done|complete|completion|task|work)$/i;

/**
 * Deterministic structural and evaluator lint for every graph authoring path.
 * Edges are stored as `from depends_on to`; execution order is therefore the
 * reverse direction (`to` before `from`). Mermaid is deliberately absent.
 */
export function lintCompletionGraphShape(input: CompletionGraphShapeLike): CompletionGraphLint {
  const diagnostics: CompletionGraphDiagnostic[] = [];
  const add = (
    severity: CompletionGraphDiagnostic['severity'], code: string,
    path: CompletionGraphDiagnostic['path'], message: string,
  ) => diagnostics.push({ severity, code, path, message });
  const keys = new Map<string, CompletionNodeKind>();
  for (const [index, node] of input.nodes.entries()) {
    if (keys.has(node.key)) add('error', 'duplicate_node_key', ['nodes', index, 'key'], 'node keys must be unique');
    keys.set(node.key, node.kind);
    if (node.policy === 'required' && node.cardinality.target === 0) add(
      'error', 'zero_required_cardinality', ['nodes', index, 'cardinality', 'target'],
      'a required node must require at least one result',
    );
    if (GENERIC_NODE_TITLE.test(node.title.trim())) add(
      'warning', 'generic_node_title', ['nodes', index, 'title'],
      'name the observable result, not a generic phase',
    );
    if (!node.description.trim()) add(
      'warning', 'missing_node_instructions', ['nodes', index, 'description'],
      'describe the concrete evidence or state that satisfies this node',
    );
  }

  if (!input.nodes.some((node) => node.policy === 'required')) add(
    'error', 'missing_required_node', ['nodes'], 'a completion graph must contain at least one required node',
  );

  const edgeKeys = new Set<string>();
  const dependencyCounts = new Map<string, number>();
  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const [index, edge] of input.edges.entries()) {
    if (!keys.has(edge.from) || !keys.has(edge.to)) add(
      'error', 'unknown_edge_endpoint', ['edges', index], 'edge endpoints must name graph nodes',
    );
    if (edge.from === edge.to) add(
      'error', 'self_dependency', ['edges', index], 'a node cannot depend on itself',
    );
    const identity = `${edge.from}\u0000${edge.to}`;
    if (edgeKeys.has(identity)) add(
      'error', 'duplicate_dependency', ['edges', index], 'dependency edges must be unique',
    );
    edgeKeys.add(identity);
    dependencyCounts.set(edge.from, (dependencyCounts.get(edge.from) ?? 0) + 1);
    dependencies.set(edge.from, [...(dependencies.get(edge.from) ?? []), edge.to]);
    dependents.set(edge.to, [...(dependents.get(edge.to) ?? []), edge.from]);
    if (keys.get(edge.from) === 'input_set') add(
      'error', 'input_set_has_dependency', ['edges', index, 'from'],
      'an input set is evidence input and cannot depend on another completion node',
    );
  }

  const visitState = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (key: string) => {
    const state = visitState.get(key) ?? 0;
    if (state === 2) return;
    if (state === 1) {
      const start = stack.indexOf(key);
      const cycle = [...stack.slice(Math.max(0, start)), key];
      add('error', 'dependency_cycle', ['edges'], `completion graph contains a dependency cycle: ${cycle.join(' -> ')}`);
      return;
    }
    visitState.set(key, 1);
    stack.push(key);
    for (const dependency of dependencies.get(key) ?? []) if (keys.has(dependency)) visit(dependency);
    stack.pop();
    visitState.set(key, 2);
  };
  for (const key of keys.keys()) visit(key);

  for (const [index, node] of input.nodes.entries()) {
    const op = node.predicate.op;
    if (node.kind === 'verification_gate' && op !== 'dependencies_satisfied'
        && (node.evaluator === 'ctx.work-run-artifact'
          || op !== 'observation_count'
          || node.predicate.observation_kind !== 'verification_receipt')) add(
      'error', 'untrusted_verification_gate', ['nodes', index, 'predicate'],
      'verification gates must consume authoritative verification_receipt observations or use a dependency-only join',
    );
    if (op === 'dependencies_satisfied') {
      const mismatch = dependencyCardinalityMismatch(
        node.cardinality.mode, node.cardinality.target, dependencyCounts.get(node.key) ?? 0,
      );
      if (mismatch) add('error', 'dependency_cardinality_mismatch', ['nodes', index, 'cardinality'], mismatch);
      if (node.kind !== 'verification_gate' || node.evaluator !== 'ctx.declarative') add(
        'error', 'invalid_dependency_join', ['nodes', index],
        'a dependency-only join must be a verification_gate evaluated by ctx.declarative',
      );
    }
    if ((op === 'manual_confirmation') !== (node.evaluator === 'ctx.manual-attestation')) add(
      'error', 'manual_evaluator_mismatch', ['nodes', index, 'evaluator'],
      'manual_confirmation predicates and ctx.manual-attestation must be used together',
    );
    if (node.evaluator === 'ctx.work-run-artifact'
        && (op !== 'observation_count' || node.predicate.observation_kind !== 'artifact')) add(
      'error', 'artifact_evaluator_mismatch', ['nodes', index, 'predicate'],
      'ctx.work-run-artifact requires an artifact observation_count predicate',
    );
    if (node.evaluator === 'ctx.input-membership' && node.kind !== 'input_set') add(
      'error', 'membership_evaluator_mismatch', ['nodes', index, 'kind'],
      'ctx.input-membership may only evaluate input_set nodes',
    );
    if (node.kind === 'input_set' && node.evaluator !== 'ctx.input-membership') add(
      'error', 'input_set_evaluator_mismatch', ['nodes', index, 'evaluator'],
      'input_set nodes must use ctx.input-membership',
    );
  }

  const membershipKeys = new Set<string>();
  let initialMemberCount = 0;
  for (const [index, membership] of input.initial_memberships.entries()) {
    initialMemberCount += membership.resource_item_ids.length;
    if (membershipKeys.has(membership.input_node_key)) add(
      'error', 'duplicate_initial_membership', ['initial_memberships', index, 'input_node_key'],
      'an input node can have only one initial membership',
    );
    membershipKeys.add(membership.input_node_key);
    if (keys.get(membership.input_node_key) !== 'input_set') add(
      'error', 'invalid_initial_membership', ['initial_memberships', index, 'input_node_key'],
      'initial membership must name an input_set node',
    );
  }
  if (initialMemberCount > 100) add(
    'error', 'too_many_initial_members', ['initial_memberships'],
    'initial memberships may contain at most 100 resource entries in one definition',
  );

  const entryNodeKeys = [...keys.keys()].filter((key) => (dependencies.get(key) ?? []).length === 0).sort();
  const terminalNodeKeys = [...keys.keys()].filter((key) => (dependents.get(key) ?? []).length === 0).sort();
  if (terminalNodeKeys.length > 1) add(
    'warning', 'implicit_root_join', ['edges'],
    `the task root implicitly joins ${terminalNodeKeys.length} terminal nodes; add an explicit dependency join when their convergence is meaningful`,
  );

  const remaining = new Map([...keys.keys()].map((key) => [key, (dependencies.get(key) ?? []).length]));
  const queue = entryNodeKeys.slice();
  const executionOrder: string[] = [];
  while (queue.length) {
    const key = queue.shift()!;
    executionOrder.push(key);
    for (const dependent of (dependents.get(key) ?? []).sort()) {
      const count = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        queue.push(dependent);
        queue.sort();
      }
    }
  }

  return {
    contract: 'ctx.work-graph-lint.v1',
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
    topology: {
      entry_node_keys: entryNodeKeys,
      terminal_node_keys: terminalNodeKeys,
      execution_order: executionOrder,
    },
  };
}

export function assertDag(input: { nodes: Array<{ key: string }>; edges: Array<{ from: string; to: string }> }) {
  const dependencies = new Map(input.nodes.map((node) => [node.key, [] as string[]]));
  for (const edge of input.edges) dependencies.get(edge.from)!.push(edge.to);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new KernelError(422, `completion graph contains a cycle at ${key}`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of dependencies.get(key) ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const node of input.nodes) visit(node.key);
}
