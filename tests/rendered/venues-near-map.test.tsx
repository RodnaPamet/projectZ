import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

import { VenueList } from '@/app/(public)/venues/VenueList';
import type { VenueSummary } from '@/app/api/v1/_lib/dto';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import type { V1Page } from '@/lib/data/keys';
import { DataProvider } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { installFakeFetch, ok, tick, type FakeCall } from '../unit/data/fake-v1';

/**
 * /venues' «Близо до мен» with its 1–100 km slider, and the list/map switch
 * (#697), against the real Bulgarian catalogue and a fake v1. The map itself
 * (maplibre, which needs WebGL) is stood in for by a list of its pins: what is
 * pinned here is which venues reach it, and what a tapped pin does.
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

jest.mock('@/components/venues/ClubsMap', () => ({
  __esModule: true,
  default: ({
    pins,
    selectAction,
    label,
  }: {
    pins: { id: string; name: string }[];
    selectAction: (id: string) => void;
    label: string;
  }) => (
    <div role="region" aria-label={label} data-testid="clubs-map">
      {pins.map((p) => (
        <button key={p.id} type="button" aria-label={p.name} onClick={() => selectAction(p.id)} />
      ))}
    </div>
  ),
}));

const v = messages.venues;

const venue = (over: Partial<VenueSummary> = {}): VenueSummary => ({
  id: 'v1',
  slug: 'alfa',
  clubSlug: 'alpha',
  publicSlug: 'alfa',
  name: 'Алфа Кортове',
  city: 'Sofia',
  cityKey: 'sofia',
  cityNames: { bg: 'София', en: 'Sofia' },
  country: 'BG',
  avgRating: 0,
  reviewCount: 0,
  sports: ['PADEL'],
  fromPriceCents: 2400,
  currency: 'EUR',
  clubLogoUrl: null,
  coverPhotoUrl: null,
  cover: null,
  lat: 42.69,
  lng: 23.32,
  ...over,
});
const page = (items: VenueSummary[]): V1Page<VenueSummary> => ({ items, nextCursor: null });
const beta = venue({ id: 'v2', name: 'Бета Арена', publicSlug: 'beta', lat: 42.15, lng: 24.75 });

function mount() {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <VenueList
            seed={page([venue()])}
            initialFilters={Object.fromEntries(search)}
            facets={{ cities: ['Sofia'], sports: ['PADEL'] }}
          />
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

type Geo = Pick<Geolocation, 'getCurrentPosition'>;
function stubGeolocation(answer: (ok: PositionCallback, no: PositionErrorCallback) => void) {
  const geo: Geo = {
    getCurrentPosition: jest.fn((ok: PositionCallback, no?: PositionErrorCallback | null) =>
      answer(ok, no!),
    ),
  };
  Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
  return geo;
}
const sofia = (ok: PositionCallback) =>
  ok({ coords: { latitude: 42.697712, longitude: 23.321868 } } as GeolocationPosition);

const nearCalls = (calls: FakeCall[]) => calls.filter((c) => c.url.includes('/venues/near'));

beforeEach(() => {
  search = new URLSearchParams();
  window.history.replaceState(null, '', '/venues');
  window.localStorage.clear();
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('/venues — «Близо до мен» (#697)', () => {
  it('reads the venues within 25 km of the person, nearest first, each with its distance', async () => {
    stubGeolocation(sofia);
    const calls = installFakeFetch((c) =>
      c.url.includes('/venues/near')
        ? ok({ venues: [{ ...venue(), distanceKm: 1.24 }], radiusKm: 25, maxResults: 50 })
        : ok(page([venue()])),
    );
    mount();
    await userEvent.click(screen.getByRole('button', { name: v.near.chip }));
    await act(tick);

    expect(screen.getByRole('button', { name: v.near.chip })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(nearCalls(calls).map((c) => c.url)).toEqual([
      '/api/v1/venues/near?lat=42.698&lng=23.322&radiusKm=25',
    ]);
    expect(await screen.findByText('1 обект в радиус 25 км')).toBeInTheDocument();
    expect(screen.getByText('София · 1,2 км')).toBeInTheDocument();
    expect(screen.getByLabelText('В радиус 25 км')).toHaveValue('25');
  });

  it('the slider reads again on release, not on every step, and remembers the reach', async () => {
    stubGeolocation(sofia);
    const calls = installFakeFetch((c) =>
      c.url.includes('/venues/near')
        ? ok({ venues: [], radiusKm: 60, maxResults: 50 })
        : ok(page([venue()])),
    );
    mount();
    await userEvent.click(screen.getByRole('button', { name: v.near.chip }));
    await act(tick);

    const slider = screen.getByLabelText('В радиус 25 км');
    fireEvent.change(slider, { target: { value: '40' } });
    fireEvent.change(slider, { target: { value: '60' } });
    expect(screen.getByText('В радиус 60 км')).toBeInTheDocument();
    expect(nearCalls(calls)).toHaveLength(1);

    fireEvent.pointerUp(slider);
    await act(tick);
    expect(nearCalls(calls).map((c) => c.url)).toEqual([
      '/api/v1/venues/near?lat=42.698&lng=23.322&radiusKm=25',
      '/api/v1/venues/near?lat=42.698&lng=23.322&radiusKm=60',
    ]);
    expect(window.localStorage.getItem('venues.radiusKm')).toBe('60');
    expect(await screen.findByText('Няма обекти в радиус 60 км')).toBeInTheDocument();
  });

  it('carries the list’s filters', async () => {
    search = new URLSearchParams({ sport: 'PADEL' });
    stubGeolocation(sofia);
    const calls = installFakeFetch((c) =>
      c.url.includes('/venues/near')
        ? ok({ venues: [], radiusKm: 25, maxResults: 50 })
        : ok(page([venue()])),
    );
    mount();
    await userEvent.click(screen.getByRole('button', { name: v.near.chip }));
    await act(tick);
    expect(nearCalls(calls)[0]!.url).toBe(
      '/api/v1/venues/near?lat=42.698&lng=23.322&radiusKm=25&sport=PADEL',
    );
  });

  it('a refused location says where to allow it, and asks nothing of the server', async () => {
    stubGeolocation((_ok, no) => no({ code: 1 } as GeolocationPositionError));
    const calls = installFakeFetch(() => ok(page([venue()])));
    mount();
    await userEvent.click(screen.getByRole('button', { name: v.near.chip }));
    await act(tick);
    expect(screen.getByText(v.near.denied)).toBeInTheDocument();
    expect(nearCalls(calls)).toEqual([]);
  });

  it('pressed again, it is the whole list again', async () => {
    stubGeolocation(sofia);
    installFakeFetch((c) =>
      c.url.includes('/venues/near')
        ? ok({ venues: [], radiusKm: 25, maxResults: 50 })
        : ok(page([venue()])),
    );
    mount();
    const chip = screen.getByRole('button', { name: v.near.chip });
    await userEvent.click(chip);
    await userEvent.click(chip);
    await act(tick);
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByLabelText(/В радиус/)).not.toBeInTheDocument();
    expect(screen.getByText('Алфа Кортове')).toBeInTheDocument();
  });
});

describe('/venues — the list/map switch (#697)', () => {
  it('the map shows every bookable venue under the list’s filters; a pin shows its card', async () => {
    search = new URLSearchParams({ sport: 'PADEL' });
    const calls = installFakeFetch((c) =>
      c.url.includes('/venues/map')
        ? ok({ venues: [venue(), beta], truncated: false, maxResults: 1000 })
        : ok(page([venue()])),
    );
    mount();
    const views = screen.getByRole('radiogroup', { name: v.view.label });
    await userEvent.click(within(views).getByRole('radio', { name: v.view.map }));
    await act(tick);

    expect(calls.filter((c) => c.url.includes('/venues/map')).map((c) => c.url)).toEqual([
      '/api/v1/venues/map?sport=PADEL',
    ]);
    const map = await screen.findByRole('region', { name: 'Карта на обектите, 2 обекта' });
    expect(screen.getByText(v.map.hint)).toBeInTheDocument();
    expect(screen.getByText('2 обекта на картата')).toBeInTheDocument();

    await userEvent.click(within(map).getByRole('button', { name: 'Бета Арена' }));
    expect(screen.getByRole('link', { name: 'Бета Арена' })).toHaveAttribute(
      'href',
      '/venues/beta',
    );
    expect(screen.queryByText(v.map.hint)).not.toBeInTheDocument();

    // Back to the list: the cards again.
    await userEvent.click(within(views).getByRole('radio', { name: v.view.list }));
    expect(screen.queryByTestId('clubs-map')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Алфа Кортове' })).toBeInTheDocument();
  });

  it('near me, the map shows the near venues and reads no country map', async () => {
    stubGeolocation(sofia);
    const calls = installFakeFetch((c) =>
      c.url.includes('/venues/near')
        ? ok({ venues: [{ ...beta, distanceKm: 3 }], radiusKm: 25, maxResults: 50 })
        : ok(page([venue()])),
    );
    mount();
    await userEvent.click(screen.getByRole('button', { name: v.near.chip }));
    await userEvent.click(screen.getByRole('radio', { name: v.view.map }));
    await act(tick);

    const map = await screen.findByRole('region', { name: 'Карта на обектите, 1 обект' });
    expect(within(map).getByRole('button', { name: 'Бета Арена' })).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/venues/map'))).toBe(false);
  });
});
