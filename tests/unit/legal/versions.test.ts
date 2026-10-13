import {
  LEGAL_STEP_PATH,
  currentLegalVersions,
  decodeLegalVersions,
  encodeLegalVersions,
  legalDocumentsDue,
  parseLegalVersions,
} from '@/lib/legal/versions';

/**
 * The versions of the terms and the privacy policy (#462): what the file may
 * say, how the session token carries what a person accepted, and when a step
 * is owed.
 */
describe('legal versions', () => {
  it('keeps the texts we know at a well-formed version, and drops the rest', () => {
    expect(
      parseLegalVersions({
        terms: '2026-11-01',
        privacy: 'v2.1_draft-3',
        cookies: '2026-11-01', // informs; nothing is accepted
        other: 'x',
      }),
    ).toEqual({ terms: '2026-11-01', privacy: 'v2.1_draft-3' });

    for (const bad of ['', ' 2026', 'a b', 'x'.repeat(33), '-leading', 'semi;colon', 'eq=uals', 7])
      expect(parseLegalVersions({ terms: bad })).toEqual({});
    for (const junk of [null, undefined, 'terms', 4, []])
      expect(parseLegalVersions(junk)).toEqual({});
  });

  it('the token claim round-trips, in a fixed order', () => {
    const both = { privacy: 'p2', terms: 't1' };
    expect(encodeLegalVersions(both)).toBe('terms=t1;privacy=p2');
    expect(decodeLegalVersions('terms=t1;privacy=p2')).toEqual({ terms: 't1', privacy: 'p2' });
    expect(encodeLegalVersions({})).toBe('');
    expect(encodeLegalVersions({ privacy: 'p2' })).toBe('privacy=p2');
  });

  it('a stale, foreign or broken claim decodes to "accepted nothing"', () => {
    for (const claim of [
      undefined,
      null,
      '',
      7,
      {},
      'terms',
      '=t1',
      'terms=',
      'cookies=1',
      'terms=a b',
    ])
      expect(decodeLegalVersions(claim)).toEqual({});
    // One good pair survives a broken neighbour.
    expect(decodeLegalVersions('junk;privacy=p2;terms=bad version')).toEqual({ privacy: 'p2' });
  });

  it('a text is due until it is accepted at exactly the version in force', () => {
    const current = { terms: 't2', privacy: 'p1' };
    expect(legalDocumentsDue(current, {})).toEqual(['terms', 'privacy']);
    expect(legalDocumentsDue(current, { terms: 't1', privacy: 'p1' })).toEqual(['terms']);
    expect(legalDocumentsDue(current, { terms: 't2', privacy: 'p1' })).toEqual([]);
    // A later version in the token than the one in force (a rollback) is not this one.
    expect(legalDocumentsDue({ terms: 't1' }, { terms: 't2' })).toEqual(['terms']);
  });

  it('with no version in force nothing is ever due', () => {
    expect(legalDocumentsDue({}, {})).toEqual([]);
    expect(legalDocumentsDue({}, { terms: 't1' })).toEqual([]);
  });

  it('reads the published file, and the step has an address', () => {
    // Whatever the file says today, it parses to texts we know.
    for (const doc of Object.keys(currentLegalVersions()))
      expect(['terms', 'privacy']).toContain(doc);
    expect(LEGAL_STEP_PATH).toBe('/start/terms');
  });
});
