// Deterministic explicit-obligation inventory and semantic coverage check for
// natural-language work requests. Pure; no model, no I/O.
import type { CompletionGraphLint } from './types';

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
