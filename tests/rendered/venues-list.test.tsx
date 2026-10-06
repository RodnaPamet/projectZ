import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { VenueList, type VenueFilters } from '@/app/(public)/venues/VenueList';
import type { VenueSummary } from '@/app/api/v1/_lib/dto';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import type { V1Page } from '@/lib/data/keys';
import { DataProvider } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { installFakeFetch, ok, tick } from '../unit/data/fake-v1';

/**
 * /venues on the client data layer (T27), against the REAL Bulgarian
 * catalogue and a fake v1.
 *
 * The page seeds page one from the server with the endpoint's own mapper;
 * `VenueList` holds it under `GET /api/v1/venues?<filters>` — the key built
 * from the URL's search params — and uses it only while those filters are the
 * ones the server read. Each test gets a fresh SWR cache: the default one is
 * module-scoped, and a list cached by one test would be served to the next.
 */

let search = new URLSearchParams();
const refresh = jest.fn();
jest.mock('next/navigation', () => ({
  useSearchParams: () => search,
  useRouter: () => ({ refresh, push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));

const v = messages.venues;

const venue = (over: Partial<VenueSummary> = {}): VenueSummary => ({
  id: 'v1',
  slug: 'alfa',
  clubSlug: 'alpha',
  publicSlug: 'alfa',
  name: 'Алфа Кортове',
  city: 'Sofia',
  country: 'BG',
  avgRating: 4.5,
  reviewCount: 12,
  sports: ['PADEL', 'TABLE_TENNIS'],
  fromPriceCents: 2400,
  coverPhotoUrl: null,
  ...over,
});

const page = (items: VenueSummary[]): V1Page<VenueSummary> => ({ items, nextCursor: null });

function mount(seed: V1Page<VenueSummary>, initialFilters: VenueFilters = {}) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <VenueList seed={seed} initialFilters={initialFilters} />
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

const cards = () => within(screen.getByRole('list')).getAllByRole('listitem');

beforeEach(() => {
  search = new URLSearchParams();
  refresh.mockReset();
  __resetSessionExpiryForTests();
  __resetViewerForTests();
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
});

describe('/venues — the seed', () => {
  it('paints the seed at once, then revalidates it from the v1 key once', async () => {
    const calls = installFakeFetch(() => ok(page([venue(), venue({ id: 'v2', name: 'Бета' })])));
    mount(page([venue()]));

    // The seed is on screen before any response: no skeleton, no blank.
    expect(cards()).toHaveLength(1);
    expect(screen.getByText('Алфа Кортове')).toBeInTheDocument();

    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/venues']);
    expect(screen.getByText(/2 налични обекта/)).toBeInTheDocument();
  });

  it('translates the sport badges from the catalogue, not the enum', async () => {
    installFakeFetch(() => ok(page([venue()])));
    mount(page([venue()]));

    const card = cards()[0]!;
    expect(within(card).getByText(messages.sports.PADEL)).toBeInTheDocument();
    expect(within(card).getByText(messages.sports.TABLE_TENNIS)).toBeInTheDocument();
    // What every card used to say, in English, on a Bulgarian page.
    expect(within(card).queryByText(/padel|table_tennis/)).toBeNull();
    await act(tick);
  });

  it('shows the rating and the price the Bulgarian way, and the name links to the venue', async () => {
    installFakeFetch(() => ok(page([venue()])));
    mount(page([venue()]));

    const card = cards()[0]!;
    // A decimal comma, and the amount before the symbol (`24,00 €`).
    expect(within(card).getByText(/4,5/)).toBeInTheDocument();
    expect(within(card).getByText(/24,00\s€/)).toBeInTheDocument();
    // #355: the venue page exists now; one link per card, named after the venue.
    expect(within(card).getAllByRole('link')).toHaveLength(1);
    expect(within(card).getByRole('link', { name: 'Алфа Кортове' })).toHaveAttribute(
      'href',
      '/venues/alfa',
    );
    await act(tick);
  });

  it('leaves out the rating with no reviews and the price with no court', async () => {
    installFakeFetch(() => ok(page([venue({ reviewCount: 0, fromPriceCents: null })])));
    mount(page([venue({ reviewCount: 0, fromPriceCents: null })]));

    const card = cards()[0]!;
    expect(within(card).queryByText(/★/)).toBeNull();
    // Null is "no bookable court", never "free".
    expect(within(card).queryByText(/€/)).toBeNull();
    await act(tick);
  });

  it('an empty answer is the empty state, still marked ready for the perf harness', async () => {
    installFakeFetch(() => ok(page([])));
    const { container } = mount(page([]));

    expect(screen.getByText(v.empty.title)).toBeInTheDocument();
    expect(container.querySelector('[data-perf-ready]')).not.toBeNull();
    await act(tick);
  });
});

describe('/venues — the filters', () => {
  it('keys the read on the URL’s filters, sorted, and uses the seed they match', async () => {
    search = new URLSearchParams('sport=PADEL&city=Sofia');
    const calls = installFakeFetch(() => ok(page([venue()])));
    mount(page([venue()]), { city: 'Sofia', sport: 'PADEL' });

    expect(cards()).toHaveLength(1);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe('/api/v1/venues?city=Sofia&sport=PADEL');
  });

  it('never shows a seed read for other filters', async () => {
    // The server read ?city=Sofia; the URL now says Plovdiv. The Sofia list
    // under a Plovdiv search would be the wrong venues, with no spinner to say so.
    search = new URLSearchParams('city=Plovdiv');
    let answer!: () => void;
    const calls = installFakeFetch(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(ok(page([venue({ id: 'p1', name: 'Пловдив Арена' })])));
        }),
    );
    mount(page([venue()]), { city: 'Sofia' });

    expect(screen.queryByText('Алфа Кортове')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe('/api/v1/venues?city=Plovdiv');
    await act(async () => answer());

    await waitFor(() => expect(screen.getByText('Пловдив Арена')).toBeInTheDocument());
    expect(screen.queryByText('Алфа Кортове')).toBeNull();
  });

  it('an unfiltered seed does not stand in for a filtered URL', async () => {
    search = new URLSearchParams('q=padel');
    installFakeFetch(() => new Promise(() => {}));
    mount(page([venue()]), {});

    expect(screen.queryByText('Алфа Кортове')).toBeNull();
    await act(tick);
  });

  it('an empty filter in the URL is no filter', async () => {
    search = new URLSearchParams('q=&city=');
    const calls = installFakeFetch(() => ok(page([venue()])));
    mount(page([venue()]), {});

    expect(cards()).toHaveLength(1);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe('/api/v1/venues');
  });
});

describe('/venues — pull to refresh', () => {
  it('re-reads the list through SWR, not by re-rendering the server component', async () => {
    const calls = installFakeFetch(() => ok(page([venue()])));
    mount(page([venue()]));
    await waitFor(() => expect(calls).toHaveLength(1));

    await act(async () => {
      fireEvent.touchStart(window, { touches: [{ clientY: 100, clientX: 0 }] });
      fireEvent.touchMove(window, { touches: [{ clientY: 400, clientX: 0 }] });
      fireEvent.touchEnd(window, { changedTouches: [{ clientY: 400, clientX: 0 }] });
    });

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.url).toBe('/api/v1/venues');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('/venues — the cards link to the venue page (#355)', () => {
  it('names one link per card after the venue, at its public slug', () => {
    installFakeFetch(() => ok(page([venue()])));
    mount(page([venue(), venue({ id: 'v2', name: 'Бета', publicSlug: 'beta-club' })]));

    expect(screen.getByRole('link', { name: 'Алфа Кортове' })).toHaveAttribute(
      'href',
      '/venues/alfa',
    );
    expect(screen.getByRole('link', { name: 'Бета' })).toHaveAttribute('href', '/venues/beta-club');
  });

  it('leaves a venue without a public slug as plain text, not a link to a 404', () => {
    installFakeFetch(() => ok(page([venue({ publicSlug: null })])));
    mount(page([venue({ publicSlug: null })]));

    expect(screen.getByText('Алфа Кортове')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
