import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { VenueBooking, type Viewer } from '@/app/(public)/venues/[slug]/VenueBooking';
import type { InitialPick } from '@/app/(public)/venues/[slug]/booking-days';
import type { AvailabilityDto } from '@/app/api/v1/_lib/dto';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import {
  fail,
  installFakeFetch,
  ok,
  tick,
  type FakeAnswer,
  type FakeCall,
} from '../unit/data/fake-v1';

/**
 * The venue page's slot picker and confirmation sheet (#355), against the REAL
 * Bulgarian catalogue and a fake v1: what a player sees for each answer the
 * booking route can give.
 */

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));

const v = messages.venue;
const s = messages.venue.sheet;

// 2036-07-16, Sofia is UTC+3: 09:00 local = 06:00Z.
const AT = (h: number) => `2036-07-16T${String(h - 3).padStart(2, '0')}:00:00Z`;
const DAYS = Array.from({ length: 14 }, (_, i) =>
  new Date(Date.UTC(2036, 6, 16 + i)).toISOString().slice(0, 10),
);

const slot = (h: number, durations: number[]) => ({
  startTs: AT(h),
  endTs: AT(h + 1),
  priceCents: 2400,
  available: true,
  durations: durations.map((m) => ({
    minutes: m,
    endTs: AT(h + m / 60),
    priceCents: 2400 * (m / 60),
  })),
});

const availability = (overrides: Partial<AvailabilityDto> = {}): AvailabilityDto => ({
  venueId: 'v1',
  venueName: 'Алфа Кортове',
  timezone: 'Europe/Sofia',
  from: '2036-07-15T21:00:00Z',
  to: '2036-07-16T21:00:00Z',
  resources: [
    {
      resourceId: 'c1',
      name: 'Корт 1',
      sport: 'PADEL',
      currency: 'EUR',
      minBookingMinutes: 60,
      maxBookingMinutes: 120,
      slotStepMinutes: 60,
      slots: [
        slot(9, [60, 120]),
        { ...slot(10, []), available: false, blockedReason: 'booked', durations: undefined },
        slot(18, [60, 120]),
      ],
    },
  ],
  ...overrides,
});

const NO_PICK: InitialPick = {
  day: DAYS[0]!,
  court: null,
  start: null,
  minutes: null,
  confirm: false,
};

function mount({
  viewer = 'player',
  pick = NO_PICK,
  renderedAt = '2036-07-15T12:00:00Z',
  cutoffHours = 24,
}: {
  viewer?: Viewer;
  pick?: InitialPick;
  renderedAt?: string;
  cutoffHours?: number;
} = {}) {
  const ui = (
    <VenueBooking
      venue={{
        id: 'v1',
        name: 'Алфа Кортове',
        publicSlug: 'alfa',
        clubSlug: 'alpha-club',
        timezone: 'Europe/Sofia',
        cancellationCutoffHours: cutoffHours,
      }}
      days={DAYS}
      seed={{ day: DAYS[0]!, availability: availability() }}
      initialPick={pick}
      renderedAt={renderedAt}
      viewer={viewer}
    />
  );
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <TooltipProvider>
            {viewer === 'signed-out' ? ui : <ViewerScope viewerId="u1">{ui}</ViewerScope>}
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

/** A fake v1: availability always answers; the booking POST answers `booking()`. */
function api(booking: () => FakeAnswer | Promise<FakeAnswer>) {
  return installFakeFetch((call) => {
    if (call.method === 'POST') return booking();
    return ok(availability());
  });
}

const posts = (calls: FakeCall[]) => calls.filter((c) => c.method === 'POST');

const pickNine = () => fireEvent.click(screen.getByRole('button', { name: /^09:00/ }));
const openSheet = async () => {
  pickNine();
  fireEvent.click(screen.getByRole('button', { name: v.book }));
  return screen.findByRole('dialog');
};
const confirmIn = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByRole('button', { name: s.confirm }));

beforeEach(() => {
  push.mockReset();
  __resetSessionExpiryForTests();
  __resetViewerForTests();
  window.history.replaceState(null, '', '/venues/alfa');
});

describe('the slot picker', () => {
  it('offers the 14 club days, and each court’s free times with the server’s price', () => {
    api(() => ok({}));
    mount();

    const days = screen.getByRole('radiogroup', { name: v.day.label });
    expect(within(days).getAllByRole('radio')).toHaveLength(14);
    expect(within(days).getByRole('radio', { name: v.day.today })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(days).getByRole('radio', { name: v.day.tomorrow })).toBeInTheDocument();

    const times = screen.getByRole('group', { name: 'Часове, Корт 1' });
    // 10:00 is taken, so it is not offered.
    expect(
      within(times)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([expect.stringMatching(/^09:00 · 24\s€$/), expect.stringMatching(/^18:00 · 24\s€$/)]);
  });

  it('offers the court’s lengths, each start priced for the length chosen', () => {
    api(() => ok({}));
    mount();

    fireEvent.click(screen.getByRole('radio', { name: '120 мин' }));
    expect(screen.getByRole('button', { name: /^09:00/ }).textContent).toMatch(/48\s€$/);
  });

  it('does not offer a time that has already started', () => {
    api(() => ok({}));
    mount({ renderedAt: '2036-07-16T06:30:00Z' }); // 09:30 at the club
    expect(screen.queryByRole('button', { name: /^09:00/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^18:00/ })).toBeInTheDocument();
  });

  it('keeps the pick in the URL, so a reload keeps it', () => {
    api(() => ok({}));
    mount();
    pickNine();
    expect(window.location.search).toBe(
      `?day=${DAYS[0]}&court=c1&start=${encodeURIComponent(AT(9))}&min=60`,
    );
  });
});

describe('signed out', () => {
  it('Резервирай goes to sign-in, and back to this slot with the sheet open', () => {
    api(() => ok({}));
    mount({ viewer: 'signed-out' });
    pickNine();
    expect(screen.getByText(v.signInHint)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: v.book }));

    const next = `/venues/alfa?day=${DAYS[0]}&court=c1&start=${encodeURIComponent(AT(9))}&min=60&confirm=1`;
    expect(push).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(next)}`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('coming back from sign-in opens the sheet on the slot picked', async () => {
    api(() => ok({}));
    mount({ pick: { day: DAYS[0]!, court: 'c1', start: AT(18), minutes: 120, confirm: true } });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('18:00–20:00')).toBeInTheDocument();
    expect(within(dialog).getByText('48,00 €')).toBeInTheDocument();
  });
});

describe('a club account', () => {
  it('sees why it cannot book, and the button is off', () => {
    api(() => ok({}));
    mount({ viewer: 'club' });
    pickNine();
    expect(screen.getByText(v.clubAccount)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: v.book })).toBeDisabled();
  });
});

describe('the confirmation sheet', () => {
  it('shows court, date, time, length, price, paid at the club, and the cancel deadline', async () => {
    api(() => ok({}));
    mount({ renderedAt: '2036-07-14T12:00:00Z' }); // two days ahead: well before the cutoff
    const dialog = await openSheet();

    expect(within(dialog).getByText('Корт 1')).toBeInTheDocument();
    expect(within(dialog).getByText('09:00–10:00')).toBeInTheDocument();
    expect(within(dialog).getByText('60 мин')).toBeInTheDocument();
    expect(within(dialog).getByText('24,00 €')).toBeInTheDocument();
    expect(within(dialog).getByText(s.payAtClub)).toBeInTheDocument();
    expect(within(dialog).getByText(s.cancelUntilTitle)).toBeInTheDocument();
    // 24 h before 09:00 on the 16th, at the club.
    expect(within(dialog).getByText(/до вторник, 15 юли.*09:00/)).toBeInTheDocument();
  });

  it('says plainly when the slot is inside the club’s cutoff', async () => {
    api(() => ok({}));
    mount({ renderedAt: '2036-07-16T03:00:00Z' }); // 06:00 at the club, 3 h before
    const dialog = await openSheet();
    expect(within(dialog).getByText(s.noOnlineCancelTitle)).toBeInTheDocument();
    expect(within(dialog).getByText(/до 24 часа преди началото/)).toBeInTheDocument();
  });

  it('confirms with one POST carrying an Idempotency-Key, then lands in Резервации', async () => {
    const calls = api(() => ok({ id: 'b1', status: 'CONFIRMED' }, 201));
    mount();
    const dialog = await openSheet();

    confirmIn(dialog);
    // A second tap while the first is in flight sends nothing.
    confirmIn(dialog);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/me/bookings'));
    const sent = posts(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('/api/v1/t/alpha-club/bookings');
    expect(sent[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[0]!.headers['x-playerz-viewer']).toBe('u1');
    expect(sent[0]!.body).toEqual({ resourceId: 'c1', startTs: AT(9), endTs: AT(10) });
  });

  it('after a dropped connection, confirming again re-sends the SAME key', async () => {
    let n = 0;
    const calls = api(() => {
      n += 1;
      if (n === 1) throw new TypeError('Failed to fetch');
      return ok({ id: 'b1', status: 'CONFIRMED' }, 200);
    });
    mount();
    const dialog = await openSheet();

    confirmIn(dialog);
    expect(await within(dialog).findByText(s.error.failedTitle)).toBeInTheDocument();
    confirmIn(dialog);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/me/bookings'));
    const [first, second] = posts(calls);
    expect(second!.headers['idempotency-key']).toBe(first!.headers['idempotency-key']);
  });

  it('409 SLOT_TAKEN: says so, refreshes the day, and offers another pick', async () => {
    const calls = api(() => fail(409, 'SLOT_TAKEN'));
    mount();
    const dialog = await openSheet();
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(0));
    const readsBefore = calls.filter((c) => c.method === 'GET').length;

    confirmIn(dialog);
    expect(await within(dialog).findByText(s.error.slotTakenTitle)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: s.confirm })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(readsBefore),
    );

    fireEvent.click(within(dialog).getByRole('button', { name: s.pickAnother }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: v.book })).toBeDisabled();
  });

  it('403 NO_SHOW_BLOCKED: the server’s own words, and no confirm', async () => {
    const said = 'Не можете да резервирате онлайн в този клуб: имате 3 неявявания.';
    api(() => fail(403, 'NO_SHOW_BLOCKED', said));
    mount();
    const dialog = await openSheet();

    confirmIn(dialog);
    expect(await within(dialog).findByText(said)).toBeInTheDocument();
    expect(within(dialog).getByText(s.error.noShowBlockedTitle)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: s.confirm })).not.toBeInTheDocument();
  });

  it('409 BOOKING_LIMIT_REACHED (#380): how many, and the cap, in Bulgarian', async () => {
    api(() => ({
      status: 409,
      body: {
        error: {
          code: 'BOOKING_LIMIT_REACHED',
          message: 'limit',
          details: { limit: 3, upcoming: 3 },
        },
      },
    }));
    mount();
    const dialog = await openSheet();

    confirmIn(dialog);
    expect(
      await within(dialog).findByText(
        'Имате 3 предстоящи резервации в този клуб (максимум 3). Отменете някоя, за да резервирате нова.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: s.confirm })).not.toBeInTheDocument();
  });

  it('401: the session ended — sign in and come back to this slot', async () => {
    api(() => fail(401, 'UNAUTHORIZED', 'Authentication required'));
    mount();
    const dialog = await openSheet();

    confirmIn(dialog);
    const link = await within(dialog).findByRole('link', { name: s.signIn });
    expect(link.getAttribute('href')).toBe(
      `/login?next=${encodeURIComponent(
        `/venues/alfa?day=${DAYS[0]}&court=c1&start=${encodeURIComponent(AT(9))}&min=60&confirm=1`,
      )}`,
    );
  });
});

describe('another day', () => {
  it('reads it from the v1 availability endpoint, by the club’s calendar date', async () => {
    const calls = api(() => ok({}));
    mount();
    await act(tick);

    fireEvent.click(screen.getByRole('radio', { name: v.day.tomorrow }));
    await waitFor(() =>
      expect(calls.map((c) => c.url)).toContain(`/api/v1/venues/v1/availability?date=${DAYS[1]}`),
    );
  });
});
