// Deterministic explicit-obligation inventory and semantic coverage check for
// natural-language work requests. Pure; no model, no I/O.
import type { CompletionGraphLint } from './types.js';
import { normalizePrompt, type ObligationIR, type Span } from './obligation-ir.js';

// Explicit obligations extracted from the prompt before any lowering. Every
// entry must map to a node/edge or the draft is not launch-ready.
export interface WorkOutcomeObligations {
  repositories: string[];
  join_requested: boolean;
  parallel_requested: boolean;
}

const REPO_OWNER = '[A-Za-z0-9_.-]+';

const REPO_NAME = '[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const wordPattern = (word: string) => new RegExp(`(?<![\\w-])${escapeRegExp(word)}(?![\\w-])`, 'i');

export function repositoryName(repository: string) {
  return repository.slice(repository.indexOf('/') + 1);
}

// A repository segment that no other candidate repository shares, so "the CLI"
// can only mean ctx-cli when ctx and ctx-cli are the candidates.
function uniqueSegments(repository: string, all: string[]) {
  const others = new Set(all.filter((entry) => entry !== repository)
    .flatMap((entry) => repositoryName(entry).toLowerCase().split(/[-_.]/)));
  return repositoryName(repository).toLowerCase().split(/[-_.]/)
    .filter((segment) => segment.length >= 3 && !others.has(segment));
}

export function repositoryMentioned(text: string, repository: string, all: string[] = [repository]) {
  const name = repositoryName(repository);
  return text.toLowerCase().includes(repository.toLowerCase())
    || wordPattern(name).test(text)
    || uniqueSegments(repository, all).some((segment) => wordPattern(segment).test(text));
}

/**
 * Deterministic explicit-obligation inventory, computed before any model call
 * or graph lowering. Repositories are ordered by first mention.
 * ponytail: word/context matching, not NLP; add aliases here when a real prompt escapes.
 */
export function extractObligations(prompt: string, knownRepositories: string[] = []): WorkOutcomeObligations {
  const known = [...new Set(knownRepositories.map((entry) => entry.toLowerCase()))];
  const knownOwners = new Set(known.map((entry) => entry.slice(0, entry.indexOf('/'))));
  const found = new Map<string, number>();
  const add = (repository: string, index: number) => {
    const key = repository.toLowerCase().replace(/\.git$/, '');
    if (!found.has(key) || found.get(key)! > index) found.set(key, index);
  };
  for (const match of prompt.matchAll(new RegExp(`github\\.com/(${REPO_OWNER})/(${REPO_NAME})(?=[/#?\\s.,;:)]|$)`, 'gi'))) {
    add(`${match[1]}/${match[2]}`, match.index ?? 0);
  }
  for (const match of prompt.matchAll(new RegExp(`(?<![\\w./-])(${REPO_OWNER})/(${REPO_NAME})(?=#\\d+|[\\s.,;:)]|$)`, 'g'))) {
    const owner = match[1]!.toLowerCase();
    const name = match[2]!;
    if (!/[a-z]/i.test(name) || /^\d+$/.test(owner)) continue;
    // ponytail: with no retained repositories to anchor owners, only a
    // handle-shaped token counts ("and/or", "src/lib" are not repositories).
    if (knownOwners.size > 0 ? !knownOwners.has(owner) : owner.length < 4 || name.length < 3) continue;
    add(`${owner}/${name}`, match.index ?? 0);
  }
  const explicit = [...found.keys()];
  // Sibling inference: "zackproser/ctx … and ctx-cli" names a second repository
  // of the same owner without repeating the owner.
  for (const repository of explicit) {
    const [owner, name] = [repository.slice(0, repository.indexOf('/')), repositoryName(repository)];
    // A purely numeric suffix is a ticket key (CTX-263), not a repository.
    for (const match of prompt.matchAll(new RegExp(`(?<![\\w/-])(${escapeRegExp(name)}-(?=[a-z0-9-]*[a-z])[a-z0-9][a-z0-9-]*)(?![\\w/-])`, 'gi'))) {
      add(`${owner}/${match[1]}`, match.index ?? 0);
    }
  }
  // A retained repository named only by its bare name counts inside software
  // prose; "update my portfolio slide" must not bind zackproser/portfolio.
  const softwareContext = explicit.length > 0
    || /\b(?:github|repo(?:sitory)?|codebase|implement(?:ation)?|refactor|fix|build|ship|deploy(?:ment)?|release|pull requests?|PRs?|cli|server|package|code)\b/i.test(prompt);
  for (const repository of softwareContext ? known : []) {
    const name = repositoryName(repository);
    const contextual = new RegExp(
      `(?:\\b(?:in|within|inside|across)\\s+(?:the\\s+)?${escapeRegExp(name)}(?![\\w-])|(?<![\\w-])${escapeRegExp(name)}\\s+(?:server|repo(?:sitory)?|codebase|backend|service|package|project|lane))`,
      'i',
    );
    const plain = name.length >= 4 ? wordPattern(name) : null;
    const index = [contextual, plain].filter((pattern): pattern is RegExp => !!pattern)
      .map((pattern) => prompt.search(pattern)).find((position) => position >= 0);
    if (index !== undefined) add(repository, index);
  }
  // "the CLI" resolves to ctx-cli only inside an already multi-repository prompt
  // and only when no other candidate shares that segment.
  if (found.size > 0) {
    const candidates = [...new Set([...found.keys(), ...known])];
    for (const repository of known) {
      // An owner name is never a repository segment: "the workos overlay" must
      // not bind workos/workos-blog-bot-flue (production, 2026-09-03).
      for (const segment of uniqueSegments(repository, candidates).filter((entry) => !knownOwners.has(entry.toLowerCase()))) {
        const index = prompt.search(wordPattern(segment));
        if (index >= 0) add(repository, index);
      }
    }
  }
  const repositories = [...found.entries()].sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
    .map(([repository]) => repository);
  return {
    repositories,
    join_requested: /\b(?:after|once|when)\s+both\b|\bjoin(?:s|ed|ing)?\b|\b(?:end-to-end|production|final|joined)\s+proof\b|\bboth\s+deliveries\b/i.test(prompt),
    // 'independent deployment/browser verification' describes a verifier, not
    // parallel work; only bare independent(ly)/separate(ly) count.
    parallel_requested: /\bparallel\b|\bindependent(?:ly)?\b(?!\s+(?:deployment|release|browser|verification|verifiers?|review))|\bseparate(?:ly)?\b(?!\s+(?:deployment|release|browser|verification|verifiers?|review))|\b(?:both|two)\s+(?:lanes|repos(?:itories)?|implementation\s+lanes)\b/i.test(prompt),
  };
}

export function sentences(prompt: string) {
  return prompt.split(/(?<=[.;!?])\s+|\n+/).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Semantic coverage: every explicit repository needs a bound executable node;
 * a requested join needs one node whose dependencies reach every repository.
 */
export function obligationDiagnostics(
  obligations: WorkOutcomeObligations,
  nodes: Array<{ key: string; kind: string; description: string }>,
  edges: Array<{ from: string; to: string }>,
) {
  const diagnostics: CompletionGraphLint['diagnostics'] = [];
  const laneKeys = new Map<string, string[]>();
  // Any evaluable node bound to the repository covers it: an artifact lane, an
  // owner gate, or a GitHub merge gate over that repository's pull requests.
  for (const node of nodes) {
    if (node.kind === 'input_set') continue;
    const bound = node.description.match(/^Repository:\s*(.+)$/m)?.[1] ?? '';
    for (const repository of bound.toLowerCase().split(/,\s*/).filter(Boolean)) {
      laneKeys.set(repository, [...(laneKeys.get(repository) ?? []), node.key]);
    }
  }
  for (const repository of obligations.repositories) {
    if (!laneKeys.has(repository)) diagnostics.push({
      severity: 'error', code: 'obligation_uncovered', path: ['prompt'],
      message: `repository ${repository} has no bound lane`,
    });
  }
  if (obligations.repositories.length >= 2 && obligations.join_requested && diagnostics.length === 0) {
    const dependencies = new Map<string, string[]>();
    for (const edge of edges) dependencies.set(edge.from, [...(dependencies.get(edge.from) ?? []), edge.to]);
    const reach = (key: string, seen = new Set<string>()): Set<string> => {
      for (const next of dependencies.get(key) ?? []) if (!seen.has(next)) { seen.add(next); reach(next, seen); }
      return seen;
    };
    const joined = nodes.some((node) => {
      const reached = reach(node.key);
      return obligations.repositories.every((repository) =>
        laneKeys.get(repository)!.some((laneKey) => reached.has(laneKey)));
    });
    if (!joined) diagnostics.push({
      severity: 'error', code: 'join_uncovered', path: ['prompt'],
      message: 'the requested join does not depend on every repository lane',
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Obligation IR extraction (deterministic floor). Everything below is pure and
// span-attributed; the service merges a model proposal on top via
// mergeObligations and lowering.ts turns the result into a graph.
// ---------------------------------------------------------------------------

export interface SentenceSpan extends Span { index: number }

export function sentenceSpans(normalized: string): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  const pattern = /[^.;!?\n]+(?:[.;!?]+|$)/g;
  for (const match of normalized.matchAll(pattern)) {
    const raw = match[0];
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (!text) continue;
    const start = (match.index ?? 0) + leading;
    out.push({ start, end: start + text.length, text, index: out.length });
  }
  return out;
}

const spanOf = (sentence: SentenceSpan): Span => ({ start: sentence.start, end: sentence.end, text: sentence.text });

// Remove explicit negative requirement tails before looking for positive
// automation intent ("do not deploy" must never select a deployment receipt).
export function positiveIntentText(text: string) {
  return text.replace(/\b(?:do\s+not|don't|never|without|there\s+(?:is|are)\s+no|no)\b[^.;\n]{0,180}/gi, '');
}

const DEPLOYMENT = [
  /\bdeploy(?:ed|ing|ment|s)?\b/i,
  /\bpublish(?:ed|ing|es)?\b[^.;\n]{0,80}\b(?:release|site|app|application)\b/i,
  /\b(?:release|deployment)\b[^.;\n]{0,40}\b(?:live|deployed|published)\b/i,
];
const BROWSER_SUBJECT = '(?:browser|ui|frontend|desktop|phone|mobile|responsive|console|overflow|page)';
const BROWSER = [
  new RegExp(`\\b(?:verify|test|inspect|check|perform|require(?:d|s|ing)?)\\b[^.;\\n]{0,140}\\b${BROWSER_SUBJECT}\\b`, 'i'),
  new RegExp(`\\b${BROWSER_SUBJECT}\\b[^.;\\n]{0,100}\\b(?:verified|tested|checked|passes?|receipt)\\b`, 'i'),
  /\bauthenticated\b[^.;\n]{0,80}\b(?:browser|desktop|phone|mobile)\b[^.;\n]{0,80}\bverification\b/i,
  /\bindependent\s+(?:browser\s+)?smoke[- ]test\s+receipt\b/i,
];
export const AUTHORITY_ACTION = /\b(?:owners?|humans?|users?|decid(?:e|es|ed|ing)|decisions?|review(?:s|ed|ing|ers?)?|accept(?:s|ed|ing|ance)?|confirm(?:s|ed|ing|ation)?|approv(?:e|es|ed|ing|al)|sign(?:s|ed|ing)?[- ]?off|attest(?:s|ed|ing|ation)?|uat|user test|provision(?:s|ed|ing)?|calls?|meetings?|managers?|customers?|stakeholders?)\b/i;
export const EXTERNAL_CHANNEL = /\b(?:email|slack|notion|discord|teams|sms|text message)\b/i;
const DELIVERABLE_WORD = /\b(?:deploy(?:ed|ment)?|publish(?:ed)?|repository|repo|artifact|document|deliverable|output|file|build|report|plan|brief|summary|markdown)\b/i;
const RELEASE_WORD = /\b(?:deploy|deployed|deployment|production|release)\b/i;
const SOFTWARE_WORD = /\b(?:github\.com|repository|repo|code|implement|implementation|fix|build|cli|web\s*app|frontend|pull requests?|prs?|commit)\b/i;

const keyFrom = (value: string) => {
  const stem = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36);
  return /^[a-z]/.test(stem) ? stem : `k_${stem || 'x'}`;
};
const unique = (base: string, used: Set<string>) => {
  let key = base; let n = 2;
  while (used.has(key)) { key = `${base.slice(0, 36)}_${n}`; n += 1; }
  used.add(key); return key;
};
const bounded = (value: string, max: number) => {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
};
const mentionSpan = (normalized: string, repository: string, all: string[]): Span => {
  const name = repositoryName(repository);
  const candidates = [repository, name, ...uniqueSegments(repository, all)];
  for (const candidate of candidates) {
    const index = normalized.toLowerCase().indexOf(candidate.toLowerCase());
    if (index >= 0) return { start: index, end: index + candidate.length, text: normalized.slice(index, index + candidate.length) };
  }
  return { start: 0, end: Math.min(normalized.length, 1), text: normalized.slice(0, 1) };
};

/**
 * Deterministic obligation inventory with provenance. This is the floor a
 * model proposal is merged onto; it never invents authority and never lowers.
 * ponytail: word/context heuristics, not NLP — add cases to the corpus first.
 */
export function extractObligationIR(prompt: string, knownRepositories: string[] = []): ObligationIR {
  const normalized = normalizePrompt(prompt);
  // Stricter than extractObligations: a retained repository binds only when the
  // prompt names it explicitly (owner/repo or github URL) or contains its FULL
  // name (after the slash, ≥4 chars) as a whole word — never an owner segment
  // or a short fragment ("the workos overlays" must not bind
  // workos/workos-blog-bot-flue; production 2026-09-03).
  const explicitPattern = new RegExp(`github\\.com/${REPO_OWNER}/${REPO_NAME}|(?<![\\w./-])${REPO_OWNER}/${REPO_NAME}(?=#\\d+|[\\s.,;:)]|$)`, 'gi');
  const explicit = new Set([...normalized.matchAll(explicitPattern)].map((match) => match[0].replace(/^.*github\.com\//i, '').toLowerCase().replace(/\.git$/, '')));
  const flatAll = extractObligations(normalized, knownRepositories);
  const flat = {
    ...flatAll,
    repositories: flatAll.repositories.filter((repository) => {
      if (explicit.has(repository.toLowerCase())) return true;
      const name = repositoryName(repository);
      return name.length >= 4 && wordPattern(name).test(normalized);
    }),
  };
  const sentences = sentenceSpans(normalized);
  const positive = positiveIntentText(normalized);
  const used = new Set<string>();
  const firstLine = normalized.split('\n').map((line) => line.trim()).find(Boolean) ?? normalized;
  const title = bounded(firstLine.replace(/^(?:repository|repo|issue)\s*:?\s*\S+\s*/i, '') || firstLine, 90);

  const repositoryIds = flat.repositories;
  const mentioning = (repository: string) => sentences.filter((sentence) =>
    repositoryMentioned(sentence.text, repository, repositoryIds));
  const repositories = repositoryIds.map((id) => {
    const sentencesFor = mentioning(id);
    const scope = repositoryIds.length === 1 ? sentences : sentencesFor;
    const deployable = scope.some((sentence) => RELEASE_WORD.test(positiveIntentText(sentence.text)));
    return {
      id, role: deployable ? 'deployable' as const : 'unknown' as const,
      provenance: sentencesFor.length ? sentencesFor.map(spanOf) : [mentionSpan(normalized, id, repositoryIds)],
    };
  });

  const deliverables: ObligationIR['deliverables'] = [];
  const checks: ObligationIR['checks'] = [];
  const ordering: ObligationIR['ordering'] = [];
  const questions: ObligationIR['questions'] = [];

  const receiptSentences = (patterns: RegExp[]) => sentences.filter((sentence) =>
    patterns.some((pattern) => pattern.test(positiveIntentText(sentence.text))));
  const deployableTarget = repositories.find((entry) => entry.role === 'deployable')?.id ?? repositories[0]?.id ?? null;
  const deploymentSentences = receiptSentences(DEPLOYMENT);
  const browserSentences = receiptSentences(BROWSER);
  if (deploymentSentences.length) checks.push({ kind: 'deployment_release', target: deployableTarget, provenance: deploymentSentences.map(spanOf) });
  if (browserSentences.length) checks.push({ kind: 'browser_smoke', target: deployableTarget, provenance: browserSentences.map(spanOf) });

  const mergeSentences = sentences.filter((sentence) => {
    const text = positiveIntentText(sentence.text);
    return /\b(?:prs?|pull requests?)\b/i.test(text) && /\bmerge(?:d|s)?\b/i.test(text);
  });
  const mergeGate = mergeSentences.length > 0 && /\b(?:#\d+|prs?\s+\d+|\/pull\/\d+)/i.test(normalized);
  if (mergeGate) checks.push({ kind: 'github_merge', target: deployableTarget, provenance: mergeSentences.map(spanOf) });

  const dualHarness = /\bcodex\b/i.test(normalized) && /\bclaude\b/i.test(normalized) && flat.parallel_requested;
  const software = repositoryIds.length > 0 || SOFTWARE_WORD.test(normalized);

  if (dualHarness && repositoryIds.length < 2) {
    for (const harness of ['codex', 'claude'] as const) {
      const sentence = sentences.find((entry) => new RegExp(`\\b${harness}\\b`, 'i').test(entry.text)) ?? sentences[0]!;
      deliverables.push({
        key: unique(`${harness}_lane`, used), kind: 'artifact', repository: null,
        summary: bounded(`Retain the exact deliverable produced by the ${harness} implementation lane.`, 300),
        provenance: [spanOf(sentence)],
      });
    }
  } else if (repositoryIds.length > 0 && !mergeGate) {
    // The repository binding is the software signal: one delivery lane per repo.
    for (const repository of repositoryIds) {
      const scoped = repositoryIds.length === 1 ? sentences : mentioning(repository);
      const spans = scoped.length ? scoped : sentences.slice(0, 1);
      deliverables.push({
        key: unique(`lane_${keyFrom(repositoryName(repository))}`, used), kind: 'pull_request', repository,
        summary: bounded(spans.map((entry) => entry.text).join(' ') || `Deliver the ${repositoryName(repository)} changes described in this task.`, 300),
        provenance: spans.map(spanOf),
      });
    }
  } else if (!mergeGate && !software) {
    // Non-software prose: classify each clause; unknown clauses become questions.
    let previous: string | null = null;
    for (const sentence of sentences) {
      for (const clauseText of clauseTexts(sentence.text)) {
        const at = normalized.indexOf(clauseText, sentence.start);
        const span: Span = at >= 0 ? { start: at, end: at + clauseText.length, text: clauseText } : spanOf(sentence);
        // "CTX alone decides completion" / "report-only" state the custody
        // contract; they are neither owner actions nor open questions.
        if (/\bctx\b[^.;\n]*\b(?:alone|decides?|owns?|evaluates?|completion|authority)\b/i.test(clauseText)) continue;
        if (AUTHORITY_ACTION.test(clauseText) || EXTERNAL_CHANNEL.test(clauseText)) {
          checks.push({ kind: 'owner_attestation', target: null, provenance: [span] });
        } else if (DELIVERABLE_WORD.test(clauseText)) {
          const key = unique(keyFrom(clauseText), used);
          deliverables.push({
            key, kind: /\bdeploy/i.test(clauseText) ? 'deployment' : /\b(?:document|report|plan|brief|summary|markdown)\b/i.test(clauseText) ? 'document' : 'artifact',
            repository: null, summary: bounded(clauseText, 300), provenance: [span],
          });
          if (previous) ordering.push({ before: key, after: [previous] });
          previous = key;
        } else {
          questions.push({ text: bounded(`Unclear how to verify: “${clauseText}”`, 600), provenance: [span] });
        }
      }
    }
  } else if (!mergeGate && software && repositoryIds.length === 0 && /\b(?:plan|research)\b/i.test(normalized)
    && sentences.some((entry) => /\b(?:document|plan|brief|report)\b/i.test(entry.text))) {
    // Research → plan → implementation handoff: the plan document precedes the work.
    const planSentences = sentences.filter((entry) => /\b(?:document|plan|brief|report|research)\b/i.test(entry.text));
    const workSentences = sentences.filter((entry) => /\b(?:implement|build|ship|deliver|fix)\b/i.test(entry.text));
    const plan = unique('plan_document', used);
    deliverables.push({
      key: plan, kind: 'document', repository: null,
      summary: bounded(planSentences.map((entry) => entry.text).join(' ') || 'Plan document retained.', 300),
      provenance: planSentences.map(spanOf),
    });
    const work = unique('implementation', used);
    deliverables.push({
      key: work, kind: 'artifact', repository: null,
      summary: bounded(workSentences.map((entry) => entry.text).join(' ') || 'Implementation deliverable retained.', 300),
      provenance: (workSentences.length ? workSentences : planSentences).map(spanOf),
    });
    ordering.push({ before: work, after: [plan] });
  } else if (!mergeGate && software && repositoryIds.length === 0) {
    // Software prose without a named repository: one unbound delivery lane.
    deliverables.push({
      key: unique('implementation', used), kind: 'pull_request', repository: null,
      summary: bounded(sentences.map((entry) => entry.text).join(' ') || normalized, 300),
      provenance: sentences.length ? sentences.map(spanOf) : [{ start: 0, end: normalized.length, text: normalized }],
    });
  }

  const laneKeys = deliverables.filter((entry) => ['pull_request', 'artifact', 'commit'].includes(entry.kind) && !ordering.some((rule) => rule.before === entry.key)).map((entry) => entry.key);
  if ((flat.join_requested || dualHarness) && laneKeys.length >= 2) {
    const joinSentences = sentences.filter((entry) => /\bjoin|\bproof\b|\bboth\b/i.test(entry.text));
    const key = unique('joined_proof', used);
    deliverables.push({
      key, kind: 'artifact', repository: null,
      summary: bounded(joinSentences.map((entry) => entry.text).join(' ') || 'Report the downstream proof only after every lane is satisfied.', 300),
      provenance: (joinSentences.length ? joinSentences : sentences.slice(0, 1)).map(spanOf),
    });
    ordering.push({ before: key, after: laneKeys });
  }

  return {
    contract: 'ctx.work-obligation-ir.v1', title, repositories, deliverables, checks, ordering,
    join_requested: flat.join_requested || dualHarness, parallel_requested: flat.parallel_requested,
    questions, source: 'deterministic',
  };
}

function clauseTexts(sentence: string) {
  const body = sentence.replace(/[.!?;]+$/, '');
  const afterOnce = body.match(/^(.*?)\s+(?:once|when)\s+(.+)$/i)?.[2] ?? body;
  return afterOnce.split(/\s*,\s*(?:and\s+)?|\s+and\s+(?=(?:it(?:'s| is)|the|uat|review|finish|have|send|email|deploy|publish)\b)/i)
    .map((entry) => entry.trim().replace(/^and\s+/i, '').replace(/^it(?:'s| is)\s+/i, '')).filter(Boolean).slice(0, 12);
}

/**
 * Deterministic facts are the floor: everything the extractor found stays;
 * the model may add deliverables/checks/ordering/questions and refine roles
 * and summaries. Unknown model repositories are dropped — a model never
 * introduces a repository the operator did not name.
 */
export function mergeObligations(deterministic: ObligationIR, model: ObligationIR | null): ObligationIR {
  if (!model) return deterministic;
  const repositories = deterministic.repositories.map((entry) => {
    const proposed = model.repositories.find((candidate) => candidate.id.toLowerCase() === entry.id.toLowerCase());
    return proposed
      ? { ...entry, role: entry.role === 'unknown' ? proposed.role : entry.role, provenance: [...entry.provenance, ...proposed.provenance] }
      : entry;
  });
  const known = new Set(repositories.map((entry) => entry.id.toLowerCase()));
  const deliverables = [...deterministic.deliverables];
  const keys = new Set(deliverables.map((entry) => entry.key));
  for (const proposed of model.deliverables) {
    if (proposed.repository && !known.has(proposed.repository.toLowerCase())) continue;
    const existing = deliverables.find((entry) => entry.key === proposed.key
      || (entry.repository && entry.repository.toLowerCase() === proposed.repository?.toLowerCase() && entry.kind === proposed.kind));
    if (existing) { existing.provenance = [...existing.provenance, ...proposed.provenance]; if (existing.summary.length < proposed.summary.length) existing.summary = proposed.summary; continue; }
    if (keys.has(proposed.key)) continue;
    keys.add(proposed.key); deliverables.push(proposed);
  }
  const checks = [...deterministic.checks];
  for (const proposed of model.checks) {
    if (proposed.target && !keys.has(proposed.target) && !known.has(proposed.target.toLowerCase())) continue;
    if (!checks.some((entry) => entry.kind === proposed.kind && (entry.target ?? '') === (proposed.target ?? ''))) checks.push(proposed);
  }
  const ordering = [...deterministic.ordering];
  for (const rule of model.ordering) {
    if (!keys.has(rule.before) || !rule.after.every((key) => keys.has(key))) continue;
    if (!ordering.some((entry) => entry.before === rule.before)) ordering.push(rule);
  }
  return {
    ...deterministic, repositories, deliverables, checks, ordering,
    join_requested: deterministic.join_requested || model.join_requested,
    parallel_requested: deterministic.parallel_requested || model.parallel_requested,
    questions: [...deterministic.questions, ...model.questions.filter((entry) => !deterministic.questions.some((known) => known.text === entry.text))],
    source: 'merged',
  };
}
