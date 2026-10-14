import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { ClubResults } from '@/app/(app)/t/[slug]/admin/results/ClubResults';
import type { ClubResultDto } from '@/components/results/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * #575: the club's «Резултати», against the REAL Bulgarian catalogue and a
 * fake v1. A disputed result waits at the top with the player's note; the
 * desk confirms it as reported. The recent ones follow, with nothing to do.
 */
const a = messages.admin.results;

const disputed: ClubResultDto = {
  id: 'rp1',
  bookingId: 'bk1',
  status: 'REJECTED',
  sport: 'PADEL',
  format: 'PERIODS',
  startTs: '2026-10-14T16:00:00Z',
  courtName: 'Корт 1',
  sides: [
    [
      { userId: 'u_ana', name: 'Ана' },
      { userId: 'u_boris', name: 'Борис' },
    ],
    [
      { userId: 'u_cveta', name: 'Цвета' },
      { userId: 'u_dimo', name: null },
    ],
  ],
  score: [
    [6, 4],
    [6, 3],
  ],
  winnerSide: 0,
  rejectNote: 'Вторият сет беше 4:6',
  reportedAt: '2026-10-14T18:00:00Z',
};
const counted: ClubResultDto = {
  ...disputed,
  id: 'rp2',
  bookingId: 'bk2',
  status: 'CONFIRMED',
  rejectNote: null,
};

function wrap(node: React.ReactNode) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), revalidateOnMount: false }}>
          <TooltipProvider>
            <ViewerScope viewerId="u_owner">{node}</ViewerScope>
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

describe('the club’s results', () => {
  it('a disputed result waits with its note; a counted one has nothing to do', () => {
    installFakeFetch(() => ok({ items: [] }));
    wrap(<ClubResults slug="alfa" waiting={[disputed]} recent={[disputed, counted]} />);

    const waiting = within(screen.getByTestId('club-results-waiting'));
    expect(waiting.getByTestId('club-result-note')).toHaveTextContent('Вторият сет беше 4:6');
    expect(waiting.getByTestId('result-summary')).toHaveTextContent(messages.results.unnamed);
    expect(waiting.getByTestId('club-result-confirm')).toHaveTextContent(a.confirm);

    // The disputed one is not listed twice.
    const recent = within(screen.getByTestId('club-results-recent'));
    expect(recent.getAllByTestId('club-result')).toHaveLength(1);
    expect(recent.queryByTestId('club-result-confirm')).toBeNull();
  });

  it('confirms it as reported', async () => {
    const calls = installFakeFetch((c) =>
      c.method === 'POST' ? ok({ status: 'DECIDED' }) : ok({ items: [] }),
    );
    wrap(<ClubResults slug="alfa" waiting={[disputed]} recent={[]} />);

    fireEvent.click(screen.getByTestId('club-result-confirm'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toMatch(/\/t\/alfa\/admin\/results\/rp1\/decide$/);
    expect(post.body).toEqual({ action: 'confirm' });
    await waitFor(() =>
      expect(screen.getByTestId('club-results-none-waiting')).toHaveTextContent(a.noneWaiting),
    );
  });
});
