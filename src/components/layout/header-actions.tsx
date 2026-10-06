'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { EmptyState } from '@/components/ui/empty-state';
import { Bell, Msgs } from '@/components/ui/icons/nucleo';
import { Popover } from '@/components/ui/popover';

import { MODULE_HREFS } from './nav-items';

/**
 * The player header's icons, before the account menu (#362): messages and
 * the bell, the owner's direction for the player chrome.
 *
 * ═══ MESSAGES WAIT FOR THEIR MODULE ═══
 *
 * The icon is drawn only when `modules.messaging` is on (module 1, #375), so
 * nothing links to a page that is not there. Switching the module on is an
 * environment change (`MODULE_MESSAGING=1`), not a code change.
 *
 * ═══ THE BELL IS THERE FROM DAY ONE ═══
 *
 * Notifications are #367. Until they land the bell opens the vendored
 * `Popover` (a bottom sheet on a phone, a dropdown from `sm`) on the vendored
 * `EmptyState`: "Нямате известия". It carries no count, and none is faked.
 * When #367 brings real notifications, this is where the list goes.
 *
 * Both are the vendored ghost icon button (`size="icon"`: 28 px drawn, 44 px
 * under a coarse pointer), named for a screen reader, the glyph hidden.
 */
export function HeaderActions({ messaging }: { messaging: boolean }) {
  const t = useTranslations('common.nav');
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-center gap-1">
      {messaging ? (
        <Link
          href={MODULE_HREFS.messaging}
          aria-label={t('messages')}
          className={buttonVariants({ variant: 'ghost', size: 'icon' })}
          data-testid="header-messages"
        >
          <Msgs aria-hidden="true" />
        </Link>
      ) : null}
      <Popover
        openPopover={open}
        setOpenPopover={setOpen}
        align="end"
        popoverContentClassName="w-72 p-2"
        content={
          <EmptyState
            size="sm"
            icon={Bell}
            title={t('notificationsEmpty')}
            description={t('notificationsEmptyBody')}
            data-testid="notifications-empty"
          />
        }
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('notifications')}
          aria-haspopup="dialog"
          aria-expanded={open}
          icon={<Bell aria-hidden="true" />}
          data-testid="header-notifications"
        />
      </Popover>
    </div>
  );
}
