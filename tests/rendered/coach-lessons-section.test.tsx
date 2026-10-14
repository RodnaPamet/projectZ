import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import type { MyLessonDto } from '@/app/api/v1/_lib/coach-dto';
import { CoachLessonsSection } from '@/components/coach/CoachLessonsSection';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import type { V1Page } from '@/lib/data/keys';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok, type FakeCall } from '../unit/data/fake-v1';

/**
 * «Уроци» on a coach's own page (#548), against the real Bulgarian catalogue
 * and a fake v1: the upcoming lessons the page was seeded with, the past ones
 * read when their tab is opened, and what an empty or failed list says.
 */

const c = messages.coachLessons;

const lesson = (over: Partial<MyLessonDto> = {}): MyLessonDto => ({
  id: 'ls1',
  bookingId: 'bk1',
  status: 'CONFIRMED',
  // 07:00 UTC is 10:00 in Sofia (EEST) on this date.
  startTs: '2036-07-14T07:00:00Z',
  endTs: '2036-07-14T08:00:00Z',
  venue: { id: 'v1', name: 'Алфа Кортове', timezone: 'Europe/Sofia' },
  club: 'Клуб Алфа',
  court: { name: 'Корт 1', sport: 'TENNIS' },
  player: 'Петя Играч',
  coachFeeCents: 4000,
  currency: 'EUR',
  ...over,
});
const page = (items: MyLessonDto[], nextCursor: string | null = null): V1Page<MyLessonDto> => ({
  items,
  nextCursor,
});

function mount(seed: V1Page<MyLessonDto>) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <ViewerScope viewerId="usr_coach">
            <CoachLessonsSection seed={seed} />
          </ViewerScope>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

const urls = (calls: FakeCall[]) => calls.map((x) => x.url);

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('«Уроци»', () => {
  it('each upcoming lesson: when (by the venue’s clock), where, who booked it, and the coach’s fee', () => {
    installFakeFetch(() => ok(page([lesson()])));
    mount(page([lesson(), lesson({ id: 'ls2', bookingId: 'bk2', player: null })]));

    const section = screen.getByTestId('coach-lessons');
    expect(within(section).getByRole('heading', { level: 2, name: c.title })).toBeVisible();
    const rows = within(section).getAllByTestId('coach-lesson');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('пн, 14 юли, 10:00–11:00');
    expect(rows[0]).toHaveTextContent('Алфа Кортове · Корт 1 · Тенис');
    expect(within(rows[0]!).getByTestId('coach-lesson-player')).toHaveTextContent(
      'Играч: Петя Играч',
    );
    expect(rows[0]).toHaveTextContent(/Вашият хонорар: 40,00\s€/);
    // A lesson still on has no status badge to read past.
    expect(rows[0]).not.toHaveTextContent(messages.myBookings.status.CONFIRMED);
    // A player whose account is gone is said to be that, not left blank.
    expect(within(rows[1]!).getByTestId('coach-lesson-player')).toHaveTextContent(c.noPlayer);
  });

  it('none upcoming says so', () => {
    installFakeFetch(() => ok(page([])));
    mount(page([]));
    expect(screen.getByTestId('coach-lessons-none')).toHaveTextContent(c.noneUpcoming);
  });

  it('while the past ones load, the upcoming ones are not shown under «Минали»', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    installFakeFetch(async (call) => {
      if (!call.url.includes('when=past')) return ok(page([lesson()]));
      await held;
      return ok(page([]));
    });
    mount(page([lesson()]));
    fireEvent.click(screen.getByRole('radio', { name: c.tabs.past }));
    await waitFor(() => expect(screen.queryByTestId('coach-lesson')).toBeNull());
    expect(screen.getByText(c.loading)).toBeVisible();
    release();
    expect(await screen.findByTestId('coach-lessons-none')).toHaveTextContent(c.nonePast);
  });

  it('the past ones are read when their tab is opened, and say how each ended', async () => {
    const calls = installFakeFetch((call) =>
      call.url.includes('when=past')
        ? ok(
            page([
              lesson({ id: 'p1', bookingId: 'b1', status: 'COMPLETED' }),
              lesson({ id: 'p2', bookingId: 'b2', status: 'CANCELLED' }),
              lesson({ id: 'p3', bookingId: 'b3', status: 'NO_SHOW' }),
            ]),
          )
        : ok(page([lesson()])),
    );
    mount(page([lesson()]));
    fireEvent.click(screen.getByRole('radio', { name: c.tabs.past }));

    await waitFor(() => expect(screen.getAllByTestId('coach-lesson')).toHaveLength(3));
    expect(urls(calls)).toContain('/api/v1/me/coach-lessons?when=past');
    const s = messages.myBookings.status;
    expect(screen.getAllByTestId('coach-lesson').map((r) => r.getAttribute('data-status'))).toEqual(
      ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
    );
    for (const text of [s.COMPLETED, s.CANCELLED, s.NO_SHOW]) {
      expect(screen.getByText(text)).toBeVisible();
    }
  });

  it('no past lessons says that, not that there are none at all', async () => {
    installFakeFetch((call) => ok(call.url.includes('when=past') ? page([]) : page([lesson()])));
    mount(page([lesson()]));
    fireEvent.click(screen.getByRole('radio', { name: c.tabs.past }));
    expect(await screen.findByTestId('coach-lessons-none')).toHaveTextContent(c.nonePast);
  });

  it('a list that did not load says so and can be tried again', async () => {
    let n = 0;
    installFakeFetch((call) => {
      if (!call.url.includes('when=past')) return ok(page([lesson()]));
      return ++n === 1 ? fail(500, 'INTERNAL') : ok(page([lesson({ status: 'COMPLETED' })]));
    });
    mount(page([lesson()]));
    fireEvent.click(screen.getByRole('radio', { name: c.tabs.past }));
    const error = await screen.findByTestId('coach-lessons-error');
    expect(error).toHaveTextContent(c.error);
    fireEvent.click(within(error).getByRole('button', { name: c.retry }));
    await waitFor(() => expect(screen.getAllByTestId('coach-lesson')).toHaveLength(1));
  });

  it('more than a page: «Покажи още» follows the cursor', async () => {
    const calls = installFakeFetch((call) =>
      call.url.includes('cursor=ls1')
        ? ok(page([lesson({ id: 'ls2', bookingId: 'bk2' })]))
        : ok(page([lesson()], 'ls1')),
    );
    mount(page([lesson()], 'ls1'));
    // Not while the seed is being checked against the server.
    const more = await screen.findByRole('button', { name: c.more });
    await waitFor(() => expect(more).toBeEnabled());
    fireEvent.click(more);
    await waitFor(() => expect(screen.getAllByTestId('coach-lesson')).toHaveLength(2));
    expect(urls(calls)).toContain('/api/v1/me/coach-lessons?cursor=ls1&when=upcoming');
    await waitFor(() => expect(screen.queryByRole('button', { name: c.more })).toBeNull());
  });
});
