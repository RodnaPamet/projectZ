/**
 * @jest-environment node
 *
 * node, not jsdom: nothing here touches the DOM, and if the singleton import
 * ever comes back, `pg` dies on a missing TextEncoder under jsdom — the suite
 * would then fail at import rather than on the assertion that names the bug.
 */
import { listVenues } from '@/app-layer/repositories/venue';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import VenuesPage from '@/app/(public)/venues/page';

/**
 * The public venues page must read through a BOUND handle.
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
 */

// Stands in for what the real wrapper hands its callback: a transaction that
// has already had `SET LOCAL ROLE app_superuser` applied. The marker is built
// inside the factory because jest hoists the factory above module scope.
jest.mock('@/lib/db/rls-middleware', () => ({
  runAsSuperuser: jest.fn((fn: (db: unknown) => unknown) =>
    Promise.resolve(fn({ __boundAs: 'app_superuser' })),
  ),
}));

jest.mock('@/app-layer/repositories/venue', () => ({
  listVenues: jest.fn(async () => ({ items: [], nextCursor: null })),
}));

jest.mock('next-intl/server', () => ({
  getLocale: jest.fn(async () => 'bg'),
  getTranslations: jest.fn(async () => (key: string) => key),
}));

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
    expect(opts).toMatchObject({ limit: 20 });
  });
});
