import { getToken } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';

import { LOCALE_COOKIE, isLocale, resolveLocale, type Locale } from '@/lib/i18n/locales';

/**
 * The language a v1 read answers in, for the reads that render copy and need
 * no account (the sport stories).
 *
 *   1. `?locale=bg|en`       what the caller asked for, by name. The native app
 *                            sends it: it carries no cookie, and the URL then
 *                            keys any cache by language on its own.
 *   2. the `NEXT_LOCALE`     the web's switcher, as `chosenLocale` reads it
 *      cookie                for the signed-in writes.
 *   3. the token's `locale`  the account's own language (`User.locale`,
 *                            copied into the token at sign-in), for a signed-in
 *                            caller that sent neither.
 *   4. Bulgarian             everyone else, as on every page (locales.ts).
 *
 * A value that is not one of ours is skipped, never an error: the answer in
 * Bulgarian is still a useful answer.
 */
export async function requestLocale(req: NextRequest): Promise<Locale> {
  const asked = req.nextUrl.searchParams.get('locale');
  if (isLocale(asked)) return asked;

  const cookie = req.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(cookie)) return cookie;

  try {
    const token = (await getToken({ req, secret: process.env.NEXTAUTH_SECRET })) as {
      locale?: unknown;
    } | null;
    return resolveLocale(token?.locale);
  } catch {
    // An unreadable token reads as no token here: this decides a language,
    // never who the caller is.
    return resolveLocale(undefined);
  }
}
