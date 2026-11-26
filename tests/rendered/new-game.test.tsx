import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

import { NewGame } from '@/app/(public)/games/new/NewGame';
import type { AvailabilityDto, VenueSummary } from '@/app/api/v1/_lib/dto';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok, tick, type FakeCall } from '../unit/data/fake-v1';

/**
 * «Създай игра» in one flow (#697): the sport, the club, the hour, the
 * players, then ONE button books the court and opens its game, and the person
 * lands on the booking's page, where the game is. Against the real Bulgarian
 * catalogue and a fake v1.
 */

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const t = messages.games.new;

// Saturday 2026-11-14, 08:00 in Sofia (UTC+2).
const RENDERED_AT = '2026-11-14T06:00:00Z';
const at = (day: number, h: number) => new Date(Date.UTC(2026, 10, day, h - 2)).toISOString();

const club: VenueSummary = {
  id: 'v1',
  slug: 'alfa',
  clubSlug: 'alpha-club',
  publicSlug: 'alfa',
  name: 'Алфа Кортове',
  city: 'Sofia',
  cityKey: 'sofia',
  cityNames: { bg: 'София', en: 'Sofia' },
  country: 'BG',
  avgRating: 0,
  reviewCount: 0,
  sports: ['PADEL'],
  fromPriceCents: 2400,
  currency: 'EUR',
  clubLogoUrl: null,
  coverPhotoUrl: null,
  cover: null,
  lat: 42.69,
  lng: 23.32,
};
const noPrice: VenueSummary = { ...club, id: 'v0', name: 'Без корт', fromPriceCents: null };

/** One padel court; its hours `hours` (local) on `day` free. */
function day(dayOfMonth: number, hours: number[]): AvailabilityDto {
  return {
    venueId: 'v1',
    venueName: club.name,
    timezone: 'Europe/Sofia',
    from: at(dayOfMonth, 0),
    to: at(dayOfMonth + 1, 0),
    resources: [
      {
        resourceId: 'r1',
        name: 'Корт 1',
        sport: 'PADEL',
        resourceType: 'COURT',
        currency: 'EUR',
        minBookingMinutes: 60,
        maxBookingMinutes: 60,
        slotStepMinutes: 60,
        slots: hours.map((h) => ({
          startTs: at(dayOfMonth, h),
          endTs: at(dayOfMonth, h + 1),
          priceCents: 2400,
          available: true,
          durations: [{ minutes: 60, endTs: at(dayOfMonth, h + 1), priceCents: 2400 }],
        })),
      },
    ],
  };
}

function server(over: (c: FakeCall) => ReturnType<typeof ok> | undefined = () => undefined) {
  return installFakeFetch((c) => {
    const special = over(c);
    if (special) return special;
    if (c.url.startsWith('/api/v1/me/bookings?')) return ok({ items: [], nextCursor: null });
    if (c.url.startsWith('/api/v1/venues?'))
      return ok({ items: [noPrice, club], nextCursor: null });
    if (c.url === '/api/v1/venues/v1')
      return ok({ ...club, timezone: 'Europe/Sofia', cancellationCutoffHours: 4 });
    // Today: 10:00 is inside the 4-hour cutoff, 18:00 is not.
    if (c.url === '/api/v1/venues/v1/availability?date=2026-11-14') return ok(day(14, [10, 18]));
    if (c.method === 'POST' && c.url === '/api/v1/t/alpha-club/bookings')
      return ok({ id: 'b1', status: 'CONFIRMED' }, 201);
    if (c.method === 'GET' && c.url === '/api/v1/me/bookings/b1/game')
      return ok({ canOpen: true, maxSpots: 3, game: null });
    if (c.method === 'PUT' && c.url === '/api/v1/me/bookings/b1/game')
      return ok({ canOpen: false, maxSpots: 0, game: { id: 'g1' } });
    return ok(null);
  });
}

function mount() {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <ViewerScope viewerId="u1">
            <NewGame sports={['PADEL', 'TENNIS']} renderedAt={RENDERED_AT} />
          </ViewerScope>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

beforeEach(() => {
  push.mockReset();
  __resetSessionExpiryForTests();
  __resetViewerForTests();
  jest.useFakeTimers({ now: Date.parse(RENDERED_AT), doNotFake: ['setTimeout', 'queueMicrotask'] });
});
afterEach(() => jest.useRealTimers());

async function pickClubAndHour() {
  const clubs = await screen.findByTestId('new-game-clubs');
  // Only a club with a price can be booked.
  expect(within(clubs).queryByText('Без корт')).not.toBeInTheDocument();
  await userEvent.click(within(clubs).getByRole('button', { name: /Алфа Кортове/ }));
  const hours = await screen.findByTestId('new-game-hours');
  expect(screen.getByText('Играта се пуска най-късно 4 часа преди началото.')).toBeInTheDocument();
  // Inside the club's 4-hour cutoff a game cannot open: 10:00 is not offered.
  expect(within(hours).queryByRole('button', { name: /^10:00/ })).not.toBeInTheDocument();
  await userEvent.click(within(hours).getByRole('button', { name: /^18:00/ }));
}

describe('«Създай игра» (#697)', () => {
  it('books the court, opens its game, and lands on it', async () => {
    const calls = server();
    mount();
    expect(screen.getByRole('radio', { name: messages.sports.PADEL })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(calls.some((c) => c.url === '/api/v1/venues?limit=50&sport=PADEL')).toBe(true);

    await pickClubAndHour();
    const players = screen.getByTestId('new-game-players');
    await userEvent.click(within(players).getByRole('radio', { name: '5' }));
    await userEvent.type(screen.getByTestId('new-game-note'), 'двама за двойки');
    await userEvent.click(screen.getByTestId('new-game-create'));
    await act(tick);
    await act(tick);

    const writes = calls.filter((c) => c.method !== 'GET' || c.url.endsWith('/game'));
    expect(writes.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/v1/t/alpha-club/bookings',
      'GET /api/v1/me/bookings/b1/game',
      'PUT /api/v1/me/bookings/b1/game',
    ]);
    expect(writes[0]!.body).toEqual({
      resourceId: 'r1',
      startTs: at(14, 18),
      endTs: at(14, 19),
    });
    expect(writes[0]!.headers['idempotency-key']).toBeTruthy();
    // No more players than the court holds: 5 asked, 3 free.
    expect(writes[2]!.body).toEqual({
      spots: 3,
      levelMin: null,
      levelMax: null,
      note: 'двама за двойки',
    });
    expect(push).toHaveBeenCalledWith('/me/bookings/b1');
  });

  it('a booked hour whose game did not open says so, and links the booking', async () => {
    server((c) =>
      c.method === 'GET' && c.url === '/api/v1/me/bookings/b1/game'
        ? ok({ canOpen: false, maxSpots: 0, game: null })
        : undefined,
    );
    mount();
    await pickClubAndHour();
    await userEvent.click(screen.getByTestId('new-game-create'));
    await act(tick);
    await act(tick);

    const notice = await screen.findByTestId('new-game-no-game');
    expect(notice).toHaveTextContent(t.noGame);
    expect(within(notice).getByRole('link', { name: t.toBooking })).toHaveAttribute(
      'href',
      '/me/bookings/b1',
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('an hour taken meanwhile is said so, and no game is asked for', async () => {
    const calls = server((c) => (c.method === 'POST' ? fail(409, 'SLOT_TAKEN') : undefined));
    mount();
    await pickClubAndHour();
    await userEvent.click(screen.getByTestId('new-game-create'));
    await act(tick);
    await act(tick);

    expect(await screen.findByText(messages.venue.sheet.error.slotTakenTitle)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/game'))).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('a day with no hour a game can open on moves to the next', async () => {
    server((c) =>
      c.url === '/api/v1/venues/v1/availability?date=2026-11-14'
        ? ok(day(14, [10]))
        : c.url === '/api/v1/venues/v1/availability?date=2026-11-15'
          ? ok(day(15, [9, 19]))
          : undefined,
    );
    mount();
    const clubs = await screen.findByTestId('new-game-clubs');
    await userEvent.click(within(clubs).getByRole('button', { name: /Алфа Кортове/ }));
    const hours = await screen.findByTestId('new-game-hours');
    expect(within(hours).getByRole('button', { name: /^09:00/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: t.tomorrow })).toHaveAttribute('aria-checked', 'true');
  });
});
