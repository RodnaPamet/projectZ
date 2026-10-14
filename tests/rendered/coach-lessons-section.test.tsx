import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import type { MyLessonDto } from '@/app/api/v1/_lib/coach-dto';
import { CoachLessonsSection, lessonErrorKey } from '@/components/coach/CoachLessonsSection';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { ApiClientError } from '@/lib/data/errors';
import type { V1Page } from '@/lib/data/keys';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok, type FakeCall } from '../unit/data/fake-v1';

/**
 * «Уроци» on a coach's own page (#548, #549), against the real Bulgarian
 * catalogue and a fake v1: the upcoming lessons the page was seeded with, the
 * past ones read when their tab is opened, what the coach is shown of a
 * player, and the two things a coach can do to a lesson.
 */

const c = messages.coachLessons;

// 07:00 UTC is 10:00 in Sofia (EEST) on this date.
const START = '2036-07-14T07:00:00Z';
const BEFORE = '2036-07-13T12:00:00Z';
const DURING = '2036-07-14T07:30:00Z';

const lesson = (over: Partial<MyLessonDto> = {}): MyLessonDto => ({
  id: 'ls1',
  bookingId: 'bk1',
  status: 'CONFIRMED',
  startTs: START,
  endTs: '2036-07-14T08:00:00Z',
  venue: { id: 'v1', name: 'Алфа Кортове', timezone: 'Europe/Sofia' },
  club: 'Клуб Алфа',
  court: { name: 'Корт 1', sport: 'TENNIS' },
  player: { name: 'Петя Играч', level: 4, rating: null, phone: '+359888123456' },
  players: 1,
  coachFeeCents: 4000,
  currency: 'EUR',
  ...over,
});
const page = (items: MyLessonDto[], nextCursor: string | null = null): V1Page<MyLessonDto> => ({
  items,
  nextCursor,
});

function mount(seed: V1Page<MyLessonDto>, renderedAt = BEFORE) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <TooltipProvider>
            <ViewerScope viewerId="usr_coach">
              <CoachLessonsSection seed={seed} renderedAt={renderedAt} />
            </ViewerScope>
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

const urls = (calls: FakeCall[]) => calls.map((x) => x.url);
const posts = (calls: FakeCall[]) => calls.filter((x) => x.method === 'POST');

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('«Уроци»: what a coach is shown', () => {
  it('each upcoming lesson: when (by the venue’s clock), where, the player’s name, level and phone, and the coach’s fee', () => {
    installFakeFetch(() => ok(page([lesson()])));
    mount(page([lesson()]));

    const section = screen.getByTestId('coach-lessons');
    expect(within(section).getByRole('heading', { level: 2, name: c.title })).toBeVisible();
    const row = within(section).getByTestId('coach-lesson');
    expect(row).toHaveTextContent('пн, 14 юли, 10:00–11:00');
    expect(row).toHaveTextContent('Алфа Кортове · Корт 1 · Тенис');
    expect(within(row).getByTestId('coach-lesson-player')).toHaveTextContent(
      /^Играч: Петя Играч · ниво 4$/,
    );
    // The number is a link that dials it.
    const phone = within(row).getByTestId('coach-lesson-phone');
    expect(phone).toHaveTextContent('+359888123456');
    expect(phone).toHaveAttribute('href', 'tel:+359888123456');
    expect(row).toHaveTextContent(/Вашият хонорар: 40,00\s€/);
    // A lesson still on has no status badge to read past.
    expect(row).not.toHaveTextContent(messages.myBookings.status.CONFIRMED);
  });

  it('a group says how many; no level, no phone, no account: each is simply not there', () => {
    installFakeFetch(() => ok(page([])));
    mount(
      page([
        lesson({ players: 3, coachFeeCents: 6000 }),
        lesson({
          id: 'ls2',
          bookingId: 'bk2',
          player: { name: 'Иво', level: null, rating: null, phone: null },
        }),
        lesson({ id: 'ls3', bookingId: 'bk3', player: null }),
      ]),
    );
    const rows = screen.getAllByTestId('coach-lesson');
    expect(within(rows[0]!).getByTestId('coach-lesson-player')).toHaveTextContent(
      /^Играч: Петя Играч · ниво 4 · 3 играчи$/,
    );
    expect(rows[0]).toHaveTextContent(/60,00\s€/);
    expect(within(rows[1]!).getByTestId('coach-lesson-player')).toHaveTextContent(/^Играч: Иво$/);
    expect(within(rows[1]!).queryByTestId('coach-lesson-phone')).toBeNull();
    expect(within(rows[2]!).getByTestId('coach-lesson-player')).toHaveTextContent(c.noPlayer);
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

  it('a list that did not load says so and can be tried again', async () => {
    let n = 0;
    installFakeFetch((call) => {
      if (!call.url.includes('when=past')) return ok(page([lesson()]));
      return ++n === 1 ? fail(500, 'INTERNAL') : ok(page([lesson({ status: 'COMPLETED' })]));
    });
    mount(page([lesson()]));
    fireEvent.click(screen.getByRole('radio', { name: c.tabs.past }));
    const error = await screen.findByTestId('coach-lessons-error');
    expect(error).toHaveTextContent(c.error.list);
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

describe('«Уроци»: what a coach can do to a lesson', () => {
  it('before it starts: cancel, and only cancel; the dialog says what happens, then one POST', async () => {
    const calls = installFakeFetch((call) =>
      call.method === 'POST' ? ok({ bookingId: 'bk1' }) : ok(page([lesson()])),
    );
    mount(page([lesson()]));
    const row = screen.getByTestId('coach-lesson');
    expect(within(row).queryByTestId('coach-lesson-no-show')).toBeNull();

    fireEvent.click(within(row).getByTestId('coach-lesson-cancel'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(c.cancel.title);
    expect(dialog).toHaveTextContent(
      'пн, 14 юли от 10:00, Алфа Кортове. Кортът ще се освободи, а играчът ще получи известие и имейл.',
    );
    // «Не» keeps the lesson and sends nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: c.keep }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(calls)).toEqual([]);

    fireEvent.click(within(row).getByTestId('coach-lesson-cancel'));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: c.cancel.yes }),
    );
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]!.url).toBe('/api/v1/me/coach-lessons/ls1/cancel');
    expect(posts(calls)[0]!.headers['x-playerz-viewer']).toBe('usr_coach');
    // Both lists are read again: the lesson has moved from one to the other.
    await waitFor(() =>
      expect(urls(calls).filter((u) => u.includes('when=')).length).toBeGreaterThan(1),
    );
  });

  it('once it has started: «Не се яви», and no cancel; the dialog names the player and the club', async () => {
    const calls = installFakeFetch((call) =>
      call.method === 'POST' ? ok({ bookingId: 'bk1' }) : ok(page([lesson()])),
    );
    mount(page([lesson()]), DURING);
    const row = screen.getByTestId('coach-lesson');
    expect(within(row).queryByTestId('coach-lesson-cancel')).toBeNull();

    fireEvent.click(within(row).getByTestId('coach-lesson-no-show'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(c.noShow.title);
    expect(dialog).toHaveTextContent('Петя Играч ще бъде отбелязан като неявил се в Клуб Алфа.');
    fireEvent.click(within(dialog).getByRole('button', { name: c.noShow.yes }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]!.url).toBe('/api/v1/me/coach-lessons/ls1/no-show');
  });

  it('a lesson that is over can still be marked; one already cancelled or marked offers nothing', () => {
    installFakeFetch(() => ok(page([])));
    mount(
      page([
        lesson({ id: 'a', bookingId: 'a', status: 'COMPLETED' }),
        lesson({ id: 'b', bookingId: 'b', status: 'CANCELLED' }),
        lesson({ id: 'c', bookingId: 'c', status: 'NO_SHOW' }),
      ]),
      '2036-07-15T12:00:00Z',
    );
    const rows = screen.getAllByTestId('coach-lesson');
    expect(within(rows[0]!).getByTestId('coach-lesson-no-show')).toBeVisible();
    for (const row of rows.slice(1)) {
      expect(within(row).queryByTestId('coach-lesson-no-show')).toBeNull();
      expect(within(row).queryByTestId('coach-lesson-cancel')).toBeNull();
    }
  });

  it('a refusal is said in words, and the list is read again', async () => {
    const calls = installFakeFetch((call) =>
      call.method === 'POST' ? fail(409, 'LESSON_STARTED') : ok(page([lesson()])),
    );
    mount(page([lesson()]));
    fireEvent.click(screen.getByTestId('coach-lesson-cancel'));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: c.cancel.yes }),
    );
    expect(await screen.findByTestId('coach-lesson-error')).toHaveTextContent(c.error.started);
    expect(posts(calls)).toHaveLength(1);
  });
});

describe('lessonErrorKey', () => {
  const e = (status: number, code: string, details?: unknown) =>
    new ApiClientError({ status, code, message: code, details });
  it.each([
    [e(409, 'LESSON_STARTED'), 'started'],
    [e(404, 'LESSON_NOT_FOUND'), 'gone'],
    [e(409, 'BOOKING_NOT_CANCELLABLE'), 'notAttendable'],
    [e(409, 'NO_SHOW_REFUSED', { reason: 'NOT_STARTED' }), 'notStarted'],
    [e(409, 'NO_SHOW_REFUSED', { reason: 'ALREADY_NO_SHOW' }), 'alreadyNoShow'],
    [e(409, 'NO_SHOW_REFUSED', { reason: 'REVIEWED' }), 'reviewed'],
    [e(409, 'NO_SHOW_REFUSED', { reason: 'NOT_ATTENDABLE' }), 'notAttendable'],
    [e(409, 'NO_SHOW_REFUSED'), 'notAttendable'],
    [e(500, 'INTERNAL'), 'failed'],
    [new Error('offline'), 'failed'],
  ])('%#: maps to %s', (err, key) => expect(lessonErrorKey(err)).toBe(key));

  it('has words for every key, in both catalogues', () => {
    const keys = [
      'started',
      'notStarted',
      'alreadyNoShow',
      'reviewed',
      'notAttendable',
      'gone',
      'failed',
    ];
    const en = jest.requireActual('../../messages/en.json') as typeof messages;
    for (const k of keys) {
      expect((c.error as Record<string, string>)[k]).toEqual(expect.any(String));
      expect((en.coachLessons.error as Record<string, string>)[k]).toEqual(expect.any(String));
    }
  });
});
