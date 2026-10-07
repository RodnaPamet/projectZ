import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import {
  asCancelled,
  BookingDetail,
  cancelErrorKey,
  cancelState,
} from '@/app/(public)/me/bookings/[id]/BookingDetail';
import { directionsUrl } from '@/app/(public)/me/bookings/[id]/directions';
import { MyBookingsTabs } from '@/app/(public)/me/bookings/MyBookingsTabs';
import type { MyBookingDetailDto, MyBookingDto } from '@/app/api/v1/_lib/dto';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { ApiClientError } from '@/lib/data/errors';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok, tick, type FakeAnswer } from '../unit/data/fake-v1';

/**
 * #359: the booking detail page's states and its cancel, and the Предстоящи /
 * Минали tabs, against the REAL Bulgarian catalogue and a fake v1.
 */

const mb = messages.myBookings;
const d = mb.detail;
const HOUR = 3_600_000;

// 16:00 UTC is 19:00 in Sofia (EEST) on this date.
const START = Date.parse('2026-10-20T16:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const detail = (over: Partial<MyBookingDetailDto> = {}): MyBookingDetailDto => ({
  id: 'bk1',
  status: 'CONFIRMED',
  startTs: iso(START),
  endTs: iso(START + 1.5 * HOUR),
  totalCents: 2400,
  currency: 'EUR',
  expiresAt: null,
  cancelledAt: null,
  createdAt: '2026-10-01T10:00:00Z',
  cancellableUntil: iso(START - 24 * HOUR),
  resource: { id: 'r1', name: 'Корт 1', sport: 'PADEL', resourceType: 'COURT' },
  venue: {
    id: 'v1',
    name: 'Алфа Кортове',
    timezone: 'Europe/Sofia',
    publicSlug: 'alfa-kortove',
    addressLine: 'ул. Тестова 1',
    city: 'София',
    lat: 42.69,
    lng: 23.32,
    phone: '+359 2 123 4567',
  },
  clubSlug: 'alpha',
  venueReview: null,
  canReview: false,
  payAtClub: true,
  players: [
    {
      participantId: null,
      name: 'Иван Петров',
      avatarUrl: null,
      isBooker: true,
      isYou: true,
      registered: true,
    },
  ],
  capacity: 4,
  spotsLeft: 3,
  playersOpen: true,
  viewerRole: 'BOOKER',
  ...over,
});

function mount(seed: MyBookingDetailDto, now: number) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <ViewerScope viewerId="usr_player">
            <BookingDetail seed={seed} serverNow={now} />
          </ViewerScope>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * The page re-reads the device clock after mount (`useNow`), so the clock is
 * pinned: two days before the game unless a test says otherwise. A spy, not
 * fake timers: the fake v1 and SWR need real ones to settle.
 */
let clock: jest.SpyInstance<number, []>;
const setNow = (ms: number) => clock.mockReturnValue(ms);

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
  clock = jest.spyOn(Date, 'now').mockReturnValue(START - 48 * HOUR);
});
afterEach(() => {
  clock.mockRestore();
});

describe('cancelState: the cutoff, decided from the server’s deadline', () => {
  const b = { startTs: iso(START), cancellableUntil: iso(START - 24 * HOUR) };

  it('is open before the deadline, and AT it (inclusive, as the server)', () => {
    expect(cancelState(b, START - 25 * HOUR)).toBe('open');
    expect(cancelState(b, START - 24 * HOUR)).toBe('open');
  });
  it('has passed one millisecond after it', () => {
    expect(cancelState(b, START - 24 * HOUR + 1)).toBe('passed');
  });
  it('has passed at the start even with a cutoff of 0', () => {
    expect(cancelState({ ...b, cancellableUntil: iso(START) }, START)).toBe('passed');
  });
  it('is none when the server says the booking is not cancellable', () => {
    expect(cancelState({ ...b, cancellableUntil: null }, 0)).toBe('none');
  });
});

describe('cancelErrorKey', () => {
  const e = (status: number, code: string) => new ApiClientError({ status, code, message: code });
  it('maps the refusals', () => {
    expect(cancelErrorKey(e(403, 'CANCELLATION_CUTOFF_PASSED'))).toBe('CUTOFF_PASSED');
    expect(cancelErrorKey(e(409, 'CONFLICT'))).toBe('NOT_CANCELLABLE');
    expect(cancelErrorKey(e(500, 'INTERNAL'))).toBe('FAILED');
    expect(cancelErrorKey(new Error('offline'))).toBe('FAILED');
  });
  it('has words for every key it shows, in both catalogues', () => {
    for (const k of ['NOT_CANCELLABLE', 'FAILED'] as const) {
      expect(d.cancelError[k]).toBeTruthy();
    }
  });
});

describe('the detail page', () => {
  it('shows venue, court, sport, the time in the VENUE’s zone, the price paid at the club, and the address', () => {
    installFakeFetch(() => ok(detail()));
    mount(detail(), START - 48 * HOUR);

    expect(screen.getByRole('heading', { level: 1, name: 'Алфа Кортове' })).toBeInTheDocument();
    expect(screen.getAllByText(/Корт 1 · Падел/).length).toBeGreaterThan(0);
    expect(screen.getByText(/19:00 – 20:30/)).toBeInTheDocument();
    expect(screen.getByText(/24,00/)).toBeInTheDocument();
    expect(screen.getByText(d.payAtClub)).toBeInTheDocument();
    expect(screen.getByText('ул. Тестова 1')).toBeInTheDocument();
    expect(screen.getByTestId('booking-status')).toHaveTextContent(mb.status.CONFIRMED);
    expect(document.querySelector('[data-perf-ready]')).not.toBeNull();
  });

  it('links directions to maps from the address, in a new tab, and back to the venue page', () => {
    installFakeFetch(() => ok(detail()));
    mount(detail(), START - 48 * HOUR);

    const dir = screen.getByTestId('booking-directions');
    expect(dir).toHaveAttribute('href', directionsUrl(detail().venue));
    expect(dir.getAttribute('href')).toContain('destination=');
    expect(dir).toHaveAttribute('target', '_blank');
    expect(dir).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByRole('link', { name: d.venuePage })).toHaveAttribute(
      'href',
      '/venues/alfa-kortove',
    );
  });

  it('lists the players: the booker as "you", guests marked', () => {
    installFakeFetch(() => ok(detail()));
    mount(
      detail({
        players: [
          {
            participantId: null,
            name: 'Иван Петров',
            avatarUrl: null,
            isBooker: true,
            isYou: true,
            registered: true,
          },
          {
            participantId: 'bp1',
            name: 'Мария',
            avatarUrl: null,
            isBooker: false,
            isYou: false,
            registered: true,
          },
          {
            participantId: 'bp2',
            name: 'Гост Георги',
            avatarUrl: null,
            isBooker: false,
            isYou: false,
            registered: false,
          },
        ],
      }),
      START - 48 * HOUR,
    );
    const rows = within(screen.getByTestId('booking-players')).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(d.you);
    expect(rows[0]).toHaveTextContent(d.booker);
    expect(rows[1]).toHaveTextContent('Мария');
    expect(rows[2]).toHaveTextContent(d.guest);
  });

  it('before the cutoff: says until when, and the button is enabled', () => {
    installFakeFetch(() => ok(detail()));
    mount(detail(), START - 48 * HOUR);

    expect(screen.getByRole('button', { name: d.cancel })).toBeEnabled();
    expect(screen.getByText(/Можете да отмените до/)).toBeInTheDocument();
    expect(screen.queryByTestId('booking-cutoff-passed')).not.toBeInTheDocument();
  });

  it('after the cutoff: the button is disabled, with the reason and the club’s phone', () => {
    setNow(START - 2 * HOUR);
    installFakeFetch(() => ok(detail()));
    mount(detail(), START - 2 * HOUR);

    expect(screen.getByRole('button', { name: d.cancel })).toBeDisabled();
    const notice = screen.getByTestId('booking-cutoff-passed');
    expect(notice).toHaveTextContent(/Срокът за отмяна изтече/);
    expect(within(notice).getByRole('link')).toHaveAttribute('href', 'tel:+35921234567');
  });

  it('a cancelled booking says Отменена and offers no cancel', () => {
    installFakeFetch(() => ok(detail({ status: 'CANCELLED', cancellableUntil: null })));
    mount(detail({ status: 'CANCELLED', cancellableUntil: null }), START - 48 * HOUR);

    expect(screen.getByTestId('booking-status')).toHaveTextContent('Отменена');
    expect(screen.queryByRole('button', { name: d.cancel })).not.toBeInTheDocument();
  });

  it('cancel: confirm, Отменена at once, POSTed to the v1 cancel route, then re-read', async () => {
    const held = deferred<FakeAnswer>();
    let cancelled = false;
    const calls = installFakeFetch((c) => {
      if (c.method === 'POST') return held.promise;
      return ok(cancelled ? detail({ status: 'CANCELLED', cancellableUntil: null }) : detail());
    });
    mount(detail(), START - 48 * HOUR);

    fireEvent.click(screen.getByRole('button', { name: d.cancel }));
    const dialog = await screen.findByRole('dialog', { name: d.confirm.title });
    fireEvent.click(within(dialog).getByRole('button', { name: d.confirm.yes }));

    await waitFor(() => expect(screen.getByTestId('booking-status')).toHaveTextContent('Отменена'));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/v1/t/alpha/bookings/bk1/cancel');
    expect(post.headers['x-playerz-viewer']).toBe('usr_player');

    cancelled = true;
    await act(async () => {
      held.resolve(ok({ refundPercent: 0, refundAmountCents: 0 }));
      await tick();
    });
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === 'GET' && c.url === '/api/v1/me/bookings/bk1').length,
      ).toBeGreaterThanOrEqual(1),
    );
    expect(screen.getByTestId('booking-status')).toHaveTextContent('Отменена');
    expect(screen.queryByRole('button', { name: d.cancel })).not.toBeInTheDocument();
  });

  it('a 403 CANCELLATION_CUTOFF_PASSED rolls back and shows the cutoff state', async () => {
    installFakeFetch((c) =>
      c.method === 'POST' ? fail(403, 'CANCELLATION_CUTOFF_PASSED') : ok(detail()),
    );
    mount(detail(), START - 48 * HOUR);

    fireEvent.click(screen.getByRole('button', { name: d.cancel }));
    const dialog = await screen.findByRole('dialog', { name: d.confirm.title });
    fireEvent.click(within(dialog).getByRole('button', { name: d.confirm.yes }));

    expect(await screen.findByTestId('booking-cutoff-passed')).toBeInTheDocument();
    expect(screen.getByTestId('booking-status')).toHaveTextContent(mb.status.CONFIRMED);
    expect(screen.getByRole('button', { name: d.cancel })).toBeDisabled();
  });

  it('asCancelled is pure and clears the deadline', () => {
    const b = detail();
    const out = asCancelled(b, new Date('2026-10-18T10:00:00.123Z'));
    expect(out).toMatchObject({
      status: 'CANCELLED',
      cancellableUntil: null,
      cancelledAt: '2026-10-18T10:00:00Z',
    });
    expect(b.status).toBe('CONFIRMED');
  });
});

describe('the Предстоящи / Минали tabs', () => {
  const row = (over: Partial<MyBookingDto>): MyBookingDto => {
    const { players: _p, payAtClub: _a, venue, ...rest } = detail();
    return {
      ...rest,
      venue: { id: venue.id, name: venue.name, timezone: venue.timezone },
      ...over,
    };
  };

  function mountTabs(seed: MyBookingDto[]) {
    return render(
      withIntl(
        <DataProvider>
          <SWRConfig value={{ provider: () => new Map() }}>
            <ViewerScope viewerId="usr_player">
              <MyBookingsTabs
                initialTab="upcoming"
                seed={{ items: seed, nextCursor: null }}
                reviewMaxLength={2000}
              />
            </ViewerScope>
          </SWRConfig>
        </DataProvider>,
      ),
    );
  }

  it('opens on Предстоящи from the seed; Минали is read on first switch, behind a skeleton', async () => {
    const past = deferred<FakeAnswer>();
    const calls = installFakeFetch((c) =>
      c.url.includes('when=past')
        ? past.promise
        : ok({ items: [row({ id: 'up1' })], nextCursor: null }),
    );
    mountTabs([row({ id: 'up1' })]);

    expect(screen.getByRole('radio', { name: mb.tabs.upcoming })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText('Алфа Кортове')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: mb.tabs.past }));
    expect(screen.getByTestId('my-bookings-skeleton')).toBeInTheDocument();
    expect(window.location.search).toBe('?tab=past');

    await act(async () => {
      past.resolve(
        ok({
          items: [row({ id: 'p1', status: 'CANCELLED', cancellableUntil: null })],
          nextCursor: null,
        }),
      );
      await tick();
    });
    expect(await screen.findByText('Отменена')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/v1/me/bookings?when=past')).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: mb.tabs.upcoming }));
    expect(window.location.search).toBe('');
  });

  it('each card opens its booking', () => {
    installFakeFetch(() => ok({ items: [row({ id: 'up1' })], nextCursor: null }));
    mountTabs([row({ id: 'up1' })]);
    expect(screen.getByTestId('booking-card-link')).toHaveAttribute('href', '/me/bookings/up1');
  });

  it('an empty Предстоящи offers the venues', () => {
    installFakeFetch(() => ok({ items: [], nextCursor: null }));
    mountTabs([]);
    expect(screen.getByText(mb.empty.upcoming.title)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: mb.browse })).toHaveAttribute('href', '/venues');
  });
});

describe('directionsUrl', () => {
  it('is Google’s cross-platform directions link to the name and address', () => {
    const url = new URL(
      directionsUrl({ name: 'Алфа', addressLine: ' ул. Тестова 1 ', city: 'София' }),
    );
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/dir/');
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('destination')).toBe('Алфа, ул. Тестова 1, София');
  });
});
