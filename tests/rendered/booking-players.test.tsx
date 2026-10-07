import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { BookingPlayers, playersErrorKey } from '@/app/(app)/me/bookings/[id]/BookingPlayers';
import {
  copyInviteLink,
  InvitePlayersSheet,
  shareInviteLink,
} from '@/app/(app)/me/bookings/[id]/InvitePlayersSheet';
import type { BookingPlayerDto, MyBookingDetailDto } from '@/app/api/v1/_lib/dto';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { ApiClientError } from '@/lib/data/errors';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok, type FakeCall } from '../unit/data/fake-v1';

/**
 * #358: "Играчи" on the booking detail and the "Покани играчи" sheet, against
 * the REAL Bulgarian catalogue and a fake v1. The states: the booker's list
 * with Премахни, an added player's Напусни, the sheet before and after a link
 * is made, shared or copied, a full court, and the co-player list.
 */
const p = messages.myBookings.players;
const d = messages.myBookings.detail;

const player = (over: Partial<BookingPlayerDto>): BookingPlayerDto => ({
  participantId: null,
  name: 'Иван Петров',
  avatarUrl: null,
  isBooker: true,
  isYou: true,
  registered: true,
  ...over,
});

const booking = (over: Partial<MyBookingDetailDto> = {}): MyBookingDetailDto => ({
  id: 'bk1',
  status: 'CONFIRMED',
  startTs: '2026-10-20T16:00:00Z',
  endTs: '2026-10-20T17:30:00Z',
  totalCents: 2400,
  currency: 'EUR',
  expiresAt: null,
  cancelledAt: null,
  createdAt: '2026-10-01T10:00:00Z',
  cancellableUntil: '2026-10-19T16:00:00Z',
  resource: { id: 'r1', name: 'Корт 1', sport: 'PADEL', resourceType: 'COURT' },
  venue: {
    id: 'v1',
    name: 'Алфа Кортове',
    timezone: 'Europe/Sofia',
    publicSlug: 'alfa',
    addressLine: 'ул. Тестова 1',
    city: 'София',
    lat: 42.69,
    lng: 23.32,
    phone: null,
  },
  clubSlug: 'alpha',
  venueReview: null,
  canReview: false,
  viewerRole: 'BOOKER',
  payAtClub: true,
  players: [
    player({}),
    player({ participantId: 'bp1', name: 'Мария', isBooker: false, isYou: false }),
  ],
  capacity: 4,
  spotsLeft: 2,
  playersOpen: true,
  ...over,
});

const LINK = {
  id: 'ln1',
  token: 'T'.repeat(43),
  url: `https://playerz.bg/invite/booking/${'T'.repeat(43)}`,
  expiresAt: '2026-10-20T16:00:00Z',
};

function wrap(node: React.ReactNode) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          {/* The app root provides the TooltipProvider the Sheet's close button needs. */}
          <TooltipProvider>
            <ViewerScope viewerId="usr_booker">{node}</ViewerScope>
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

/** A v1 that answers the sheet's two reads, and records the writes. */
function fakeV1(
  opts: { coPlayers?: unknown[]; spotsLeft?: number; liveInviteLinks?: number } = {},
  write?: (c: FakeCall) => ReturnType<typeof ok> | undefined,
) {
  return installFakeFetch((c) => {
    const answered = write?.(c);
    if (answered) return answered;
    if (c.url.endsWith('/participants') && c.method === 'GET') {
      return ok({
        viewerRole: 'BOOKER',
        capacity: 4,
        spotsLeft: opts.spotsLeft ?? 2,
        playersOpen: true,
        liveInviteLinks: opts.liveInviteLinks ?? 0,
        players: [],
      });
    }
    if (c.url.endsWith('/co-players')) return ok(opts.coPlayers ?? []);
    if (c.url.endsWith('/invite-links') && c.method === 'POST') return ok(LINK, 201);
    return ok({});
  });
}

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('the players list', () => {
  it('shows the booker as "you", and Премахни on each added player, for the booker', () => {
    installFakeFetch(() => ok({}));
    wrap(<BookingPlayers booking={booking()} date="20 окт." time="19:00" />);

    const rows = within(screen.getByTestId('booking-players')).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent(d.you);
    expect(rows[0]).toHaveTextContent(d.booker);
    expect(within(rows[0]!).queryByTestId('booking-player-remove')).toBeNull();
    expect(within(rows[1]!).getByTestId('booking-player-remove')).toHaveTextContent(p.remove);
    expect(screen.getByTestId('booking-invite-open')).toHaveTextContent(p.invite);
    expect(screen.queryByTestId('booking-leave')).toBeNull();
    expect(screen.getByTestId('booking-spots-left')).toHaveTextContent('2 свободни места');
  });

  it('an added player gets Напусни, and no invite or remove', () => {
    installFakeFetch(() => ok({}));
    wrap(
      <BookingPlayers
        booking={booking({
          viewerRole: 'PARTICIPANT',
          cancellableUntil: null,
          players: [
            player({ isYou: false }),
            player({ participantId: 'bp1', name: 'Мария', isBooker: false, isYou: true }),
          ],
        })}
        date="20 окт."
        time="19:00"
      />,
    );
    expect(screen.getByTestId('booking-leave')).toHaveTextContent(p.leave);
    expect(screen.queryByTestId('booking-invite-open')).toBeNull();
    expect(screen.queryByTestId('booking-player-remove')).toBeNull();
  });

  it('after the start, nothing to press', () => {
    installFakeFetch(() => ok({}));
    wrap(<BookingPlayers booking={booking({ playersOpen: false })} date="20 окт." time="19:00" />);
    expect(screen.queryByTestId('booking-invite-open')).toBeNull();
    expect(screen.queryByTestId('booking-player-remove')).toBeNull();
    expect(screen.getByText(p.closed)).toBeInTheDocument();
  });

  it('removes a player after asking, through DELETE …/participants/{id}', async () => {
    const calls = installFakeFetch(() => ({ status: 204 }));
    wrap(<BookingPlayers booking={booking()} date="20 окт." time="19:00" />);

    fireEvent.click(screen.getByTestId('booking-player-remove'));
    const confirm = await screen.findByRole('button', { name: p.removeConfirm.yes });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === 'DELETE' && c.url === '/api/v1/me/bookings/bk1/participants/bp1',
        ),
      ).toBe(true),
    );
  });
});

describe('the invite sheet', () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')!;
  afterEach(() => Object.defineProperty(globalThis, 'navigator', nav));
  const setNavigator = (n: Partial<Navigator>) =>
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { ...navigator, ...n },
    });

  const mount = (b = booking()) =>
    wrap(
      <InvitePlayersSheet booking={b} date="20 окт." time="19:00" open onOpenChange={() => {}} />,
    );

  it('before a link: Сподели връзка, the places left, and an empty co-player list', async () => {
    fakeV1();
    mount();
    expect(await screen.findByTestId('invite-share')).toHaveTextContent(p.share);
    expect(screen.queryByTestId('invite-link')).toBeNull();
    expect(await screen.findByText(p.recentEmpty)).toBeInTheDocument();
  });

  it('makes a link and hands it to the native share sheet', async () => {
    const share = jest.fn().mockResolvedValue(undefined);
    setNavigator({ share });
    const calls = fakeV1();
    mount();

    fireEvent.click(await screen.findByTestId('invite-share'));

    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(share.mock.calls[0][0]).toMatchObject({ url: LINK.url, title: p.shareTitle });
    expect(share.mock.calls[0][0].text).toContain('Алфа Кортове');
    expect(
      calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/me/bookings/bk1/invite-links'),
    ).toHaveLength(1);
    expect(screen.getByTestId('invite-url')).toHaveTextContent(LINK.url);

    // A second press shares the same link rather than making another.
    fireEvent.click(screen.getByTestId('invite-share'));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('copies where there is no share sheet, and says so', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    setNavigator({ share: undefined, clipboard: { writeText } as unknown as Clipboard });
    fakeV1();
    mount();

    fireEvent.click(await screen.findByTestId('invite-share'));
    expect(await screen.findByTestId('invite-copied')).toHaveTextContent(p.copied);
    expect(writeText).toHaveBeenCalledWith(LINK.url);
  });

  it('a full court says so and offers no add; the link can still be shared', async () => {
    fakeV1({ spotsLeft: 0, coPlayers: [{ userId: 'u2', name: 'Петър', avatarUrl: null }] });
    mount(booking({ spotsLeft: 0 }));
    expect(await screen.findByTestId('invite-full')).toHaveTextContent(p.full);
    expect(await screen.findByTestId('invite-add')).toBeDisabled();
    expect(screen.getByTestId('invite-share')).toBeEnabled();
  });

  it('adds a co-player with POST …/participants', async () => {
    const calls = fakeV1({ coPlayers: [{ userId: 'u2', name: 'Петър', avatarUrl: null }] });
    mount();
    fireEvent.click(await screen.findByTestId('invite-add'));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url === '/api/v1/me/bookings/bk1/participants')
          ?.body,
      ).toEqual({ userId: 'u2' }),
    );
  });

  it('offers to stop live links, and says players stay', async () => {
    const calls = fakeV1({ liveInviteLinks: 2 });
    mount();
    expect(await screen.findByTestId('invite-live-links')).toHaveTextContent('2 активни връзки');
    fireEvent.click(screen.getByTestId('invite-stop'));
    expect(await screen.findByTestId('invite-stopped')).toHaveTextContent(p.linksStopped);
    expect(
      calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/me/bookings/bk1/invite-links'),
    ).toBe(true);
  });

  it('says why a link was refused', async () => {
    installFakeFetch((c) =>
      c.method === 'POST'
        ? fail(409, 'TOO_MANY_INVITE_LINKS')
        : ok(c.url.endsWith('co-players') ? [] : {}),
    );
    mount();
    fireEvent.click(await screen.findByTestId('invite-share'));
    expect(await screen.findByTestId('invite-error')).toHaveTextContent(p.error.TOO_MANY);
  });
});

describe('sharing, without a browser', () => {
  const data = { title: 't', text: 'x', url: 'https://playerz.bg/invite/booking/abc' };

  it('a dismissed share sheet is not an error', async () => {
    const share = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('x'), { name: 'AbortError' }));
    expect(await shareInviteLink({ share } as unknown as Navigator, data)).toBe('shared');
  });
  it('a refused share sheet falls back to the clipboard', async () => {
    const share = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    const writeText = jest.fn().mockResolvedValue(undefined);
    expect(
      await shareInviteLink({ share, clipboard: { writeText } } as unknown as Navigator, data),
    ).toBe('copied');
  });
  it('neither: the link stays on screen to copy by hand', async () => {
    expect(await copyInviteLink(undefined, data.url)).toBe('manual');
  });
  it('maps the refusals to words in both catalogues', () => {
    const e = (code: string) => new ApiClientError({ status: 409, code, message: code });
    expect(playersErrorKey(e('BOOKING_FULL'))).toBe('FULL');
    expect(playersErrorKey(e('BOOKING_PLAYERS_CLOSED'))).toBe('CLOSED');
    expect(playersErrorKey(e('TOO_MANY_INVITE_LINKS'))).toBe('TOO_MANY');
    expect(playersErrorKey(new Error('offline'))).toBe('FAILED');
  });
});
