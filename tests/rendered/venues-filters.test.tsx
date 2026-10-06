import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

import { VenueList, type VenueFilters } from '@/app/(public)/venues/VenueList';
import type { VenueSummary } from '@/app/api/v1/_lib/dto';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import type { V1Page } from '@/lib/data/keys';
import { DataProvider } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok, tick } from '../unit/data/fake-v1';

/**
 * /venues' filter bar (#357), the city names (A07), the dropped `?sport=`
 * (#334) and the error with nothing to show (#335), against the REAL
 * Bulgarian catalogue and a fake v1.
 *
 * Each control writes its URL param through the History API — no navigation,
 * no server render — and the list keys its read on the URL (venues-list.test
 * pins that half). `useSearchParams` is mocked here, so what is asserted is
 * what each control WRITES; a test that wants the list to follow sets `search`
 * before mounting, as Next does after a pushState.
 */

let search = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useSearchParams: () => search,
  useRouter: () => ({
    refresh: jest.fn(),
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
  }),
}));

const f = messages.venues.filters;
const facets = { cities: ['Plovdiv', 'Sofia'], sports: ['PADEL', 'TENNIS'] };

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
  sports: ['PADEL'],
  fromPriceCents: 2400,
  coverPhotoUrl: null,
  cover: null,
  ...over,
});

const page = (items: VenueSummary[]): V1Page<VenueSummary> => ({ items, nextCursor: null });

function mount(
  seed: V1Page<VenueSummary>,
  initialFilters: VenueFilters = {},
  swr: Record<string, unknown> = {},
) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), ...swr }}>
          <VenueList seed={seed} initialFilters={initialFilters} facets={facets} />
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

const cards = () => within(screen.getByRole('list')).getAllByRole('listitem');

let push: jest.SpyInstance;
let replace: jest.SpyInstance;

beforeEach(() => {
  search = new URLSearchParams();
  window.history.replaceState(null, '', '/venues');
  push = jest.spyOn(window.history, 'pushState');
  replace = jest.spyOn(window.history, 'replaceState');
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});
afterEach(() => {
  push.mockRestore();
  replace.mockRestore();
});

describe('/venues — the sport filter (#357)', () => {
  it('offers the live sports as a radio group, "Всички" first and chosen', async () => {
    installFakeFetch(() => ok(page([venue()])));
    mount(page([venue()]));

    const group = screen.getByRole('radiogroup', { name: f.sport });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual([f.allSports, messages.sports.PADEL, messages.sports.TENNIS]);
    expect(within(group).getByRole('radio', { name: f.allSports })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await act(tick);
  });

  it('a pick pushes ?sport=, a step Back can undo', async () => {
    installFakeFetch(() => ok(page([venue()])));
    mount(page([venue()]));

    const group = screen.getByRole('radiogroup', { name: f.sport });
    fireEvent.click(within(group).getByRole('radio', { name: messages.sports.TENNIS }));
    expect(push).toHaveBeenLastCalledWith(null, '', '?sport=TENNIS');
    await act(tick);
  });

  it('"Всички" clears the sport and keeps the other filters', async () => {
    window.history.replaceState(null, '', '/venues?city=Sofia&sport=PADEL');
    search = new URLSearchParams('city=Sofia&sport=PADEL');
    installFakeFetch(() => ok(page([venue()])));
    mount(page([venue()]), { city: 'Sofia', sport: 'PADEL' });

    const group = screen.getByRole('radiogroup', { name: f.sport });
    expect(within(group).getByRole('radio', { name: messages.sports.PADEL })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(within(group).getByRole('radio', { name: f.allSports }));
    expect(push).toHaveBeenLastCalledWith(null, '', '?city=Sofia');
    await act(tick);
  });

  it('a ?sport= outside the enum is dropped, not sent to the API (#334)', async () => {
    search = new URLSearchParams('sport=foo');
    const calls = installFakeFetch(() => ok(page([venue()])));
    mount(page([venue()]), {});

    // The server dropped it too, so the unfiltered seed still fits.
    expect(cards()).toHaveLength(1);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe('/api/v1/venues');
  });
});

describe('/venues — the city filter and the city names (#357, A07)', () => {
  it('names the city in Bulgarian, on the trigger and on every card', async () => {
    search = new URLSearchParams('city=Sofia');
    installFakeFetch(() => ok(page([venue()])));
    mount(page([venue()]), { city: 'Sofia' });

    expect(
      screen.getByRole('combobox', { name: `${f.city}, ${messages.cities.sofia}` }),
    ).toBeInTheDocument();
    const card = cards()[0]!;
    expect(within(card).getByText(messages.cities.sofia)).toBeInTheDocument();
    // What every card used to say.
    expect(within(card).queryByText(/Sofia|, BG/)).toBeNull();
    await act(tick);
  });

  it('a city not in the table shows as the club typed it', async () => {
    installFakeFetch(() => ok(page([venue({ city: 'Кранево' })])));
    mount(page([venue({ city: 'Кранево' })]));
    expect(within(cards()[0]!).getByText('Кранево')).toBeInTheDocument();
    await act(tick);
  });

  it('a city picked in the combobox is pushed as its canonical ?city=', async () => {
    const user = userEvent.setup();
    installFakeFetch(() => ok(page([venue()])));
    mount(page([venue()]));

    await user.click(screen.getByRole('combobox', { name: `${f.city}, ${f.allCities}` }));
    await user.click(await screen.findByRole('option', { name: messages.cities.plovdiv }));
    expect(push).toHaveBeenLastCalledWith(null, '', '?city=Plovdiv');
  });
});

describe('/venues — the search (#357)', () => {
  it('reaches the URL once typing pauses, trimmed, replacing rather than pushing', async () => {
    const user = userEvent.setup();
    installFakeFetch(() => ok(page([venue()])));
    mount(page([venue()]));

    await user.type(screen.getByRole('searchbox', { name: f.search }), ' падел ');
    // Not on every keystroke: nothing has been written yet.
    expect(replace).not.toHaveBeenCalledWith(null, '', expect.stringContaining('q='));
    // Once it settles, as a replace: Back must not spell the word out.
    await waitFor(() =>
      expect(replace).toHaveBeenLastCalledWith(
        null,
        '',
        `?${new URLSearchParams({ q: 'падел' }).toString()}`,
      ),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('Enter writes it at once', async () => {
    const user = userEvent.setup();
    installFakeFetch(() => ok(page([venue()])));
    mount(page([venue()]));

    await user.type(screen.getByRole('searchbox', { name: f.search }), 'arena{Enter}');
    expect(replace).toHaveBeenLastCalledWith(null, '', '?q=arena');
  });
});

describe('/venues — a failed read with nothing to show (#335)', () => {
  it('is an error with a retry, not a skeleton for ever, and the retry recovers', async () => {
    // The server rendered Sofia; the URL says Plovdiv: no seed fits.
    search = new URLSearchParams('city=Plovdiv');
    let failing = true;
    const calls = installFakeFetch(() =>
      failing ? fail(500, 'INTERNAL') : ok(page([venue({ id: 'p1', name: 'Пловдив Арена' })])),
    );
    mount(page([venue()]), { city: 'Sofia' }, { shouldRetryOnError: false });

    expect(await screen.findByText(messages.venues.error.title)).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: messages.common.retry }));
    await waitFor(() => expect(screen.getByText('Пловдив Арена')).toBeInTheDocument());
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
