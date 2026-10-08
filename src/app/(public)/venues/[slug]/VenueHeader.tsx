import { getTranslations } from 'next-intl/server';

import { VenuePhotoImg } from '@/components/media/venue-photo-img';
import { LocationPin } from '@/components/ui/icons/nucleo';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { cn } from '@/lib/cn';
import type { PhotoView } from '@/lib/media/photo-shape';

import { VenueBackLink } from './VenueBackLink';

/**
 * Who the venue is: the cover, the name, the address and the sports.
 *
 * The cover is the club's uploaded photo (#366), drawn as a responsive
 * `<img>` with its blurred placeholder and the club's alt text, loaded at
 * once (it is the page's largest paint). Without one it is a token-tinted
 * band, decorative. The back link is VenueBackLink, which the skeleton
 * renders too.
 */
export async function VenueHeader({
  name,
  addressLine,
  city,
  sports,
  cover = null,
}: {
  name: string;
  addressLine: string;
  city: string;
  sports: string[];
  cover?: PhotoView | null;
}) {
  const [t, tSports] = await Promise.all([getTranslations('venue'), getTranslations('sports')]);

  return (
    <header className="flex flex-col gap-4">
      <div
        className={cn(
          'bg-brand-subtle in-shell:rounded-lg relative overflow-hidden md:rounded-lg',
          cover ? 'h-48 md:h-64' : 'h-32 md:h-40',
        )}
      >
        {cover && (
          <VenuePhotoImg
            photo={cover}
            sizes="(min-width: 768px) 720px, 100vw"
            className="absolute inset-0 size-full"
            priority
          />
        )}
        <VenueBackLink />
      </div>

      <div className="in-shell:px-0 flex flex-col gap-2 px-6 md:px-0">
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
