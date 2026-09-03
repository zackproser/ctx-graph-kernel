<p align="center">
  <img src="docs/hero.png" alt="" width="100%">
</p>

# @ctx/graph-kernel

The pure computational core of [CTX](https://github.com/zackproser/ctx)'s completion graphs. Given a graph shape it lints the topology; given nodes, edges, and retained observations it decides, deterministically, which nodes are `blocked`, `ready`, `satisfied`, or `failed`; given a natural-language outcome it extracts the explicit obligations and lowers them into a graph. It hashes graph shapes into the compare-and-swap identity the control plane stores, and it owns the run-state transition table.

No I/O. No database, no secrets, no clock, no randomness. The same inputs produce the same bytes on a Cloudflare Worker, in Node, or in a browser tab. CTX runs this code in production; the golden fixture in `test/fixtures/parallel-join.ts` reproduces a real production shape hash byte for byte.

## Dependency direction

```
          ┌────────────────────────────────────────┐
          │  ctx  (control plane: DB, secrets,     │
          │        providers, receipts, owner UI)  │
          └───────┬────────────────────────────────┘
                  │ exact pin
                  ▼
   ┌──────────────────────┐
   │  @ctx/graph-kernel   │  ◀── this package
   │  lint · evaluate ·   │
   │  shape hash · IR ·   │
   │  lowering · runs     │
   └──────────┬───────────┘
              │ exact pin
              ▼
   ┌──────────────────────┐
   │   @ctx/contracts     │  vocabulary · stable()/sha256() · envelopes
   └──────────────────────┘
```

What stays in `ctx`: the compare-and-swap writes, idempotency ledgers, receipt authentication, owner gates, provider dispatch. The kernel computes; the control plane persists. `ctx-cli` does not depend on this package (it never needs to evaluate a graph; it reads the server's evaluation through `@ctx/contracts` envelopes).

## Install

Not on the public npm registry yet. Pin a commit; npm builds `dist/` on install via `prepare`:

```sh
npm install "git+https://github.com/zackproser/ctx-graph-kernel.git#<commit-sha>"
```

npm records git dependencies as `git+ssh://`; on a CI runner without an SSH key add
`git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"` before `npm ci`.
`zod ^3.25` is a peer dependency.

## API

### Lint a shape

```ts
import { lintCompletionGraphShape, assertDag } from '@ctx/graph-kernel';

const lint = lintCompletionGraphShape({ nodes, edges, initial_memberships });
lint.contract;            // 'ctx.work-graph-lint.v1'
lint.valid;               // false if any diagnostic has severity 'error'
lint.diagnostics;         // [{ severity, code, path, message }]
lint.topology;            // { entry_node_keys, terminal_node_keys, execution_order }
```

Diagnostics cover duplicate keys, dangling edges, cycles (`assertDag` throws a `KernelError` with status 400), self-edges, cardinality targets that a dependency can never satisfy, and predicate shapes the evaluator would reject.

### Validate a predicate

```ts
import { validatePredicate, PredicateObject } from '@ctx/graph-kernel';

validatePredicate({ type: 'artifact', artifact_type: 'github_pr', min_count: 1 }, 'artifact_requirement');
```

Predicates are the per-node rule (`fact`, `artifact`, `action_receipt`, `verification_receipt`, `input_set`, …). `validatePredicate` normalises the object and throws `KernelError` for anything the evaluator would not understand.

### Evaluate nodes

```ts
import { evaluateNodes } from '@ctx/graph-kernel';

const result = evaluateNodes(nodes, edges, observations, inputSetSnapshots);
result.get(nodeItemId);   // { result: 'satisfied' | 'ready' | 'blocked' | 'failed' | 'waived', count, refs, evidenceRefs, explanation }
```

Rules the evaluator enforces, and that the golden fixture pins:

* A node is `blocked` while any required dependency is not `satisfied`/`waived`.
* An executor's self-report never satisfies a lane; only retained evidence with attribution counts (the explanation says how many unattributed claims were ignored).
* Evaluation is a pure function of its inputs: the test suite runs it twice and asserts identity.

### Shape identity

```ts
import { shapeHash, appendedShapeHash, canonicalShape } from '@ctx/graph-kernel';

await shapeHash({ nodes, edges });                 // 64 hex chars; excludes titles and descriptions
await appendedShapeHash(previousHash, branch);    // identity of a graph extension
```

The hash is the CAS boundary for topology and evaluation semantics, not prose. Node and edge order do not matter. It is built on `sha256`/`stable` from `@ctx/contracts`, so it is byte-compatible with every `shape_hash` CTX has ever stored.

### Run-state transitions

```ts
import { legalRunTransition, runStatesThatMayEnter } from '@ctx/graph-kernel';

legalRunTransition('delivered', 'verified');   // true
legalRunTransition('verified', 'running');     // false
runStatesThatMayEnter('failed', ['running']);  // ['running']; throws if a listed state could never enter
```

`queued → running|failed`, `running → needs_input|failed|delivered|verified`, `needs_input → running|failed|delivered|verified`, `delivered → verified|failed`; `failed` and `verified` are terminal. Self-transitions are legal.

### Obligations: extract and lower

```ts
import { extractObligationIR, lowerObligations, selectTemplate, TEMPLATES } from '@ctx/graph-kernel';

const ir = extractObligationIR('Ship zackproser/ctx and zackproser/ctx-cli in parallel, then prove the join in production.');
ir.repositories;          // [{ value: 'zackproser/ctx', span }, { value: 'zackproser/ctx-cli', span }]
ir.join_requested;        // true, with the sentence span that said so
const graph = lowerObligations(ir, { registry_version: '1' });
graph.nodes; graph.edges; graph.template;   // e.g. 'multi_repo_join'
```

Extraction is deterministic and every finding carries the span of prompt text that justified it, so the compiler can show its work. Lowering picks one of the fixed `TEMPLATES` (`single_repo_delivery`, `multi_repo_join`, `report_only`, `research_plan_handoff`, `merge_gate`, `owner_checklist`) and emits a shape that passes `lintCompletionGraphShape`. The corpus in `test/corpus/compiler/` pins prompt → template → shape for every template.

### Types

`CompletionNode`, `CompletionEdge`, `CompletionObservation`, `GraphShapeNode`, `GraphShapeEdge`, `CompletionGraphShapeLike`, `CompletionGraphLint`, `CompletionGraphDiagnostic`, `PredicateEvaluation`, `EvaluationResult`, `WorkInputSetEvaluationSnapshot`, `ObligationIR`, `Span`, `LoweredGraph`, `TemplateId`, `KernelError`. Enumerations (`COMPLETION_NODE_KINDS`, `COMPLETION_STATUSES`, …) are re-exported from `@ctx/contracts`.

## Versioning and compatibility

| `@ctx/graph-kernel` | `@ctx/contracts` | `ctx` | Notes |
|---|---|---|---|
| 0.1.x | 0.1.x (exact pin) | pins exact commit | first extraction; no function body changed from `ctx/src/kernel` |

* Anything that changes a `shapeHash` result or an `evaluateNodes` verdict for an existing input is a **major** bump and needs a data migration in `ctx`; the golden fixture will fail first.
* New predicate types, templates, or diagnostics are minor bumps.
* The run-state table is frozen; changing it is a major bump.

## Contributing

```sh
npm ci
npm test          # boundary + golden + corpus, 35 tests
npm run typecheck
```

`test/boundary.test.ts` fails if any module imports anything other than a sibling, `zod`, or `@ctx/contracts`. Keep it that way: the moment the kernel touches I/O it stops being portable and stops being trustworthy as a pure function of its inputs.

## License

MIT, see [LICENSE](LICENSE). Extracted from `ctx` with history; see [NOTICE](NOTICE).
