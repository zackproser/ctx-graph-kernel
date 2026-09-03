// Shape identity for completion graphs. The hash deliberately excludes titles
// and descriptions: it is the CAS boundary for topology and evaluation
// semantics, not prose. Byte-compatible with every stored shape_hash.
import { sha256 } from './canonical';

interface ShapeNode {
  key: string; kind: string; policy: string;
  cardinality: { mode: string; target: number };
  predicate: Record<string, unknown>;
  evaluator: string; evaluator_version: string;
}
interface ShapeEdge { from: string; to: string; kind: string }
export interface ShapeInput { nodes: ShapeNode[]; edges: ShapeEdge[] }

export function canonicalShape(input: ShapeInput) {
  return {
    nodes: input.nodes.map((node) => ({
      key: node.key, kind: node.kind, policy: node.policy,
      cardinality: node.cardinality, predicate: node.predicate,
      evaluator: node.evaluator, evaluator_version: node.evaluator_version,
    })).sort((a, b) => a.key.localeCompare(b.key)),
    edges: input.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind }))
      .sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
  };
}

export function shapeHash(input: ShapeInput) {
  return sha256({ schema: 'ctx.work-completion.v1', ...canonicalShape(input) });
}

export function appendedShapeHash(previousShapeHash: string, branch: ShapeInput) {
  return sha256({
    schema: 'ctx.work-completion.v1', previous_shape_hash: previousShapeHash,
    append: canonicalShape(branch),
  });
}
