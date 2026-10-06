import { getTranslations } from 'next-intl/server';

import { VenuePhotoImg } from '@/components/media/venue-photo-img';
import { Heading } from '@/components/ui/typography';
import type { PhotoView } from '@/lib/media/photo-shape';

/**
 * The venue's gallery (#366), below the slots: the club's photos in the order
 * it set, lazily loaded at the width each cell is drawn. Each opens its
 * largest rendition on a tap, which needs no JavaScript.
 *
 * Server-rendered with no client code, so it adds nothing to the page's
 * First Load JS.
 */
export async function VenueGallery({ name, photos }: { name: string; photos: PhotoView[] }) {
  const t = await getTranslations('venue.gallery');
  return (
    <section aria-labelledby="venue-gallery" className="flex flex-col gap-3 px-6 md:px-0">
      <Heading level={2} id="venue-gallery">
        {t('title')}
      </Heading>
      <ul aria-label={t('label', { name })} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {photos.map((p) => {
          const largest = p.variants[p.variants.length - 1]?.url ?? p.url;
          return (
            <li key={p.id}>
              <a
                href={largest}
                className="focus-visible:ring-ring block overflow-hidden rounded-md focus-visible:ring-2 focus-visible:outline-none"
              >
                <VenuePhotoImg
                  photo={p}
                  sizes="(min-width: 768px) 240px, (min-width: 640px) 33vw, 50vw"
                  className="bg-bg-muted aspect-[4/3] w-full"
                />
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
