import { fireEvent, render, screen, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { VenueBooking } from '@/app/(public)/venues/[slug]/VenueBooking';
import type { AvailabilityDto } from '@/app/api/v1/_lib/dto';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';
import type { VenuePlan } from '@/lib/venues/plan';

import { messages, withIntl } from '../helpers/intl';
import { installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * The venue plan above the slots (#625), against the REAL Bulgarian catalogue:
 * time first, then which courts are free for it, said in words for anyone who
 * cannot see the canvas. The canvas itself (taps, pan, zoom) is a browser's:
 * tests/e2e/venue-plan.spec.ts.
 */

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    refresh: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
  }),
}));

const p = messages.venue.plan;

// 2036-07-16, Sofia is UTC+3: 09:00 local = 06:00Z.
const AT = (h: number) => `2036-07-16T${String(h - 3).padStart(2, '0')}:00:00Z`;
const DAYS = Array.from({ length: 14 }, (_, i) =>
  new Date(Date.UTC(2036, 6, 16 + i)).toISOString().slice(0, 10),
);

const slot = (h: number, free: boolean, durations: number[]) => ({
  startTs: AT(h),
  endTs: AT(h + 1),
  priceCents: 2400,
  available: free,
  durations: free
    ? durations.map((m) => ({ minutes: m, endTs: AT(h + m / 60), priceCents: 2400 * (m / 60) }))
    : undefined,
});

const court = (id: string, name: string, lengths: number[], free: Record<number, boolean>) => ({
  resourceId: id,
  name,
  sport: 'PADEL',
  resourceType: 'COURT',
  currency: 'EUR',
  minBookingMinutes: lengths[0]!,
  maxBookingMinutes: lengths[lengths.length - 1]!,
  slotStepMinutes: 60,
  slots: Object.entries(free).map(([h, f]) => slot(Number(h), f, lengths)),
});

// Корт 1: free at 09:00 and 18:00, for an hour or two. Корт 2: free at 18:00
// and 19:00, for an hour only.
const availability: AvailabilityDto = {
  venueId: 'v1',
  venueName: 'Алфа Кортове',
  timezone: 'Europe/Sofia',
  from: '2036-07-15T21:00:00Z',
  to: '2036-07-16T21:00:00Z',
  resources: [
    court('c1', 'Корт 1', [60, 120], { 9: true, 10: false, 18: true, 19: false }),
    court('c2', 'Корт 2', [60], { 9: false, 10: false, 18: true, 19: true }),
  ],
};

const outline = (x: number): [number, number][] => [
  [x, 0],
  [x + 20, 0],
  [x + 20, 10],
  [x, 10],
];

const plan = (attribution: VenuePlan['attribution'] = 'OpenStreetMap'): VenuePlan => ({
  venueId: 'v1',
  courts: [
    {
      resourceId: 'c1',
      name: 'Корт 1',
      sport: 'PADEL',
      resourceType: 'COURT',
      outline: outline(0),
      source: 'OSM',
    },
    {
      resourceId: 'c2',
      name: 'Корт 2',
      sport: 'PADEL',
      resourceType: 'COURT',
      outline: outline(22),
      source: 'OSM',
    },
  ],
  features: [],
  attribution,
});

function mount(withPlan: VenuePlan | null = plan()) {
  installFakeFetch((call) =>
    call.url.endsWith('/usage-events') ? { status: 204 } : ok(availability),
  );
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <TooltipProvider>
            <ViewerScope viewerId="u1">
              <VenueBooking
                venue={{
                  id: 'v1',
                  name: 'Алфа Кортове',
                  publicSlug: 'alfa',
                  clubSlug: 'alpha-club',
                  timezone: 'Europe/Sofia',
                  cancellationCutoffHours: 24,
                }}
                days={DAYS}
                seed={{ day: DAYS[0]!, availability }}
                initialPick={{
                  day: DAYS[0]!,
                  court: null,
                  start: null,
                  minutes: null,
                  confirm: false,
                }}
                renderedAt="2036-07-15T12:00:00Z"
                viewer="player"
                plan={withPlan}
              />
            </ViewerScope>
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

const startTimes = () => screen.findByRole('radiogroup', { name: p.timeLabel });
const said = (key: 'stateFree' | 'stateTaken' | 'statePicked', court: string, time: string) =>
  p[key].replace('{court}', court).replace('{time}', time);

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
  window.history.replaceState(null, '', '/venues/alfa');
});

describe('the venue plan', () => {
  it('offers every start at which some court is free, the first picked', async () => {
    mount();
    const times = await startTimes();
    expect(
      within(times)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['09:00', '18:00', '19:00']);
    expect(within(times).getByRole('radio', { name: '09:00' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('says each court’s state at the picked time, in words', async () => {
    mount();
    const canvas = await screen.findByRole('img', { name: p.label });
    const list = document.getElementById(canvas.getAttribute('aria-describedby')!)!;
    expect(within(list).getByText(said('stateFree', 'Корт 1', '09:00'))).toBeInTheDocument();
    expect(within(list).getByText(said('stateTaken', 'Корт 2', '09:00'))).toBeInTheDocument();

    fireEvent.click(within(await startTimes()).getByRole('radio', { name: '19:00' }));
    expect(within(list).getByText(said('stateTaken', 'Корт 1', '19:00'))).toBeInTheDocument();
    expect(within(list).getByText(said('stateFree', 'Корт 2', '19:00'))).toBeInTheDocument();
  });

  it('moves to a time picked in the list, and shows that court as the pick', async () => {
    mount();
    const times = await startTimes();
    const court2 = screen.getByRole('group', {
      name: messages.venue.slots.courtTimes.replace('{court}', 'Корт 2'),
    });
    fireEvent.click(within(court2).getByRole('button', { name: /^19:00/ }));

    expect(within(times).getByRole('radio', { name: '19:00' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText(said('statePicked', 'Корт 2', '19:00'))).toBeInTheDocument();
  });

  it('offers the lengths the courts allow; a court that does not allow one is not free for it', async () => {
    mount();
    const lengths = await screen.findByRole('radiogroup', { name: p.lengthLabel });
    fireEvent.click(within(lengths).getByRole('radio', { name: '120 мин' }));

    const times = await startTimes();
    expect(
      within(times)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['09:00', '18:00']);
    fireEvent.click(within(times).getByRole('radio', { name: '18:00' }));
    expect(screen.getByText(said('stateFree', 'Корт 1', '18:00'))).toBeInTheDocument();
    expect(screen.getByText(said('stateTaken', 'Корт 2', '18:00'))).toBeInTheDocument();
  });

  it('credits OpenStreetMap when the shapes came from it, and only then', async () => {
    const { unmount } = mount();
    expect(await screen.findByRole('link', { name: p.credit })).toHaveAttribute(
      'href',
      'https://www.openstreetmap.org/copyright',
    );
    unmount();

    mount(plan(null));
    await startTimes();
    expect(screen.queryByRole('link', { name: p.credit })).not.toBeInTheDocument();
  });

  it('lights a court’s card while the pointer or the focus is on it', async () => {
    mount();
    await startTimes();
    const card = screen.getByRole('heading', { level: 3, name: 'Корт 1' }).closest('article')!;
    fireEvent.mouseEnter(card);
    expect(card).toHaveClass('ring-2');
    fireEvent.mouseLeave(card);
    expect(card).not.toHaveClass('ring-2');
  });

  it('is not there when the venue has no plan', () => {
    mount(null);
    expect(screen.queryByRole('radiogroup', { name: p.timeLabel })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: p.label })).not.toBeInTheDocument();
  });
});
