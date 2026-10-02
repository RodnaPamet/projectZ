import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig, type SWRConfiguration } from 'swr';

import {
  MyBookingsList,
  reviewErrorKey,
  withPendingReview,
} from '@/app/(app)/me/bookings/MyBookingsList';
import type { MyBookingDto } from '@/app/api/v1/_lib/dto';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { ApiClientError } from '@/lib/data/errors';
import type { V1Page } from '@/lib/data/keys';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import {
  fail,
  installFakeFetch,
  ok,
  tick,
  type FakeAnswer,
  type FakeHandler,
} from '../unit/data/fake-v1';

/**
 * /me/bookings on the client data layer (T22), against the REAL Bulgarian
 * catalogue and a fake v1.
 *
 * The page seeds page one from the server with the endpoint's own mapper; the
 * list holds it under `GET /api/v1/me/bookings` and writes reviews to the v1
 * review route, optimistically. Each test gets a fresh SWR cache
 * (`provider: () => new Map()`): the default one is module-scoped, and a list
 * cached by one test would be served to the next instead of its seed.
 */

const mb = messages.myBookings;

const booking = (over: Partial<MyBookingDto> = {}): MyBookingDto => ({
  id: 'bk1',
  status: 'COMPLETED',
  // 16:00 UTC is 19:00 in Sofia (EEST, UTC+3) on this date.
  startTs: '2026-09-29T16:00:00.000Z',
  endTs: '2026-09-29T17:30:00.000Z',
  totalCents: 2400,
  currency: 'EUR',
  expiresAt: null,
  cancelledAt: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  resource: { id: 'r1', name: 'Корт 1', sport: 'PADEL' },
  venue: { id: 'v1', name: 'Алфа Кортове', timezone: 'Europe/Sofia' },
  clubSlug: 'alpha',
  venueReview: null,
  canReview: true,
  ...over,
});

const page = (items: MyBookingDto[], nextCursor: string | null = null): V1Page<MyBookingDto> => ({
  items,
  nextCursor,
});

const SEED = page([booking()]);

function serve(
  opts: { list?: (url: string) => FakeAnswer | Promise<FakeAnswer>; post?: FakeHandler } = {},
) {
  return installFakeFetch((c) => {
    if (c.method === 'POST') return opts.post ? opts.post(c) : ok({ id: 'rv1' }, 201);
    return opts.list ? opts.list(c.url) : ok(SEED);
  });
}

function mount(seed: V1Page<MyBookingDto> = SEED, config: SWRConfiguration = {}) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), ...config }}>
          <ViewerScope viewerId="usr_player">
            <MyBookingsList seed={seed} reviewMaxLength={2000} />
          </ViewerScope>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

const gets = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method === 'GET');
const posts = <T extends { method: string }>(calls: T[]) =>
  calls.filter((c) => c.method === 'POST');

/** A promise the test settles by hand: the POST that is still in flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function openForm() {
  await userEvent.click(screen.getByRole('button', { name: mb.review.rate }));
}

async function rateAndSubmit(stars: number, text = '') {
  await openForm();
  await userEvent.click(screen.getAllByRole('radio')[stars - 1]!);
  if (text) await userEvent.type(screen.getByLabelText(mb.review.bodyLabel), text);
  await userEvent.click(screen.getByRole('button', { name: mb.review.submit }));
}

const yours = (rating: number) => mb.review.yours.replace('{rating}', String(rating));

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('the server seed', () => {
  it('paints in the first render — no skeleton — then revalidates ONCE, as this viewer', async () => {
    const calls = serve();
    mount();

    // Synchronously after render: the seed is the first paint.
    expect(screen.getByText('Алфа Кортове')).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByRole('list')).toHaveAttribute('data-perf-ready');

    await waitFor(() => expect(gets(calls)).toHaveLength(1));
    expect(calls[0]!.url).toBe('/api/v1/me/bookings');
    expect(calls[0]!.headers['x-playerz-viewer']).toBe('usr_player');

    await act(tick);
    expect(gets(calls)).toHaveLength(1);
  });

  it('replaces the seed with what the endpoint answers', async () => {
    serve({ list: () => ok(page([booking({ venue: { ...booking().venue, name: 'Бета' } })])) });
    mount();

    expect(await screen.findByText('Бета')).toBeInTheDocument();
    expect(screen.queryByText('Алфа Кортове')).not.toBeInTheDocument();
  });

  it('keeps the seed on screen when the revalidation fails', async () => {
    serve({ list: () => fail(503, 'UNAVAILABLE') });
    mount();

    await act(tick);
    expect(screen.getByText('Алфа Кортове')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("tells the time in the VENUE's zone, not the runtime's", () => {
    serve();
    mount(
      page([
        booking(),
        booking({
          id: 'bk2',
          venue: { id: 'v2', name: 'Лондон', timezone: 'Europe/London' },
        }),
      ]),
    );

    const [sofia, london] = screen.getAllByRole('listitem');
    // The same instant: 19:00–20:30 in Sofia, 17:00–18:30 in London.
    expect(sofia).toHaveTextContent(/19:00/);
    expect(sofia).toHaveTextContent(/20:30/);
    expect(london).toHaveTextContent(/17:00/);
    expect(london).toHaveTextContent(/18:30/);
  });

  it('says the status in words, on a badge', () => {
    serve();
    mount(page([booking({ status: 'CONFIRMED', canReview: false })]));
    expect(screen.getByText(mb.status.CONFIRMED)).toBeInTheDocument();
  });

  it('with no bookings, offers the venues — a client-side link, not a full reload', () => {
    serve({ list: () => ok(page([])) });
    mount(page([]));

    expect(screen.getByText(mb.empty.title)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: mb.browse })).toHaveAttribute('href', '/venues');
    expect(document.querySelector('[data-perf-ready]')).not.toBeNull();
  });
});

describe('load more', () => {
  const PAGE_2 = page([booking({ id: 'bk0', venue: { ...booking().venue, name: 'По-стара' } })]);

  it('follows the cursor, appends the page, and stops when there is no next one', async () => {
    const first = page([booking()], 'bk1');
    const calls = serve({ list: (url) => ok(url.includes('cursor=bk1') ? PAGE_2 : first) });
    mount(first);
    await waitFor(() => expect(gets(calls)).toHaveLength(1));

    await userEvent.click(screen.getByRole('button', { name: mb.loadMore }));

    expect(await screen.findByText('По-стара')).toBeInTheDocument();
    expect(screen.getByText('Алфа Кортове')).toBeInTheDocument();
    expect(gets(calls).some((c) => c.url === '/api/v1/me/bookings?cursor=bk1')).toBe(true);
    expect(screen.queryByRole('button', { name: mb.loadMore })).not.toBeInTheDocument();
  });

  it('is not offered when the seed is the whole list', () => {
    serve();
    mount();
    expect(screen.queryByRole('button', { name: mb.loadMore })).not.toBeInTheDocument();
  });

  it('says so when the next page fails, and keeps what is shown', async () => {
    const first = page([booking()], 'bk1');
    serve({
      list: (url) => (url.includes('cursor=') ? fail(503, 'UNAVAILABLE') : ok(first)),
    });
    // No retries: the hook's two (2–6 s and 4–12 s out) are SWR's business,
    // and what is tested here is what shows once the error sticks.
    mount(first, { onErrorRetry: () => {} });
    await act(tick);

    await userEvent.click(screen.getByRole('button', { name: mb.loadMore }));

    expect(await screen.findByRole('alert')).toHaveTextContent(mb.loadMoreError);
    expect(screen.getByText('Алфа Кортове')).toBeInTheDocument();
  });
});

describe('reviewing a venue, optimistically', () => {
  it('shows the review as pending at once, POSTs it to the v1 route, then shows what was stored', async () => {
    const held = deferred<FakeAnswer>();
    let stored = false;
    const calls = serve({
      post: () => held.promise,
      list: () =>
        ok(
          page([
            booking(
              stored
                ? {
                    canReview: false,
                    venueReview: { id: 'rv1', bookingId: 'bk1', rating: 5, status: 'PUBLISHED' },
                  }
                : {},
            ),
          ]),
        ),
    });
    mount();
    await waitFor(() => expect(gets(calls)).toHaveLength(1));

    await rateAndSubmit(5);

    // Before the server has answered.
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent(yours(5));
    expect(row).toHaveTextContent(mb.review.status.PENDING_REVIEW);
    expect(within(row).queryByRole('button', { name: mb.review.rate })).not.toBeInTheDocument();

    const post = posts(calls)[0]!;
    expect(post.url).toBe('/api/v1/t/alpha/bookings/bk1/review');
    expect(post.body).toEqual({ rating: 5, body: null });
    expect(post.headers['x-playerz-viewer']).toBe('usr_player');
    expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);

    stored = true;
    await act(async () => held.resolve(ok({ id: 'rv1', status: 'PUBLISHED' }, 201)));

    // The re-read replaces the guess with the stored status.
    await waitFor(() =>
      expect(screen.getByRole('listitem')).toHaveTextContent(mb.review.status.PUBLISHED),
    );
    expect(gets(calls).length).toBeGreaterThanOrEqual(2);
  });

  it('sends the text when there is some', async () => {
    const calls = serve();
    mount();
    await rateAndSubmit(4, 'Чисти кортове');

    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]!.body).toEqual({ rating: 4, body: 'Чисти кортове' });
  });

  it('marks every row at that venue — one review per venue — and no other', async () => {
    const held = deferred<FakeAnswer>();
    serve({ post: () => held.promise, list: () => new Promise(() => {}) });
    mount(
      page([
        booking(),
        booking({ id: 'bk-again', canReview: true }),
        booking({ id: 'bk-other', venue: { id: 'v2', name: 'Друг', timezone: 'Europe/Sofia' } }),
      ]),
    );

    const [first] = screen.getAllByRole('button', { name: mb.review.rate });
    await userEvent.click(first!);
    await userEvent.click(screen.getAllByRole('radio')[2]!);
    await userEvent.click(screen.getByRole('button', { name: mb.review.submit }));

    const [reviewed, sameVenue, other] = screen.getAllByRole('listitem');
    expect(reviewed).toHaveTextContent(yours(3));
    expect(sameVenue).toHaveTextContent(mb.review.alreadyThisVenue);
    expect(within(other!).getByRole('button', { name: mb.review.rate })).toBeInTheDocument();
  });

  it('rolls back on refusal and says why, keeping what the person typed', async () => {
    const calls = serve({ post: () => fail(409, 'ALREADY_REVIEWED') });
    mount();
    await waitFor(() => expect(gets(calls)).toHaveLength(1));

    await rateAndSubmit(2, 'Шумно');

    expect(await screen.findByRole('alert')).toHaveTextContent(mb.review.error.ALREADY_REVIEWED);
    const row = screen.getByRole('listitem');
    expect(row).not.toHaveTextContent(yours(2));
    expect(screen.getByLabelText(mb.review.bodyLabel)).toHaveValue('Шумно');
    expect(screen.getAllByRole('radio')[1]).toBeChecked();
  });

  it('asks for a rating before sending anything', async () => {
    const calls = serve();
    mount();
    await openForm();
    await userEvent.click(screen.getByRole('button', { name: mb.review.submit }));

    expect(await screen.findByRole('alert')).toHaveTextContent(mb.review.error.RATING_REQUIRED);
    expect(posts(calls)).toHaveLength(0);
  });

  it('a network failure rolls back to the form with a generic retry message', async () => {
    serve({ post: () => Promise.reject(new TypeError('Failed to fetch')) });
    mount();
    await rateAndSubmit(5);

    expect(await screen.findByRole('alert')).toHaveTextContent(mb.review.error.FAILED);
    expect(screen.getByRole('button', { name: mb.review.submit })).toBeInTheDocument();
  });
});

describe('reviewErrorKey', () => {
  const e = (status: number, code: string, details?: unknown) =>
    new ApiClientError({ status, code, message: code, details });

  it.each([
    [e(403, 'NO_PROOF_OF_VISIT'), 'NO_PROOF_OF_VISIT'],
    [e(409, 'ALREADY_REVIEWED'), 'ALREADY_REVIEWED'],
    [e(400, 'INVALID_RATING'), 'RATING_REQUIRED'],
    [e(400, 'BAD_REQUEST', { field: 'rating' }), 'RATING_REQUIRED'],
    [e(400, 'BAD_REQUEST', { field: 'body' }), 'TOO_LONG'],
    [e(400, 'BAD_REQUEST'), 'FAILED'],
    [e(404, 'NOT_FOUND'), 'NOT_ALLOWED'],
    [e(403, 'FORBIDDEN'), 'NOT_ALLOWED'],
    [e(500, 'INTERNAL'), 'FAILED'],
    [e(0, 'NETWORK'), 'FAILED'],
    [new Error('boom'), 'FAILED'],
  ])('%s → %s', (err, key) => {
    expect(reviewErrorKey(err)).toBe(key);
  });

  it('has words for every key it returns, in both catalogues', () => {
    for (const key of ['NO_PROOF_OF_VISIT', 'ALREADY_REVIEWED', 'RATING_REQUIRED', 'TOO_LONG']) {
      expect(mb.review.error).toHaveProperty(key);
    }
    expect(mb.review.error).toHaveProperty('NOT_ALLOWED');
    expect(mb.review.error).toHaveProperty('FAILED');
  });
});

describe('withPendingReview', () => {
  it('is pure', () => {
    const pages = [page([booking()])];
    const before = JSON.stringify(pages);
    withPendingReview(
      pages,
      { slug: 'alpha', bookingId: 'bk1', venueId: 'v1', rating: 5, body: '' },
      'tmp',
    );
    expect(JSON.stringify(pages)).toBe(before);
  });
});
