'use client';

import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';

import { UserArrowRight } from '@/components/ui/icons/nucleo';

import { USER_MENU_ROW_CLASS, UserMenu } from './user-menu';

/**
 * The player chrome's account menu: upstream's vendored `UserMenu`, with
 * playerz's sign-out in its `items` slot (T20).
 *
 * A client module of its own because `items` is a render prop, and a function
 * cannot cross from the server-rendered `SiteHeader` to the client. The same
 * menu opens from the header (from `md`) and from the tab bar's Account tab
 * (below it), where it is controlled and presents as the phone bottom sheet.
 *
 * As in the admin top bar: the language row is off, because the middleware
 * re-seeds the locale cookie from `User.locale` on every signed-in request and
 * a cookie-only switch would flip straight back; and sign-out lands on the
 * homepage, not on /login, which would read as "that failed".
 */
export function PlayerUserMenu({
  name,
  email,
  open,
  onOpenChange,
}: {
  name: string | null;
  email: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('common');

  return (
    <UserMenu
      displayName={name ?? email}
      displayEmail={email}
      displayImage={null}
      showLanguage={false}
      open={open}
      onOpenChange={onOpenChange}
      items={({ close }) => (
        <button
          type="button"
          className={USER_MENU_ROW_CLASS}
          data-testid="user-menu-sign-out"
          onClick={() => {
            close();
            void signOut({ callbackUrl: '/' });
          }}
        >
          <UserArrowRight className="size-4" aria-hidden="true" />
          {t('signOut')}
        </button>
      )}
    />
  );
}
