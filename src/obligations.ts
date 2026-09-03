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

// A dot followed by a word character continues the token: "ctx.zackproser.com"
// does not mention the ctx repository (round 2, 2026-09-03).
const wordPattern = (word: string) => new RegExp(`(?<![\\w-])${escapeRegExp(word)}(?![\\w-]|\\.\\w)`, 'i');

// "in ctx", "of ctx", "the ctx server": a bare repository name in a position
// only a repository occupies. This is what lets a 3-letter name bind.
const contextualPattern = (name: string) => new RegExp(
  `(?:\\b(?:in|within|inside|across|of)\\s+(?:the\\s+)?${escapeRegExp(name)}(?![\\w-]|\\.\\w)|(?<![\\w-])${escapeRegExp(name)}\\s+(?:server|repo(?:sitory)?|codebase|backend|service|package|project|lane))`,
  'i',
);

// "config/packages.lock.json", "docs/runbook.md", "src/lib" are paths, not
// repositories, however owner/name-shaped they look (production 2026-09-03).
const PATH_OWNERS = new Set(['src', 'lib', 'app', 'apps', 'docs', 'doc', 'config', 'configs', 'test', 'tests', 'spec', 'scripts', 'bin', 'dist', 'build', 'public', 'static', 'assets', 'packages', 'node_modules', 'ui', 'api', 'internal', 'cmd', 'pkg', 'etc', 'var', 'tmp', 'usr', 'home']);
const FILE_EXTENSION = /\.(?:json|md|mdx|txt|ya?ml|toml|lock|ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|sh|css|scss|html|sql|env|csv|xml|ini|cfg)$/i;
export function looksLikePath(owner: string, name: string) {
  return PATH_OWNERS.has(owner.toLowerCase()) || FILE_EXTENSION.test(name);
}

export function repositoryName(repository: string) {
  return repository.slice(repository.indexOf('/') + 1);
}

function editDistance(a: string, b: string) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return rows[a.length]![b.length]!;
}

// "zackproser/ctx-clii" is a typo for the retained zackproser/ctx-cli, not a
// new repository. ponytail: edit distance ≤ 2 on names ≥ 5 chars, same owner,
// one unambiguous candidate; loosen only with a corpus case.
export function snapToKnown(repository: string, known: string[]) {
  if (known.includes(repository)) return repository;
  const owner = repository.slice(0, repository.indexOf('/'));
  const name = repositoryName(repository);
  if (name.length < 5) return repository;
  const candidates = known.filter((entry) => entry.startsWith(`${owner}/`)
    && repositoryName(entry).length >= 5 && editDistance(name, repositoryName(entry)) <= 2);
  return candidates.length === 1 ? candidates[0]! : repository;
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
    const key = snapToKnown(repository.toLowerCase().replace(/\.git$/, ''), known);
    if (!found.has(key) || found.get(key)! > index) found.set(key, index);
  };
  for (const match of prompt.matchAll(new RegExp(`github\\.com/(${REPO_OWNER})/(${REPO_NAME})(?=[/#?\\s.,;:)]|$)`, 'gi'))) {
    add(`${match[1]}/${match[2]}`, match.index ?? 0);
  }
  for (const match of prompt.matchAll(new RegExp(`(?<![\\w./-])(${REPO_OWNER})/(${REPO_NAME})(?=#\\d+|[\\s.,;:)]|$)`, 'g'))) {
    const owner = match[1]!.toLowerCase();
    const name = match[2]!;
    if (!/[a-z]/i.test(name) || /^\d+$/.test(owner) || looksLikePath(owner, name)) continue;
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
    const plain = name.length >= 4 ? wordPattern(name) : null;
    const index = [contextualPattern(name), plain].filter((pattern): pattern is RegExp => !!pattern)
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

// Every line is a sentence boundary and a list marker ("- ", "1. ", "2) ") is
// layout, never a sentence of its own: "1. book dentist" is the chore "book
// dentist" (round 2, 2026-09-03).
const LIST_MARKER = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;
export function sentenceSpans(normalized: string): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  // A terminator followed by a non-space is part of a token (config/packages.lock.json, e.g., v1.2).
  const pattern = /(?:[^.;!?\n]|[.;!?](?=\S))+(?:[.;!?]+|$)/g;
  let offset = 0;
  for (const line of normalized.split('\n')) {
    const marker = line.match(LIST_MARKER)?.[0].length ?? 0;
    for (const match of line.slice(marker).matchAll(pattern)) {
      const raw = match[0];
      const leading = raw.length - raw.trimStart().length;
      const text = raw.trim();
      if (!text) continue;
      const start = offset + marker + (match.index ?? 0) + leading;
      out.push({ start, end: start + text.length, text, index: out.length });
    }
    offset += line.length + 1;
  }
  return out;
}

const spanOf = (sentence: Span): Span => ({ start: sentence.start, end: sentence.end, text: sentence.text });
const overlapping = (a: Span, b: Span) => a.start < b.end && b.start < a.end && a.end > a.start && b.end > b.start;

// Remove explicit negative requirement tails before looking for positive
// automation intent ("do not deploy" must never select a deployment receipt).
// The owner's own first-person actions ("I'll deploy myself", "I review and
// merge") are not asks to CTX either.
export function positiveIntentText(text: string) {
  return text
    .replace(/\b(?:do\s+not|don't|never|without|there\s+(?:is|are)\s+no|no|does\s+not|doesn't|is\s+not|isn't|will\s+not|won't|not\s+in)\b[^.;\n]{0,180}/gi, '')
    .replace(/\b(?:I|I'll|I’ll|I\s+will|me)\s+(?:deploy|release|merge|review|ship|handle)\b[^.;\n]{0,80}/g, '')
    .replace(/\((?:by\s+)?me\)/gi, '');
}

const DEPLOYMENT = [
  /\bdeploy(?:ed|ing|ment|s)?\b/i,
  /\bpublish(?:ed|ing|es)?\b[^.;\n]{0,80}\b(?:release|site|app|application)\b/i,
  /\b(?:release|deployment)\b[^.;\n]{0,40}\b(?:live|deployed|published)\b/i,
  // "make sure it's live on prod", "get the flow live", "out on production",
  // "must be on production", "production picked it up" — deploy without the word.
  /\b(?:get|gets|put|make\s+sure|be|is|it's|are|goes?|went)\s+(?:[\w/-]+\s+){0,6}live\b|\b(?:on|to|in|out\s+on|into)\s+prod(?:uction)?\b|\bprod(?:uction)?\s+(?:picked|has\s+picked|is\s+running|reflects)\b/i,
];
// "The deploy run failed on the schema job" reports context, not an ask.
// ponytail: any failure word in the sentence suppresses its deploy receipt;
// "fix the failed deploy and redeploy" needs a second sentence.
const FAILURE_CONTEXT = /\b(?:failed|failing|failure|broke|broken|crashed|errored)\b/i;
const BROWSER_SUBJECT = '(?:browser|ui|frontend|desktop|phone|mobile|responsive|console|overflow|page|preview)';
const BROWSER = [
  new RegExp(`\\b(?:verify|test|inspect|check|confirm|perform|require(?:d|s|ing)?)\\b[^.;\\n]{0,140}\\b${BROWSER_SUBJECT}\\b`, 'i'),
  new RegExp(`\\b${BROWSER_SUBJECT}\\b[^.;\\n]{0,100}\\b(?:verified|tested|checked|passes?|receipt)\\b`, 'i'),
  /\bauthenticated\b[^.;\n]{0,80}\b(?:browser|desktop|phone|mobile)\b[^.;\n]{0,80}\bverification\b/i,
  /\bindependent\s+(?:browser\s+)?smoke[- ]test\s+receipt\b/i,
];
export const AUTHORITY_ACTION = /\b(?:owners?|humans?|users?|decid(?:e|es|ed|ing)|decisions?|review(?:s|ed|ing|ers?)?|accept(?:s|ed|ing|ance)?|confirm(?:s|ed|ing|ation)?|approv(?:e|es|ed|ing|al)|sign(?:s|ed|ing)?[- ]?off|attest(?:s|ed|ing|ation)?|uat|user test|provision(?:s|ed|ing)?|calls?|meetings?|managers?|customers?|stakeholders?)\b/i;
export const EXTERNAL_CHANNEL = /\b(?:email|slack|notion|discord|teams|sms|text message)\b/i;
const DELIVERABLE_WORD = /\b(?:deploy(?:ed|ment)?|publish(?:ed)?|repository|repo|artifact|document|deliverable|output|file|build|report|plan|brief|summary|markdown)\b/i;
// "write an operator runbook", "produce a Markdown write-up", "write a short comparison doc", "a design note for the team"
const DOCUMENT_ASK = /\b(?:write|writes|written|produce|draft|author|create|prepare|compose)\b[^.;\n]{0,60}?\b(runbooks?|reports?|write-?ups?|documents?|documentation|docs?|briefs?|plans?|summar(?:y|ies)|guides?|playbooks?|postmortems?|memos?|notes?|adrs?)\b|\b(?:a|an|the|one)\s+(?:[\w-]+\s+){0,2}(runbook|report|write-?up|playbook|postmortem|memo|guide|note)\b\s*(?:\(|for\b|describing|explaining|covering|that\b|which\b|:|on\b)/i;
// "attested by the owner", "you approve it", "owner signs off" — the attester is the signed-in owner by definition.
const ATTESTED = /\battest(?:s|ed|ation)?\b|\b(?:approv(?:e|es|ed|al)|sign(?:s|ed)?[- ]?off|accept(?:s|ed|ance)?)\b[^.;\n]{0,40}\b(?:owner|you|me|human)\b|\b(?:owner|you|human)\b[^.;\n]{0,40}\b(?:approv|sign[- ]?off|accept)/i;
// "read the code" is research, not a code change: bare "code" is not a software signal.
const SOFTWARE_WORD = /\b(?:github\.com|repository|repo|codebase|code\s+changes?|implement|implementation|fix|build|cli|web\s*app|frontend|pull requests?|prs?|commit)\b/i;
// Part of the PR lane, never a separate document: "write a summary in the PR description", "update the README".
const PR_BOUND = /\b(?:PRs?|pull requests?|commits?|README|repo(?:sitory)?|branch|changelog)\b/i;
// A non-software chore the owner does: it becomes an attested step beside the software lanes.
const CHORE_VERB = /^(?:please\s+)?(?:renew|book|call|phone|email|pay|buy|order|schedule|reschedule|cancel|register|sign\s+up|submit|mail|print|pick\s+up|drop\s+off)\b/i;
// "read src/x.ts to find out" is part of writing the report, not an owner chore.
const INVESTIGATE = /\b(?:read|look\s+at|investigate|research|find\s+out|analy[sz]e|compare|dig\s+into|trace)\b/i;
// A join lane is a real artifact only when the prompt names a proof; "done when
// both are open" is a gate, not a deliverable.
const PROOF_WORD = /\b(?:proof|e2e|end-to-end|report|demo|smoke)\b/i;
// "First …, then …": the only signal that owner steps are sequential.
export const ORDER_WORDS = /\b(?:first|then|after|before|once|next|finally|afterwards|following|later|last(?:ly)?)\b/i;

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

// One sentence, several asks: "Renew the domain, then fix the cron in ctx and
// open a PR" / "a PR …, and write a design note" / "…; separately, write …".
const CLAUSE_BREAK = /(?:\s*[,;:]\s*|\s+)(?:(?:and\s+)?then|after\s+that|separately|afterwards)\b[,:]?\s*|,\s*and\s+(?=(?:(?:a|an|one|the)\s+(?:PR|pull\s+request)|write|produce|draft|author|prepare|compose|renew|book|call|email|pay|buy|order|schedule|cancel)\b)/gi;
// A short leading label is not part of the ask: "Two things:", "What I want:".
const LABEL = /^(?:[\w'’-]+\s+){0,3}[\w'’-]+:\s*/;
export function clauseSpans(sentence: Span): Span[] {
  const out: Span[] = [];
  let cursor = 0;
  const cut = (end: number) => {
    const raw = sentence.text.slice(cursor, end);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim().replace(/[.;!?]+$/, '').trimEnd();
    if (text) out.push({ start: sentence.start + cursor + leading, end: sentence.start + cursor + leading + text.length, text });
  };
  for (const match of sentence.text.matchAll(CLAUSE_BREAK)) {
    cut(match.index ?? 0);
    cursor = (match.index ?? 0) + match[0].length;
  }
  cut(sentence.text.length);
  return out.length ? out : [spanOf(sentence)];
}
const unlabeled = (text: string) => text.replace(LABEL, '');

interface OrderRule { re: RegExp; dependent: 1 | 2; prerequisite: 1 | 2 }
// Deterministic ordering phrases. `dependent` waits for `prerequisite`.
const ORDER_RULES: OrderRule[] = [
  { re: /^(?:after|once|when)\s+(.+?)(?:,\s*(?:then\s+)?|\s+then\s+)(.+)$/i, dependent: 2, prerequisite: 1 },
  { re: /^block\s+(.+?)\s+on\s+(.+)$/i, dependent: 1, prerequisite: 2 },
  { re: /^(.+?)\s+(?:depends|is\s+blocked|blocked)\s+on\s+(.+)$/i, dependent: 1, prerequisite: 2 },
  { re: /^(.+?),?\s+(?:but\s+)?(?:only\s+)?after\s+(.+)$/i, dependent: 1, prerequisite: 2 },
  { re: /^(.+?)\s+before\s+(.+)$/i, dependent: 2, prerequisite: 1 },
  { re: /^(.+?),?\s+(?:and\s+)?then\s+(.+)$/i, dependent: 2, prerequisite: 1 },
];
const CONTINUES_PREVIOUS = /^(?:then|after\s+that|afterwards|next|finally),?\s+/i;
const JOIN_PHRASE = /\bjoin|\bproof\b|\bboth\b/i;

/**
 * Deterministic obligation inventory with provenance. This is the floor a
 * model proposal is merged onto; it never invents authority and never lowers.
 * ponytail: word/context heuristics, not NLP — add cases to the corpus first.
 */
export function extractObligationIR(prompt: string, knownRepositories: string[] = []): ObligationIR {
  const normalized = normalizePrompt(prompt);
  // Stricter than extractObligations: a retained repository binds only when the
  // prompt names it explicitly (owner/repo or github URL), contains its FULL
  // name (after the slash, ≥4 chars) as a whole word, or names a shorter one in
  // repository position ("in ctx", "of ctx, ctx-cli and pi-harness") — never
  // an owner segment or a short fragment ("the workos overlays" must not bind
  // workos/workos-blog-bot-flue; production 2026-09-03).
  const explicitPattern = new RegExp(`github\\.com/${REPO_OWNER}/${REPO_NAME}|(?<![\\w./-])${REPO_OWNER}/${REPO_NAME}(?=#\\d+|[\\s.,;:)]|$)`, 'gi');
  const known = [...new Set(knownRepositories.map((entry) => entry.toLowerCase()))];
  const explicit = new Set([...normalized.matchAll(explicitPattern)].map((match) => snapToKnown(match[0].replace(/^.*github\.com\//i, '').toLowerCase().replace(/\.git$/, ''), known)));
  const flatAll = extractObligations(normalized, knownRepositories);
  const flat = {
    ...flatAll,
    repositories: flatAll.repositories.filter((repository) => {
      if (explicit.has(repository.toLowerCase())) return true;
      const name = repositoryName(repository);
      return name.length >= 4 ? wordPattern(name).test(normalized) : contextualPattern(name).test(normalized);
    }),
  };
  const sentences = sentenceSpans(normalized);
  const positive = positiveIntentText(normalized);
  const used = new Set<string>();
  const firstLine = normalized.split('\n').map((line) => line.trim().replace(LIST_MARKER, '')).find(Boolean) ?? normalized;
  const title = bounded(firstLine.replace(/^(?:repository|repo|issue)\s*:?\s*\S+\s*/i, '') || firstLine, 90);

  const repositoryIds = flat.repositories;
  const mentions = (text: string) => repositoryIds.filter((repository) => repositoryMentioned(text, repository, repositoryIds));
  const mentioning = (repository: string) => sentences.filter((sentence) => repositoryMentioned(sentence.text, repository, repositoryIds));

  const deliverables: ObligationIR['deliverables'] = [];
  const checks: ObligationIR['checks'] = [];
  const ordering: ObligationIR['ordering'] = [];
  const questions: ObligationIR['questions'] = [];

  const receiptSentences = (patterns: RegExp[], exclude?: RegExp) => sentences.filter((sentence) =>
    !(exclude && exclude.test(sentence.text)) && patterns.some((pattern) => pattern.test(positiveIntentText(sentence.text))));
  const deploymentSentences = receiptSentences(DEPLOYMENT, FAILURE_CONTEXT);
  const browserSentences = receiptSentences(BROWSER);
  // The deployable repository is the one the deployment clause names; with one
  // repository it is that one; otherwise roles stay unknown and the receipt
  // gates the first-mentioned lane.
  // "the server side is on prod before the CLI release" deploys the server, not the CLI.
  const deploymentFragments = deploymentSentences.flatMap((sentence) => sentence.text.split(/\s+(?:before|after|once|until|then)\s+|[,;]/i)
    .filter((fragment) => DEPLOYMENT.some((pattern) => pattern.test(positiveIntentText(fragment)))));
  const deployable = new Set(repositoryIds.length === 1 && deploymentSentences.length ? repositoryIds
    : deploymentFragments.flatMap((fragment) => mentions(fragment)));
  const repositories = repositoryIds.map((id) => {
    const sentencesFor = mentioning(id);
    return {
      id, role: deployable.has(id) ? 'deployable' as const : 'unknown' as const,
      provenance: sentencesFor.length ? sentencesFor.map(spanOf) : [mentionSpan(normalized, id, repositoryIds)],
    };
  });
  const deployableTarget = repositories.find((entry) => entry.role === 'deployable')?.id ?? repositories[0]?.id ?? null;
  if (deploymentSentences.length) checks.push({ kind: 'deployment_release', target: deployableTarget, provenance: deploymentSentences.map(spanOf) });
  if (browserSentences.length) checks.push({ kind: 'browser_smoke', target: deployableTarget, provenance: browserSentences.map(spanOf) });

  // "#366 already merged" / "PR #366 has landed" state a fact; only an
  // imperative merge is a gate (round 2, 2026-09-03).
  const MERGE_STATE = /\b(?:already|has|have|had|was|were|is|are|it's|that's|been|got)\s+(?:been\s+|already\s+|just\s+)?(?:merged|landed)\b|\b(?:merged|landed)\s+already\b/gi;
  const mergeSentences = sentences.filter((sentence) => {
    const text = positiveIntentText(sentence.text).replace(MERGE_STATE, '');
    return /\b(?:prs?|pull requests?)\b|[\w.-]+\/[\w.-]+#\d+|\/pull\/\d+/i.test(text) && /\b(?:merge(?:d|s)?|land(?:ed|s)?)\b/i.test(text);
  });
  const mergeGate = mergeSentences.length > 0 && /#\d+|\bprs?\s+\d+|\/pull\/\d+/i.test(normalized);
  if (mergeGate) checks.push({ kind: 'github_merge', target: deployableTarget, provenance: mergeSentences.map(spanOf) });

  const dualHarness = /\bcodex\b/i.test(normalized) && /\bclaude\b/i.test(normalized) && flat.parallel_requested;
  const software = repositoryIds.length > 0 || SOFTWARE_WORD.test(positive);

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
    // Asks that name no repository — a separately written document ("Separately,
    // write an operator runbook …", "…, and write a design note (not in the
    // repo)") or an owner chore ("Renew the domain, then …") — are their own
    // lanes; they never land inside the pull-request lane. A whole unbound
    // sentence is one candidate; a bound sentence contributes its unbound clauses.
    const claimed = new Set<string>();
    const spanKey = (span: Span) => `${span.start}:${span.end}`;
    const candidates: Array<{ span: Span; sentence: SentenceSpan; whole: boolean }> = [];
    for (const sentence of sentences) {
      if (mentions(sentence.text).length === 0) { candidates.push({ span: spanOf(sentence), sentence, whole: true }); continue; }
      for (const clause of clauseSpans(sentence)) {
        if (clause.text !== sentence.text && mentions(clause.text).length === 0) candidates.push({ span: clause, sentence, whole: false });
      }
    }
    const side: ObligationIR['deliverables'] = [];
    for (const candidate of candidates) {
      if (claimed.has(spanKey(candidate.span))) continue;
      const positiveText = positiveIntentText(unlabeled(candidate.span.text));
      if (PR_BOUND.test(positiveText)) continue;
      const ask = DOCUMENT_ASK.exec(positiveText);
      const noun = ask?.[1] ?? ask?.[2];
      if (noun) {
        const stem = noun.toLowerCase().replace(/s$/, '');
        const about = candidate.whole
          ? candidates.filter((entry) => entry.whole && (entry.sentence.index === candidate.sentence.index
            || (entry.sentence.index > candidate.sentence.index && !claimed.has(spanKey(entry.span)) && new RegExp(`\\b${escapeRegExp(stem)}s?\\b`, 'i').test(entry.span.text)))).map((entry) => entry.span)
          : [candidate.span];
        about.forEach((span) => claimed.add(spanKey(span)));
        const key = unique(`${keyFrom(stem)}_document`, used);
        side.push({ key, kind: 'document', repository: null, summary: bounded(about.map((span) => span.text).join(' '), 300), provenance: about });
        const attested = about.filter((span) => ATTESTED.test(span.text));
        if (attested.length) checks.push({ kind: 'owner_attestation', target: key, provenance: attested });
        continue;
      }
      if (CHORE_VERB.test(positiveText) && !SOFTWARE_WORD.test(positiveText)) {
        claimed.add(spanKey(candidate.span));
        const key = unique(`${keyFrom(positiveText)}_step`, used);
        side.push({ key, kind: 'artifact', repository: null, summary: bounded(unlabeled(candidate.span.text), 300), provenance: [candidate.span] });
        checks.push({ kind: 'owner_attestation', target: key, provenance: [candidate.span] });
      }
    }
    // The repository binding is the software signal: one delivery lane per repo,
    // whose provenance is what the side lanes did not claim.
    const remaining = (sentence: SentenceSpan): Span[] => {
      if (claimed.has(spanKey(sentence))) return [];
      const clauses = clauseSpans(sentence);
      return clauses.some((clause) => claimed.has(spanKey(clause))) ? clauses.filter((clause) => !claimed.has(spanKey(clause))) : [spanOf(sentence)];
    };
    for (const repository of repositoryIds) {
      const scoped = (repositoryIds.length === 1 ? sentences : mentioning(repository)).flatMap(remaining);
      const spans = scoped.length ? scoped : sentences.slice(0, 1).map(spanOf);
      deliverables.push({
        key: unique(`lane_${keyFrom(repositoryName(repository))}`, used), kind: 'pull_request', repository,
        summary: bounded(spans.map((entry) => entry.text).join(' ') || `Deliver the ${repositoryName(repository)} changes described in this task.`, 300),
        provenance: spans,
      });
    }
    deliverables.push(...side);
  } else if (!mergeGate && !software) {
    // Non-software prose: classify each clause; chores become owner steps.
    let previous: string | null = null;
    for (const sentence of sentences) {
      const [deliverablesBefore, checksBefore] = [deliverables.length, checks.length];
      for (const clauseText of clauseTexts(sentence.text)) {
        const at = normalized.indexOf(clauseText, sentence.start);
        const span: Span = at >= 0 ? { start: at, end: at + clauseText.length, text: clauseText } : spanOf(sentence);
        // "CTX alone decides completion" / "report-only" state the custody
        // contract; they are neither owner actions nor open questions.
        if (/\bctx\b[^.;\n]*\b(?:alone|decides?|owns?|evaluates?|completion|authority)\b/i.test(clauseText)) continue;
        // "No code changes" / "but don't change anything" state a constraint, not a step.
        if (!positiveIntentText(clauseText).replace(/^\W*(?:but|and|or)\b/i, '').trim()) continue;
        const last = deliverables[deliverables.length - 1];
        if (last?.kind === 'document' && INVESTIGATE.test(clauseText) && !AUTHORITY_ACTION.test(clauseText) && !EXTERNAL_CHANNEL.test(clauseText)) {
          // "read src/x.ts to find out" is how the report gets written.
          last.provenance.push(span);
        } else if (AUTHORITY_ACTION.test(clauseText) || EXTERNAL_CHANNEL.test(clauseText)) {
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
          // A chore CTX cannot verify is still a TODO: the owner checks it off.
          // Questions are reserved for ambiguity that changes the graph shape.
          checks.push({ kind: 'owner_attestation', target: null, provenance: [span] });
        }
      }
      // One deliverable from a sentence owns the whole sentence: "(report only,
      // no code)" is a parenthetical, not a clause boundary.
      if (deliverables.length === deliverablesBefore + 1 && checks.length === checksBefore) {
        const only = deliverables[deliverables.length - 1]!;
        only.summary = bounded(sentence.text, 300); only.provenance = [spanOf(sentence)];
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

  // Explicit ordering between lanes: "After X lands in ctx, then update ctx-cli",
  // "block the CLI work on the server change", "the server side is on prod
  // before the CLI release", "write a comparison doc, then implement … in ctx",
  // "after that, implement …". A clause maps to the repository lane it names or
  // the side lane whose text it overlaps; with exactly two lanes an unnamed side
  // is the other lane. Join sentences are handled by the join below.
  if (repositoryIds.length > 0 && !mergeGate && deliverables.length >= 2) {
    const resolve = (clause: Span): string[] => {
      const named = mentions(clause.text).map((repository) => deliverables.find((entry) => entry.repository?.toLowerCase() === repository.toLowerCase())?.key)
        .filter((key): key is string => !!key);
      const overlapped = deliverables.filter((entry) => entry.repository === null && entry.provenance.some((span) => overlapping(span, clause))).map((entry) => entry.key);
      return [...new Set([...named, ...overlapped])];
    };
    const addOrder = (dependents: string[], prerequisites: string[]) => {
      for (const dependent of dependents) {
        const after = prerequisites.filter((key) => key !== dependent);
        if (!after.length) continue;
        const existing = ordering.find((rule) => rule.before === dependent);
        if (existing) existing.after = [...new Set([...existing.after, ...after])];
        else ordering.push({ before: dependent, after });
      }
    };
    const disambiguate = (dependents: string[], prerequisites: string[]): [string[], string[]] => {
      let dep = dependents, pre = prerequisites;
      if (dep.some((key) => pre.includes(key))) {
        const trimmedPre = pre.filter((key) => !dep.includes(key));
        if (trimmedPre.length) pre = trimmedPre; else dep = dep.filter((key) => !pre.includes(key));
      }
      if (deliverables.length === 2) {
        const other = (keys: string[]) => deliverables.map((entry) => entry.key).filter((key) => !keys.includes(key));
        if (!dep.length && pre.length) dep = other(pre);
        if (!pre.length && dep.length) pre = other(dep);
      }
      return [dep, pre];
    };
    sentences.forEach((sentence, index) => {
      if (JOIN_PHRASE.test(sentence.text)) return;
      const text = unlabeled(sentence.text.replace(/[.;!?]+$/, ''));
      const continues = CONTINUES_PREVIOUS.test(text);
      if (continues && index > 0) {
        const [dep, pre] = disambiguate(resolve(spanOf(sentence)), resolve(spanOf(sentences[index - 1]!)));
        addOrder(dep, pre);
        return;
      }
      for (const rule of ORDER_RULES) {
        const match = rule.re.exec(text);
        if (!match) continue;
        const offset = sentence.start + sentence.text.indexOf(text);
        const clause = (group: 1 | 2): Span => {
          const value = match[group]!;
          const at = text.indexOf(value, group === 2 ? match[1]!.length : 0);
          return { start: offset + at, end: offset + at + value.length, text: value };
        };
        const [dep, pre] = disambiguate(resolve(clause(rule.dependent)), resolve(clause(rule.prerequisite)));
        if (dep.length && pre.length) { addOrder(dep, pre); break; }
      }
    });
  }

  const laneKeys = deliverables.filter((entry) => ['pull_request', 'artifact', 'commit'].includes(entry.kind)
    && !ordering.some((rule) => rule.before === entry.key)
    && !checks.some((check) => check.kind === 'owner_attestation' && check.target === entry.key)).map((entry) => entry.key);
  if ((flat.join_requested || dualHarness) && laneKeys.length >= 2) {
    const joinSentences = sentences.filter((entry) => JOIN_PHRASE.test(entry.text));
    if (dualHarness || joinSentences.some((entry) => PROOF_WORD.test(entry.text))) {
      const key = unique('joined_proof', used);
      deliverables.push({
        key, kind: 'artifact', repository: null,
        summary: bounded(joinSentences.map((entry) => entry.text).join(' ') || 'Report the downstream proof only after every lane is satisfied.', 300),
        provenance: (joinSentences.length ? joinSentences : sentences.slice(0, 1)).map(spanOf),
      });
      ordering.push({ before: key, after: laneKeys });
    }
  }

  return {
    contract: 'ctx.work-obligation-ir.v1', title, repositories, deliverables, checks, ordering,
    join_requested: flat.join_requested || dualHarness, parallel_requested: flat.parallel_requested,
    questions, source: 'deterministic',
  };
}

const CONNECTIVE_ONLY = /^(?:and\s+)?(?:then|after\s+that|next|finally|afterwards|first|later|lastly)$/i;
function clauseTexts(sentence: string) {
  const body = sentence.replace(/[.!?;]+$/, '');
  const afterOnce = body.match(/^(.*?)\s+(?:once|when)\s+(.+)$/i)?.[2] ?? body;
  const parts = afterOnce.split(/\s*,\s*(?:and\s+)?|\s+and\s+(?=(?:it(?:'s| is)|the|uat|review|finish|have|send|email|deploy|publish)\b)/i)
    .map((entry) => entry.trim().replace(/^and\s+/i, '').replace(/^it(?:'s| is)\s+/i, '')).filter(Boolean);
  // "after that, book the flights": the connective belongs to the next clause.
  const merged: string[] = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    if (previous && CONNECTIVE_ONLY.test(previous)) merged[merged.length - 1] = `${previous}, ${part}`;
    else merged.push(part);
  }
  return merged.slice(0, 12);
}

/**
 * Merge policy (production 2026-09-03): the deterministic floor owns the graph
 * structure — repositories, deliverables, checks, ordering, flags, questions.
 * The model refines wording (a matched lane's summary) and repository roles.
 * A model deliverable that matches no floor item is folded into the lane it
 * overlaps (its spans become provenance) and never becomes a node: a single-PR
 * ask must not split into PR + commit + "request review" lanes, "GitHub
 * Actions workflow" must not add a deployment receipt, and "which cron day?"
 * must not block launch. A folded span attaches only where it overlaps the
 * lane's own text (a list marker quoted for lane B never highlights under lane
 * A), and the first matching proposal owns the summary.
 */
export function mergeObligations(deterministic: ObligationIR, model: ObligationIR | null): ObligationIR {
  if (!model) return deterministic;
  const receipts = deterministic.checks.some((check) => check.kind === 'deployment_release' || check.kind === 'browser_smoke');
  const spanKey = (span: Span) => `${span.start}:${span.end}`;
  const append = (target: Span[], spans: Span[]) => {
    const seen = new Set(target.map(spanKey));
    for (const span of spans) {
      if (span.end <= span.start || seen.has(spanKey(span))) continue;
      seen.add(spanKey(span)); target.push(span);
    }
  };
  const repositories = deterministic.repositories.map((entry) => {
    const proposed = model.repositories.find((candidate) => candidate.id.toLowerCase() === entry.id.toLowerCase());
    if (!proposed) return entry;
    // A role only matters when a receipt has to pick its lane; without one the
    // model's "deployable" for a CI-only repository is noise.
    const role = entry.role === 'unknown' && receipts ? proposed.role : entry.role;
    const provenance = [...entry.provenance];
    append(provenance, proposed.provenance);
    return { ...entry, role, provenance };
  });
  const deliverables = deterministic.deliverables.map((entry) => ({ ...entry, provenance: [...entry.provenance] }));
  const overlaps = (a: Span[], b: Span[]) => a.some((x) => b.some((y) => overlapping(x, y)));
  const summarized = new Set<string>();
  for (const proposed of model.deliverables) {
    const repository = proposed.repository?.toLowerCase() ?? null;
    const exact = deliverables.find((entry) => entry.key === proposed.key)
      ?? deliverables.find((entry) => repository && entry.repository?.toLowerCase() === repository && entry.kind === proposed.kind);
    const folded = exact
      ?? deliverables.find((entry) => (!repository || entry.repository?.toLowerCase() === repository) && overlaps(entry.provenance, proposed.provenance))
      ?? (repository ? deliverables.find((entry) => entry.repository?.toLowerCase() === repository) : undefined)
      ?? (deliverables.length === 1 ? deliverables[0] : undefined);
    if (!folded) continue;
    const own = folded.provenance.slice();
    append(folded.provenance, proposed.provenance.filter((span) => overlaps(own, [span])));
    // The floor's summary is the raw sentences; the model's is a real summary.
    if (exact && !summarized.has(exact.key) && proposed.summary.trim().length >= 20) { exact.summary = proposed.summary.trim(); summarized.add(exact.key); }
  }
  return { ...deterministic, repositories, deliverables, source: 'merged' };
}
