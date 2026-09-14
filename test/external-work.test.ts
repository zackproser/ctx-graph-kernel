import { expect, it } from 'vitest';
import { externalWorkGraph } from '../src/external-work.js';
import { lintCompletionGraphShape } from '../src/graph-lint.js';
it('lowers an external case to chained native gates with case-bound receipt predicates', () => {
  const graph = externalWorkGraph('case-42');
  expect(lintCompletionGraphShape(graph).valid).toBe(true);
  expect(graph.nodes.map(n => n.key)).toEqual(['intake', 'packet', 'submitted', 'booking', 'owner_update']);
  expect(graph.edges).toHaveLength(4);
  for (const node of graph.nodes) expect(node.predicate.matches).toContainEqual({ path: 'case_id', operator: 'eq', value: 'case-42' });
});
