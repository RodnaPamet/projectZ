import { act, render, screen } from '@testing-library/react';

import { DayGrid, type DayBooking } from '@/app/(app)/t/[slug]/admin/calendar/DayGrid';
import type { DiaryDay } from '@/app/(app)/t/[slug]/admin/calendar/diary-day';
import { STALE_AFTER_MS } from '@/lib/hooks/use-refresh-when-stale';

import { withIntl } from '../helpers/intl';

/**
 * THE DIARY REFRESHES ITS DAY, NOT THE ROUTE (#314).
 *
 * A stale diary used to call `router.refresh()`, which in Next 16.3.6 purges
 * the whole client router cache: every diary revisit after 10 s turned every
 * other warm admin screen cold. It now re-fetches only the day, through
 * `refreshDiaryDayAction`, and swaps it into the grid. These pin the
 * user-visible half: a stale grid still replaces itself with fresh bookings,
 * without the router being asked for anything. That the action leaves the
 * router cache alone is the action's half: it revalidates nothing
 * (tests/unit/diary-refresh-action.test.ts, and the guardrail in
 * router-cache-policy.test.ts).
 */

const routerRefresh = jest.fn();
const router = { refresh: routerRefresh, push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => router }));

const refreshDiaryDayAction = jest.fn();
jest.mock('@/app/(app)/t/[slug]/admin/calendar/actions', () => ({
  markNoShowAction: jest.fn(),
  refreshDiaryDayAction: (...args: unknown[]) => refreshDiaryDayAction(...args),
}));

const booking = (id: string, who: string): DayBooking => ({
  id,
  resourceId: 'r1',
  startLabel: '18:00',
  endLabel: '19:00',
  startOffsetMinutes: 600,
  durationMinutes: 60,
  status: 'CONFIRMED',
  who,
  priceLabel: '€24.00',
  expiresLabel: null,
  canMarkNoShow: false,
});

const dayOf = (renderedAt: number, ...who: string[]): DiaryDay => ({
  isoDay: '2026-09-29',
  prevDay: '2026-09-28',
  nextDay: '2026-09-30',
  isToday: true,
  dayLabel: 'Tuesday',
  courts: [{ id: 'r1', name: 'Court 1', venueName: null }],
  bookings: who.map((w, i) => booking(`b${i}`, w)),
  firstHour: 8,
  lastHour: 22,
  renderedAt,
});

/** Each test is its own club: the grid remembers fetched days in module state, as in the app. */
let n = 0;
let hour = 0;
const nextClub = () => `club-${++n}`;

const grid = (slug: string, day: DiaryDay, requestedDay: string | null = null) =>
  render(withIntl(<DayGrid slug={slug} requestedDay={requestedDay} day={day} />));

/** Let the mocked action's promise settle inside act. */
const flush = () => act(async () => {});

beforeEach(() => {
  // Each test starts an hour after the last: the stale-check's memory is keyed
  // by `renderedAt` (module state, as in the app), so payloads must not repeat.
  jest.useFakeTimers({ now: new Date('2026-09-30T10:00:00Z').getTime() + ++hour * 3_600_000 });
  routerRefresh.mockClear();
  refreshDiaryDayAction.mockReset();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});
afterEach(() => jest.useRealTimers());

describe('DayGrid: a stale diary re-fetches its day', () => {
  it('THE POINT: a cached grid revisited after 10 s swaps in fresh bookings, and never refreshes the router', async () => {
    const slug = nextClub();
    const cached = dayOf(Date.now(), 'Ivo');
    grid(slug, cached).unmount();

    act(() => jest.advanceTimersByTime(STALE_AFTER_MS + 1));
    refreshDiaryDayAction.mockResolvedValue(dayOf(Date.now(), 'Ivo', 'Maria'));

    // The revisit: the router cache remounts the same server payload.
    grid(slug, cached);
    // Painted at once, from the cache.
    expect(screen.getByText('Ivo')).toBeInTheDocument();
    expect(screen.queryByText('Maria')).not.toBeInTheDocument();

    await flush();
    expect(refreshDiaryDayAction).toHaveBeenCalledTimes(1);
    expect(refreshDiaryDayAction).toHaveBeenCalledWith(slug, null);
    expect(screen.getByText('Maria')).toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('asks for the day the URL asked for', async () => {
    const slug = nextClub();
    grid(slug, dayOf(Date.now(), 'Ivo'), '2026-09-29');
    act(() => jest.advanceTimersByTime(STALE_AFTER_MS + 1));
    refreshDiaryDayAction.mockResolvedValue(dayOf(Date.now(), 'Ivo'));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    expect(refreshDiaryDayAction).toHaveBeenCalledWith(slug, '2026-09-29');
  });

  it('does nothing for a fresh grid', async () => {
    grid(nextClub(), dayOf(Date.now(), 'Ivo'));
    await flush();
    expect(refreshDiaryDayAction).not.toHaveBeenCalled();
  });

  it('a later revisit paints the newest copy it fetched, not the older cached payload', async () => {
    const slug = nextClub();
    const cached = dayOf(Date.now(), 'Ivo');
    grid(slug, cached).unmount();
    act(() => jest.advanceTimersByTime(STALE_AFTER_MS + 1));
    refreshDiaryDayAction.mockResolvedValue(dayOf(Date.now(), 'Ivo', 'Maria'));
    grid(slug, cached).unmount();
    await flush();
    expect(refreshDiaryDayAction).toHaveBeenCalledTimes(1);

    // Back again 5 s later: the router still holds the OLD payload.
    act(() => jest.advanceTimersByTime(5_000));
    grid(slug, cached);
    await flush();
    expect(screen.getByText('Maria')).toBeInTheDocument();
    // The copy on screen is 5 s old, so nothing is fetched.
    expect(refreshDiaryDayAction).toHaveBeenCalledTimes(1);
  });

  it('a newer server payload (after a write revalidated the diary) beats a fetched copy', async () => {
    const slug = nextClub();
    const cached = dayOf(Date.now(), 'Ivo');
    const view = grid(slug, cached);
    act(() => jest.advanceTimersByTime(STALE_AFTER_MS + 1));
    refreshDiaryDayAction.mockResolvedValue(dayOf(Date.now(), 'Ivo', 'Maria'));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    expect(screen.getByText('Maria')).toBeInTheDocument();

    act(() => jest.advanceTimersByTime(1_000));
    view.rerender(
      withIntl(<DayGrid slug={slug} requestedDay={null} day={dayOf(Date.now(), 'Petar')} />),
    );
    expect(screen.getByText('Petar')).toBeInTheDocument();
    expect(screen.queryByText('Maria')).not.toBeInTheDocument();
  });

  it('keeps the grid on screen when the refresh fails, and tries again at most once per window', async () => {
    const slug = nextClub();
    grid(slug, dayOf(Date.now(), 'Ivo'));
    act(() => jest.advanceTimersByTime(STALE_AFTER_MS + 1));
    refreshDiaryDayAction.mockRejectedValue(new Error('offline'));

    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    expect(refreshDiaryDayAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Ivo')).toBeInTheDocument();

    act(() => jest.advanceTimersByTime(STALE_AFTER_MS + 1));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    expect(refreshDiaryDayAction).toHaveBeenCalledTimes(2);
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
