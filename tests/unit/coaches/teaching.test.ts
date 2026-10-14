import {
  COACH_RATE_MAX_CENTS,
  formatClock,
  lessonLengthOptions,
  missingForLessons,
  parseClock,
  readTeachingHours,
  readTeachingTerms,
  readTimeOff,
  TeachingInvalidError,
} from '@/lib/coaches/teaching';

/** What a coach sets for teaching at a venue, and their days off (#546). */

const invalid = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof TeachingInvalidError) return `${e.field}:${e.reason}`;
    throw e;
  }
  return null;
};

describe('the lengths a lesson can have are the courts’', () => {
  const court = (minBookingMinutes: number, maxBookingMinutes: number) => ({
    minBookingMinutes,
    maxBookingMinutes,
  });

  it.each([
    // By the hour, up to three: whole hours. NOT 90 or 150, whatever grid a
    // booking starts on: a court booking is a whole number of its units.
    [[court(60, 180)], [60, 120, 180]],
    [[court(60, 60)], [60]],
    [[court(90, 120)], [90]],
    [[court(30, 90)], [30, 60, 90]],
    // A lesson is never longer than four hours, whatever the court allows.
    [[court(120, 480)], [120, 240]],
    // Nor shorter than a quarter of an hour.
    [[court(5, 30)], [15, 20, 25, 30]],
    // Two courts booked differently: every length either allows, shortest first, each once.
    [
      [court(90, 180), court(60, 120)],
      [60, 90, 120, 180],
    ],
    // A venue with no court to book has no lesson length.
    [[], []],
    // A court with no unit to count in offers nothing rather than looping.
    [[court(0, 120)], []],
  ])('%j → %j', (courts, expected) => {
    expect(lessonLengthOptions(courts)).toEqual(expected);
  });

  it('never more than the twelve the database keeps, and those are the shortest', () => {
    const lengths = lessonLengthOptions([court(15, 240)]);
    expect(lengths).toHaveLength(12);
    expect(lengths[0]).toBe(15);
    expect(lengths.at(-1)).toBe(180);
  });

  it('agrees with what a court booking accepts: every length offered is one `slotDurations` would offer', () => {
    // The same court as `slotDurations` sees it: units of the minimum up to the maximum.
    for (const [min, max] of [
      [60, 180],
      [30, 120],
      [45, 180],
      [90, 90],
    ] as const) {
      const offered: number[] = [];
      for (let m = min; m <= max; m += min) offered.push(m);
      expect(lessonLengthOptions([court(min, max)])).toEqual(offered);
    }
  });
});

describe('rates, lengths and the cutoff', () => {
  const LENGTHS = [60, 90, 120];
  const ok = {
    hourlyRateCents: 4000,
    groupRateCents: 6000,
    lessonMinutes: [90, 60],
    cancelCutoffHours: 12,
  };

  it('takes a full set, with the lengths in the venue’s order, each once', () => {
    expect(readTeachingTerms({ ...ok, lessonMinutes: [90, 60, 90] }, LENGTHS)).toEqual({
      hourlyRateCents: 4000,
      groupRateCents: 6000,
      lessonMinutes: [60, 90],
      cancelCutoffHours: 12,
    });
  });

  it('no group rate means no group lessons; no cutoff means a day', () => {
    expect(readTeachingTerms({ hourlyRateCents: 0, lessonMinutes: [60] }, LENGTHS)).toEqual({
      hourlyRateCents: 0,
      groupRateCents: null,
      lessonMinutes: [60],
      cancelCutoffHours: 24,
    });
  });

  it.each([
    ['no rate', { ...ok, hourlyRateCents: undefined }, 'hourlyRateCents:REQUIRED'],
    ['a negative rate', { ...ok, hourlyRateCents: -1 }, 'hourlyRateCents:OUT_OF_RANGE'],
    [
      'a rate that is a typo',
      { ...ok, hourlyRateCents: COACH_RATE_MAX_CENTS + 1 },
      'hourlyRateCents:OUT_OF_RANGE',
    ],
    [
      'a rate with a fraction of a cent',
      { ...ok, hourlyRateCents: 40.5 },
      'hourlyRateCents:OUT_OF_RANGE',
    ],
    ['a rate as text', { ...ok, hourlyRateCents: '4000' }, 'hourlyRateCents:OUT_OF_RANGE'],
    ['a group rate out of range', { ...ok, groupRateCents: -5 }, 'groupRateCents:OUT_OF_RANGE'],
    ['no length', { ...ok, lessonMinutes: [] }, 'lessonMinutes:REQUIRED'],
    [
      'a length the court is not booked for',
      { ...ok, lessonMinutes: [60, 45] },
      'lessonMinutes:NOT_A_COURT_LENGTH',
    ],
    ['a length as text', { ...ok, lessonMinutes: ['60'] }, 'lessonMinutes:NOT_A_COURT_LENGTH'],
    ['a cutoff over a week', { ...ok, cancelCutoffHours: 169 }, 'cancelCutoffHours:OUT_OF_RANGE'],
    ['a negative cutoff', { ...ok, cancelCutoffHours: -1 }, 'cancelCutoffHours:OUT_OF_RANGE'],
  ])('refuses %s', (_l, raw, expected) => {
    expect(invalid(() => readTeachingTerms(raw, LENGTHS))).toBe(expected);
  });
});

describe('the clock', () => {
  it.each([
    ['09:30', 570],
    ['9:30', 570],
    ['00:00', 0],
    ['23:45', 1425],
    [' 18:15 ', 1095],
  ])('%s is %d minutes', (text, minutes) => {
    expect(parseClock(text)).toBe(minutes);
  });
  // 24:00 is not a time of day: midnight is where the next day starts.
  it.each([['24:00'], ['24:15'], ['12:60'], ['noon'], ['12'], ['12:5'], [''], [null], [570]])(
    '%s is not a time',
    (text) => {
      expect(parseClock(text)).toBeNull();
    },
  );
  it('writes it back', () => {
    expect([0, 570, 1095, 1425].map(formatClock)).toEqual(['00:00', '09:30', '18:15', '23:45']);
  });
});

describe('a week of working hours', () => {
  it('sorts by day and time, and lets two stretches touch', () => {
    expect(
      readTeachingHours([
        { dayOfWeek: 3, open: '17:00', close: '21:00' },
        { dayOfWeek: 1, open: '12:00', close: '14:00' },
        { dayOfWeek: 1, open: '09:00', close: '12:00' },
      ]),
    ).toEqual([
      { dayOfWeek: 1, openMinute: 540, closeMinute: 720 },
      { dayOfWeek: 1, openMinute: 720, closeMinute: 840 },
      { dayOfWeek: 3, openMinute: 1020, closeMinute: 1260 },
    ]);
  });

  it('an empty week is valid', () => {
    expect(readTeachingHours([])).toEqual([]);
    expect(readTeachingHours(undefined)).toEqual([]);
  });

  it.each([
    [
      'a day that does not exist',
      [{ dayOfWeek: 7, open: '09:00', close: '10:00' }],
      'hours:BAD_DAY',
    ],
    ['a time that is not one', [{ dayOfWeek: 1, open: '9am', close: '10:00' }], 'hours:BAD_TIME'],
    [
      'a time off the quarter hour',
      [{ dayOfWeek: 1, open: '09:10', close: '10:00' }],
      'hours:BAD_TIME',
    ],
    [
      'a stretch that ends before it starts',
      [{ dayOfWeek: 1, open: '12:00', close: '09:00' }],
      'hours:ENDS_BEFORE_IT_STARTS',
    ],
    [
      'a stretch of no length',
      [{ dayOfWeek: 1, open: '09:00', close: '09:00' }],
      'hours:ENDS_BEFORE_IT_STARTS',
    ],
    [
      'two stretches that overlap',
      [
        { dayOfWeek: 1, open: '09:00', close: '12:00' },
        { dayOfWeek: 1, open: '11:45', close: '14:00' },
      ],
      'hours:OVERLAP',
    ],
    [
      'five stretches in one day',
      [8, 10, 12, 14, 16].map((h) => ({ dayOfWeek: 2, open: `${h}:00`, close: `${h + 1}:00` })),
      'hours:TOO_MANY',
    ],
    ['something that is not a stretch', [null], 'hours:BAD_DAY'],
  ])('refuses %s', (_l, raw, expected) => {
    expect(invalid(() => readTeachingHours(raw))).toBe(expected);
  });

  it('the same hours on two different days do not overlap', () => {
    expect(
      readTeachingHours([
        { dayOfWeek: 1, open: '09:00', close: '12:00' },
        { dayOfWeek: 2, open: '09:00', close: '12:00' },
      ]),
    ).toHaveLength(2);
  });
});

describe('days off', () => {
  const TODAY = '2026-10-14';

  it('one day, a stretch, and a note kept on one line', () => {
    expect(readTimeOff({ startDate: '2026-10-20' }, TODAY)).toEqual({
      startDate: '2026-10-20',
      endDate: '2026-10-20',
      note: null,
    });
    expect(
      readTimeOff(
        { startDate: '2026-12-24', endDate: '2027-01-02', note: '  Коледа \n и Нова година ' },
        TODAY,
      ),
    ).toEqual({ startDate: '2026-12-24', endDate: '2027-01-02', note: 'Коледа и Нова година' });
  });

  it('may start today, and may have started already if it has not ended', () => {
    expect(readTimeOff({ startDate: TODAY }, TODAY).startDate).toBe(TODAY);
    expect(readTimeOff({ startDate: '2026-10-10', endDate: '2026-10-16' }, TODAY).endDate).toBe(
      '2026-10-16',
    );
  });

  it.each([
    ['no date', {}, 'startDate:BAD_DATE'],
    ['a date that is not one', { startDate: '14.10.2026' }, 'startDate:BAD_DATE'],
    ['a day that does not exist', { startDate: '2027-02-30' }, 'startDate:BAD_DATE'],
    [
      'an end that is not a date',
      { startDate: '2026-10-20', endDate: 'later' },
      'endDate:BAD_DATE',
    ],
    [
      'an end before the start',
      { startDate: '2026-10-20', endDate: '2026-10-19' },
      'endDate:ENDS_BEFORE_IT_STARTS',
    ],
    [
      'a stretch that is over',
      { startDate: '2026-10-01', endDate: '2026-10-13' },
      'endDate:IN_THE_PAST',
    ],
    ['more than a year ahead', { startDate: '2027-10-16' }, 'startDate:TOO_FAR'],
    [
      'longer than three months',
      { startDate: '2026-11-01', endDate: '2027-02-01' },
      'endDate:TOO_LONG',
    ],
    [
      'a note that is an essay',
      { startDate: '2026-10-20', note: 'я'.repeat(201) },
      'note:TOO_LONG',
    ],
  ])('refuses %s', (_l, raw, expected) => {
    expect(invalid(() => readTimeOff(raw, TODAY))).toBe(expected);
  });
});

describe('what a link needs before a lesson can be booked on it', () => {
  it('a rate, a length and some hours; each is named when it is missing', () => {
    const ready = { hourlyRateCents: 4000, lessonMinutes: [60], hours: [{}], courts: 2 };
    expect(missingForLessons(ready)).toEqual([]);
    // Free lessons are a rate: zero is not "missing".
    expect(missingForLessons({ ...ready, hourlyRateCents: 0 })).toEqual([]);
    expect(
      missingForLessons({ hourlyRateCents: null, lessonMinutes: [], hours: [], courts: 1 }),
    ).toEqual(['rate', 'lengths', 'hours']);
    // No court in use at the venue for a sport the coach teaches: named first,
    // because nothing the coach sets here would make a lesson bookable.
    expect(missingForLessons({ ...ready, courts: 0 })).toEqual(['courts']);
    expect(
      missingForLessons({ hourlyRateCents: null, lessonMinutes: [], hours: [], courts: 0 }),
    ).toEqual(['courts', 'rate', 'lengths', 'hours']);
  });
});
