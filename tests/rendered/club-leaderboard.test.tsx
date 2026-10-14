import { render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { ClubLeaderboard } from '@/components/ranking/ClubLeaderboard';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * #578: «Класиране» on a club's page, against the real Bulgarian catalogue
 * and a fake v1. Signed out, a sign-in prompt and no request at all (decision
 * 49); signed in, the club's players by level.
 */
const lb = messages.club.leaderboard;

function mount(signedIn: boolean) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <TooltipProvider>
            <ClubLeaderboard
              slug="alfa"
              signedIn={signedIn}
              loginHref="/login?next=%2Fclubs%2Falfa"
            />
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

describe('a club’s leaderboard', () => {
  it('signed out: a sign-in prompt, and nothing asked of the server', () => {
    const calls = installFakeFetch(() => ok({}));
    mount(false);
    const prompt = screen.getByTestId('club-leaderboard-sign-in');
    expect(prompt).toHaveTextContent(lb.signIn);
    expect(within(prompt).getByRole('link', { name: lb.signInButton })).toHaveAttribute(
      'href',
      '/login?next=%2Fclubs%2Falfa',
    );
    expect(calls).toHaveLength(0);
  });

  it('signed in: the players by level, full names, with their matches', async () => {
    installFakeFetch(() =>
      ok({
        sports: ['PADEL'],
        sport: 'PADEL',
        rows: [
          {
            rank: 1,
            userId: 'u1',
            name: 'Ана Петрова',
            avatarUrl: null,
            level: 5.4,
            matchesPlayed: 12,
          },
          {
            rank: 2,
            userId: 'u2',
            name: 'Борис Иванов',
            avatarUrl: null,
            level: 4,
            matchesPlayed: 5,
          },
        ],
      }),
    );
    mount(true);
    const rows = await screen.findAllByTestId('club-leaderboard-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Ана Петрова');
    expect(rows[0]).toHaveTextContent('Ниво 5,4');
    expect(rows[0]).toHaveTextContent('12 мача');
    expect(rows[1]).toHaveTextContent('Ниво 4,0');
    // One sport: no picker.
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('signed in, with nobody settled yet: says how one gets on it', async () => {
    installFakeFetch(() => ok({ sports: ['PADEL'], sport: 'PADEL', rows: [] }));
    mount(true);
    await waitFor(() =>
      expect(screen.getByTestId('club-leaderboard-empty')).toHaveTextContent(lb.empty),
    );
  });
});
