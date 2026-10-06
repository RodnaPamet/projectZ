import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { buttonVariants } from '@/components/ui/button-variants';
import { ArrowLeft, LocationPin } from '@/components/ui/icons/nucleo';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { cn } from '@/lib/cn';

/**
 * Who the venue is: the cover, the name, the address and the sports.
 *
 * The cover is a token-tinted band until clubs can upload photos (#366); it is
 * decorative and says nothing a screen reader needs. The back link is the
 * page's own way to the index, not navigation chrome (#362 owns that).
 */
export async function VenueHeader({
  name,
  addressLine,
  city,
  sports,
}: {
  name: string;
  addressLine: string;
  city: string;
  sports: string[];
}) {
  const [t, tSports] = await Promise.all([getTranslations('venue'), getTranslations('sports')]);

  return (
    <header className="flex flex-col gap-4">
      <div className="bg-bg-success relative h-32 md:h-40 md:rounded-lg">
        <Link
          href="/venues"
          aria-label={t('back')}
          className={cn(
            buttonVariants({ variant: 'secondary', size: 'icon' }),
            'absolute top-3 left-4 md:left-3',
          )}
        >
          <ArrowLeft aria-hidden="true" />
        </Link>
      </div>

      <div className="flex flex-col gap-2 px-6 md:px-0">
        <Heading level={1}>{name}</Heading>
        <Caption className="flex items-center gap-1">
          <LocationPin className="size-3.5 shrink-0" aria-hidden="true" />
          {addressLine}, {city}
        </Caption>
        {sports.length > 0 && (
          <ul aria-label={t('sportsLabel')} className="flex flex-wrap gap-1">
            {sports.map((s) => (
              <li key={s}>
                <StatusBadge variant="neutral" icon={null}>
                  {tSports(s as never)}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </header>
  );
}
