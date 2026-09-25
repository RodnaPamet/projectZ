import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/**
 * The 404 page.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * There wasn't one, so an unknown address got Next's built-in 404 — which is in
 * English and carries none of this product's chrome. In an app whose default
 * locale is Bulgarian, that is the one page most likely to be seen by somebody
 * who does not read English, because arriving here means something already went
 * wrong.
 *
 * It is not hypothetical. Eight of the nine links in `AppNav` point at pages that
 * do not exist yet (#176), and the player half of that nav is not
 * permission-gated — so a signed-out visitor is three clicks from here.
 *
 * ═══ WHAT IT DELIBERATELY DOES NOT DO ═══
 *
 * It does not guess where you meant to go. A 404 that redirects somewhere
 * plausible turns "this address is wrong" into "you are somewhere unexpected and
 * nobody told you", and the back button stops working the way the reader expects.
 *
 * It offers ONE link, to `/venues`, because that is the only substantial page
 * that currently exists. When the rest of the nav is built this should point at
 * whatever the real home becomes — and if it still says `/venues` then, the link
 * is stale rather than wrong, which is the safer way round.
 */
export default async function NotFound() {
  // `getTranslations` with no locale argument resolves from the request, so this
  // honours the NEXT_LOCALE cookie and falls back to bg. A 404 is rendered for a
  // real request, unlike the offline page, which is precached and must bake in
  // the default.
  const t = await getTranslations('notFound');

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="text-content-muted max-w-sm text-sm">{t('body')}</p>
      <Link
        href="/venues"
        className="mt-2 text-sm text-[var(--brand-emphasis)] underline underline-offset-4"
      >
        {t('backToVenues')}
      </Link>
    </main>
  );
}
