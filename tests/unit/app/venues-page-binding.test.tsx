/**
 * @jest-environment node
 *
 * node, not jsdom: nothing here touches the DOM, and if the singleton import
 * ever comes back, `pg` dies on a missing TextEncoder under jsdom — the suite
 * would then fail at import rather than on the assertion that names the bug.
 */
import { isValidElement, type ReactNode } from 'react';

import { listVenues } from '@/app-layer/repositories/venue';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import VenuesPage from '@/app/(public)/venues/page';
import { VenueList } from '@/app/(public)/venues/VenueList';

/**
 * The public venues page must read through a BOUND handle — and, since T27,
 * hand the client a seed in exactly the shape `GET /api/v1/venues` answers.
 *
 * `venue` carries FORCE ROW LEVEL SECURITY keyed on app.tenant_id. Handed the
 * raw singleton the page runs with no RLS context at all: every row in dev,
 * where the connection role is a cluster superuser, and zero rows — with no
 * error — as the least-privileged production role. The page renders "no venues
 * in Sofia" either way and nothing in the logs disagrees.
 *
 * The guardrail scan proves the singleton is not IMPORTED here. This proves the
 * handle the repository actually receives is the one `runAsSuperuser` opened,
 * which a text scan cannot see.
 *
 * The seed matters as much: `VenueList` holds it under the v1 key and
 * revalidates once after paint, so a seed that differs from the endpoint —
 * another page size, an inactive court's sport, a club-less venue — is a list
 * that changes under the person's thumb a moment after it appears.
 */

// Stands in for what the real wrapper hands its callback: a transaction that
// has already had `SET LOCAL ROLE app_superuser` applied. The marker is built
// inside the factory because jest hoists the factory above module scope. The
// club lookup runs on the same handle.
jest.mock('@/lib/db/rls-middleware', () => {
  const db = {
    __boundAs: 'app_superuser',
    venueOrg: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        // `t_gone` has no club row: a venue that outlived its club.
        where.id.in.filter((id) => id !== 't_gone').map((id) => ({ id, slug: `club-${id}` })),
      ),
    },
  };
  return {
    runAsSuperuser: jest.fn((fn: (handle: unknown) => unknown) => Promise.resolve(fn(db))),
  };
});

jest.mock('@/app-layer/repositories/venue', () => ({
  listVenues: jest.fn(async () => ({ items: [], nextCursor: null })),
}));

jest.mock('next-intl/server', () => ({
  getLocale: jest.fn(async () => 'bg'),
  getTranslations: jest.fn(async () => (key: string) => key),
}));

type Row = Awaited<ReturnType<typeof listVenues>>['items'][number];
type ListProps = Parameters<typeof VenueList>[0];

const row = (id: string, tenantId: string): Row =>
  ({
    id,
    tenantId,
    slug: `venue-${id}`,
    name: `Venue ${id}`,
    city: 'Sofia',
    country: 'BG',
    avgRating: 4.5,
    reviewCount: 3,
    coverPhotoUrl: null,
    resources: [
      { sport: 'PADEL', basePriceCents: 2400, status: 'ACTIVE' },
      { sport: 'TENNIS', basePriceCents: 1800, status: 'ACTIVE' },
      // Inactive: neither its sport nor its price may reach the card. The
      // endpoint's mapper drops it; the page's own mapping did not.
      { sport: 'CHESS', basePriceCents: 100, status: 'INACTIVE' },
    ],
  }) as unknown as Row;

/** The props the page hands `VenueList`, found in the element tree it returns. */
function listProps(tree: ReactNode): ListProps {
  const found: ListProps[] = [];
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isValidElement(node)) return;
    const props = node.props as { children?: ReactNode };
    if (node.type === VenueList) found.push(props as ListProps);
    walk(props.children);
  };
  walk(tree);
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe('public venues page database binding', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads through the superuser binding, not an unbound client', async () => {
    await VenuesPage({ searchParams: Promise.resolve({ city: 'Sofia' }) });

    expect(runAsSuperuser).toHaveBeenCalledTimes(1);

    // The repository was handed the transaction the wrapper opened, not a client
    // obtained some other way: only the wrapper's handle carries this marker.
    const [db] = jest.mocked(listVenues).mock.calls[0]!;
    expect((db as unknown as { __boundAs?: string }).__boundAs).toBe('app_superuser');
  });

  it('forwards the search filters to the repository', async () => {
    // Guards the mechanical half of the change: the filters moved inward by one
    // closure when the call was wrapped, and dropping one there would widen
    // every search to "everything" without failing anything else.
    await VenuesPage({ searchParams: Promise.resolve({ q: 'padel', city: 'Sofia' }) });

    const [, filter, opts] = jest.mocked(listVenues).mock.calls[0]!;
    expect(filter).toMatchObject({ q: 'padel', city: 'Sofia' });
    // No limit: `clampLimit`'s default (20), which is what GET /api/v1/venues
    // applies to the key the seed is held under — a key with no `limit`.
    expect(opts).toEqual({});
  });

  it('seeds the list in the endpoint’s shape, under the filters it read', async () => {
    jest.mocked(listVenues).mockResolvedValueOnce({
      items: [row('v1', 't1'), row('v2', 't_gone')],
      nextCursor: 'c1',
    });

    const tree = await VenuesPage({
      searchParams: Promise.resolve({ city: 'Sofia', q: '', sport: 'PADEL' }),
    });
    const { seed, initialFilters } = listProps(tree);

    // An empty `q` is absent, as `query()` in keys.ts leaves it out of the key.
    expect(initialFilters).toEqual({ city: 'Sofia', sport: 'PADEL' });

    // `toVenueSummary` with the club's slug; the club-less venue is left out,
    // as the route leaves it out; the cursor is the repository's.
    expect(seed).toEqual({
      items: [
        {
          id: 'v1',
          slug: 'venue-v1',
          clubSlug: 'club-t1',
          name: 'Venue v1',
          city: 'Sofia',
          country: 'BG',
          avgRating: 4.5,
          reviewCount: 3,
          sports: ['PADEL', 'TENNIS'],
          fromPriceCents: 1800,
          coverPhotoUrl: null,
        },
      ],
      nextCursor: 'c1',
    });
  });

  it('an empty search seeds an empty, unfiltered list', async () => {
    const tree = await VenuesPage({ searchParams: Promise.resolve({}) });

    expect(listProps(tree)).toEqual({
      seed: { items: [], nextCursor: null },
      initialFilters: {},
    });
  });
});
