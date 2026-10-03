'use client';

import { useTranslations } from 'next-intl';

import { SignOutButton } from '@/components/layout/SignOutButton';
import { InlineNotice } from '@/components/ui/inline-notice';
import type { AccountKindRefusal } from '@/lib/auth/account-kind';

/**
 * "Accept this with a separate account" (#263).
 *
 * Shown in place of the Accept button when the signed-in account is the wrong
 * KIND for the invitation: a player offered a staff role, a club account
 * that already runs another club, a club account offered a player
 * invitation. The person holding a working invitation is told exactly what to
 * do, and given the first half of doing it — signing out, straight back to the
 * sign-in page with this invitation as `next`, so switching accounts does not
 * lose it.
 *
 * A client component because the sign-out is one (`signOut` must POST with a
 * CSRF token); the copy is `invite.refusal.*`, in every locale.
 */
export function InviteRefusal({
  refusal,
  invitePath,
}: {
  refusal: AccountKindRefusal;
  /** This invitation's own path, `/invite/<token>`, to come back to. */
  invitePath: string;
}) {
  const t = useTranslations('invite');

  return (
    // InlineNotice's error variant is the one role="alert" surface
    // (no-hand-rolled-alerts). The heading goes in the body, not `title`,
    // because `title` renders inside a <p>.
    <InlineNotice variant="error" className="mt-6">
      <h2 className="font-medium">{t(`refusal.${refusal}.title`)}</h2>
      <p className="mt-1">{t(`refusal.${refusal}.description`)}</p>
      <div className="mt-3">
        <SignOutButton
          label={t('signOutToSwitch')}
          callbackUrl={`/login?next=${encodeURIComponent(invitePath)}`}
        />
      </div>
    </InlineNotice>
  );
}
