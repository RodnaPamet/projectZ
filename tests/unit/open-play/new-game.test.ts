import type { ResourceSlotsDto } from '@/app/api/v1/_lib/dto';
import {
  anyGameHour,
  bookingsToOpen,
  createGame,
  gameBody,
  gameHours,
} from '@/lib/open-play/new-game';

/** «Създай игра» in one flow (#697): book, then open the booking's game. */

const wanted = { spots: 3, levelMin: null, levelMax: null, note: '' };

describe('createGame', () => {
  it('books, reads the game, opens it with no more players than the court holds', async () => {
    const order: string[] = [];
    const openGame = jest.fn(async () => {
      order.push('open');
    });
    const outcome = await createGame({
      book: async () => {
        order.push('book');
        return { id: 'b1' };
      },
      readGame: async (id) => {
        order.push(`read:${id}`);
        return { canOpen: true, maxSpots: 2 };
      },
      openGame,
      wanted: { spots: 5, levelMin: 4, levelMax: 2, note: '  двама за двойки ' },
    });
    expect(outcome).toEqual({ kind: 'opened', bookingId: 'b1' });
    expect(order).toEqual(['book', 'read:b1', 'open']);
    expect(openGame).toHaveBeenCalledWith('b1', {
      spots: 2,
      levelMin: 2,
      levelMax: 4,
      note: 'двама за двойки',
    });
  });

  it('a booking whose game cannot open is booked, with no game', async () => {
    const openGame = jest.fn();
    const outcome = await createGame({
      book: async () => ({ id: 'b2' }),
      readGame: async () => ({ canOpen: false, maxSpots: 3 }),
      openGame,
      wanted,
    });
    expect(outcome).toEqual({ kind: 'bookedNoGame', bookingId: 'b2' });
    expect(openGame).not.toHaveBeenCalled();
  });

  it('a full court is booked, with no game', async () => {
    const outcome = await createGame({
      book: async () => ({ id: 'b3' }),
      readGame: async () => ({ canOpen: true, maxSpots: 0 }),
      openGame: jest.fn(),
      wanted,
    });
    expect(outcome).toEqual({ kind: 'bookedNoGame', bookingId: 'b3' });
  });

  it('a game that fails to open leaves the booking, and says so', async () => {
    const outcome = await createGame({
      book: async () => ({ id: 'b4' }),
      readGame: async () => ({ canOpen: true, maxSpots: 3 }),
      openGame: async () => {
        throw new Error('OPEN_PLAY_CUTOFF_PASSED');
      },
      wanted,
    });
    expect(outcome).toEqual({ kind: 'bookedNoGame', bookingId: 'b4' });
  });

  it('a refused booking is thrown as it came, and nothing else is asked', async () => {
    const readGame = jest.fn();
    const refusal = Object.assign(new Error('taken'), { code: 'SLOT_TAKEN' });
    await expect(
      createGame({
        book: async () => {
          throw refusal;
        },
        readGame,
        openGame: jest.fn(),
        wanted,
      }),
    ).rejects.toBe(refusal);
    expect(readGame).not.toHaveBeenCalled();
  });

  it('no booking made is no outcome', async () => {
    await expect(
      createGame({ book: async () => undefined, readGame: jest.fn(), openGame: jest.fn(), wanted }),
    ).resolves.toBeNull();
  });
});

describe('gameBody', () => {
  it('any level is no level, an empty note is none, at least one player', () => {
    expect(gameBody({ spots: 0, levelMin: null, levelMax: null, note: '   ' }, 3)).toEqual({
      spots: 1,
      levelMin: null,
      levelMax: null,
      note: null,
    });
  });
});

describe('bookingsToOpen', () => {
  const b = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    viewerRole: 'BOOKER',
    status: 'CONFIRMED',
    lesson: null,
    tournamentMatch: null,
    ...over,
  });

  it('the caller’s own confirmed court bookings, two at most', () => {
    const out = bookingsToOpen([
      b('guest', { viewerRole: 'PARTICIPANT' }),
      b('pending', { status: 'PENDING' }),
      b('lesson', { lesson: { id: 'l' } }),
      b('match', { tournamentMatch: { id: 'm' } }),
      b('one'),
      b('two'),
      b('three'),
    ]);
    expect(out.map((x) => x.id)).toEqual(['one', 'two']);
  });
});

describe('the hours a game can open on', () => {
  // 2026-11-14 in Sofia (UTC+2).
  const at = (h: number) => new Date(Date.UTC(2026, 10, 14, h - 2, 0)).toISOString();
  const court = (sport: string, hours: number[]): ResourceSlotsDto =>
    ({
      resourceId: `r-${sport}`,
      name: 'Корт 1',
      sport,
      resourceType: 'COURT',
      currency: 'EUR',
      minBookingMinutes: 60,
      maxBookingMinutes: 60,
      slotStepMinutes: 60,
      slots: hours.map((h) => ({
        startTs: at(h),
        endTs: at(h + 1),
        priceCents: 3000,
        available: true,
        durations: [{ minutes: 60, endTs: at(h + 1), priceCents: 3000 }],
      })),
    }) as ResourceSlotsDto;
  const NOW = Date.parse(at(9));

  it('start from the club’s cutoff, not from now', () => {
    const cells = (cutoff: number) =>
      gameHours(court('PADEL', [10, 12, 18]), 60, NOW, cutoff, 'Europe/Sofia').flatMap((g) =>
        g.cells.map((c) => c.startTs),
      );
    expect(cells(0)).toEqual([at(10), at(12), at(18)]);
    expect(cells(2)).toEqual([at(12), at(18)]);
    expect(cells(24)).toEqual([]);
  });

  it('a day has one only for the chosen sport', () => {
    const day = [court('PADEL', [10]), court('TENNIS', [18])];
    expect(anyGameHour(day, 'TENNIS', NOW, 4, 'Europe/Sofia')).toBe(true);
    expect(anyGameHour(day, 'PADEL', NOW, 4, 'Europe/Sofia')).toBe(false);
  });
});
