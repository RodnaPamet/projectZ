import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { AdminTournamentDetail } from '@/app/(app)/t/[slug]/admin/tournaments/[id]/AdminTournamentDetail';
import { TournamentDetail } from '@/app/(public)/tournaments/[id]/TournamentDetail';
import type { ClubTournamentDto, TournamentViewDto } from '@/app/api/v1/_lib/tournament-dto';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * #579: a tournament's page for a player, and the club's page of it, against
 * the real Bulgarian catalogue and a fake v1.
 */
const t = messages.tournaments;
const a = messages.admin.tournaments;

const tournament = (over: Partial<TournamentViewDto> = {}): TournamentViewDto => ({
  id: 'tr1',
  name: 'Есенна купа',
  sport: 'PADEL',
  format: 'SINGLE_ELIMINATION',
  teamSize: 1,
  status: 'REGISTRATION',
  startsAt: '2026-11-01T08:00:00.000Z',
  endsAt: null,
  entriesCloseAt: null,
  entriesOpen: true,
  drawSize: 8,
  confirmed: 3,
  pending: 0,
  entryFeeCents: 2000,
  feePayment: 'AT_CLUB',
  description: 'Две групи, после елиминации.',
  club: { slug: 'alfa', name: 'Клуб Алфа' },
  venue: {
    id: 'v1',
    name: 'Алфа Кортове',
    city: 'Sofia',
    publicSlug: 'alfa-courts',
    timezone: 'Europe/Sofia',
  },
  myEntry: null,
  ...over,
});

function wrap(node: React.ReactNode) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), revalidateOnMount: false }}>
          <TooltipProvider>
            <ViewerScope viewerId="u_ana">{node}</ViewerScope>
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

describe('a tournament, for a player', () => {
  it('signed out: the facts, and «Вход» to enter', () => {
    installFakeFetch(() => ok({}));
    wrap(<TournamentDetail seed={tournament()} signedIn={false} loginHref="/login?next=x" />);
    expect(screen.getByTestId('tournament-detail')).toHaveTextContent('Есенна купа');
    expect(screen.getByTestId('tournament-detail')).toHaveTextContent('Алфа Кортове');
    expect(
      within(screen.getByTestId('tournament-entry')).getByRole('link', { name: t.signInButton }),
    ).toHaveAttribute('href', '/login?next=x');
  });

  it('enters, and then waits for the club, on the waiting list past the draw', async () => {
    const calls = installFakeFetch((c) =>
      c.method === 'POST'
        ? ok(
            tournament({
              myEntry: {
                id: 'e1',
                status: 'PENDING',
                role: 'entrant',
                partner: null,
                waitingPosition: 2,
                createdAt: '2026-10-14T10:00:00.000Z',
              },
            }),
            201,
          )
        : ok(tournament()),
    );
    wrap(<TournamentDetail seed={tournament()} signedIn loginHref="/login" />);
    fireEvent.click(screen.getByTestId('tournament-enter'));
    await waitFor(() =>
      expect(screen.getByTestId('tournament-entry-status')).toHaveTextContent(t.entry.PENDING),
    );
    expect(screen.getByTestId('tournament-entry-waiting')).toHaveTextContent('2');
    expect(calls.find((c) => c.method === 'POST')!.url).toMatch(/\/tournaments\/tr1\/entries$/);
  });

  it('doubles: no partner, no entry, and nothing is sent', () => {
    const calls = installFakeFetch(() => ok({}));
    wrap(<TournamentDetail seed={tournament({ teamSize: 2 })} signedIn loginHref="/login" />);
    expect(screen.getByTestId('partner-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tournament-enter'));
    expect(screen.getByTestId('tournament-error')).toHaveTextContent(
      t.error.TOURNAMENT_PARTNER_REQUIRED,
    );
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a refusal is said in words', async () => {
    installFakeFetch((c) =>
      c.method === 'POST' ? fail(409, 'TOURNAMENT_NOT_OPEN') : ok(tournament()),
    );
    wrap(<TournamentDetail seed={tournament()} signedIn loginHref="/login" />);
    fireEvent.click(screen.getByTestId('tournament-enter'));
    await waitFor(() =>
      expect(screen.getByTestId('tournament-error')).toHaveTextContent(t.error.TOURNAMENT_NOT_OPEN),
    );
  });
});

describe('a tournament, for the club', () => {
  const club = (over: Partial<ClubTournamentDto> = {}): ClubTournamentDto => {
    const { myEntry: _m, ...rest } = tournament();
    return {
      ...rest,
      drawSize: 2,
      confirmed: 1,
      pending: 2,
      entries: [
        {
          id: 'e1',
          status: 'CONFIRMED',
          player: { userId: 'u1', name: 'Ана', deleted: false },
          partner: null,
          createdAt: '2026-10-14T10:00:00.000Z',
          decidedAt: '2026-10-14T11:00:00.000Z',
          withdrawnAt: null,
          waitingPosition: null,
        },
        {
          id: 'e2',
          status: 'PENDING',
          player: { userId: 'u2', name: 'Борис', deleted: false },
          partner: null,
          createdAt: '2026-10-14T10:05:00.000Z',
          decidedAt: null,
          withdrawnAt: null,
          waitingPosition: null,
        },
        {
          id: 'e3',
          status: 'PENDING',
          player: { userId: 'u3', name: 'Цвета', deleted: false },
          partner: null,
          createdAt: '2026-10-14T10:10:00.000Z',
          decidedAt: null,
          withdrawnAt: null,
          waitingPosition: 1,
        },
      ],
      ...over,
    };
  };

  it('confirms the next entry, and the one past the draw waits, numbered', async () => {
    const calls = installFakeFetch((c) =>
      c.method === 'POST' ? ok(club({ confirmed: 2, pending: 1 })) : ok(club()),
    );
    wrap(
      <AdminTournamentDetail
        slug="alfa"
        seed={club()}
        venues={[
          {
            id: 'v1',
            name: 'Алфа Кортове',
            sports: ['PADEL'],
            courts: [{ id: 'r1', name: 'Корт 1' }],
          },
        ]}
      />,
    );
    const rows = screen.getAllByTestId('admin-tournament-entry');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent(t.waitingPosition.replace('{place}', '1'));
    fireEvent.click(within(rows[1]!).getByTestId('admin-tournament-confirm'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.url).toMatch(
      /\/admin\/tournament-entries\/e2\/confirm$/,
    );
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: a.entries.replace('{confirmed}', '2').replace('{size}', '2'),
      }),
    ).toBeInTheDocument();
  });
});
