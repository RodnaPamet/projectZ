import type { SportType } from '@prisma/client';
import { getTranslations } from 'next-intl/server';

import { listVenueFacets, listVenues } from '@/app-layer/repositories/venue';
import { toVenueSummary, type VenueSummary } from '@/app/api/v1/_lib/dto';
import { playCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { chromeIdentity } from '@/components/layout/player-chrome-data';
import { Heading } from '@/components/ui/typography';
import type { V1Page } from '@/lib/data/keys';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { countPageUsage } from '@/lib/usage/record';

import { filtersFromParams } from './filters';
import { VenueList } from './VenueList';

export async function generateMetadata() {
  const t = await getTranslations('venues');
  return { title: t('metaTitle') };
}

/**
 * Public venue search: a server SEED, then `GET /api/v1/venues` through SWR.
 *
 * ═══ THE SEED IS THE ENDPOINT'S PAGE ONE ═══
 *
 * The page reads page one on the server and hands it to `VenueList`, which
 * holds it under `KEYS.venues({ q, city, sport })` — the URL the native app
 * reads too — and revalidates once after paint, on tab focus, and on a pull
 * to refresh. So the seed must be EXACTLY what that URL answers, or the first
 * revalidation swaps one list for another under the person's thumb:
 *
 *   - the same repository call with the same filters, and NO `limit`, so
 *     `listVenues` applies `clampLimit`'s default (20) exactly as the route
 *     does for a key that carries none;
 *   - the same mapper, `toVenueSummary`, with each venue's club slug looked
 *     up the way the route looks it up, and a venue with no club row left
 *     out the way the route leaves it out (`venue.tenantId` is not a foreign
 *     key, so a venue can outlive its club — see the route's comments).
 *
 * The slug lookup is written out here as well as in
 * src/app/api/v1/venues/route.ts rather than shared, because the route is not
 * this change's file. tests/unit/app/venues-page-binding.test.tsx pins the
 * seed's half: the binding, the filters, the default page size, and the
 * club-less venue left out.
 *
 * The QUERY lives in venue.ts, where the query-shape and tenant-isolation
 * ratchets scan it. The BINDING is this file's own responsibility, and nothing
 * about going through the repository supplies it — see the comment below.
 */
export default async function VenuesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; city?: string; sport?: string }>;
}) {
  const sp = await searchParams;
  const [t, tNav, me] = await Promise.all([
    getTranslations('venues'),
    getTranslations('common.nav'),
    // Request-cached: the layout's chrome asked already.
    chromeIdentity(),
  ]);

  // Only what the key carries, and empty is absent — as `query()` in keys.ts
  // treats it. A filter the server applied that the key did not would serve
  // one query's rows under another query's name. VenueList reads the URL with
  // the same function, so the two agree; it drops an unknown sport (#334).
  const filters = filtersFromParams({
    get: (k) => {
      const v = sp[k as keyof typeof sp];
      return typeof v === 'string' ? v : null;
    },
  });

  // BYPASSRLS, not the raw singleton — the same binding /api/v1/venues uses,
  // and for the same reason. `venue` carries FORCE ROW LEVEL SECURITY keyed on
  // app.tenant_id, and a public search has no tenant to bind: as app_user this
  // returns ZERO ROWS, so the page renders "no venues in Sofia" with nothing in
  // the logs. It only appeared to work because the dev connection role is a
  // cluster superuser and is exempt from row security.
  //
  // Cross-tenant is the point — a player hunting a padel court does not know
  // which club owns it — so what keeps this read safe is `publicVenueFilter` in
  // listVenues and the hand-written DTO, not the tenant policy. `venue_org` is
  // no more readable unbound than `venue`, so the slug lookup shares the
  // transaction.
  //
  // `runAsSuperuser` directly rather than `asSuperuser` from the v1 bindings:
  // that helper takes a RequestContext, which a page does not have.
  const { seed, facets } = await runAsSuperuser(async (db) => {
    const result = await listVenues(
      db,
      // `filtersFromParams` let only a Sport enum value through.
      { q: filters.q, city: filters.city, sport: filters.sport as SportType | undefined },
      {},
    );

    // One lookup over the page's distinct clubs, `id` and `slug` only — the
    // slug is already in every public `/t/{slug}` URL.
    const tenantIds = [...new Set(result.items.map((v) => v.tenantId))];
    const clubs = tenantIds.length
      ? await db.venueOrg.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, slug: true },
          take: tenantIds.length,
        })
      : [];
    const slugs = new Map(clubs.map((c) => [c.id, c.slug]));

    const seed: V1Page<VenueSummary> = {
      items: result.items.flatMap((v) => {
        const clubSlug = slugs.get(v.tenantId);
        return clubSlug ? [toVenueSummary(v, clubSlug)] : [];
      }),
      nextCursor: result.nextCursor,
    };

    // What the filters offer (#357): the cities and sports some live venue
    // has. Two DISTINCT reads in the same transaction, for the same reason.
    return { seed, facets: await listVenueFacets(db) };
  });

  // The funnel's first step (#371): anonymous, counted after the response.
  await countPageUsage('VENUES_VIEW', {});

  // The chrome (and its <main>) comes from (public)/layout.tsx (T20, #362).
  return (
    <>
      {/*
        safe-area-x and px-6 on DIFFERENT elements. `.safe-area-x` lives in
        globals.css outside any cascade layer, so it beats Tailwind's layered
        `px-6` and, on a phone with no notch inset, set the side padding to
        env(...) = 0: the venue cards ran edge to edge at 393 px (seen in T12's
        skeleton screens, which copied these classes). The inset goes on the
        outside, the gutter on the inside. Inside a signed-in shell the frame's
        <main> pads, so the gutter goes (`in-shell:`, globals.css).
      */}
      <div className="bg-bg-page text-content-default safe-area-x">
        <div className="in-shell:p-0 px-6 py-10">
          {/* Signed in, the shell's top bar shows the trail from md (#362); a
              visitor's header has none. One crumb, the page's own title, so
              it is not drawn inline. */}
          {me ? <PageBreadcrumbs items={playCrumbs(tNav)} className="hidden" /> : null}
          <Heading level={1}>{t('title')}</Heading>
          <VenueList seed={seed} initialFilters={filters} facets={facets} />
        </div>
      </div>
    </>
  );
}
