import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { SeriesBoard } from '@/app/(app)/t/[slug]/admin/calendar/series/SeriesBoard';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { withIntl } from '../helpers/intl';
import { installFakeFetch, ok } from '../unit/data/fake-v1';

/** The diary's weekly series (#415): the list, moving one, and a refused move. */
const SERIES = {
  id: 'cseries0000000000000000001',
  resourceId: 'ccourt1',
  courtName: 'Корт 1',
  venueName: 'Обект Изток',
  startTime: '18:00',
  durationMinutes: 60,
  customerName: 'Иван Петров',
  linked: true,
  priceCents: null,
  weeksLeft: 3,
  nextDate: '2036-07-16',
  lastDate: '2036-07-30',
};
const COURTS = [
  { id: 'ccourt1', name: 'Корт 1' },
  { id: 'ccourt2', name: 'Корт 2' },
];

function mount() {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <SeriesBoard slug="club" courts={COURTS} />
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('SeriesBoard (#415)', () => {
  it('lists each series with what is left', async () => {
    installFakeFetch(() => ok({ items: [SERIES] }));
    mount();
    expect(await screen.findByText('Иван Петров')).toBeInTheDocument();
    expect(screen.getByText(/остават 3 седмици/)).toBeInTheDocument();
  });

  it('moves a series and says how many weeks moved', async () => {
    const calls = installFakeFetch((c) =>
      c.method === 'PATCH' ? ok({ ...SERIES, moved: 3, split: false }) : ok({ items: [SERIES] }),
    );
    mount();
    fireEvent.click(await screen.findByTestId('series-move'));
    fireEvent.change(screen.getByLabelText('Час'), { target: { value: '19:00' } });
    fireEvent.submit(screen.getByTestId('series-move-form').querySelector('form')!);

    await waitFor(() =>
      expect(screen.getByTestId('series-moved')).toHaveTextContent('Преместени са 3 седмици'),
    );
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(`/api/v1/t/club/admin/booking-series/${SERIES.id}`);
    expect(patch.body).toEqual({
      fromDate: '2036-07-16',
      startTime: '19:00',
      durationMinutes: 60,
      resourceId: 'ccourt1',
    });
  });

  it('shows the weeks that clash when the move is refused', async () => {
    installFakeFetch((c) =>
      c.method === 'PATCH'
        ? {
            status: 409,
            body: {
              error: {
                code: 'SERIES_CLASH',
                message: 'clash',
                details: { clashes: [{ date: '2036-07-23', reason: 'taken' }] },
              },
            },
          }
        : ok({ items: [SERIES] }),
    );
    mount();
    fireEvent.click(await screen.findByTestId('series-move'));
    fireEvent.submit(screen.getByTestId('series-move-form').querySelector('form')!);
    await waitFor(() =>
      expect(screen.getByTestId('series-move-clashes')).toHaveTextContent('2036-07-23 (заето)'),
    );
  });
});
