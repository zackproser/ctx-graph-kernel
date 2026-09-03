// Golden fixture: production task 5a961ada (2026-09-02), graph revision 1,
// shape_hash 6453b367… — two independent repository lanes joined by a proof.
import type { CompletionEdge, CompletionNode, CompletionObservation } from '../../src/types.js';

export const TASK_ID = '5a961ada-7cfd-4ccd-9a7a-0ba3271339af';
export const CLI = '23d280d6-b3a5-4d9f-96dc-d5340343bbb8';
export const SERVER = '464020e4-f01c-4257-9bad-4cc26a2e3e6d';
export const JOIN = '71acc695-6618-4b38-a142-e59f50e1242e';
export const PRODUCTION_SHAPE_HASH = '6453b367f271a5cb8cbed079b987764ff929941b0d0b082db41f300b41dc14ae';

const artifact = { op: 'observation_count', observation_kind: 'artifact', min_count: 1 };
const receipt = (verifier: string) => ({
  op: 'observation_count', observation_kind: 'verification_receipt', min_count: 1,
  matches: [{ path: 'verifier_id', operator: 'eq', value: verifier }, { path: 'passed', operator: 'eq', value: true }],
});

export const shape = {
  nodes: [
    { key: 'cli_control_plane', title: 'Add prompt preview and confirmed dispatch to ctx-cli', description: 'see production node', kind: 'artifact_requirement', policy: 'required', cardinality: { mode: 'at_least', target: 1 }, predicate: artifact, evaluator: 'ctx.declarative', evaluator_version: '1' },
    { key: 'production_join_proof', title: 'Prove the joined CLI workflow against production', description: 'see production node', kind: 'artifact_requirement', policy: 'required', cardinality: { mode: 'exact', target: 1 }, predicate: artifact, evaluator: 'ctx.declarative', evaluator_version: '1' },
    { key: 'server_control_plane', title: 'Finish the CTX compiler and governed handling contract', description: 'see production node', kind: 'artifact_requirement', policy: 'required', cardinality: { mode: 'at_least', target: 1 }, predicate: { op: 'all', conditions: [artifact, receipt('ctx.deployment-release-verifier'), receipt('ctx.browser-smoke-verifier')] }, evaluator: 'ctx.declarative', evaluator_version: '1' },
  ],
  edges: [
    { from: 'production_join_proof', to: 'server_control_plane', kind: 'depends_on' },
    { from: 'production_join_proof', to: 'cli_control_plane', kind: 'depends_on' },
  ],
};

const node = (item_id: string, key: string, cardinality_mode: 'exact' | 'at_least', predicate: Record<string, unknown>): CompletionNode => ({
  item_id, node_key: key, title: key, description: '', kind: 'artifact_requirement', policy: 'required',
  cardinality_mode, target_count: 1, predicate, evaluator: 'ctx.declarative', evaluator_version: '1',
  status: 'ready', satisfied_count: 0, spec_revision: 1, evaluated_at: null,
});
export const nodes: CompletionNode[] = [
  node(CLI, 'cli_control_plane', 'at_least', artifact),
  node(JOIN, 'production_join_proof', 'exact', artifact),
  node(SERVER, 'server_control_plane', 'at_least', shape.nodes[2]!.predicate),
];
export const edges: CompletionEdge[] = [
  { id: '896c07ea-052e-4703-8982-563928255583', from_item_id: JOIN, to_item_id: SERVER, kind: 'depends_on' },
  { id: 'd8d6b44d-bb67-40f5-893b-fd770301aeb4', from_item_id: JOIN, to_item_id: CLI, kind: 'depends_on' },
];
const observation = (id: string, node_item_id: string, evidence_item_id: string | null, source: string, observed_at: string): CompletionObservation => ({
  id, node_item_id, kind: 'artifact', evidence_item_id, payload: {}, source, observed_at, expires_at: null, spec_revision: 1,
});
// The Orb's own claim (no retained evidence) arrived first; connector-projected
// PR and commit observations followed 47 seconds later.
export const cliSelfReport = observation('e2dd5405-331b-46e8-a41f-dbb12b5e9130', CLI, null, 'mcp:orb-run:2aaed853-df43-4831-8e08-c51b43104017:1', '2026-09-02T22:57:37.225Z');
export const cliRetained = [
  observation('5bfd5df7-0a6c-454c-bd64-e021045d2315', CLI, '59bf2aa7-3b33-5c7d-8130-29fa4291becf', 'connector:ctx-work-run', '2026-09-02T22:58:24.198Z'),
  observation('2c10cb82-c371-4fab-915a-43b190a36594', CLI, 'ff929400-3792-50e2-89c5-beb76dbecbcf', 'connector:ctx-work-run', '2026-09-02T22:58:25.486Z'),
];
export const serverRetained = [
  observation('99077656-e38f-4e71-b0bc-37166b19e8cd', SERVER, 'bb6bb6f1-5996-5875-bc3f-8994ddf98f5f', 'connector:ctx-work-run', '2026-09-02T22:53:57.011Z'),
  observation('19851cbf-6e4b-442c-a9b0-2b986bd89230', SERVER, '53c0676e-16d9-51e3-9f2c-75d59b9119c3', 'connector:ctx-work-run', '2026-09-02T22:53:58.216Z'),
];
