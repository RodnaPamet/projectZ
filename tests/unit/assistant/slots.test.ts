import {
  availabilityAt,
  cheapestPerStart,
  clockOf,
  freeHourlyStarts,
  localDayRange,
  rankTimes,
  type FreeStart,
  type PlayerTime,
  type ResourceSlots,
} from '@/lib/assistant/slots';

const TZ = 'Europe/Sofia';
const at = (iso: string) => new Date(iso);
const H = 3_600_000;

/** A court whose slots start at each `starts` (UTC), every one free for 60 and 90 minutes. */
function court(
  starts: string[],
  opts: { taken?: string[]; id?: string; price?: number } = {},
): ResourceSlots {
  return {
    resource: { id: opts.id ?? 'r1', sport: 'PADEL', minBookingMinutes: 30 },
    slots: starts.map((s) => {
      const startTs = at(s);
      const available = !(opts.taken ?? []).includes(s);
      return {
        startTs,
        available,
        ...(available
          ? {
              durations: [60, 90].map((m) => ({
                minutes: m,
                endTs: new Date(startTs.getTime() + m * 60_000),
                priceCents: (opts.price ?? 2400) * (m / 60),
              })),
            }
          : {}),
      };
    }),
  };
}

describe('the hours the assistant offers are the hours the app offers', () => {
  const now = at('2026-11-14T10:00:00Z'); // 12:00 in Sofia

  it('starts on the hour on the club’s clock, not yet begun, free', () => {
    const r = court(
      [
        '2026-11-14T09:00:00Z',
        '2026-11-14T15:00:00Z',
        '2026-11-14T15:30:00Z',
        '2026-11-14T16:00:00Z',
        '2026-11-14T17:00:00Z',
      ],
      { taken: ['2026-11-14T16:00:00Z'] },
    );
    const got = freeHourlyStarts(r, { now, timeZone: TZ });
    // 09:00Z (11:00 local) has begun; 15:30Z is not on the hour; 16:00Z is taken.
    expect(got.map((s) => s.startTs.toISOString())).toEqual([
      '2026-11-14T15:00:00.000Z',
      '2026-11-14T17:00:00.000Z',
    ]);
    expect(got[0]).toMatchObject({ minutes: 60, priceCents: 2400 });
  });

  it('keeps to a local time window: starts from timeFrom, ends by timeTo', () => {
    const r = court([
      '2026-11-14T15:00:00Z',
      '2026-11-14T16:00:00Z',
      '2026-11-14T17:00:00Z',
      '2026-11-14T18:00:00Z',
    ]);
    // 17:00–20:00 Sofia is 15:00Z–18:00Z; a 60-minute game must END by 20:00.
    const got = freeHourlyStarts(r, { now, timeZone: TZ, timeFrom: '18:00', timeTo: '20:00' });
    expect(got.map((s) => clockOf(s.startTs, TZ).time)).toEqual(['18:00', '19:00']);
  });

  it('a length the court does not take finds nothing; one it takes is priced for that length', () => {
    const r = court(['2026-11-14T15:00:00Z']);
    expect(freeHourlyStarts(r, { now, timeZone: TZ, minutes: 120 })).toEqual([]);
    expect(freeHourlyStarts(r, { now, timeZone: TZ, minutes: 90 })[0]).toMatchObject({
      minutes: 90,
      priceCents: 3600,
    });
  });

  it('one option per hour: the cheapest court', () => {
    const a = freeHourlyStarts(court(['2026-11-14T15:00:00Z'], { id: 'a', price: 3000 }), {
      now,
      timeZone: TZ,
    });
    const b = freeHourlyStarts(court(['2026-11-14T15:00:00Z'], { id: 'b', price: 2000 }), {
      now,
      timeZone: TZ,
    });
    expect(cheapestPerStart([...a, ...b]).map((s) => s.resourceId)).toEqual(['b']);
  });

  it('a local day range is the club’s midnight to midnight', () => {
    const { from, to } = localDayRange('2026-11-14', '2026-11-15', TZ);
    expect(from.toISOString()).toBe('2026-11-13T22:00:00.000Z');
    expect(to.toISOString()).toBe('2026-11-15T22:00:00.000Z');
  });
});

describe('who can make a time', () => {
  const slot = (iso: string, resourceId = 'r1'): FreeStart => ({
    resourceId,
    startTs: at(iso),
    endTs: new Date(at(iso).getTime() + H),
    minutes: 60,
    priceCents: 2400,
  });
  const free = (name: string): PlayerTime => ({ userId: name, name, calendar: [], bookings: [] });
  const unknown = (name: string): PlayerTime => ({
    userId: name,
    name,
    calendar: null,
    bookings: [],
    unknownReason: 'no Google Calendar connected',
  });

  it('unknown is never free; a playerz booking is busy even without a calendar', () => {
    const p = unknown('Ана');
    expect(availabilityAt(p, at('2026-11-15T16:00:00Z'), at('2026-11-15T17:00:00Z'))).toBe(
      'unknown',
    );
    p.bookings.push({ start: at('2026-11-15T16:30:00Z'), end: at('2026-11-15T17:30:00Z') });
    expect(availabilityAt(p, at('2026-11-15T16:00:00Z'), at('2026-11-15T17:00:00Z'))).toBe('busy');
  });

  it('back to back is not a clash', () => {
    const p = free('Иво');
    p.calendar!.push({ start: at('2026-11-15T15:00:00Z'), end: at('2026-11-15T16:00:00Z') });
    expect(availabilityAt(p, at('2026-11-15T16:00:00Z'), at('2026-11-15T17:00:00Z'))).toBe('free');
  });

  it('drops any time a player is busy; everyone known-free first, then fewest unknowns, then soonest', () => {
    const busyIvo = free('Иво');
    busyIvo.calendar!.push({ start: at('2026-11-15T16:00:00Z'), end: at('2026-11-15T17:00:00Z') });
    const ana = unknown('Ана');
    ana.bookings.push({ start: at('2026-11-16T16:00:00Z'), end: at('2026-11-16T17:00:00Z') });
    const players = [free('you'), busyIvo, ana];
    // Ана is unknown everywhere except the 16th, where she plays: so no
    // option is everyone-known-free, and the 15th at 16Z (Иво busy) and the
    // 16th at 16Z (Ана busy) are gone.
    const ranked = rankTimes(
      [
        slot('2026-11-15T16:00:00Z'),
        slot('2026-11-15T17:00:00Z'),
        slot('2026-11-16T16:00:00Z'),
        slot('2026-11-17T08:00:00Z'),
      ],
      players,
      { timeZone: TZ },
    );
    expect(ranked.map((o) => o.start.startTs.toISOString())).toEqual([
      '2026-11-15T17:00:00.000Z',
      '2026-11-17T08:00:00.000Z',
    ]);
    expect(ranked[0]!.unknown.map((p) => p.name)).toEqual(['Ана']);
    expect(ranked[0]!.free.map((p) => p.name)).toEqual(['you', 'Иво']);
  });

  it('a time everyone is known to be free at beats a sooner one with an unknown player', () => {
    const ivo = free('Иво');
    const ana: PlayerTime = { userId: 'a', name: 'Ана', calendar: null, bookings: [] };
    const anaKnown: PlayerTime = { ...ana, calendar: [] };
    const soon = slot('2026-11-15T08:00:00Z');
    const later = slot('2026-11-16T08:00:00Z');
    expect(rankTimes([soon, later], [ivo, ana], { timeZone: TZ })[0]!.start).toBe(soon);
    // With Ана's calendar known and free only on the 16th:
    anaKnown.calendar!.push({ start: at('2026-11-15T07:00:00Z'), end: at('2026-11-15T10:00:00Z') });
    const r = rankTimes([soon, later], [ivo, anaKnown], { timeZone: TZ });
    expect(r.map((o) => o.start)).toEqual([later]);
  });

  it('three options on different days rather than three neighbouring hours', () => {
    const r = rankTimes(
      [
        slot('2026-11-15T15:00:00Z'),
        slot('2026-11-15T16:00:00Z'),
        slot('2026-11-15T17:00:00Z'),
        slot('2026-11-16T15:00:00Z'),
        slot('2026-11-17T15:00:00Z'),
      ],
      [free('you')],
      { timeZone: TZ, limit: 3 },
    );
    expect(r.map((o) => clockOf(o.start.startTs, TZ).date)).toEqual([
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
    ]);
  });
});
