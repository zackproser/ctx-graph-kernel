// Pure Work graph vocabulary shared by Worker services and the browser's
// realtime contracts. Keep this file dependency-free so UI typechecks never
// pull Cloudflare Worker globals through the server database modules.
export const WORK_NODE_KINDS = ['project', 'task', 'decision', 'reference', 'event'] as const;
export type WorkNodeKind = typeof WORK_NODE_KINDS[number];

// Humans may capture the three ordinary work shapes. `event` joins the read
// graph only for typed proof resources and is created through the proof
// service, never as an untyped manual event.
export const CREATABLE_WORK_NODE_KINDS = ['project', 'task', 'reference'] as const;
export type CreatableWorkNodeKind = typeof CREATABLE_WORK_NODE_KINDS[number];

export const WORK_EDGE_KINDS = [
  'contains', 'blocks', 'depends_on', 'relates_to', 'evidence_for', 'delivers',
] as const;
export type WorkEdgeKind = typeof WORK_EDGE_KINDS[number];

export const WORK_RESOURCE_TYPES = [
  'github_issue', 'github_pr', 'repo_file', 'local_file', 'url', 'image',
  'recording', 'commit', 'agent_run', 'build', 'deployment', 'document',
  'email', 'decision', 'connector_action', 'verification_receipt', 'receipt',
] as const;
export type WorkResourceType = typeof WORK_RESOURCE_TYPES[number];

export const WORK_RUN_STATES = [
  'queued', 'running', 'needs_input', 'failed', 'delivered', 'verified',
] as const;
export type WorkRunState = typeof WORK_RUN_STATES[number];

export const WORK_RESOURCE_HEALTH = ['current', 'stale', 'unknown', 'error'] as const;
export type WorkResourceHealth = typeof WORK_RESOURCE_HEALTH[number];

export interface WorkResource {
  type: WorkResourceType;
  provider: string;
  locator: string;
  reference_mode: 'immutable' | 'live';
  version_ref: string | null;
  run_state: WorkRunState | null;
  health: WorkResourceHealth;
  observed_at: string;
  checked_at: string | null;
  metadata: Record<string, unknown>;
  canonical_key?: string | null;
  storage_locator?: string | null;
  media_type?: string | null;
  content_sha256?: string | null;
  size_bytes?: number | null;
  revision: number;
}
