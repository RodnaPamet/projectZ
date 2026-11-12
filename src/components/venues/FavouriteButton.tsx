'use client';

import { Heart } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { cn } from '@/lib/cn';
import { KEYS, V1 } from '@/lib/data/keys';
import { useViewerId } from '@/lib/data/provider';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

/** `GET /api/v1/me/favourites/venues` (#672). */
export interface FavouriteVenues {
  ids: string[];
  items: unknown[];
}

/**
 * The heart on a venue (#672, owner 2026-11-12): on and off at once, saved
 * behind it. Signed out there is nothing to save to, so there is no heart.
 *
 * It sits above a card's stretched link (`relative z-10`), so a click on the
 * heart is not a click on the card.
 */
export function FavouriteButton({ venueId, className }: { venueId: string; className?: string }) {
  const t = useTranslations('venues.favourite');
  const viewerId = useViewerId();
  const key = viewerId ? KEYS.myFavouriteVenues() : null;
  const { data } = useV1SWR<FavouriteVenues>(key);
  const [failed, setFailed] = useState(false);

  const toggle = useV1Mutation<boolean, unknown, FavouriteVenues>({
    url: () => V1.favouriteVenue(venueId),
    method: 'PUT',
    target: key ? { key } : undefined,
    update: (visible, on) => ({
      ...visible,
      ids: on
        ? [venueId, ...visible.ids.filter((id) => id !== venueId)]
        : visible.ids.filter((id) => id !== venueId),
    }),
    fallback: { ids: [], items: [] },
  });
  const unheart = useV1Mutation<boolean, unknown, FavouriteVenues>({
    url: () => V1.favouriteVenue(venueId),
    method: 'DELETE',
    target: key ? { key } : undefined,
    update: (visible) => ({ ...visible, ids: visible.ids.filter((id) => id !== venueId) }),
    fallback: { ids: [], items: [] },
  });

  if (!viewerId) return null;
  const on = data?.ids.includes(venueId) ?? false;

  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? t('remove') : t('add')}
      title={failed ? t('failed') : on ? t('remove') : t('add')}
      onClick={() => {
        setFailed(false);
        (on ? unheart : toggle).trigger(!on).catch(() => setFailed(true));
      }}
      className={cn(
        'focus-visible:ring-ring relative z-10 inline-flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2',
        on ? 'text-content-error' : 'text-content-muted hover:text-content-emphasis',
        className,
      )}
    >
      <Heart aria-hidden className="size-5" fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}
