// Pure completion-graph vocabulary. No I/O, no Worker or Node imports.

export type CardinalityMode = 'exact' | 'at_least' | 'dynamic';

export const COMPLETION_NODE_KINDS = [
  'input_set', 'action', 'artifact_requirement', 'verification_gate',
] as const;

export const COMPLETION_STATUSES = [
  'blocked', 'ready', 'running', 'satisfied', 'failed', 'waived',
] as const;

export type CompletionNodeKind = typeof COMPLETION_NODE_KINDS[number];

export type CompletionPolicy = 'required' | 'optional' | 'waived';

export type CompletionStatus = typeof COMPLETION_STATUSES[number];

export interface GraphShapeNode {
  key: string;
  title: string;
  description: string;
  kind: CompletionNodeKind;
  policy: CompletionPolicy;
  cardinality: { mode: CardinalityMode; target: number };
  predicate: Record<string, unknown>;
  evaluator: string;
  evaluator_version: string;
}

export interface GraphShapeEdge {
  from: string;
  to: string;
  kind: 'depends_on';
}

export interface GraphShapeMembership {
  input_node_key: string;
  resource_item_ids: string[];
}

export interface CompletionGraphShapeLike {
  nodes: GraphShapeNode[];
  edges: GraphShapeEdge[];
  initial_memberships: GraphShapeMembership[];
}

export interface CompletionGraphDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  path: Array<string | number>;
  message: string;
}

export interface CompletionGraphLint {
  contract: 'ctx.work-graph-lint.v1';
  valid: boolean;
  diagnostics: CompletionGraphDiagnostic[];
  topology: {
    entry_node_keys: string[];
    terminal_node_keys: string[];
    execution_order: string[];
  };
}

export type EvaluationResult = Exclude<CompletionStatus, 'running'>;

export interface CompletionNode {
  item_id: string;
  node_key: string;
  title: string;
  description: string;
  kind: CompletionNodeKind;
  policy: CompletionPolicy;
  cardinality_mode: CardinalityMode;
  target_count: number;
  predicate: Record<string, unknown>;
  evaluator: string;
  evaluator_version: string;
  status: CompletionStatus;
  satisfied_count: number;
  spec_revision: number;
  evaluated_at: string | null;
  // Execution is a separate dimension from completion: the job holding this
  // node's custody — a live job first, else the newest terminal one. Only
  // inspectCompletionGraph projects it; the evaluator never derives status
  // from it.
  execution?: {
    job_id: string;
    state: 'queued' | 'running' | 'needs_input' | 'failed' | 'delivered' | 'verified';
    executor: string;
    attempt: number;
    updated_at: string;
  } | null;
}

export interface CompletionObservation {
  id: string;
  node_item_id: string;
  kind: 'fact' | 'artifact' | 'action_receipt' | 'verification_receipt';
  evidence_item_id: string | null;
  payload: Record<string, unknown>;
  source: string;
  observed_at: string;
  expires_at: string | null;
  spec_revision: number;
}

export interface CompletionEdge {
  id: string;
  from_item_id: string;
  to_item_id: string;
  kind: 'depends_on';
}

export interface PredicateEvaluation {
  passed: boolean;
  failed: boolean;
  count: number;
  refs: string[];
  evidenceRefs: string[];
  explanation: string;
}

export interface WorkInputSetEvaluationSnapshot {
  node_item_id: string;
  revision: number;
  member_hash: string;
  member_count: number;
  members: { resource_item_id: string }[];
}
