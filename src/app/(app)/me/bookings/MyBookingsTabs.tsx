'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { MyBookingDto } from '@/app/api/v1/_lib/dto';
import { ToggleGroup } from '@/components/ui/toggle-group';
import type { V1Page } from '@/lib/data/keys';

import { MyBookingsList } from './MyBookingsList';
import { BOOKING_TABS, bookingTabFrom, type BookingTab } from './tabs';

/**
 * Предстоящи and Минали (#359, audit P05): two lists, each on its own
 * `GET /api/v1/me/bookings?when=` key, under one toggle.
 *
 * The server seeds the tab the page was opened on. Switching is client state,
 * not a navigation: the other list is read once through SWR, behind a
 * skeleton, and is then held for the rest of the visit, so switching back and
 * forth costs nothing. The address follows the tab (`?tab=past`) with
 * `history.replaceState`, so a reload or a shared link opens the same tab,
 * without a server round trip on every tap.
 *
 * Each list is keyed by its tab, so its review drafts and "load more" pages
 * belong to that list and do not leak into the other one.
 */
export function MyBookingsTabs({
  initialTab,
  seed,
  reviewMaxLength,
}: {
  initialTab: BookingTab;
  seed: V1Page<MyBookingDto>;
  reviewMaxLength: number;
}) {
  const t = useTranslations('myBookings');
  const [tab, setTab] = useState<BookingTab>(initialTab);

  function pick(next: string) {
    const value = bookingTabFrom(next);
    setTab(value);
    const url = new URL(window.location.href);
    if (value === 'upcoming') url.searchParams.delete('tab');
    else url.searchParams.set('tab', value);
    window.history.replaceState(window.history.state, '', url);
  }

  return (
    <div className="gap-section grid">
      <ToggleGroup
        ariaLabel={t('tabs.label')}
        options={BOOKING_TABS.map((value) => ({ value, label: t(`tabs.${value}`) }))}
        selected={tab}
        selectAction={pick}
        className="self-start justify-self-start"
        optionClassName="min-h-11 whitespace-nowrap"
      />

      <MyBookingsList
        key={tab}
        when={tab}
        seed={tab === initialTab ? seed : undefined}
        reviewMaxLength={reviewMaxLength}
      />
    </div>
  );
}
