import {
  coachFeeCents,
  coachWorks,
  lessonFeeCents,
  lessonPrice,
  lessonTimes,
  type CoachOnTheDay,
  type CourtForLesson,
} from '@/lib/coaches/lessons';

/**
 * When a lesson can be booked, and what it costs (#548). Sofia, Monday
 * 2 November 2026: winter time, UTC+2, so 09:00 at the venue is 07:00Z.
 */

const TZ = 'Europe/Sofia';
const at = (hhmm: string, day = '2026-11-02') => new Date(`${day}T${hhmm}:00+02:00`);
const NOW = at('06:00');

/** A court free at each start given, bookable for 60 and 120 minutes there. */
const court = (
  resourceId: string,
  starts: string[],
  over: Partial<CourtForLesson> & { price?: number; lengths?: number[] } = {},
): CourtForLesson => ({
  resourceId,
  name: over.name ?? `Корт ${resourceId}`,
  sport: over.sport ?? 'TENNIS',
  slots: starts.map((s) => ({
    startTs: at(s),
    durations: (over.lengths ?? [60, 120]).map((minutes) => ({
      minutes,
      endTs: new Date(at(s).getTime() + minutes * 60_000),
      priceCents: ((over.price ?? 2400) * minutes) / 60,
    })),
  })),
});

/** Monday (1) 09:00–12:00, nothing else on. */
const coach = (over: Partial<CoachOnTheDay> = {}): CoachOnTheDay => ({
  hours: [{ dayOfWeek: 1, openMinute: 540, closeMinute: 720 }],
  busy: [],
  off: false,
  ...over,
});

const starts = (times: ReturnType<typeof lessonTimes>) =>
  times.map((t) => t.startTs.toISOString().slice(11, 16));

describe('the coach’s fee', () => {
  it.each([
    [4000, 60, 4000],
    [4000, 90, 6000],
    [4000, 120, 8000],
    [3500, 45, 2625],
    // A third of a cent rounds to the nearest.
    [1000, 20, 333],
    [0, 60, 0],
  ])('%d an hour for %d minutes is %d', (rate, minutes, fee) => {
    expect(coachFeeCents(rate, minutes)).toBe(fee);
  });

  it('one player pays the hourly rate; a group the group rate, when the coach has one', () => {
    const base = { minutes: 60, courtPriceCents: 2400, hourlyRateCents: 4000 };
    expect(lessonPrice({ ...base, groupRateCents: 6000, group: false })).toEqual({
      coachFeeCents: 4000,
      courtPriceCents: 2400,
      totalCents: 6400,
    });
    expect(lessonPrice({ ...base, groupRateCents: 6000, group: true })).toEqual({
      coachFeeCents: 6000,
      courtPriceCents: 2400,
      totalCents: 8400,
    });
    // No group rate: there are no group lessons, and nobody is charged a made-up one.
    expect(lessonPrice({ ...base, groupRateCents: null, group: true }).coachFeeCents).toBe(4000);
  });
});

describe('the coach’s fee follows the number of players (decisions 9, 18, 19)', () => {
  const base = { hourlyRateCents: 4000, minutes: 60 };
  it.each([
    // One player: the hourly rate.
    [1, 6000, 4000],
    // Two or more: the group rate, once, for the whole group.
    [2, 6000, 6000],
    [3, 6000, 6000],
    [4, 6000, 6000],
    // No group rate: the hourly rate however many come.
    [1, null, 4000],
    [2, null, 4000],
    [4, null, 4000],
    // A group rate below the hourly one is the coach's to set.
    [2, 3000, 3000],
    // Free for a group is a rate, not "no rate".
    [2, 0, 0],
  ])('%d player(s), group rate %s: %d', (players, groupRateCents, fee) => {
    expect(lessonFeeCents({ ...base, groupRateCents, players })).toBe(fee);
  });

  it('is for the lesson’s length, at either rate', () => {
    const ninety = { hourlyRateCents: 4000, groupRateCents: 6000, minutes: 90 };
    expect(lessonFeeCents({ ...ninety, players: 1 })).toBe(6000);
    expect(lessonFeeCents({ ...ninety, players: 2 })).toBe(9000);
  });
});

describe('when the coach works', () => {
  const hours = [
    { dayOfWeek: 1, openMinute: 540, closeMinute: 720 },
    { dayOfWeek: 1, openMinute: 720, closeMinute: 840 },
    { dayOfWeek: 1, openMinute: 1020, closeMinute: 1260 },
  ];
  it.each([
    ['inside a stretch', '09:00', '10:00', true],
    ['to the very end of one', '11:00', '12:00', true],
    ['across two stretches that touch', '11:30', '12:30', true],
    ['starting before the day does', '08:30', '09:30', false],
    ['running into the gap', '13:30', '14:30', false],
    ['in the gap', '15:00', '16:00', false],
    ['the evening stretch', '19:00', '21:00', true],
    ['past the end of the evening', '20:30', '21:30', false],
  ])('%s (%s–%s): %s', (_l, from, to, expected) => {
    expect(coachWorks(hours, at(from), at(to), TZ)).toBe(expected);
  });

  it('is by the venue’s clock and the venue’s weekday, not UTC’s', () => {
    // Monday 00:30 at the venue is still Sunday in UTC.
    const early = [{ dayOfWeek: 1, openMinute: 0, closeMinute: 120 }];
    expect(coachWorks(early, at('00:30'), at('01:30'), TZ)).toBe(true);
    // Tuesday 09:00 is not Monday's hours.
    expect(coachWorks(hours, at('09:00', '2026-11-03'), at('10:00', '2026-11-03'), TZ)).toBe(false);
  });
});

describe('the times a lesson can start', () => {
  it('where the court is free for the length AND the coach works', () => {
    const times = lessonTimes({
      minutes: 60,
      timezone: TZ,
      courts: [court('a', ['08:00', '09:00', '10:00', '11:00', '12:00'])],
      coach: coach(),
      now: NOW,
    });
    // 08:00 is before the coach starts, 12:00 is when they stop.
    expect(starts(times)).toEqual(['07:00', '08:00', '09:00']);
    expect(times[0]).toMatchObject({
      resourceId: 'a',
      sport: 'TENNIS',
      courtPriceCents: 2400,
    });
    expect(times[0]!.endTs.getTime() - times[0]!.startTs.getTime()).toBe(3_600_000);
  });

  it('a longer lesson needs the coach for all of it', () => {
    const times = lessonTimes({
      minutes: 120,
      timezone: TZ,
      courts: [court('a', ['09:00', '10:00', '11:00'])],
      coach: coach(),
      now: NOW,
    });
    // 11:00–13:00 runs past the coach's 12:00.
    expect(starts(times)).toEqual(['07:00', '08:00']);
    expect(times[0]!.courtPriceCents).toBe(4800);
  });

  it('not a length the court cannot be booked for at that start', () => {
    expect(
      lessonTimes({
        minutes: 90,
        timezone: TZ,
        courts: [court('a', ['09:00', '10:00'])],
        coach: coach(),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('not while the coach has another lesson, at any club; back to back is fine', () => {
    const times = lessonTimes({
      minutes: 60,
      timezone: TZ,
      courts: [court('a', ['09:00', '10:00', '11:00'])],
      coach: coach({ busy: [{ startTs: at('10:00'), endTs: at('11:00') }] }),
      now: NOW,
    });
    expect(starts(times)).toEqual(['07:00', '09:00']);
  });

  it('none on a day off, whatever is free', () => {
    expect(
      lessonTimes({
        minutes: 60,
        timezone: TZ,
        courts: [court('a', ['09:00', '10:00'])],
        coach: coach({ off: true }),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('not a time that has already started', () => {
    const times = lessonTimes({
      minutes: 60,
      timezone: TZ,
      courts: [court('a', ['09:00', '10:00', '11:00'])],
      coach: coach(),
      now: at('10:00'),
    });
    expect(starts(times)).toEqual(['09:00']);
  });

  it('one answer per start: the cheaper court, then the first by name', () => {
    const times = lessonTimes({
      minutes: 60,
      timezone: TZ,
      courts: [
        court('dear', ['09:00', '10:00'], { name: 'Корт 1', price: 3000 }),
        court('cheap', ['09:00'], { name: 'Корт 2', price: 2000 }),
        court('same-b', ['11:00'], { name: 'Корт Б', price: 2400 }),
        court('same-a', ['11:00'], { name: 'Корт А', price: 2400 }),
      ],
      coach: coach(),
      now: NOW,
    });
    expect(times.map((t) => [t.startTs.toISOString().slice(11, 16), t.resourceId])).toEqual([
      ['07:00', 'cheap'],
      // Only the dearer court is free at ten.
      ['08:00', 'dear'],
      ['09:00', 'same-a'],
    ]);
  });

  it('no court, or a coach with no hours: no times', () => {
    expect(
      lessonTimes({ minutes: 60, timezone: TZ, courts: [], coach: coach(), now: NOW }),
    ).toEqual([]);
    expect(
      lessonTimes({
        minutes: 60,
        timezone: TZ,
        courts: [court('a', ['09:00'])],
        coach: coach({ hours: [] }),
        now: NOW,
      }),
    ).toEqual([]);
  });
});
