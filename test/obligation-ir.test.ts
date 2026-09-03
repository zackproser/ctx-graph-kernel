import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ObligationIR, normalizePrompt, validateObligationIR } from '../src/obligation-ir.js';
import { extractObligationIR, mergeObligations, sentenceSpans } from '../src/obligations.js';

const prompt = 'Complete zackproser/ctx#301 across the CTX server and ctx-cli. Two lanes may run independently, but CTX must join them after both deliveries exist.';

describe('obligation IR schema and validation', () => {
  it('normalizes the prompt so spans index into one canonical text', () => {
    const normalized = normalizePrompt('  A\r\nBÅ  ');
    expect(normalized).toBe('A\nBÅ');
    expect(sentenceSpans('First one. Second; third!\nFourth').map((s) => s.text)).toEqual(['First one.', 'Second;', 'third!', 'Fourth']);
  });

  it('extracts a span-attributed deterministic IR whose spans point at the normalized prompt', () => {
    const ir = extractObligationIR(prompt);
    expect(ObligationIR.parse(ir)).toBeTruthy();
    expect(validateObligationIR(ir, normalizePrompt(prompt))).toEqual([]);
    expect(ir.repositories.map((r) => r.id)).toEqual(['zackproser/ctx', 'zackproser/ctx-cli']);
    for (const entry of [...ir.repositories, ...ir.deliverables, ...ir.checks]) expect(entry.provenance.length).toBeGreaterThan(0);
    expect(ir.source).toBe('deterministic');
  });

  it('rejects malformed model output structurally, not by luck', () => {
    const malformed = JSON.parse(readFileSync(resolve('test/corpus/compiler/malformed_model.json'), 'utf8'));
    expect(ObligationIR.safeParse(malformed).success).toBe(false);
    const cyclic = {
      ...extractObligationIR('In zackproser/ctx implement the feature and then deploy it.'),
      deliverables: [
        { key: 'a', kind: 'artifact', repository: 'zackproser/ctx', summary: 'a', provenance: [{ start: 0, end: 1, text: 'I' }] },
        { key: 'b', kind: 'artifact', repository: 'zackproser/ctx', summary: 'b', provenance: [{ start: 0, end: 1, text: 'I' }] },
      ],
      ordering: [{ before: 'a', after: ['b'] }, { before: 'b', after: ['a'] }],
    } as const;
    expect(validateObligationIR(cyclic as never).some((error) => error.startsWith('ordering cycle'))).toBe(true);
    expect(validateObligationIR({ ...cyclic, ordering: [{ before: 'a', after: ['zzz'] }] } as never)).toContain('ordering names unknown key zzz');
  });

  it('merges a model proposal on top of the deterministic floor without dropping facts or inventing repositories', () => {
    const det = extractObligationIR(prompt);
    const model = {
      ...det, source: 'model' as const,
      repositories: [
        { id: 'zackproser/ctx', role: 'deployable' as const, provenance: det.repositories[0]!.provenance },
        { id: 'evil/other', role: 'unknown' as const, provenance: det.repositories[0]!.provenance },
      ],
      deliverables: [
        { key: 'docs', kind: 'document' as const, repository: 'evil/other', summary: 'x', provenance: det.repositories[0]!.provenance },
        { key: 'notes', kind: 'document' as const, repository: null, summary: 'release notes', provenance: det.repositories[0]!.provenance },
      ],
      checks: [{ kind: 'browser_smoke' as const, target: 'zackproser/ctx', provenance: det.repositories[0]!.provenance }],
      questions: [{ text: 'Which branch?', provenance: det.repositories[0]!.provenance }],
    };
    const merged = mergeObligations(det, model);
    expect(merged.source).toBe('merged');
    expect(merged.repositories.map((r) => r.id)).toEqual(det.repositories.map((r) => r.id));
    expect(merged.repositories[0]!.role).toBe('deployable');
    expect(merged.deliverables.map((d) => d.key)).toEqual([...det.deliverables.map((d) => d.key), 'notes']);
    expect(merged.checks.some((c) => c.kind === 'browser_smoke')).toBe(true);
    expect(merged.questions).toHaveLength(1);
    expect(mergeObligations(det, null)).toEqual(det);
  });
});
