import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import type { BookingGameDto, OpenGameDto } from '@/app/api/v1/_lib/open-play-dto';
import { BookingGame } from '@/app/(public)/me/bookings/[id]/BookingGame';
import { GameCard } from '@/components/games/GameCard';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * Open play's screens (#376): a game's card — ask, withdraw, sign in — and the
 * booker's requests on their booking, with accept and decline.
 */

const g = messages.games;
const mg = messages.myBookings.game;

const GAME: OpenGameDto = {
  id: 'g1',
  sport: 'PADEL',
  resourceType: 'COURT',
  courtName: 'Корт 1',
  venue: { id: 'v1', slug: 'alfa', name: 'Алфа Кортове', city: 'Sofia' },
  startTs: '2026-10-20T16:00:00.000Z',
  endTs: '2026-10-20T17:30:00.000Z',
  timezone: 'Europe/Sofia',
  cutoffAt: '2026-10-19T16:00:00.000Z',
  capacity: 4,
  playersCount: 2,
  spotsLeft: 2,
  open: true,
  levelMin: 3,
  levelMax: 4,
  note: 'Търсим двама за двойки',
  booker: { firstName: 'Иван', avatarUrl: null },
  viewer: { isBooker: false, isPlaying: false, bookingId: null, request: null },
};

function mount(ui: React.ReactNode) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), revalidateOnMount: false }}>
          <TooltipProvider>
            <ViewerScope viewerId="usr_player">{ui}</ViewerScope>
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('a game card', () => {
  it('shows the game, the wish and the note, and asks with a note', async () => {
    const calls = installFakeFetch(() =>
      ok({ ...GAME, viewer: { ...GAME.viewer!, request: { id: 'r1', status: 'PENDING' } } }),
    );
    const changed = jest.fn();
    mount(<GameCard game={GAME} signInHref="/login" onChanged={changed} />);

    expect(screen.getByText('Търсим двама за двойки')).toBeInTheDocument();
    expect(
      screen.getByText(g.card.levelRange.replace('{min}', '3').replace('{max}', '4')),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: g.card.ask }));
    expect(await screen.findByTestId('ask-dialog')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('ask-note'), { target: { value: 'Ниво 3, двойки' } });
    fireEvent.click(screen.getByRole('button', { name: g.ask.submit }));

    await waitFor(() => expect(changed).toHaveBeenCalled());
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/v1/games/g1/requests');
    expect(post.body).toEqual({ note: 'Ниво 3, двойки' });
  });

  it('says why an ask was refused', async () => {
    installFakeFetch(() => fail(409, 'ASK_DECLINED'));
    mount(<GameCard game={GAME} signInHref="/login" />);
    fireEvent.click(screen.getByRole('button', { name: g.card.ask }));
    fireEvent.click(await screen.findByRole('button', { name: g.ask.submit }));
    expect(await screen.findByText(g.error.ASK_DECLINED)).toBeInTheDocument();
  });

  it('a visitor is sent to sign in; a waiting request can be withdrawn', async () => {
    const { unmount } = mount(
      <GameCard game={{ ...GAME, viewer: null }} signInHref="/login?next=%2Fgames" />,
    );
    expect(screen.getByRole('link', { name: g.card.signIn })).toHaveAttribute(
      'href',
      '/login?next=%2Fgames',
    );
    unmount();

    const calls = installFakeFetch(() => ok(null));
    const changed = jest.fn();
    mount(
      <GameCard
        game={{ ...GAME, viewer: { ...GAME.viewer!, request: { id: 'r1', status: 'PENDING' } } }}
        signInHref="/login"
        onChanged={changed}
      />,
    );
    expect(screen.getByTestId('game-request-status')).toHaveTextContent(g.status.PENDING);
    expect(screen.queryByRole('button', { name: g.card.ask })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: g.card.withdraw }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(null));
    expect(calls.find((c) => c.method === 'DELETE')!.url).toBe('/api/v1/me/game-requests/r1');
  });
});

describe('the booker’s requests', () => {
  const VIEW: BookingGameDto = {
    viewerRole: 'BOOKER',
    bookingId: 'b1',
    sport: 'PADEL',
    cutoffAt: '2099-01-01T00:00:00.000Z',
    canOpen: true,
    maxSpots: 2,
    game: {
      id: 'g1',
      open: true,
      closedAt: null,
      spotsLeft: 2,
      accepted: 0,
      levelMin: null,
      levelMax: null,
      note: null,
    },
    requests: [
      {
        id: 'r1',
        status: 'PENDING',
        note: 'Играя от 5 години',
        askedAt: '2026-10-13T10:00:00.000Z',
        decidedAt: null,
        participantId: null,
        player: {
          userId: 'u2',
          name: 'Мария Георгиева',
          avatarUrl: null,
          sports: [{ sport: 'PADEL', level: 4 }],
          deleted: false,
        },
      },
    ],
    myRequest: null,
    chatId: null,
  };

  it('shows each request with the asker’s card, and accepts one', async () => {
    const accepted: BookingGameDto = {
      ...VIEW,
      game: { ...VIEW.game!, accepted: 1, spotsLeft: 1 },
      requests: [{ ...VIEW.requests[0]!, status: 'ACCEPTED', participantId: 'p1' }],
      chatId: 'c1',
    };
    const calls = installFakeFetch(() => ok(accepted));
    mount(<BookingGame bookingId="b1" seed={VIEW} />);

    expect(screen.getByText('Мария Георгиева')).toBeInTheDocument();
    expect(screen.getByText('„Играя от 5 години“')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: mg.acceptLabel.replace('{name}', 'Мария Георгиева') }),
    );

    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.url).toBe(
        '/api/v1/me/bookings/b1/game/requests/r1/accept',
      ),
    );
    expect(await screen.findByTestId('booking-game-chat')).toHaveAttribute('href', '/messages/c1');
  });

  it('offers «Търся играчи» on a booking that has no game yet', () => {
    installFakeFetch(() => ok({ ...VIEW, game: null, requests: [] }));
    mount(<BookingGame bookingId="b1" seed={{ ...VIEW, game: null, requests: [] }} />);
    expect(screen.getByRole('button', { name: mg.open })).toBeInTheDocument();
  });
});
