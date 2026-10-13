import { getTranslations } from 'next-intl/server';

import { Heading } from '@/components/ui/typography';
import { DEFAULT_LOCALE, LOCALES } from '@/lib/i18n/locales';
import { translateFor } from '@/lib/i18n/server-messages';

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
 *
 * ═══ IN EVERY LANGUAGE AT ONCE (#431) ═══
 *
 * `force-static` means there is no request and no cookie to read, so the page
 * cannot know which language its reader chose. It used to bake in Bulgarian
 * alone, and an English reader with no network got a page they could not read
 * at the one moment nothing else could explain it.
 *
 * So it says it in every language the app has: the default first, as the
 * page's own (the heading), then each other one beneath it, marked with its
 * `lang` so a screen reader pronounces it properly. No script picks one: a
 * script is one more thing that has to be in the cache with no network, and
 * two short paragraphs cost nobody anything.
 */
export const dynamic = 'force-static';

export default async function OfflinePage() {
  // The request-less default locale: the page's own language, and `<html lang>`.
  const t = await getTranslations('offline');
  const others = await Promise.all(
    LOCALES.filter((locale) => locale !== DEFAULT_LOCALE).map(async (locale) => ({
      locale,
      title: await translateFor(locale, 'offline.title'),
      body: await translateFor(locale, 'offline.body'),
    })),
  );

  return (
    // Page tokens, not `text-muted-foreground`: that is a shadcn name this
    // theme never defined, so the body rendered in the inherited colour. The
    // markup is complete from the server, so it reads the same if the
    // Heading's client chunk is not in the cache yet.
    <main className="bg-bg-page text-content-default flex min-h-dvh flex-col items-center justify-center gap-3 p-8 text-center">
      <Heading level={1}>{t('title')}</Heading>
      <p className="text-content-muted max-w-sm text-sm">{t('body')}</p>
      {others.map((o) => (
        <div
          key={o.locale}
          lang={o.locale}
          className="border-border-subtle mt-3 max-w-sm border-t pt-4"
          data-testid={`offline-${o.locale}`}
        >
          <p className="text-content-default text-sm font-medium">{o.title}</p>
          <p className="text-content-muted mt-1 text-sm">{o.body}</p>
        </div>
      ))}
    </main>
  );
}
