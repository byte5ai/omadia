import { describe, expect, it } from 'vitest';

import { matchVocabulary, type VocabularyEntry } from '../entityVocabulary';

const VOCAB: ReadonlyArray<VocabularyEntry> = [
  { name: 'DocumentRef', version: '1.0.0', $id: 'entity://DocumentRef@1' },
  { name: 'Email', version: '1.0.0', $id: 'entity://Email@1' },
  { name: 'EmployeeId', version: '1.0.0', $id: 'entity://EmployeeId@1' },
];

describe('matchVocabulary', () => {
  it('returns empty array for short queries', () => {
    expect(matchVocabulary('', VOCAB)).toEqual([]);
    expect(matchVocabulary('e', VOCAB)).toEqual([]);
  });

  it('matches case-insensitively as substring', () => {
    const r = matchVocabulary('docu', VOCAB);
    expect(r.map((e) => e.name)).toEqual(['DocumentRef']);
  });

  it('returns multiple matches up to limit', () => {
    const r = matchVocabulary('em', VOCAB, 5);
    expect(r.map((e) => e.name)).toEqual(['Email', 'EmployeeId']);
  });

  it('honours the limit', () => {
    const r = matchVocabulary('em', VOCAB, 1);
    expect(r).toHaveLength(1);
  });
});
