// @ctx/graph-kernel is the pure seam lifted out of ctx/src/kernel unchanged.
// Two things must hold: it imports nothing with I/O (only sibling modules, zod,
// and @ctx/contracts), and moving the code changed no bytes of behavior
// (pinned production hash + golden fixture).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateNodes } from '../src/evaluate.js';
import { lintCompletionGraphShape } from '../src/graph-lint.js';
import { legalRunTransition } from '../src/run-transitions.js';
import { appendedShapeHash, shapeHash } from '../src/shape-hash.js';
import {
  CLI, JOIN, PRODUCTION_SHAPE_HASH, SERVER, cliRetained, cliSelfReport, edges, nodes, serverRetained, shape,
} from './fixtures/parallel-join.js';

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('kernel boundary', () => {
  it('imports only sibling kernel modules, zod, and @ctx/contracts', () => {
    const offenders: string[] = [];
    for (const file of files(resolve('src'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^(?:import|export)[^'"]*from\s+'([^']+)'/gm)) {
        const specifier = match[1]!;
        if (specifier === 'zod' || specifier === '@ctx/contracts' || specifier.startsWith('./')) continue;
        offenders.push(`${file.replace(`${process.cwd()}/`, '')} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is exercised: the walk finds the kernel modules it protects', () => {
    const names = files(resolve('src')).map((file) => file.split('/').at(-1));
    expect(names).toEqual(expect.arrayContaining([
      'evaluate.ts', 'graph-lint.ts', 'lowering.ts', 'obligation-ir.ts', 'obligations.ts', 'predicates.ts',
      'run-transitions.ts', 'shape-hash.ts', 'types.ts',
    ]));
  });
});

describe('kernel golden: production parallel-join graph', () => {
  it('reproduces the stored production shape hash byte for byte', async () => {
    expect(await shapeHash(shape)).toBe(PRODUCTION_SHAPE_HASH);
    // Node order and edge order must not matter.
    const shuffled = { nodes: [...shape.nodes].reverse(), edges: [...shape.edges].reverse() };
    expect(await shapeHash(shuffled)).toBe(PRODUCTION_SHAPE_HASH);
    expect(await appendedShapeHash(PRODUCTION_SHAPE_HASH, { nodes: [], edges: [] }))
      .toBe(await appendedShapeHash(PRODUCTION_SHAPE_HASH, { nodes: [], edges: [] }));
  });

  it('lints the shape as a valid two-lane join', () => {
    const lint = lintCompletionGraphShape({ ...shape, initial_memberships: [] } as Parameters<typeof lintCompletionGraphShape>[0]);
    expect(lint.valid).toBe(true);
    expect(lint.topology).toEqual({
      entry_node_keys: ['cli_control_plane', 'server_control_plane'],
      terminal_node_keys: ['production_join_proof'],
      execution_order: ['cli_control_plane', 'server_control_plane', 'production_join_proof'],
    });
  });

  it('evaluates exactly as production did once retained evidence existed', () => {
    const result = evaluateNodes(nodes, edges, [cliSelfReport, ...cliRetained, ...serverRetained], []);
    expect(result.get(CLI)).toMatchObject({ result: 'satisfied', count: 2 });
    expect(result.get(CLI)!.explanation).toContain('1 unattributed artifact claim ignored');
    expect(result.get(SERVER)).toMatchObject({ result: 'ready', count: 2 });
    expect(result.get(JOIN)).toMatchObject({ result: 'blocked' });
    // Determinism: a second run over the same inputs is identical.
    expect(evaluateNodes(nodes, edges, [cliSelfReport, ...cliRetained, ...serverRetained], [])).toEqual(result);
  });

  it('never lets the executor self-report alone satisfy the CLI lane', () => {
    const result = evaluateNodes(nodes, edges, [cliSelfReport, ...serverRetained], []);
    expect(result.get(CLI)).toMatchObject({ result: 'ready', count: 0 });
    expect(result.get(JOIN)).toMatchObject({ result: 'blocked' });
  });

  it('keeps the run-state table intact', () => {
    expect(legalRunTransition('delivered', 'verified')).toBe(true);
    expect(legalRunTransition('verified', 'running')).toBe(false);
    expect(legalRunTransition('queued', 'delivered')).toBe(false);
  });
});
