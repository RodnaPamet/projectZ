import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { Caption } from '@/components/ui/typography';

import { FooterLocaleSwitcher } from './footer-locale-switcher';

/**
 * The public site's footer (#368, #369): the wordmark, two links, and the
 * language switch every visitor can reach, signed in or not.
 *
 * Mounted by `PlayerChrome` on the public pages and the landing page, not on
 * /me (the profile has its own switch, #362). Below `md` it sits above the
 * bottom tab bar's in-flow spacer, so the bar never covers it.
 *
 * Links keep the default (auto) prefetch: docs/perf/navigation-policy.md keeps
 * full prefetch to the tab bar and the landing page's two links.
 */
export async function SiteFooter({ signedIn }: { signedIn: boolean }) {
  const [t, tCommon] = await Promise.all([
    getTranslations('common.footer'),
    getTranslations('common'),
  ]);
  const linkClass =
    'text-content-muted hover:text-content-emphasis rounded-sm text-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none';

  return (
    <footer
      aria-label={t('label')}
      className="border-border-subtle bg-bg-page safe-area-x mt-auto border-t"
      data-testid="site-footer"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <Link
            href="/"
            className="text-content-emphasis w-fit rounded-sm font-semibold focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
          >
            {tCommon('appName')}
          </Link>
          <Caption>{t('tagline')}</Caption>
        </div>

        <nav aria-label={t('linksLabel')}>
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            <li>
              <Link href="/venues" className={linkClass}>
                {t('venues')}
              </Link>
            </li>
            <li>
              <Link href="/#clubs" className={linkClass}>
                {t('forClubs')}
              </Link>
            </li>
          </ul>
        </nav>

        <div className="flex items-center gap-3" data-testid="footer-language">
          <span className="text-content-muted text-sm">{t('language')}</span>
          <FooterLocaleSwitcher signedIn={signedIn} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-6xl px-6 pb-8">
        <Caption className="text-xs">{t('copyright', { year: new Date().getFullYear() })}</Caption>
      </div>
    </footer>
  );
}
