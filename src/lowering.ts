// Templated lowering: ObligationIR → completion graph shape. This is the ONLY
// place predicates and evaluators are written. Output is byte-stable for a
// given IR (deterministic keys, insertion order derived from the IR).
// Contract: ctx.work-shape.v1.
import type { ObligationIR, Span } from './obligation-ir';
import type { CompletionGraphDiagnostic, GraphShapeEdge, GraphShapeNode } from './types';

export const TEMPLATES = [
  'single_repo_delivery', 'multi_repo_join', 'report_only', 'research_plan_handoff', 'merge_gate', 'owner_checklist',
] as const;
export type TemplateId = typeof TEMPLATES[number];

export interface LoweringOptions {
  hasGithubResources: boolean;
  // Number of retained pull requests governed by a merge gate (input-set size).
  matchedPullRequests?: number;
  // Question indexes the owner has answered via overrides.
  answeredQuestions?: number[];
  // Owner override (attrs.draft_overrides.template): force a shape.
  template?: TemplateId;
}

export interface LoweredGraph {
  template: TemplateId;
  nodes: GraphShapeNode[];
  edges: GraphShapeEdge[];
  provenance: Record<string, { obligation_keys: string[]; spans: Span[] }>;
  coverage: CompletionGraphDiagnostic[];
}

const LANE_KINDS = new Set(['pull_request', 'commit', 'artifact', 'deployment']);
const DESCRIPTION_MAX = 8192;
const TITLE_MAX = 300;
const bounded = (value: string, max: number) => {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
};
const RECEIPT_ID = {
  deployment_release: 'ctx.deployment-release-verifier',
  browser_smoke: 'ctx.browser-smoke-verifier',
} as const;

export function selectTemplate(ir: ObligationIR): TemplateId {
  if (ir.checks.some((check) => check.kind === 'github_merge')) return 'merge_gate';
  const lanes = ir.deliverables.filter((entry) => LANE_KINDS.has(entry.kind));
  if (ir.repositories.length >= 2) return 'multi_repo_join';
  if (ir.repositories.length === 0 && lanes.filter((entry) => entry.repository === null && entry.kind === 'artifact').length >= 2
    && (ir.join_requested || ir.parallel_requested)) return 'multi_repo_join';
  if (ir.repositories.length === 1) return 'single_repo_delivery';
  const executable = ir.deliverables.some((entry) => entry.kind === 'pull_request' || entry.kind === 'commit' || entry.kind === 'deployment');
  if (executable) return 'single_repo_delivery';
  if (ir.deliverables.length === 0) return 'owner_checklist';
  const research = ir.deliverables.some((entry) => entry.kind === 'document' && /\b(?:plan|research)\b/i.test(entry.summary));
  if (research && ir.deliverables.some((entry) => entry.kind !== 'document')) return 'research_plan_handoff';
  return 'report_only';
}

function receiptPredicate(verifierId: string) {
  return {
    op: 'observation_count', observation_kind: 'verification_receipt', min_count: 1,
    matches: [
      { path: 'verifier_id', operator: 'eq', value: verifierId },
      { path: 'passed', operator: 'eq', value: true },
    ],
  };
}

const ARTIFACT_PREDICATE = { op: 'observation_count', observation_kind: 'artifact', min_count: 1 };

function laneNode(
  deliverable: ObligationIR['deliverables'][number], receipts: string[],
): GraphShapeNode {
  const body = deliverable.summary || 'A retained run artifact or connected harness receipt must be reported.';
  const receiptDetail = receipts.length
    ? ` CTX also requires independent ${receipts.map((id) => id === RECEIPT_ID.browser_smoke ? 'browser smoke' : 'deployment release').join(' and ')} receipts.`
    : '';
  return {
    key: deliverable.key,
    title: bounded(deliverable.summary.split(/(?<=[.;!?])\s+/)[0] ?? deliverable.key, TITLE_MAX),
    description: bounded(`${deliverable.repository ? `Repository: ${deliverable.repository}\n` : ''}${body}${receiptDetail}`, DESCRIPTION_MAX),
    kind: 'artifact_requirement', policy: 'required',
    cardinality: { mode: 'at_least', target: 1 },
    predicate: receipts.length ? { op: 'all', conditions: [ARTIFACT_PREDICATE, ...receipts.map(receiptPredicate)] } : ARTIFACT_PREDICATE,
    evaluator: receipts.length ? 'ctx.declarative' : 'ctx.work-run-artifact', evaluator_version: '1',
  };
}

// Deployment/browser receipts gate exactly one lane: the deployable
// repository's lane (else the first repository's), never a downstream proof.
function receiptGate(ir: ObligationIR, lanes: ObligationIR['deliverables']): { key: string | null; receipts: string[] } {
  const receipts = ir.checks
    .filter((check) => check.kind === 'deployment_release' || check.kind === 'browser_smoke')
    .map((check) => RECEIPT_ID[check.kind as 'deployment_release' | 'browser_smoke']);
  if (!receipts.length || !lanes.length) return { key: null, receipts: [] };
  const deployable = ir.repositories.find((entry) => entry.role === 'deployable')?.id ?? ir.repositories[0]?.id ?? null;
  const target = lanes.find((lane) => deployable && lane.repository?.toLowerCase() === deployable.toLowerCase())
    ?? lanes.find((lane) => /\b(?:deploy|deployed|deployment|production|release)\b/i.test(lane.summary))
    ?? lanes[lanes.length - 1]!;
  return { key: target.key, receipts: [...new Set(receipts)] };
}

export function lowerObligations(ir: ObligationIR, opts: LoweringOptions): LoweredGraph {
  let template = opts.template ?? selectTemplate(ir);
  // A merge gate without retained pull requests has nothing to verify against;
  // fall back to the shape the rest of the IR describes.
  if (template === 'merge_gate' && !opts.hasGithubResources) {
    const gate = ir.checks.find((check) => check.kind === 'github_merge')!;
    const lanes = ir.repositories
      .filter((repository) => !ir.deliverables.some((entry) => entry.repository?.toLowerCase() === repository.id.toLowerCase()))
      .map((repository) => ({
        key: `lane_${repository.id.slice(repository.id.indexOf('/') + 1).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
        kind: 'pull_request' as const, repository: repository.id,
        summary: bounded(gate.provenance.map((span) => span.text).join(' ') || ir.title, 300), provenance: gate.provenance,
      }));
    ir = {
      ...ir,
      deliverables: [...ir.deliverables, ...lanes],
      // With no repository at all the merge ask can only be an owner attestation.
      checks: ir.checks.map((check) => check.kind === 'github_merge' && ir.repositories.length === 0
        ? { ...check, kind: 'owner_attestation' as const } : check).filter((check) => check.kind !== 'github_merge'),
    };
    template = selectTemplate(ir);
  }
  const nodes: GraphShapeNode[] = [];
  const edges: GraphShapeEdge[] = [];
  const provenance: LoweredGraph['provenance'] = {};
  const attach = (key: string, obligationKeys: string[], spans: Span[]) => {
    provenance[key] = { obligation_keys: obligationKeys, spans };
  };
  const dependencyEdges = () => {
    const keys = new Set(nodes.map((node) => node.key));
    for (const rule of ir.ordering) {
      if (!keys.has(rule.before)) continue;
      for (const after of rule.after) if (keys.has(after)) edges.push({ from: rule.before, to: after, kind: 'depends_on' });
    }
  };

  if (template === 'merge_gate') {
    const gate = ir.checks.find((check) => check.kind === 'github_merge')!;
    const target = Math.max(1, opts.matchedPullRequests ?? 1);
    const scope = ir.repositories.map((entry) => entry.id).join(', ');
    nodes.push({
      key: 'prs_in_scope', title: 'PRs in scope',
      description: 'Exact retained GitHub pull requests governed by this outcome.',
      kind: 'input_set', policy: 'required', cardinality: { mode: 'dynamic', target },
      predicate: { op: 'observation_count', min_count: 1 }, evaluator: 'ctx.input-membership', evaluator_version: '1',
    }, {
      key: 'all_prs_merged', title: bounded(ir.title, TITLE_MAX),
      description: bounded(`${scope ? `Repository: ${scope}\n` : ''}GitHub merge state is the evidence for every retained pull request in scope.`, DESCRIPTION_MAX),
      kind: 'verification_gate', policy: 'required', cardinality: { mode: 'exact', target },
      predicate: {
        op: 'observation_count', observation_kind: 'verification_receipt', min_count: target,
        matches: [
          { path: 'verifier', operator: 'eq', value: 'github.pull_request.merged' },
          { path: 'passed', operator: 'eq', value: true },
        ],
      },
      evaluator: 'ctx.github-merge-verifier', evaluator_version: '1',
    });
    attach('prs_in_scope', ['github_merge'], gate.provenance);
    attach('all_prs_merged', ['github_merge'], gate.provenance);
  } else if (template === 'owner_checklist') {
    let previous: string | null = null;
    const used = new Set<string>();
    ir.checks.filter((check) => check.kind === 'owner_attestation').forEach((check, index) => {
      const text = check.provenance[0]?.text ?? `Owner confirmation ${index + 1}`;
      let key = `step_${index + 1}`;
      while (used.has(key)) key = `${key}_x`;
      used.add(key);
      nodes.push({
        key, title: bounded(text, TITLE_MAX),
        description: 'No first-class connector yet — you confirm it while signed in.',
        kind: 'action', policy: 'required', cardinality: { mode: 'exact', target: 1 },
        predicate: { op: 'manual_confirmation' }, evaluator: 'ctx.manual-attestation', evaluator_version: '1',
      });
      attach(key, [`owner_attestation:${index}`], check.provenance);
      if (previous) edges.push({ from: key, to: previous, kind: 'depends_on' });
      previous = key;
    });
    if (nodes.length === 0) {
      nodes.push({
        key: 'step_1', title: bounded(ir.title, TITLE_MAX),
        description: 'No first-class connector yet — you confirm it while signed in.',
        kind: 'action', policy: 'required', cardinality: { mode: 'exact', target: 1 },
        predicate: { op: 'manual_confirmation' }, evaluator: 'ctx.manual-attestation', evaluator_version: '1',
      });
      attach('step_1', [], ir.questions.flatMap((question) => question.provenance));
    }
  } else {
    // single_repo_delivery, multi_repo_join, report_only, research_plan_handoff
    const lanes = ir.deliverables.filter((entry) => LANE_KINDS.has(entry.kind) || entry.kind === 'document' || entry.kind === 'message');
    const gate = receiptGate(ir, lanes.filter((entry) => !ir.ordering.some((rule) => rule.before === entry.key && rule.after.length >= 2)));
    for (const deliverable of lanes) {
      nodes.push(laneNode(deliverable, deliverable.key === gate.key ? gate.receipts : []));
      attach(deliverable.key, [deliverable.key, ...(deliverable.key === gate.key ? gate.receipts : [])], deliverable.provenance);
    }
    dependencyEdges();
    if (template === 'multi_repo_join' && ir.join_requested) {
      const laneKeys = lanes.filter((entry) => !ir.ordering.some((rule) => rule.before === entry.key)).map((entry) => entry.key);
      const hasJoinDeliverable = ir.ordering.some((rule) => rule.after.length >= 2 && laneKeys.every((key) => rule.after.includes(key)));
      if (!hasJoinDeliverable && laneKeys.length >= 2) {
        nodes.push({
          key: 'all_lanes_accepted', title: 'All lanes accepted',
          description: 'CTX joins the independent lanes only after every retained deliverable exists.',
          kind: 'verification_gate', policy: 'required', cardinality: { mode: 'exact', target: laneKeys.length },
          predicate: { op: 'dependencies_satisfied' }, evaluator: 'ctx.declarative', evaluator_version: '1',
        });
        attach('all_lanes_accepted', laneKeys, []);
        for (const key of laneKeys) edges.push({ from: 'all_lanes_accepted', to: key, kind: 'depends_on' });
      }
    }
    // Owner attestations that survived in a software prompt are not lowered
    // (invariant 1): they are reported as coverage questions instead.
  }

  return { template, nodes, edges, provenance, coverage: coverageDiagnostics(ir, nodes, edges, opts) };
}

/**
 * Semantic coverage against the IR: every repository bound, every requested
 * join reaching every lane, every question answered.
 */
export function coverageDiagnostics(
  ir: ObligationIR, nodes: GraphShapeNode[], edges: GraphShapeEdge[], opts: Pick<LoweringOptions, 'answeredQuestions'> = {},
): CompletionGraphDiagnostic[] {
  const diagnostics: CompletionGraphDiagnostic[] = [];
  const laneKeys = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.kind === 'input_set') continue;
    const bound = node.description.match(/^Repository:\s*(.+)$/m)?.[1] ?? '';
    for (const repository of bound.toLowerCase().split(/,\s*/).filter(Boolean)) {
      laneKeys.set(repository, [...(laneKeys.get(repository) ?? []), node.key]);
    }
  }
  for (const repository of ir.repositories) {
    if (!laneKeys.has(repository.id.toLowerCase())) diagnostics.push({
      severity: 'error', code: 'obligation_uncovered', path: ['prompt'], message: `repository ${repository.id} has no bound lane`,
    });
  }
  if (ir.repositories.length >= 2 && ir.join_requested && diagnostics.length === 0) {
    const dependencies = new Map<string, string[]>();
    for (const edge of edges) dependencies.set(edge.from, [...(dependencies.get(edge.from) ?? []), edge.to]);
    const reach = (key: string, seen = new Set<string>()): Set<string> => {
      for (const next of dependencies.get(key) ?? []) if (!seen.has(next)) { seen.add(next); reach(next, seen); }
      return seen;
    };
    const joined = nodes.some((node) => {
      const reached = reach(node.key);
      return ir.repositories.every((repository) => laneKeys.get(repository.id.toLowerCase())!.some((key) => reached.has(key)));
    });
    if (!joined) diagnostics.push({
      severity: 'error', code: 'join_uncovered', path: ['prompt'], message: 'the requested join does not depend on every repository lane',
    });
  }
  const answered = new Set(opts.answeredQuestions ?? []);
  ir.questions.forEach((question, index) => {
    if (!answered.has(index)) diagnostics.push({
      severity: 'error', code: 'questions_unresolved', path: ['questions', index], message: question.text,
    });
  });
  return diagnostics;
}
