'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { ChevronRight } from '@/components/ui/icons/nucleo';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Caption } from '@/components/ui/typography';
import { cn } from '@/lib/cn';

import { PROFILE_ROW, ProfileSection } from './ProfileSection';

// The dialog, its field and the sign-out it ends in are only loaded when
// somebody actually opens it.
const DeleteAccountDialog = dynamic(() =>
  import('./DeleteAccountDialog').then((m) => m.DeleteAccountDialog),
);

/** One upcoming booking as the page hands it over: times as ISO strings. */
export interface UpcomingBookingView {
  bookingId: string;
  venueName: string;
  courtName: string;
  timezone: string;
  startTs: string;
  endTs: string;
  role: 'BOOKER' | 'PARTICIPANT';
  cure: 'cancel' | 'leave' | 'wait';
  cancellableUntil: string;
  deletableFrom: string;
}

export type DeletionStandingView =
  | { kind: 'allowed' }
  | { kind: 'club' }
  | { kind: 'blocked'; total: number; bookings: UpcomingBookingView[] };

/** Where the landing page's contact form is: its "За клубове" section. */
export const CONTACT_FORM_HREF = '/#clubs';

/**
 * "Изтриване на профила" (#370), the last section of /me/profile.
 *
 *   club      a club account cannot delete itself (owner decision 3): it is
 *             told to ask through the contact form, and given the link
 *   blocked   upcoming bookings first (owner decision 1): each is listed with
 *             a link to its page, where it is cancelled or left, and for one
 *             too late to cancel, when deletion becomes possible
 *   allowed   what goes and what stays, then the button that opens the typed
 *             confirmation
 *
 * The page decides which, on the server; the API decides again, under a lock,
 * when the button is pressed, so the state shown here is never trusted.
 */
export function DeleteAccountSection({ standing }: { standing: DeletionStandingView }) {
  const t = useTranslations('profile.delete');
  const format = useFormatter();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const when = (iso: string, timeZone: string) =>
    format.dateTime(new Date(iso), {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <ProfileSection title={t('title')} testId="profile-delete">
      {standing.kind === 'club' ? (
        <div className="gap-compact flex flex-col px-4 py-3" data-testid="profile-delete-club">
          <InlineNotice variant="info" title={t('club.title')}>
            {t('club.body')}
          </InlineNotice>
          <Link
            href={CONTACT_FORM_HREF}
            className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'self-start')}
            data-testid="profile-delete-contact"
          >
            {t('club.contact')}
          </Link>
        </div>
      ) : standing.kind === 'blocked' ? (
        <div className="gap-compact flex flex-col py-3" data-testid="profile-delete-blocked">
          <div className="px-4">
            <InlineNotice variant="warning" title={t('blocked.title')}>
              {t('blocked.body')}
            </InlineNotice>
          </div>
          <ul className="divide-border-subtle divide-y" data-testid="profile-delete-bookings">
            {standing.bookings.map((b) => (
              <li key={b.bookingId}>
                <Link
                  href={`/me/bookings/${encodeURIComponent(b.bookingId)}`}
                  className="hover:bg-bg-muted flex min-h-14 items-center gap-3 px-4 py-2 transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none focus-visible:ring-inset"
                  data-testid="profile-delete-booking"
                  data-cure={b.cure}
                >
                  <span className="min-w-0 flex-1">
                    {/* The venue may be long; the time never truncates. */}
                    <span className="text-content-default block truncate text-sm">
                      {b.venueName}
                    </span>
                    <span className="text-content-default block text-sm">
                      {when(b.startTs, b.timezone)}
                    </span>
                    <Caption className="block">
                      {b.cure === 'cancel'
                        ? t('blocked.cancel', { deadline: when(b.cancellableUntil, b.timezone) })
                        : b.cure === 'leave'
                          ? t('blocked.leave')
                          : t('blocked.wait', { end: when(b.deletableFrom, b.timezone) })}
                    </Caption>
                  </span>
                  <ChevronRight className="text-content-muted size-4 shrink-0" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
          {standing.total > standing.bookings.length ? (
            <Caption className="px-4">
              {t('blocked.more', { count: standing.total - standing.bookings.length })}
            </Caption>
          ) : null}
          <div className="px-4">
            <Button
              type="button"
              variant="destructive"
              disabled
              data-testid="profile-delete-button"
              text={t('button')}
            />
          </div>
        </div>
      ) : (
        <div className="gap-compact flex flex-col px-4 py-3" data-testid="profile-delete-allowed">
          <p className="text-content-default text-sm">{t('intro')}</p>
          <Caption>{t('exportFirst')}</Caption>
          <div>
            <Button
              type="button"
              variant="destructive"
              onClick={() => setOpen(true)}
              data-testid="profile-delete-button"
              text={t('button')}
            />
          </div>
          {open ? (
            <DeleteAccountDialog open={open} setOpen={setOpen} onRefused={() => router.refresh()} />
          ) : null}
        </div>
      )}
    </ProfileSection>
  );
}

/** The row that downloads the export, for the privacy section. */
export function DataExportRow({ href }: { href: string }) {
  const t = useTranslations('profile.data');
  return (
    <div className={PROFILE_ROW} data-testid="profile-export-row">
      <div className="min-w-0">
        <p className="text-content-default text-sm">{t('row')}</p>
        <Caption>{t('hint')}</Caption>
      </div>
      {/* A plain link with `download`: the browser saves the file the route
          sends as an attachment. No prefetch, no client fetch. */}
      <a
        href={href}
        download
        className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'shrink-0')}
        data-testid="profile-export"
      >
        {t('download')}
      </a>
    </div>
  );
}
