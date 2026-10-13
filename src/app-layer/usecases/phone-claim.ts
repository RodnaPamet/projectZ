import { phoneClaim, type PhoneClaim } from '@/lib/auth/phone-ask';
import { runAsUserOnly } from '@/lib/db/rls-middleware';

/**
 * What the session token says about the account's phone number (#500): `ok`,
 * `ask` or `na` (src/lib/auth/phone-ask.ts). Read at sign-in and whenever the
 * session is refreshed. A missing or deleted account reads as `na`: there is
 * nobody to ask.
 *
 * A module of its own, apart from phone-verification.ts: `auth.ts` imports
 * this, and must not pull in the SMS provider, the rate limiter or the
 * environment schema with it (the `production-sign-in-providers` guardrail
 * loads `auth.ts` in a bare production environment).
 */
export async function phoneClaimFor(userId: string): Promise<PhoneClaim> {
  const user = await runAsUserOnly(userId, (db) =>
    db.user.findUnique({
      where: { id: userId },
      select: { accountKind: true, phoneVerifiedAt: true, deletedAt: true },
    }),
  );
  return user && !user.deletedAt ? phoneClaim(user) : 'na';
}
