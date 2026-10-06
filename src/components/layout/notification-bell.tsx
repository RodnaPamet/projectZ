'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

import type { NotificationDto } from '@/app/api/v1/_lib/dto';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Bell } from '@/components/ui/icons/nucleo';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Popover } from '@/components/ui/popover';
import { SkeletonLine } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

/** `GET /api/v1/me/notifications`: a page plus the unread count. */
export interface NotificationPage {
  items: NotificationDto[];
  nextCursor: string | null;
  unreadCount: number;
}

/** The badge reads "9+" past nine: a count, not a ledger. */
export function badgeLabel(count: number): string {
  return count > 9 ? '9+' : String(count);
}

/** The count is re-read this often while the tab is visible. */
export const BELL_POLL_MS = 60_000;

/** "преди 5 минути", "вчера": the recipient's language, from the page's locale. */
function ago(locale: string, iso: string, now: number): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(0, 'minute');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86_400), 'day');
}

/**
 * The bell in the player header (#367), at every width.
 *
 * The vendored ghost icon `Button` with the vendored `StatusBadge` on it for
 * the unread count (#362's note: upstream has no icon-badge primitive, and the
 * badge composed on the button is what the prototype did). It opens the
 * vendored `Popover`: a dropdown from `sm`, a bottom sheet below it.
 *
 * ═══ WHAT OPENING DOES ═══
 *
 * Opening marks every unread notification read (`POST …/read {all: true}`),
 * so the count clears the moment you look, the way a bell does. The rows that
 * WERE unread keep their emphasis for as long as the list stays open, so you
 * can still see which ones are new. Each row links to its booking.
 *
 * ═══ ONE READ ═══
 *
 * `GET /api/v1/me/notifications` answers the newest rows AND the unread
 * count, so the badge and the list are one request, polled every minute
 * while the tab is visible (SWR does not poll a hidden tab) and re-read on
 * focus. A failed read leaves the bell as it was: no badge is better than a
 * wrong one.
 */
export function NotificationBell() {
  const t = useTranslations('common.nav');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  // The rows that were unread when the list was opened.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  // "5 minutes ago" is measured from when the list was opened.
  const [openedAt, setOpenedAt] = useState(0);

  const key = KEYS.notifications();
  const { data, error, mutate } = useV1SWR<NotificationPage>(key, {
    refreshInterval: BELL_POLL_MS,
  });

  const markAll = useV1Mutation<{ all: true }, unknown, NotificationPage>({
    url: () => V1.markNotificationsRead(),
    body: (arg) => arg,
    target: { key },
    update: (page) => ({
      ...page,
      unreadCount: 0,
      items: page.items.map((n) => ({ ...n, read: true })),
    }),
  });

  const unread = data?.unreadCount ?? 0;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    setOpenedAt(Date.now());
    if (!data) return;
    setFresh(new Set(data.items.filter((n) => !n.read).map((n) => n.id)));
    if (data.unreadCount > 0) {
      // A failure puts the count back (SWR's rollback); nothing to say about it.
      markAll.trigger({ all: true }).catch(() => undefined);
    }
  }

  let body;
  if (!data && !error) {
    body = (
      <div className="gap-compact flex flex-col p-3" data-testid="notifications-loading">
        <SkeletonLine className="w-3/4" />
        <SkeletonLine className="w-1/2" />
        <SkeletonLine className="w-2/3" />
      </div>
    );
  } else if (!data) {
    body = (
      <div className="gap-compact flex flex-col p-2" data-testid="notifications-error">
        <InlineNotice variant="error">{t('notificationsError')}</InlineNotice>
        <Button variant="secondary" size="sm" className="self-start" onClick={() => void mutate()}>
          {t('notificationsRetry')}
        </Button>
      </div>
    );
  } else if (data.items.length === 0) {
    body = (
      <EmptyState
        size="sm"
        icon={Bell}
        title={t('notificationsEmpty')}
        description={t('notificationsEmptyBody')}
        data-testid="notifications-empty"
      />
    );
  } else {
    body = (
      <ul
        className="divide-border-subtle flex max-h-[60vh] flex-col divide-y overflow-y-auto"
        data-testid="notifications-list"
      >
        {data.items.map((n) => {
          const isFresh = fresh.has(n.id);
          const row = (
            <>
              <span className="flex items-start justify-between gap-2">
                <span
                  className={
                    isFresh
                      ? 'text-content-emphasis text-sm font-semibold'
                      : 'text-content-default text-sm'
                  }
                >
                  {n.title}
                </span>
                <span className="text-content-subtle shrink-0 text-xs tabular-nums">
                  {ago(locale, n.createdAt, openedAt)}
                </span>
              </span>
              <span className="text-content-muted text-xs">{n.body}</span>
            </>
          );
          const cls =
            'flex min-h-11 flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors ' +
            'hover:bg-bg-muted focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none' +
            (isFresh ? ' bg-bg-subtle' : '');
          return (
            <li key={n.id} data-testid="notification-item" data-unread={isFresh || undefined}>
              {n.href ? (
                <Link href={n.href} className={cls} onClick={() => setOpen(false)}>
                  {row}
                </Link>
              ) : (
                <div className={cls}>{row}</div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Popover
      openPopover={open}
      setOpenPopover={onOpenChange}
      align="end"
      popoverContentClassName="w-80 p-1"
      content={
        <div className="w-full" data-testid="notifications-panel">
          {body}
        </div>
      }
    >
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        aria-label={unread > 0 ? t('notificationsUnread', { count: unread }) : t('notifications')}
        aria-haspopup="dialog"
        aria-expanded={open}
        icon={<Bell aria-hidden="true" />}
        right={
          unread > 0 ? (
            <StatusBadge
              variant="error"
              tone="solid"
              size="sm"
              icon={null}
              aria-hidden="true"
              className="pointer-events-none absolute -top-1 -right-1 min-w-4 justify-center px-1 tabular-nums"
              data-testid="notifications-count"
            >
              {badgeLabel(unread)}
            </StatusBadge>
          ) : null
        }
        data-testid="header-notifications"
      />
    </Popover>
  );
}
