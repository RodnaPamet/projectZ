'use client';

import { useTranslations } from 'next-intl';

import { SignOutButton } from '@/components/layout/SignOutButton';
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
    <div role="alert" className="border-border-subtle mt-6 rounded-lg border p-4">
      <h2 className="font-medium">{t(`refusal.${refusal}.title`)}</h2>
      <p className="text-content-muted mt-1 text-sm">{t(`refusal.${refusal}.description`)}</p>
      <div className="mt-3">
        <SignOutButton
          label={t('signOutToSwitch')}
          callbackUrl={`/login?next=${encodeURIComponent(invitePath)}`}
        />
      </div>
    </div>
  );
}
