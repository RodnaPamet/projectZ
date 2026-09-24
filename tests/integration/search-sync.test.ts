import { __resetMeili, meili } from '@/lib/search/client';
import { INDEXES } from '@/lib/search/indexes';
import { reindexAll, syncSession, syncVenue } from '@/lib/search/sync';

import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Against a REAL Meilisearch, not a mock.
 *
 * A mocked search test proves the mapper compiles. It cannot prove that
 * "padle" finds padel — and typo tolerance is the entire reason to run a
 * search engine rather than an ILIKE.
 */
describe('search sync', () => {
  const prisma = prismaTestClient();

  beforeAll(async () => {
    // The test creates its own indexes rather than depending on a CI step.
    //
    // Relying on a separate `search-setup` job step means the suite passes in
    // one job and fails in another purely because somebody added the step to
    // the integration job and not the coverage one — which is exactly what
    // happened. A test that needs a fixture should build it.
    __resetMeili();
    for (const def of Object.values(INDEXES)) {
      await meili()
        .createIndex(def.uid, { primaryKey: def.primaryKey })
        .catch(() => {});
      await meili()
        .index(def.uid)
        .updateSettings({
          searchableAttributes: [...def.searchable],
          filterableAttributes: [...def.filterable],
          sortableAttributes: [...def.sortable],
          typoTolerance: { enabled: true, minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 } },
        })
        .waitTask();
    }
  }, 60_000);

  beforeEach(async () => {
    __resetMeili();
    // Start from empty so a stale doc from a previous test cannot make a
    // failing assertion pass.
    for (const def of Object.values(INDEXES)) {
      await meili().index(def.uid).deleteAllDocuments().waitTask();
    }
  });

  async function makeVenue(name: string, city = 'Sofia') {
    const t = await seedTenant();
    return asAppSuperuser(prisma, async (tx) => {
      const v = await tx.venue.create({
        data: {
          tenantId: t.tenantId,
          slug: name.toLowerCase().replace(/\W+/g, '-'),
          name,
          addressLine: '1',
          city,
          email: `${name}@playerz.test`,
          lat: 42.6977,
          lng: 23.3219,
        },
      });
      await tx.resource.create({
        data: {
          tenantId: t.tenantId,
          venueId: v.id,
          name: 'Court 1',
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 2400,
        },
      });
      return v;
    });
  }

  async function search(index: string, q: string) {
    const res = await meili().index(index).search(q);
    return res.hits as Array<{ id: string; name?: string }>;
  }

  /**
   * Wait until everything already queued against `uid` has actually been indexed.
   *
   * `syncVenue`/`syncSession` return as soon as Meilisearch has ENQUEUED the task
   * (src/lib/search/sync.ts) — deliberately, because the index is a cache and the
   * write path must not block on it. They hand back no taskUid, so a test cannot
   * await the work directly.
   *
   * The queue is FIFO, so enqueueing an empty `addDocuments([])` and awaiting THAT
   * task cannot finish before everything queued ahead of it has. That is the whole
   * trick, and it works for deletions too.
   *
   * ═══ WHY THIS IS NOT A FIXED DELAY ═══
   *
   * These waits used to be fixed delays of 300-400ms, which passed on CI and
   * failed on a developer laptop — the worst possible split, because the failure
   * then looks like a product bug.
   *
   * Measured here: a single-document add costs ~514ms under Colima on an emulated
   * amd64 stack, against ~0.7ms for a deletion. So a 400ms wait was short by
   * ~114ms EVERY time, and three tests failed deterministically in six seconds
   * while the document they wanted sat in the index, correct, 114ms later. On a
   * native CI runner the same add is single-digit milliseconds and 400ms looked
   * generous.
   *
   * A longer delay would not fix this. It would be slower everywhere and still a
   * guess about somebody else's disk.
   */
  async function settle(uid: string) {
    const index = meili().index(uid);
    // 30s, not the client's 5s default: the point is to outlast a slow host, and
    // a barrier that times out is just a delay that fails more loudly.
    await index.addDocuments([]).waitTask({ timeout: 30_000 });
  }

  it('a venue update reaches the index', async () => {
    const v = await makeVenue('Sofia Padel Club');
    await syncVenue(prisma, v.id);
    await settle(INDEXES.venues.uid);

    const hits = await search(INDEXES.venues.uid, 'Sofia Padel');
    expect(hits.map((h) => h.id)).toContain(v.id);
  });

  it('TYPO TOLERANCE: "padle" finds the padel venue', async () => {
    // The entire reason to run Meilisearch instead of an ILIKE. A user on a
    // phone types "padle", and an ILIKE returns nothing.
    const v = await makeVenue('Padel Palace');
    await syncVenue(prisma, v.id);
    await settle(INDEXES.venues.uid);

    const hits = await search(INDEXES.venues.uid, 'padle');
    expect(hits.map((h) => h.id)).toContain(v.id);
  });

  it('a deleted venue is removed from the index', async () => {
    const v = await makeVenue('Ephemeral');
    await syncVenue(prisma, v.id);
    await settle(INDEXES.venues.uid);
    expect((await search(INDEXES.venues.uid, 'Ephemeral')).length).toBeGreaterThan(0);

    await asAppSuperuser(prisma, (tx) => tx.venue.delete({ where: { id: v.id } }));
    await syncVenue(prisma, v.id);
    await settle(INDEXES.venues.uid);

    // A deleted venue that lingers in the index is worse than one that never
    // appeared: a player clicks through to a 404.
    expect(await search(INDEXES.venues.uid, 'Ephemeral')).toEqual([]);
  });

  it('reindexAll rebuilds every index from an empty state', async () => {
    // A cache you cannot rebuild is not a cache; it is a liability.
    await makeVenue('Rebuildable One');
    await makeVenue('Rebuildable Two');

    expect(await search(INDEXES.venues.uid, 'Rebuildable')).toEqual([]);

    const { venues } = await reindexAll(prisma);
    expect(venues).toBeGreaterThanOrEqual(2);
    await settle(INDEXES.venues.uid);

    expect((await search(INDEXES.venues.uid, 'Rebuildable')).length).toBeGreaterThanOrEqual(2);
  });

  it('a sync failure NEVER breaks the write path — the index is a cache', async () => {
    // Point the client at a dead Meilisearch.
    __resetMeili();
    const saved = process.env.MEILISEARCH_HOST;
    process.env.MEILISEARCH_HOST = 'http://127.0.0.1:9';

    try {
      const v = await makeVenue('Resilient');

      // The venue write succeeded. The sync must degrade, not throw — a write
      // rolled back because a SEARCH SERVER was down would be an absurd way to
      // lose data.
      await expect(syncVenue(prisma, v.id)).resolves.toBeUndefined();

      const stillThere = await asAppSuperuser(prisma, (tx) =>
        tx.venue.findUnique({ where: { id: v.id } }),
      );
      expect(stillThere).toBeTruthy();
    } finally {
      process.env.MEILISEARCH_HOST = saved;
      __resetMeili();
    }
  });

  it('a session doc carries its spotsLeft and never goes negative', async () => {
    const t = await seedTenant();
    const sessionId = await asAppSuperuser(prisma, async (tx) => {
      const v = await tx.venue.create({
        data: {
          tenantId: t.tenantId,
          slug: 'sv',
          name: 'SV',
          addressLine: '1',
          city: 'Sofia',
          email: 'sv@playerz.test',
          lat: 42.7,
          lng: 23.3,
        },
      });
      const r = await tx.resource.create({
        data: {
          tenantId: t.tenantId,
          venueId: v.id,
          name: 'C',
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 1,
        },
      });
      const s = await tx.openPlaySession.create({
        data: {
          tenantId: t.tenantId,
          resourceId: r.id,
          hostUserId: t.userId,
          sport: 'PADEL',
          startTs: new Date(Date.now() + 86_400_000),
          endTs: new Date(Date.now() + 90_000_000),
          maxParticipants: 4,
          currentCount: 1,
        },
      });
      return s.id;
    });

    await syncSession(prisma, sessionId);
    await settle(INDEXES.sessions.uid);

    const hits = (await meili().index(INDEXES.sessions.uid).search('')).hits as Array<{
      id: string;
      spotsLeft: number;
      sportLabel: string;
    }>;

    const doc = hits.find((h) => h.id === sessionId);
    expect(doc?.spotsLeft).toBe(3);
    // The label comes from the REGISTRY, so a newly registered sport becomes
    // searchable by name without touching this code.
    expect(doc?.sportLabel).toBe('Padel');
  });
});
