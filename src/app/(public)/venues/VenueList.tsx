'use client';

import { useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { VenueSummary } from '@/app/api/v1/_lib/dto';
import { CardGridSkeleton } from '@/components/loading/shapes';
import { MobileListAffordances } from '@/components/mobile/MobileListAffordances';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { useSsrFallback } from '@/components/ui/hooks/use-ssr-fallback';
import { StatusBadge } from '@/components/ui/status-badge';
import { KEYS, type V1Page } from '@/lib/data/keys';
import { useV1SWRInfinite } from '@/lib/data/use-v1-swr';

/** The filters `GET /api/v1/venues` is keyed on here. Absent means unfiltered. */
export type VenueFilters = Partial<Record<'q' | 'city' | 'sport', string>>;

const FILTER_NAMES = ['q', 'city', 'sport'] as const;

/**
 * The venue index on `GET /api/v1/venues`, the endpoint the native app reads.
 *
 * ═══ THE SEED IS PAGE ONE, WHILE THE FILTERS STILL MATCH ═══
 *
 * page.tsx reads page one on the server with the endpoint's own mapper and
 * hands it over as `fallbackData`, so the list paints with the HTML — no
 * skeleton, no second paint — and SWR revalidates it once after paint. On a
 * client navigation back here the cache already holds the list and wins over
 * the seed.
 *
 * The key is built from the URL's own search params, not from the props, and
 * `useSsrFallback` decides whether the seed still describes it: a seed for
 * `?city=Sofia` must never stand in for `?city=Plovdiv`, where it would be
 * the wrong venues with no spinner to say so. `keepPreviousData` (on in
 * use-v1-swr.ts) then keeps the last list on screen while a new filter loads,
 * and the skeleton below is only for a key with nothing at all to show.
 *
 * ═══ PAGE ONE ONLY ═══
 *
 * `KEYS.venues` is a cursor list, so this is `useSWRInfinite` at size 1: the
 * same twenty venues the server-rendered page always showed. A "show more"
 * needs copy the `venues` catalogue does not carry yet.
 *
 * ═══ THE CARDS ARE NOT LINKS ═══
 *
 * Not until the venue page exists (#224). Every card linked to
 * /venues/{slug}, a route that was never built: a tap was a 404, and because
 * a <Link> in the viewport prefetches, every visit also fetched one 404 per
 * card in the background (#267). The name is plain text until there is
 * somewhere for it to go; tests/e2e/venue-discovery.spec.ts holds that.
 */
export function VenueList({
  seed,
  initialFilters,
}: {
  seed: V1Page<VenueSummary>;
  /** The filters the server rendered `seed` for. */
  initialFilters: VenueFilters;
}) {
  const t = useTranslations('venues');
  const params = useSearchParams();

  // Joined into one string so the memo below changes only when a VALUE does,
  // not on every new URLSearchParams object.
  const sig = FILTER_NAMES.map((k) => params?.get(k) ?? '').join('\u0000');
  const filters = useMemo(() => {
    const values = sig.split('\u0000');
    const out: Record<string, string> = {};
    FILTER_NAMES.forEach((k, i) => {
      if (values[i]) out[k] = values[i]!;
    });
    return out as VenueFilters;
  }, [sig]);

  // The key function is the list's identity (`unstable_serialize`), so it is
  // rebuilt only when a filter changes.
  const getKey = useMemo(() => KEYS.venues(filters), [filters]);

  const seedFits = useSsrFallback({
    queryKeyFilters: filters as Record<string, string>,
    initialFilters: initialFilters as Record<string, string>,
    serverHadFilters: Object.keys(initialFilters).length > 0,
    hasActive: Object.keys(filters).length > 0,
  });

  const { data, mutate } = useV1SWRInfinite<VenueSummary>(getKey, {
    fallbackData: seedFits ? [seed] : undefined,
    keepPreviousData: true,
  });

  const items = data?.[0]?.items;

  return (
    <>
      {/* Pull down to refresh, jump back to the top of a long list. The pull
          re-reads the list through SWR — the same GET a focus would make —
          rather than re-rendering the server component. */}
      <MobileListAffordances onRefresh={() => mutate()} />

      {items === undefined ? (
        <CardGridSkeleton className="mt-8" count={6} />
      ) : (
        <>
          {/* ICU plural, not `venue{s}`. Bulgarian does not form plurals by
              appending a letter, and the count word itself changes — so the
              shape has to come from the catalogue, not from the JSX. */}
          <p className="text-content-muted mt-1 mb-8 text-sm">
            {t('count', { count: items.length })}
          </p>

          {items.length === 0 ? (
            // data-perf-ready: the perf harness's READY marker (docs/perf/README.md).
            <div data-perf-ready>
              <EmptyState title={t('empty.title')} description={t('empty.description')} />
            </div>
          ) : (
            <ul data-perf-ready className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((v) => (
                <VenueCard key={v.id} venue={v} />
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

function VenueCard({ venue: v }: { venue: VenueSummary }) {
  const t = useTranslations('venues');
  const tSports = useTranslations('sports');
  const format = useFormatter();

  return (
    <Card as="li" elevation="flat" density="compact" className="bg-bg-default">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-content-emphasis font-medium">{v.name}</h2>
        {v.reviewCount > 0 && (
          <StatusBadge variant="success" className="shrink-0">
            {format.number(v.avgRating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ★
          </StatusBadge>
        )}
      </div>

      <p className="text-content-muted mt-1 text-sm">
        {v.city}, {v.country}
      </p>

      {v.sports.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {/* The catalogue's name for the sport, not the enum lower-cased:
              `table_tennis` was on every card, in English, on a Bulgarian
              page. `sports.*` carries every value of the Sport enum. */}
          {v.sports.map((s) => (
            <StatusBadge key={s} variant="neutral">
              {tSports(s as never)}
            </StatusBadge>
          ))}
        </div>
      )}

      {v.fromPriceCents !== null && (
        <p className="text-content-subtle mt-3 text-xs">
          {/* Formatted through Intl, not `€` + toFixed. Bulgarian writes the
              amount before the symbol and uses a comma for the decimal
              separator — "24,00 €", not "€24.00". */}
          {t('priceFrom', {
            price: format.number(v.fromPriceCents / 100, { style: 'currency', currency: 'EUR' }),
          })}
        </p>
      )}
    </Card>
  );
}
