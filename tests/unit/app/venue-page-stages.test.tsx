/**
 * @jest-environment node
 */
import { isValidElement, Suspense, type ReactElement, type ReactNode } from 'react';

import { loadVenueAvailability } from '@/app-layer/usecases/venue-availability';
import VenuePage from '@/app/(public)/venues/[slug]/page';
import { VenueBooking } from '@/app/(public)/venues/[slug]/VenueBooking';
import { VenueHeader } from '@/app/(public)/venues/[slug]/VenueHeader';
import { VenueSlots, VenueSlotsSkeleton } from '@/app/(public)/venues/[slug]/VenueSlots';

/**
 * THE HEADER DOES NOT WAIT FOR THE SLOTS (#403).
 *
 * The venue page paints in two stages: the header (one venue row) in the
 * shell, and the day's slots behind their own Suspense boundary. Here the
 * availability read is held open, and the page must still resolve, with the
 * header outside the boundary and the slots inside it. A page that awaited the
 * availability before returning would hang this test instead.
 */

jest.mock('@/lib/db/rls-middleware', () => {
  const db = {
    venueOrg: { findUnique: jest.fn(async () => ({ slug: 'sofia-club', status: 'ACTIVE' })) },
  };
  return { runAsSuperuser: jest.fn((fn: (h: unknown) => unknown) => Promise.resolve(fn(db))) };
});

jest.mock('@/app-layer/repositories/venue', () => ({
  getVenueByPublicSlug: jest.fn(async (_db: unknown, slug: string) =>
    slug === 'sofia-padel-club'
      ? {
          id: 'v1',
          tenantId: 't1',
          publicSlug: 'sofia-padel-club',
          name: 'Sofia Padel Club',
          description: null,
          addressLine: 'ул. Тест 1',
          city: 'София',
          country: 'BG',
          lat: null,
          lng: null,
          phone: null,
          timezone: 'Europe/Sofia',
          cancellationCutoffHours: 24,
          coverPhotoUrl: null,
          photos: [],
          resources: [
            { id: 'r1', name: 'Court 1', sport: 'PADEL', basePriceCents: 2400, currency: 'EUR' },
          ],
        }
      : null,
  ),
}));

jest.mock('@/app-layer/usecases/venue-availability', () => ({
  loadVenueAvailability: jest.fn(),
}));

jest.mock('@/components/layout/player-chrome', () => ({
  playerChrome: jest.fn(async () => ({ me: null, kind: 'signed-out' })),
}));

jest.mock('next-intl/server', () => ({
  getLocale: jest.fn(async () => 'bg'),
  getTranslations: jest.fn(async () => (key: string) => key),
}));

const availability = loadVenueAvailability as jest.MockedFunction<typeof loadVenueAvailability>;

/** Every element in a tree, with the Suspense boundaries above each. */
function walk(
  node: ReactNode,
  above: ReactElement[] = [],
  out: Array<[ReactElement, ReactElement[]]> = [],
) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, above, out);
  } else if (isValidElement(node)) {
    out.push([node, above]);
    const props = node.props as { children?: ReactNode };
    walk(props.children, node.type === Suspense ? [...above, node] : above, out);
  }
  return out;
}

const props = (slug: string, sp: Record<string, string> = {}) => ({
  params: Promise.resolve({ slug }),
  searchParams: Promise.resolve(sp),
});

describe('the venue page, two stages (#403)', () => {
  beforeEach(() => availability.mockReset());

  it('resolves with the header while the day’s availability is still loading', async () => {
    let release!: (v: never[]) => void;
    availability.mockReturnValue(new Promise((r) => (release = r)) as never);

    const tree = await VenuePage(props('sofia-padel-club'));
    const all = walk(tree);

    const header = all.find(([el]) => el.type === VenueHeader);
    expect(header).toBeDefined();
    expect((header![0].props as { name: string }).name).toBe('Sofia Padel Club');
    expect(header![1]).toEqual([]); // outside every Suspense boundary

    const slots = all.find(([el]) => el.type === VenueSlots);
    expect(slots).toBeDefined();
    expect(slots![1]).toHaveLength(1); // inside exactly one
    const boundary = slots![1][0]!.props as { fallback: ReactElement };
    expect(boundary.fallback.type).toBe(VenueSlotsSkeleton);

    // The slots stage itself waits for the read, and renders once it lands.
    let done = false;
    const stage = Promise.resolve(
      VenueSlots(slots![0].props as Parameters<typeof VenueSlots>[0]),
    ).then((el) => {
      done = true;
      return el;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);

    release([]);
    const booking = (await stage) as ReactElement;
    expect(booking.type).toBe(VenueBooking);
    expect((booking.props as { viewer: string }).viewer).toBe('signed-out');
  });

  it('an unknown slug is not found before anything renders', async () => {
    await expect(VenuePage(props('no-such-venue'))).rejects.toMatchObject({
      digest: expect.stringContaining('404'),
    });
    expect(availability).not.toHaveBeenCalled();
  });
});
