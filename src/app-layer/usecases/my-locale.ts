import type { Locale } from '@prisma/client';

import { runAsUserOnly } from '@/lib/db/rls-middleware';

/**
 * Save the signed-in person's UI language on their own user row (#362).
 *
 * `User.locale` is the preference: sign-in copies it into the token, the
 * middleware seeds the locale cookie from the token, and notifications are
 * written in it (#151). The profile page's language switch writes it here
 * first, then asks next-auth to re-read it into the token (`auth.ts`,
 * `trigger: 'update'`), and only then sets the cookie, so the three agree.
 *
 * `runAsUserOnly`, not superuser: the row is the caller's own, found by the
 * id from a verified session, never from the request, and `app_user` may
 * update it. Nothing tenant-scoped is touched.
 */
export async function setMyLocale(userId: string, locale: Locale): Promise<void> {
  await runAsUserOnly(userId, (db) =>
    db.user.update({ where: { id: userId }, data: { locale }, select: { id: true } }),
  );
}
