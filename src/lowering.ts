// Templated lowering: ObligationIR → completion graph shape. This is the ONLY
// place predicates and evaluators are written. Output is byte-stable for a
// given IR (deterministic keys, insertion order derived from the IR).
// Contract: ctx.work-shape.v1.
import type { ObligationIR, Span } from './obligation-ir.js';
import { ORDER_WORDS } from './obligations.js';
import type { CompletionGraphDiagnostic, GraphShapeEdge, GraphShapeNode } from './types.js';

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
  github_checks: 'ctx.github-ci-verifier',
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

// The first sentence that says something ("Two deliverables." is a preamble).
function laneTitle(summary: string) {
  const parts = summary.split(/(?<=[.;!?])\s+/).filter(Boolean);
  return parts.find((part) => part.split(/\s+/).length >= 4) ?? parts[0] ?? '';
}

function laneNode(
  deliverable: ObligationIR['deliverables'][number], receipts: string[],
): GraphShapeNode {
  const body = deliverable.summary || 'A retained run artifact or connected harness receipt must be reported.';
  const receiptDetail = receipts.length
    ? ` CTX also requires independent ${receipts.map((id) => id === RECEIPT_ID.github_checks ? 'GitHub PR and CI' : id === RECEIPT_ID.browser_smoke ? 'browser smoke' : 'deployment release').join(' and ')} receipts.`
    : '';
  return {
    key: deliverable.key,
    title: bounded(laneTitle(deliverable.summary) || deliverable.key, TITLE_MAX),
    description: bounded(`${deliverable.repository ? `Repository: ${deliverable.repository}\n` : ''}${body}${receiptDetail}`, DESCRIPTION_MAX),
    kind: 'artifact_requirement', policy: 'required',
    cardinality: { mode: 'at_least', target: 1 },
    predicate: receipts.length ? { op: 'all', conditions: [ARTIFACT_PREDICATE, ...receipts.map(receiptPredicate)] } : ARTIFACT_PREDICATE,
    evaluator: receipts.length ? 'ctx.declarative' : 'ctx.work-run-artifact', evaluator_version: '1',
  };
}

function receiptLanes(ir: ObligationIR): ObligationIR['deliverables'] {
  return ir.deliverables.filter(entry => (LANE_KINDS.has(entry.kind) || entry.kind === 'document' || entry.kind === 'message')
    && !ir.ordering.some(rule => rule.before === entry.key && rule.after.length >= 2)
    && !(entry.repository === null && ir.checks.some(check => check.kind === 'owner_attestation' && check.target === entry.key)));
}

// The check's explicit target owns custody. Model role labels, wording and
// repository order cannot redirect a requirement to a different executor.
function receiptTarget(check: ObligationIR['checks'][number], lanes: ObligationIR['deliverables']): string | null {
  const matches = check.target === null ? lanes : lanes.filter(lane =>
    lane.key === check.target || lane.repository?.toLowerCase() === check.target!.toLowerCase());
  return matches.length === 1 ? matches[0]!.key : null;
}

function receiptGates(ir: ObligationIR): Map<string, string[]> {
  const gates = new Map<string, string[]>();
  const lanes = receiptLanes(ir);
  for (const check of ir.checks) {
    if (check.kind !== 'deployment_release' && check.kind !== 'browser_smoke') continue;
    const key = receiptTarget(check, lanes);
    if (key === null) continue; // Coverage reports unresolved or ambiguous custody.
    gates.set(key, [...new Set([...(gates.get(key) ?? []), RECEIPT_ID[check.kind]])]);
  }
  return gates;
}

function requiresReceipt(predicate: Record<string, unknown>, verifier: string): boolean {
  if (predicate.op === 'all' && Array.isArray(predicate.conditions)) {
    return predicate.conditions.some(condition => condition && typeof condition === 'object'
      && requiresReceipt(condition as Record<string, unknown>, verifier));
  }
  if (predicate.op !== 'observation_count' || predicate.observation_kind !== 'verification_receipt'
    || typeof predicate.min_count !== 'number' || predicate.min_count < 1 || !Array.isArray(predicate.matches)) return false;
  const matches = predicate.matches.filter(match => match && typeof match === 'object') as Array<Record<string, unknown>>;
  return matches.some(match => match.path === 'verifier_id' && match.operator === 'eq' && match.value === verifier)
    && matches.some(match => match.path === 'passed' && match.operator === 'eq' && match.value === true);
}

export function lowerObligations(ir: ObligationIR, opts: LoweringOptions): LoweredGraph {
  let template = opts.template ?? selectTemplate(ir);
  const notes: CompletionGraphDiagnostic[] = [];
  // A merge gate without retained pull requests has nothing to verify against;
  // fall back to the shape the rest of the IR describes and say so.
  if (template === 'merge_gate' && !opts.hasGithubResources) {
    notes.push({ severity: 'warning', code: 'merge_gate_degraded', path: ['prompt'],
      message: 'no retained PRs matched; delivering instead of gating' });
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
    // Steps are parallel unless the prompt orders them ("first …, then …").
    const steps = ir.checks.filter((check) => check.kind === 'owner_attestation');
    const sequential = steps.some((check) => check.provenance.some((span) => ORDER_WORDS.test(span.text)));
    let previous: string | null = null;
    const used = new Set<string>();
    steps.forEach((check, index) => {
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
      if (previous && sequential) edges.push({ from: key, to: previous, kind: 'depends_on' });
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
    const gates = receiptGates(ir);
    for (const deliverable of lanes) {
      // An owner-attested deliverable that lands in no repository ("the runbook
      // … is attested by the owner") is confirmed by the owner, not by a run
      // artifact. Repository-bound lanes never lower to attestations (invariant 1).
      const attested = deliverable.repository === null
        && ir.checks.find((check) => check.kind === 'owner_attestation' && check.target === deliverable.key);
      if (attested) {
        const lane = laneNode(deliverable, []);
        nodes.push({
          ...lane, description: bounded(`${deliverable.summary}\nYou confirm this deliverable while signed in.`, DESCRIPTION_MAX),
          cardinality: { mode: 'exact', target: 1 },
          predicate: { op: 'manual_confirmation' }, evaluator: 'ctx.manual-attestation',
        });
        attach(deliverable.key, [deliverable.key, 'owner_attestation'], [...deliverable.provenance, ...attested.provenance]);
        continue;
      }
      const ci = ir.checks.some((check) => check.kind === 'github_checks'
        && (check.target === deliverable.repository || check.target === deliverable.key));
      const receipts = [...(gates.get(deliverable.key) ?? []), ...(ci ? [RECEIPT_ID.github_checks] : [])];
      nodes.push(laneNode(deliverable, receipts));
      attach(deliverable.key, [deliverable.key, ...receipts], deliverable.provenance);
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
    // Any other owner attestation in a software prompt (a reviewed PR, a
    // "users decide" aside) is not lowered: repository lanes stay artifact-verified.
  }

  return { template, nodes, edges, provenance, coverage: [...notes, ...coverageDiagnostics(ir, nodes, edges, opts)] };
}

/**
 * Semantic coverage against the IR: every repository bound, every requested
 * join reaching every lane, every question answered.
 */
export function coverageDiagnostics(
  ir: ObligationIR, nodes: GraphShapeNode[], edges: GraphShapeEdge[], opts: Pick<LoweringOptions, 'answeredQuestions'> = {},
): CompletionGraphDiagnostic[] {
  const diagnostics: CompletionGraphDiagnostic[] = [];
  const eligible = receiptLanes(ir);
  for (const check of ir.checks) {
    if (check.kind !== 'deployment_release' && check.kind !== 'browser_smoke') continue;
    const key = receiptTarget(check, eligible);
    const node = nodes.find(candidate => candidate.key === key);
    if (!node || !requiresReceipt(node.predicate, RECEIPT_ID[check.kind])) diagnostics.push({
      severity: 'error', code: 'receipt_obligation_uncovered', path: ['prompt'],
      message: `${check.kind} requires one eligible delivery lane for ${check.target ?? 'its unspecified target'} and an independent passing receipt on that lane.`,
    });
  }
  for (const check of ir.checks.filter((entry) => entry.kind === 'github_checks')) {
    const covered = check.target && nodes.some((node) =>
      (node.key === check.target || node.description.startsWith(`Repository: ${check.target}\n`))
      && JSON.stringify(node.predicate).includes(RECEIPT_ID.github_checks));
    if (!covered) diagnostics.push({ severity: 'error', code: 'ci_obligation_uncovered', path: ['prompt'],
      message: 'Green CI requires a repository-bound delivery lane with independent GitHub checks.' });
  }
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
  // A join lane bound to no repository has no executor lane producing its
  // artifact; unless the owner attests it, say so before launch.
  for (const rule of ir.ordering.filter((entry) => entry.after.length >= 2)) {
    const join = ir.deliverables.find((entry) => entry.key === rule.before);
    if (!join || join.kind !== 'artifact' || join.repository !== null) continue;
    if (ir.checks.some((check) => check.kind === 'owner_attestation' && check.target === join.key)) continue;
    if (!nodes.some((node) => node.key === join.key && node.kind === 'artifact_requirement')) continue;
    diagnostics.push({
      severity: 'warning', code: 'join_without_executor', path: ['nodes', nodes.findIndex((node) => node.key === join.key)],
      message: `join lane ${join.key} is an artifact requirement bound to no repository: no executor lane produces it and no owner attestation is declared`,
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
