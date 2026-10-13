'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { MyGameRequestDto, OpenGameDto } from '@/app/api/v1/_lib/open-play-dto';
import { GameCard } from '@/components/games/GameCard';
import { CardGridSkeleton } from '@/components/loading/shapes';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { useSsrFallback } from '@/components/ui/hooks/use-ssr-fallback';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { KEYS, type V1Page } from '@/lib/data/keys';
import { useV1SWR, useV1SWRInfinite } from '@/lib/data/use-v1-swr';
import { canonicalCity, cityLabel } from '@/lib/geo/cities';

import {
  GAME_FILTER_NAMES,
  GAMES_TABS,
  gameFiltersFromParams,
  gamesTabFrom,
  nextDays,
  type GameFilters,
  type GamesTab,
} from './filters';

/** The ToggleGroups' "every sport" / "every day" option; never sent. */
const ALL = '__all';
/** How many days the day filter offers: the listing's own two weeks, the first one of them. */
const DAYS_SHOWN = 7;

function writeParam(name: string, value: string | null, mode: 'push' | 'replace') {
  const next = new URLSearchParams(window.location.search);
  if (value) next.set(name, value);
  else next.delete(name);
  const qs = next.toString();
  const url = qs ? `?${qs}` : window.location.pathname;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

/**
 * Игри (#376): «Търсят играчи», the open games, and «Моите заявки», the
 * viewer's own requests. The open games read `GET /api/v1/games`, the endpoint
 * the native app reads, page by page; the filters live in the URL, as on
 * /venues, and only the server's facets (what some public venue has) are
 * offered.
 */
export function GamesView({
  initialTab,
  seed,
  initialFilters,
  mine,
  facets,
  signedIn,
  timeZone,
}: {
  initialTab: GamesTab;
  seed: V1Page<OpenGameDto>;
  initialFilters: GameFilters;
  /** «Моите заявки», seeded when that tab was rendered; null signed out. */
  mine: MyGameRequestDto[] | null;
  facets: { cities: string[]; sports: string[] };
  signedIn: boolean;
  /** The pilot's zone: the day filter's days are its days. */
  timeZone: string;
}) {
  const t = useTranslations('games');
  const [tab, setTab] = useState<GamesTab>(initialTab);

  function pick(next: string) {
    const value = gamesTabFrom(next);
    setTab(value);
    writeParam('tab', value === 'open' ? null : value, 'replace');
  }

  return (
    <div className="gap-section mt-6 grid">
      <ToggleGroup
        ariaLabel={t('tabs.label')}
        options={GAMES_TABS.map((value) => ({ value, label: t(`tabs.${value}`) }))}
        selected={tab}
        selectAction={pick}
        className="self-start justify-self-start"
        optionClassName="min-h-11 whitespace-nowrap"
      />
      {tab === 'open' ? (
        <OpenGames
          seed={seed}
          initialFilters={initialFilters}
          facets={facets}
          signedIn={signedIn}
          timeZone={timeZone}
        />
      ) : (
        <MyRequests seed={mine} signedIn={signedIn} />
      )}
    </div>
  );
}

function OpenGames({
  seed,
  initialFilters,
  facets,
  timeZone,
}: {
  seed: V1Page<OpenGameDto>;
  initialFilters: GameFilters;
  facets: { cities: string[]; sports: string[] };
  signedIn: boolean;
  timeZone: string;
}) {
  const t = useTranslations('games');
  const params = useSearchParams();
  const cleaned = gameFiltersFromParams(params);
  const sig = GAME_FILTER_NAMES.map((k) => cleaned[k] ?? '').join('\u0000');
  const filters = useMemo(() => {
    const values = sig.split('\u0000');
    const out: Record<string, string> = {};
    GAME_FILTER_NAMES.forEach((k, i) => {
      if (values[i]) out[k] = values[i]!;
    });
    return out as GameFilters;
  }, [sig]);

  const getKey = useMemo(() => KEYS.games(filters), [filters]);
  const seedFits = useSsrFallback({
    queryKeyFilters: filters as Record<string, string>,
    initialFilters: initialFilters as Record<string, string>,
    serverHadFilters: Object.keys(initialFilters).length > 0,
    hasActive: Object.keys(filters).length > 0,
  });
  const { data, error, mutate, size, setSize, isValidating } = useV1SWRInfinite<OpenGameDto>(
    getKey,
    { fallbackData: seedFits ? [seed] : undefined, keepPreviousData: true },
  );
  const retry = useCallback(() => void mutate(), [mutate]);

  const items = data?.flatMap((p) => p.items);
  const hasMore = !!data?.at(-1)?.nextCursor;
  const signInHref = `/login?next=${encodeURIComponent('/games')}`;

  return (
    <>
      <GameFilterBar filters={filters} facets={facets} timeZone={timeZone} />
      {items === undefined ? (
        error ? (
          <ErrorState
            title={t('error.title')}
            description={t('error.description')}
            onRetry={retry}
          />
        ) : (
          <CardGridSkeleton count={4} />
        )
      ) : items.length === 0 ? (
        <div data-perf-ready>
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        </div>
      ) : (
        <>
          <ul data-perf-ready className="grid gap-4 md:grid-cols-2" data-testid="games-list">
            {items.map((g) => (
              <li key={g.id} className="grid">
                <GameCard game={g} signInHref={signInHref} onChanged={() => void mutate()} />
              </li>
            ))}
          </ul>
          {hasMore ? (
            <Button
              type="button"
              variant="secondary"
              className="justify-self-start"
              loading={isValidating && size > (data?.length ?? 0)}
              onClick={() => void setSize(size + 1)}
              data-testid="games-more"
            >
              {t('more')}
            </Button>
          ) : null}
        </>
      )}
    </>
  );
}

function GameFilterBar({
  filters,
  facets,
  timeZone,
}: {
  filters: GameFilters;
  facets: { cities: string[]; sports: string[] };
  timeZone: string;
}) {
  const t = useTranslations('games.filters');
  const tSports = useTranslations('sports');
  const tCities = useTranslations('cities');
  const format = useFormatter();
  // The days are the browser's "now" in the pilot's zone; the server renders
  // the same seven, so the first paint does not shift.
  const [days] = useState(() => nextDays(new Date(), timeZone, DAYS_SHOWN));

  const sports =
    filters.sport && !facets.sports.includes(filters.sport)
      ? [...facets.sports, filters.sport]
      : facets.sports;
  const sportOptions = [
    { value: ALL, label: t('allSports') },
    ...sports.map((s) => ({ value: s, label: tSports(s as never) })),
  ];
  const dayOptions = [
    { value: ALL, label: t('anyDay') },
    ...days.map((d, i) => ({
      value: d,
      label:
        i === 0
          ? t('today')
          : i === 1
            ? t('tomorrow')
            : format.dateTime(new Date(`${d}T12:00:00Z`), {
                weekday: 'short',
                day: 'numeric',
                timeZone: 'UTC',
              }),
    })),
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
    <div role="search" aria-label={t('label')} className="flex flex-col gap-3">
      <div className="in-shell:mx-0 in-shell:px-0 -mx-6 overflow-x-auto px-6 md:mx-0 md:px-0">
        <ToggleGroup
          size="sm"
          ariaLabel={t('day')}
          options={dayOptions}
          selected={filters.date ?? ALL}
          selectAction={(v) => writeParam('date', v === ALL ? null : v, 'push')}
          optionClassName="whitespace-nowrap"
        />
      </div>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        {sports.length > 0 ? (
          <div className="in-shell:mx-0 in-shell:px-0 -mx-6 overflow-x-auto px-6 md:mx-0 md:px-0">
            <ToggleGroup
              size="sm"
              ariaLabel={t('sport')}
              options={sportOptions}
              selected={filters.sport ?? ALL}
              selectAction={(v) => writeParam('sport', v === ALL ? null : v, 'push')}
              optionClassName="whitespace-nowrap"
            />
          </div>
        ) : null}
        {cityOptions.length > 0 ? (
          <div className="md:w-56 md:shrink-0">
            <Combobox
              id="games-city"
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
        ) : null}
      </div>
    </div>
  );
}

/** «Моите заявки»: every request the viewer made, newest first, in its state now. */
function MyRequests({ seed, signedIn }: { seed: MyGameRequestDto[] | null; signedIn: boolean }) {
  const t = useTranslations('games.mine');
  const { data, error, mutate } = useV1SWR<MyGameRequestDto[]>(
    signedIn ? KEYS.myGameRequests() : null,
    { fallbackData: seed ?? undefined },
  );

  if (!signedIn) {
    return (
      <EmptyState
        title={t('signInTitle')}
        description={t('signInDescription')}
        primaryAction={{
          label: t('signIn'),
          href: `/login?next=${encodeURIComponent('/games?tab=mine')}`,
        }}
      />
    );
  }
  if (!data) {
    return error ? (
      <ErrorState
        title={t('error.title')}
        description={t('error.description')}
        onRetry={() => void mutate()}
      />
    ) : (
      <CardGridSkeleton count={2} />
    );
  }
  if (data.length === 0) {
    return (
      <div data-perf-ready>
        <EmptyState title={t('empty.title')} description={t('empty.description')} />
      </div>
    );
  }
  return (
    <ul data-perf-ready className="grid gap-4 md:grid-cols-2" data-testid="my-game-requests">
      {data.map((r) => (
        <li key={r.id} className="grid">
          <GameCard
            game={r.game}
            status={r.status}
            signInHref="/login"
            onChanged={() => void mutate()}
          />
        </li>
      ))}
    </ul>
  );
}
