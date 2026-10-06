'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { VenueSummary } from '@/app/api/v1/_lib/dto';
import { CardGridSkeleton } from '@/components/loading/shapes';
import { MobileListAffordances } from '@/components/mobile/MobileListAffordances';
import { Card } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { useSsrFallback } from '@/components/ui/hooks/use-ssr-fallback';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { KEYS, type V1Page } from '@/lib/data/keys';
import { useV1SWRInfinite } from '@/lib/data/use-v1-swr';
import { canonicalCity, cityLabel } from '@/lib/geo/cities';

import { FILTER_NAMES, filtersFromParams, type VenueFilters } from './filters';

export type { VenueFilters };

/** What the filters offer: cities with a live venue, sports with a live court (#357). */
export interface VenueFacetOptions {
  cities: string[];
  sports: string[];
}

/** The ToggleGroup's "every sport" option. Not a Sport enum value, so never sent. */
const ALL = '__all';

/** How long typing must pause before the search reaches the URL and the API. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * Write one filter into the address bar WITHOUT a navigation (#357).
 *
 * The History API, not `router.replace`: Next folds `pushState` and
 * `replaceState` into its router, so `useSearchParams` sees the change and
 * the SWR key below follows it, but nothing re-runs the server page. A filter
 * change is one `GET /api/v1/venues` — the read the native app makes — and
 * not a server render of the whole page. The URL still says what is on screen,
 * so it can be shared, reloaded, or opened in a new tab.
 *
 * A sport or a city is a step back can undo (`push`); each keystroke of a
 * search replaces the last (`replace`), or Back would spell the word out.
 */
function writeParam(
  name: (typeof FILTER_NAMES)[number],
  value: string | null,
  mode: 'push' | 'replace',
) {
  const next = new URLSearchParams(window.location.search);
  if (value) next.set(name, value);
  else next.delete(name);
  const qs = next.toString();
  const url = qs ? `?${qs}` : window.location.pathname;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

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
 * ═══ THE FILTERS (#357) ═══
 *
 * A search box, the sports as a ToggleGroup (upstream has no filter chips; the
 * ToggleGroup is the accepted stand-in, #362) and the cities as a Combobox.
 * Each writes its URL param (`writeParam`) and the list follows the URL. The
 * choices are the server's `facets`: only what some live venue has.
 *
 * ═══ AN ERROR WITH NOTHING TO SHOW (#335) ═══
 *
 * A filter the server did not render has no seed, so a failed read used to
 * leave the skeleton up for ever. It is an ErrorState with a retry now. A
 * failure with a list already on screen keeps the list (`keepPreviousData`).
 *
 * ═══ PAGE ONE ONLY ═══
 *
 * `KEYS.venues` is a cursor list, so this is `useSWRInfinite` at size 1: the
 * same twenty venues the server-rendered page always showed (#332).
 *
 * ═══ EACH CARD LINKS TO ITS VENUE PAGE (#355) ═══
 *
 * `/venues/{publicSlug}`: the venue's public address, unique across clubs
 * (P41). The name is the link and stretches over the card, so the whole card
 * is the target and a screen reader hears one link named after the venue.
 * Default (auto) prefetch, per docs/perf/navigation-policy.md: each card in the
 * viewport fetches the page's `loading.tsx` shell, so a tap paints the
 * skeleton at once. Full prefetch stays pinned to the two links T30 chose.
 * A venue without a public slug (none, after P41's backfill) stays plain text
 * rather than linking to a 404 (#267).
 */
export function VenueList({
  seed,
  initialFilters,
  facets = { cities: [], sports: [] },
}: {
  seed: V1Page<VenueSummary>;
  /** The filters the server rendered `seed` for. */
  initialFilters: VenueFilters;
  facets?: VenueFacetOptions;
}) {
  const t = useTranslations('venues');
  const params = useSearchParams();

  // Cleaned as the server page cleans them (filters.ts), then joined into one
  // string so the memo below changes only when a VALUE does, not on every new
  // URLSearchParams object.
  const cleaned = filtersFromParams(params);
  const sig = FILTER_NAMES.map((k) => cleaned[k] ?? '').join('\u0000');
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

  const { data, error, mutate } = useV1SWRInfinite<VenueSummary>(getKey, {
    fallbackData: seedFits ? [seed] : undefined,
    keepPreviousData: true,
  });

  // Stable, so MobileListAffordances' memo holds across renders (#335).
  const refresh = useCallback(() => mutate(), [mutate]);
  const retry = useCallback(() => void mutate(), [mutate]);

  const items = data?.[0]?.items;

  return (
    <>
      <VenueFilterBar filters={filters} facets={facets} />

      {/* Pull down to refresh, jump back to the top of a long list. The pull
          re-reads the list through SWR — the same GET a focus would make —
          rather than re-rendering the server component. */}
      <MobileListAffordances onRefresh={refresh} />

      {items === undefined ? (
        error ? (
          <div className="mt-8">
            <ErrorState
              title={t('error.title')}
              description={t('error.description')}
              onRetry={retry}
            />
          </div>
        ) : (
          <CardGridSkeleton className="mt-8" count={6} />
        )
      ) : (
        <>
          {/* ICU plural, not `venue{s}`. Bulgarian does not form plurals by
              appending a letter, and the count word itself changes — so the
              shape has to come from the catalogue, not from the JSX. */}
          <p role="status" className="text-content-muted mt-4 mb-6 text-sm">
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

/**
 * The search box, the sports and the city (#357), each bound to its URL param.
 *
 * The search keeps its own draft so typing is not held up by the URL: the
 * draft reaches the URL once typing pauses for SEARCH_DEBOUNCE_MS, or at once
 * on Enter. When the URL's `q` changes under it — Back, or a link — the draft
 * follows, unless it is only the draft's own trailing space the URL trimmed.
 */
function VenueFilterBar({ filters, facets }: { filters: VenueFilters; facets: VenueFacetOptions }) {
  const t = useTranslations('venues.filters');
  const tSports = useTranslations('sports');
  const tCities = useTranslations('cities');

  const urlQ = filters.q ?? '';
  const [draft, setDraft] = useState(urlQ);
  const [seenQ, setSeenQ] = useState(urlQ);
  if (urlQ !== seenQ) {
    // Adjusting state while rendering, React's pattern for "props changed":
    // no effect, so no frame with the stale draft.
    setSeenQ(urlQ);
    if (draft.trim() !== urlQ) setDraft(urlQ);
  }

  useEffect(() => {
    if (draft.trim() === urlQ) return;
    const id = window.setTimeout(
      () => writeParam('q', draft.trim(), 'replace'),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(id);
  }, [draft, urlQ]);

  // A sport the URL names that no live venue has is still shown as chosen,
  // so the control says why the list is empty.
  const sports =
    filters.sport && !facets.sports.includes(filters.sport)
      ? [...facets.sports, filters.sport]
      : facets.sports;
  const sportOptions = [
    { value: ALL, label: t('allSports') },
    ...sports.map((s) => ({ value: s, label: tSports(s as never) })),
  ];

  const cityOptions: ComboboxOption[] = facets.cities.map((c) => ({
    value: c,
    label: cityLabel(tCities, c),
  }));
  const cityValue = filters.city ? canonicalCity(filters.city) : null;
  const citySelected = cityValue
    ? (cityOptions.find((o) => o.value.toLowerCase() === cityValue.toLowerCase()) ?? {
        value: cityValue,
        label: cityLabel(tCities, cityValue),
      })
    : null;

  return (
    <form
      role="search"
      aria-label={t('label')}
      className="mt-6 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        writeParam('q', draft.trim(), 'replace');
      }}
    >
      <Input
        type="search"
        name="q"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={t('search')}
        placeholder={t('searchPlaceholder')}
        enterKeyHint="search"
        autoComplete="off"
        size="lg"
      />
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        {sports.length > 0 && (
          // A row of sports can be wider than a phone. It scrolls inside its
          // own strip, bleeding to the screen edge, rather than wrap a
          // segmented control onto two lines or push the page sideways.
          <div className="-mx-6 overflow-x-auto px-6 md:mx-0 md:px-0">
            <ToggleGroup
              size="sm"
              ariaLabel={t('sport')}
              options={sportOptions}
              selected={filters.sport ?? ALL}
              selectAction={(v) => writeParam('sport', v === ALL ? null : v, 'push')}
              optionClassName="whitespace-nowrap"
            />
          </div>
        )}
        {cityOptions.length > 0 && (
          <div className="md:w-56 md:shrink-0">
            <Combobox
              id="venues-city"
              options={cityOptions}
              selected={citySelected}
              setSelected={(o) => writeParam('city', o?.value ?? null, 'push')}
              placeholder={t('allCities')}
              searchPlaceholder={t('citySearch')}
              emptyState={t('cityNone')}
              matchTriggerWidth
              caret
              buttonProps={{
                className: 'w-full',
                'aria-label': citySelected
                  ? `${t('city')}, ${String(citySelected.label)}`
                  : `${t('city')}, ${t('allCities')}`,
              }}
            />
          </div>
        )}
      </div>
    </form>
  );
}

function VenueCard({ venue: v }: { venue: VenueSummary }) {
  const t = useTranslations('venues');
  const tSports = useTranslations('sports');
  const tCities = useTranslations('cities');
  const format = useFormatter();

  return (
    <Card
      as="li"
      elevation="flat"
      density="compact"
      className="bg-bg-default focus-within:ring-ring relative focus-within:ring-2"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-content-emphasis font-medium">
          {v.publicSlug ? (
            <Link
              href={`/venues/${encodeURIComponent(v.publicSlug)}`}
              className="outline-none after:absolute after:inset-0 after:rounded-[inherit] hover:underline"
            >
              {v.name}
            </Link>
          ) : (
            v.name
          )}
        </h2>
        {v.reviewCount > 0 && (
          // icon={null}: the badge's default status glyph is a check or an
          // ⓘ, which says "state" on what is a fact. The ★ is the glyph here.
          <StatusBadge variant="success" icon={null} className="shrink-0">
            {format.number(v.avgRating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ★
          </StatusBadge>
        )}
      </div>

      {/* The city in the page's language, from the catalogue (#357, A07):
          "София", not "Sofia, BG". Every venue here is in Bulgaria, so the
          country code said nothing; a city not in src/lib/geo/cities.ts
          shows as the club typed it. */}
      <p className="text-content-muted mt-1 text-sm">{cityLabel(tCities, v.city)}</p>

      {v.sports.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {/* The catalogue's name for the sport, not the enum lower-cased:
              `table_tennis` was on every card, in English, on a Bulgarian
              page. `sports.*` carries every value of the Sport enum. */}
          {v.sports.map((s) => (
            <StatusBadge key={s} variant="neutral" icon={null}>
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
