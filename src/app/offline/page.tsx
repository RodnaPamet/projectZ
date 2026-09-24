import { getTranslations } from 'next-intl/server';

/**
 * The offline fallback.
 *
 * DELIBERATELY STATIC and personal to nobody. It is the only page the service
 * worker precaches, and it is what a failed navigation falls back to.
 *
 * The tempting alternative — falling back to "the last page this device saw" —
 * would serve whoever is holding the phone the PREVIOUS user's dashboard,
 * rendered, from disk. A shared laptop at a club's front desk makes that a
 * certainty rather than a risk.
 */
export const dynamic = 'force-static';

export default async function OfflinePage() {
  // `force-static` above means there is no request and no cookie to read, so
  // this bakes in the DEFAULT locale — Bulgarian. That is the right answer for
  // the one page that must render with no network: an English speaker who has
  // set English sees Bulgarian here and nowhere else, which is a far smaller
  // cost than a fallback page that cannot be precached.
  const t = await getTranslations('offline');

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="text-muted-foreground max-w-sm text-sm">{t('body')}</p>
    </main>
  );
}
