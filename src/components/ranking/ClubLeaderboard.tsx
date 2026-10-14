'use client';

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS } from '@/lib/data/keys';
import { useV1SWR } from '@/lib/data/use-v1-swr';

/** `GET /api/v1/clubs/{slug}/leaderboard` (#578). */
export interface ClubLeaderboardDto {
  sports: string[];
  sport: string | null;
  rows: Array<{
    rank: number;
    userId: string;
    name: string | null;
    avatarUrl: string | null;
    level: number;
    matchesPlayed: number;
  }>;
}

/**
 * «Класиране» on a club's page (#578): its players by level in each sport,
 * settled levels only. Full names for signed-in players (decision 49); a
 * signed-out visitor, and a search engine, sees a sign-in prompt instead.
 * Read in the browser, so the public page stays the same for everyone.
 */
export function ClubLeaderboard({
  slug,
  signedIn,
  loginHref,
}: {
  slug: string;
  signedIn: boolean;
  loginHref: string;
}) {
  const t = useTranslations('club.leaderboard');

  return (
    <section
      aria-labelledby="club-leaderboard"
      className="in-shell:px-0 flex flex-col gap-3 px-6 md:px-0"
    >
      <Heading level={2} id="club-leaderboard">
        {t('title')}
      </Heading>
      {signedIn ? (
        <Board slug={slug} />
      ) : (
        <Card
          elevation="flat"
          className="gap-default flex flex-col"
          data-testid="club-leaderboard-sign-in"
        >
          <p className="text-content-default text-sm">{t('signIn')}</p>
          <Link
            href={loginHref}
            className={buttonVariants({ variant: 'secondary', className: 'self-start' })}
          >
            {t('signInButton')}
          </Link>
        </Card>
      )}
    </section>
  );
}

function Board({ slug }: { slug: string }) {
  const t = useTranslations('club.leaderboard');
  const tSports = useTranslations('sports');
  const tLevel = useTranslations('profile.sports');
  const format = useFormatter();
  const [sport, setSport] = useState<string | null>(null);
  const { data } = useV1SWR<ClubLeaderboardDto>(KEYS.clubLeaderboard(slug, sport));

  if (!data) {
    return <Skeleton className="h-24 w-full rounded-lg" />;
  }
  if (!data.sport) {
    return <Caption data-testid="club-leaderboard-none">{t('noResults')}</Caption>;
  }

  return (
    <div className="gap-compact flex flex-col" data-testid="club-leaderboard">
      {data.sports.length > 1 ? (
        <ToggleGroup
          options={data.sports.map((s) => ({ value: s, label: tSports(s as never) }))}
          selected={data.sport}
          selectAction={setSport}
          ariaLabel={t('sport')}
          size="sm"
        />
      ) : null}
      {data.rows.length === 0 ? (
        <Caption data-testid="club-leaderboard-empty">{t('empty')}</Caption>
      ) : (
        <Card elevation="flat" density="none">
          <ol className="divide-border-subtle divide-y">
            {data.rows.map((r) => {
              const name = r.name ?? t('unnamed');
              return (
                <li
                  key={r.userId}
                  className="flex items-center gap-3 px-4 py-2"
                  data-testid="club-leaderboard-row"
                >
                  <span className="text-content-emphasis w-6 shrink-0 text-right text-sm font-semibold tabular-nums">
                    {r.rank}
                  </span>
                  <InitialsAvatar value={name} imageUrl={r.avatarUrl} size="sm" />
                  <span className="text-content-default min-w-0 flex-1 truncate text-sm">
                    {name}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="text-content-emphasis block text-sm font-medium">
                      {tLevel('rated', {
                        level: format.number(r.level, {
                          minimumFractionDigits: 1,
                          maximumFractionDigits: 1,
                        }),
                      })}
                    </span>
                    <Caption className="block">{t('matches', { count: r.matchesPlayed })}</Caption>
                  </span>
                </li>
              );
            })}
          </ol>
        </Card>
      )}
      <Caption>{t('hint')}</Caption>
    </div>
  );
}
