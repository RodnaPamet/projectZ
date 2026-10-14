import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';

import { coachesAtVenue } from '@/app-layer/usecases/coach-directory';
import { CoachCard } from '@/components/coaches/CoachCard';
import { Heading } from '@/components/ui/typography';
import { COACHES_HREF } from '@/lib/coaches/hrefs';

/**
 * «Треньори» on a venue page (#547; owner decision 10): the coaches a player
 * can book here, each with the rate at THIS venue, each a link to their page.
 *
 * A Server Component with no script: the list is the same for everybody.
 * Renders nothing when nobody teaches here, so a venue without coaches does
 * not grow an empty heading.
 */
export async function VenueCoaches({ venueId }: { venueId: string }) {
  const coaches = await coachesAtVenue(venueId);
  if (coaches.length === 0) return null;
  const [t, tSports, format] = await Promise.all([
    getTranslations('coaches'),
    getTranslations('sports'),
    getFormatter(),
  ]);

  return (
    <section
      aria-labelledby="venue-coaches"
      className="in-shell:px-0 flex flex-col gap-3 px-6 md:px-0"
      data-testid="venue-coaches"
    >
      <div className="flex items-baseline justify-between gap-3">
        <Heading level={2} id="venue-coaches" className="text-lg">
          {t('venue.title')}
        </Heading>
        <Link
          href={COACHES_HREF}
          className="text-content-muted hover:text-content-emphasis text-sm underline-offset-4 hover:underline"
        >
          {t('venue.all')}
        </Link>
      </div>
      <ul className="grid gap-3">
        {coaches.map((c) => {
          // `coachesAtVenue` puts this venue first.
          const here = c.venues[0];
          return (
            <li key={c.slug} className="grid">
              <CoachCard
                slug={c.slug}
                name={c.name?.trim() || t('noName')}
                avatarUrl={c.avatarUrl}
                sports={c.sports.map((s) => tSports(s.sport as never))}
                line={
                  here
                    ? t('venue.rate', {
                        price: format.number(here.hourlyRateCents / 100, {
                          style: 'currency',
                          currency: here.currency,
                        }),
                      })
                    : null
                }
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
