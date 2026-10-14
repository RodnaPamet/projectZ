import {
  lessonPagePath,
  parseLessonPick,
  type PickableVenue,
} from '@/app/(public)/coaches/[slug]/lesson-pick';

/**
 * What the coach page's URL may say about a lesson being picked (#548). Every
 * value in it is a hint, checked against what the coach offers; the page's
 * own URL is built only from values the page holds.
 */

const DAYS = ['2036-07-14', '2036-07-15', '2036-07-16'];
const venues: PickableVenue[] = [
  { linkId: 'l1', sports: ['TENNIS', 'PADEL'], lessonMinutes: [60, 90], days: DAYS },
  { linkId: 'l2', sports: ['PADEL'], lessonMinutes: [120], days: DAYS },
];

describe('the pick the URL asks for', () => {
  it('with nothing asked: the first venue, its first sport, its shortest lesson, today there', () => {
    expect(parseLessonPick({}, venues)).toEqual({
      linkId: 'l1',
      sport: 'TENNIS',
      minutes: 60,
      day: '2036-07-14',
      start: null,
      confirm: false,
    });
  });

  it('a whole pick, as the sign-in round trip brings it back', () => {
    expect(
      parseLessonPick(
        {
          at: 'l1',
          sport: 'PADEL',
          min: '90',
          day: '2036-07-15',
          start: '2036-07-15T07:00:00.000Z',
          confirm: '1',
        },
        venues,
      ),
    ).toEqual({
      linkId: 'l1',
      sport: 'PADEL',
      minutes: 90,
      day: '2036-07-15',
      // As the times DTO writes it: no fractional seconds.
      start: '2036-07-15T07:00:00Z',
      confirm: true,
    });
  });

  it.each([
    ['a venue the coach does not teach at', { at: 'nope' }, { linkId: 'l1' }],
    ['a sport that venue has no court for', { at: 'l2', sport: 'TENNIS' }, { sport: 'PADEL' }],
    ['a length not taught there', { at: 'l2', min: '60' }, { minutes: 120 }],
    ['a length that is not a number', { min: 'long' }, { minutes: 60 }],
    ['a day outside the two weeks', { day: '2036-08-30' }, { day: '2036-07-14' }],
    ['a day that is not a date', { day: 'tomorrow' }, { day: '2036-07-14' }],
    ['a start that is not a time', { start: 'noon' }, { start: null }],
    ['the same value twice', { at: ['l2', 'l1'] }, { linkId: 'l1' }],
  ])('%s falls back to what is offered', (_l, sp, expected) => {
    expect(parseLessonPick(sp, venues)).toMatchObject(expected);
  });

  it('the sheet opens only for a pick that names a time', () => {
    expect(parseLessonPick({ confirm: '1' }, venues)!.confirm).toBe(false);
    expect(
      parseLessonPick({ confirm: 'yes', start: '2036-07-14T07:00:00Z' }, venues)!.confirm,
    ).toBe(false);
  });

  it('a coach with no venue has nothing to pick', () => {
    expect(parseLessonPick({ at: 'l1' }, [])).toBeNull();
  });
});

describe('the page’s own URL for a pick', () => {
  const choice = { linkId: 'l1', sport: 'PADEL', minutes: 90, day: '2036-07-15' };

  it('carries the choice, and the time and the open sheet only when there is a time', () => {
    expect(lessonPagePath('ivan-petrov', choice)).toBe(
      '/coaches/ivan-petrov?at=l1&day=2036-07-15&min=90&sport=PADEL',
    );
    expect(
      lessonPagePath('ivan-petrov', { ...choice, start: '2036-07-15T07:00:00Z', confirm: true }),
    ).toBe(
      '/coaches/ivan-petrov?at=l1&day=2036-07-15&min=90&sport=PADEL&start=2036-07-15T07%3A00%3A00Z&confirm=1',
    );
    // No time, no sheet.
    expect(lessonPagePath('ivan-petrov', { ...choice, confirm: true })).not.toContain('confirm');
  });

  it('round-trips through the parser', () => {
    const path = lessonPagePath('ivan-petrov', {
      ...choice,
      start: '2036-07-15T07:00:00Z',
      confirm: true,
    });
    const sp = Object.fromEntries(new URL(path, 'http://x').searchParams);
    expect(parseLessonPick(sp, venues)).toEqual({
      ...choice,
      start: '2036-07-15T07:00:00Z',
      confirm: true,
    });
  });

  it('is a path on this site whatever the address is', () => {
    expect(lessonPagePath('a/../b', choice).startsWith('/coaches/a%2F..%2Fb?')).toBe(true);
  });
});
