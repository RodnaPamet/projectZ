import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

import { CoachReviews } from '@/app/(public)/coaches/[slug]/CoachReviews';
import type { CoachReviewsPageDto } from '@/app/api/v1/_lib/coach-dto';
import { CoachCard } from '@/components/coaches/CoachCard';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * «Отзиви» on a coach's page (#551), against the real Bulgarian catalogue and
 * a fake v1: the rating as venues show it, the reviews with their authors as
 * first name and initial, «Изтрий» on one's own, «Подай сигнал» on the rest
 * for a signed-in reader, and "more" by cursor.
 */
const t = (messages as unknown as { coaches: { reviews: Record<string, string> } }).coaches.reviews;
const tReport = (messages as unknown as { messaging: { report: Record<string, unknown> } })
  .messaging.report as { titleReview: string; submit: string; reason: Record<string, string> };

const review = (over: Partial<CoachReviewsPageDto['items'][number]> = {}) => ({
  id: 'cr1',
  rating: 4,
  body: 'Много търпелив.',
  author: 'Петя И.',
  createdAt: '2026-10-10T10:00:00Z',
  mine: false,
  ...over,
});

const SEED: CoachReviewsPageDto = {
  rating: { avgRating: 4.2, reviewCount: 2 },
  items: [review(), review({ id: 'cr2', rating: 5, body: null, author: null, mine: true })],
  nextCursor: null,
};

function mount(seed = SEED, signedIn = true) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), revalidateOnMount: false }}>
          <TooltipProvider>
            <ViewerScope viewerId="usr_reader">
              <CoachReviews slug="ivan-petrov" seed={seed} signedIn={signedIn} />
            </ViewerScope>
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

it('shows the rating as venues do, each author as first name and initial, and the stars in words', () => {
  installFakeFetch(() => ok(SEED));
  mount();
  expect(screen.getByTestId('coach-reviews-rating')).toHaveTextContent('4,2 ★ · 2 отзива');
  const [first, second] = screen.getAllByTestId('coach-review');
  expect(first).toHaveTextContent('Петя И.');
  expect(first).toHaveTextContent('Много търпелив.');
  expect(within(first!).getByLabelText('4 от 5 звезди')).toBeInTheDocument();
  // No name on the account: «Играч»; the caller's own says so.
  expect(second).toHaveTextContent(t.anonymous!);
  expect(second).toHaveTextContent(t.yours!);
});

it('with none, says so and shows no number', () => {
  installFakeFetch(() => ok(SEED));
  mount({ rating: { avgRating: 0, reviewCount: 0 }, items: [], nextCursor: null });
  expect(screen.getByTestId('coach-reviews-none')).toHaveTextContent(t.none!);
  expect(screen.queryByTestId('coach-reviews-rating')).toBeNull();
});

it('«Изтрий» on one’s own asks first, then DELETEs it and takes it off the list', async () => {
  // The server as it is: once deleted, the re-read no longer has it.
  let deleted = false;
  const calls = installFakeFetch((c) => {
    if (c.method === 'DELETE') {
      deleted = true;
      return { status: 204 };
    }
    return ok(deleted ? { ...SEED, items: SEED.items.filter((r) => !r.mine) } : SEED);
  });
  mount();
  const own = screen.getAllByTestId('coach-review')[1]!;
  await userEvent.click(within(own).getByTestId('coach-review-delete'));
  expect((await screen.findAllByText(t.deleteTitle!))[0]).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: t.deleteYes }));
  await waitFor(() => expect(screen.getAllByTestId('coach-review')).toHaveLength(1));
  expect(calls.find((c) => c.method === 'DELETE')!.url).toBe('/api/v1/me/coach-reviews/cr2');
});

it('«Подай сигнал» on somebody else’s, through the report dialog, to the review’s report route', async () => {
  const calls = installFakeFetch((c) =>
    c.method === 'POST' ? ok({ reported: true }, 201) : ok(SEED),
  );
  mount();
  const other = screen.getAllByTestId('coach-review')[0]!;
  // Not on one's own.
  expect(
    within(screen.getAllByTestId('coach-review')[1]!).queryByTestId('coach-review-report'),
  ).toBeNull();
  await userEvent.click(within(other).getByTestId('coach-review-report'));
  expect((await screen.findAllByText(tReport.titleReview))[0]).toBeInTheDocument();
  await userEvent.click(screen.getByRole('radio', { name: tReport.reason.abuse }));
  await userEvent.click(screen.getByRole('button', { name: tReport.submit }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  const post = calls.find((c) => c.method === 'POST')!;
  expect(post.url).toBe('/api/v1/coach-reviews/cr1/report');
  expect(post.body).toEqual({ reason: 'abuse' });
});

it('a reader who is not signed in is offered no report', () => {
  installFakeFetch(() => ok(SEED));
  mount({ ...SEED, items: [review()] }, false);
  expect(screen.queryByTestId('coach-review-report')).toBeNull();
});

it('"more" reads the next page by cursor and adds it', async () => {
  const first = { ...SEED, items: [review()], nextCursor: 'cr1' };
  const calls = installFakeFetch((c) =>
    ok(
      c.url.includes('cursor=cr1')
        ? {
            rating: SEED.rating,
            items: [review({ id: 'cr9', author: 'Георги Д.' })],
            nextCursor: null,
          }
        : first,
    ),
  );
  mount(first);
  await userEvent.click(screen.getByRole('button', { name: t.more }));
  expect(await screen.findByText('Георги Д.')).toBeInTheDocument();
  expect(calls.some((c) => c.url === '/api/v1/coaches/ivan-petrov/reviews?cursor=cr1')).toBe(true);
});

it('the coach card carries the rating line it is given, and none without', () => {
  const { rerender } = render(
    <CoachCard
      slug="ivan-petrov"
      name="Иван Петров"
      avatarUrl={null}
      sports={['Падел']}
      line={null}
      rating="4,2 ★ (2)"
    />,
  );
  expect(screen.getByTestId('coach-card-rating')).toHaveTextContent('4,2 ★ (2)');
  rerender(
    <CoachCard
      slug="ivan-petrov"
      name="Иван Петров"
      avatarUrl={null}
      sports={['Падел']}
      line={null}
    />,
  );
  expect(screen.queryByTestId('coach-card-rating')).toBeNull();
});
