// Obligation IR — the only thing a model is ever allowed to propose. Nodes,
// edges, predicates and evaluators are produced from this by lowering.ts.
// Contract: ctx.work-obligation-ir.v1 (see docs/COMPILER.md when it lands).
import { z } from 'zod';

export const Span = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  text: z.string(),
}).refine((span) => span.end >= span.start, 'span end precedes start');
export type Span = z.infer<typeof Span>;

const Key = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
const RepositoryId = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

export const DELIVERABLE_KINDS = ['pull_request', 'commit', 'document', 'artifact', 'deployment', 'message'] as const;
export const CHECK_KINDS = ['deployment_release', 'browser_smoke', 'github_merge', 'owner_attestation', 'connector'] as const;
export type DeliverableKind = typeof DELIVERABLE_KINDS[number];
export type CheckKind = typeof CHECK_KINDS[number];

export const ObligationIR = z.object({
  contract: z.literal('ctx.work-obligation-ir.v1'),
  title: z.string().min(1).max(90),
  repositories: z.array(z.object({
    id: RepositoryId,
    role: z.enum(['deployable', 'library', 'unknown']),
    provenance: z.array(Span).min(1),
  })).max(12),
  deliverables: z.array(z.object({
    key: Key,
    kind: z.enum(DELIVERABLE_KINDS),
    repository: RepositoryId.nullable(),
    summary: z.string().min(1).max(300),
    provenance: z.array(Span).min(1),
  })).max(24),
  checks: z.array(z.object({
    kind: z.enum(CHECK_KINDS),
    target: z.string().nullable(),
    provenance: z.array(Span).min(1),
  })).max(24),
  ordering: z.array(z.object({ before: Key, after: z.array(Key).min(1).max(24) })).max(24),
  join_requested: z.boolean(),
  parallel_requested: z.boolean(),
  questions: z.array(z.object({ text: z.string().min(1).max(600), provenance: z.array(Span).min(1) })).max(24),
  source: z.enum(['deterministic', 'model', 'merged']),
});
export type ObligationIR = z.infer<typeof ObligationIR>;

// Aliases for callers that prefer *Schema names for the zod values.
export const SpanSchema = Span;
export const ObligationIRSchema = ObligationIR;

// Spans index into this text, never into the raw prompt.
export function normalizePrompt(prompt: string) {
  return prompt.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

// Structural rules zod cannot express: unique keys, resolvable acyclic
// ordering, spans inside the normalized prompt. Returns human-readable errors.
export function validateObligationIR(ir: ObligationIR, normalizedPrompt?: string): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const deliverable of ir.deliverables) {
    if (keys.has(deliverable.key)) errors.push(`duplicate deliverable key ${deliverable.key}`);
    keys.add(deliverable.key);
  }
  const repositories = new Set(ir.repositories.map((entry) => entry.id.toLowerCase()));
  if (repositories.size !== ir.repositories.length) errors.push('duplicate repository');
  for (const deliverable of ir.deliverables) {
    if (deliverable.repository && !repositories.has(deliverable.repository.toLowerCase())) {
      errors.push(`deliverable ${deliverable.key} names unknown repository ${deliverable.repository}`);
    }
  }
  for (const check of ir.checks) {
    if (check.target && !keys.has(check.target) && !repositories.has(check.target.toLowerCase())) {
      errors.push(`check ${check.kind} targets unknown ${check.target}`);
    }
  }
  const dependencies = new Map<string, string[]>();
  for (const rule of ir.ordering) {
    if (!keys.has(rule.before)) errors.push(`ordering names unknown key ${rule.before}`);
    for (const after of rule.after) if (!keys.has(after)) errors.push(`ordering names unknown key ${after}`);
    dependencies.set(rule.before, [...(dependencies.get(rule.before) ?? []), ...rule.after]);
  }
  const state = new Map<string, 1 | 2>();
  const visit = (key: string, path: string[]) => {
    const seen = state.get(key);
    if (seen === 2) return;
    if (seen === 1) { errors.push(`ordering cycle: ${[...path, key].join(' -> ')}`); return; }
    state.set(key, 1);
    for (const next of dependencies.get(key) ?? []) visit(next, [...path, key]);
    state.set(key, 2);
  };
  for (const key of dependencies.keys()) visit(key, []);
  if (normalizedPrompt !== undefined) {
    const spans = [
      ...ir.repositories.flatMap((entry) => entry.provenance),
      ...ir.deliverables.flatMap((entry) => entry.provenance),
      ...ir.checks.flatMap((entry) => entry.provenance),
      ...ir.questions.flatMap((entry) => entry.provenance),
    ];
    for (const span of spans) {
      if (span.end > normalizedPrompt.length) { errors.push(`span ${span.start}-${span.end} exceeds prompt`); continue; }
      if (normalizedPrompt.slice(span.start, span.end) !== span.text) errors.push(`span ${span.start}-${span.end} text mismatch`);
    }
  }
  return errors;
}
