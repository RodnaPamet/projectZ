import { getTranslations } from 'next-intl/server';

import { PlayerChrome } from '@/components/layout/player-chrome';
import { playerChrome } from '@/components/layout/SiteHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/typography';

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
 * ═══ IT WEARS THE CHROME (audit A06) ═══
 *
 * It was a bare card: no header, no tab bar, no account menu, so the way on
 * was the one button or the browser's back. It now sits in the player chrome
 * like every public page, which also gives a club member who opened an admin
 * page their role does not reach (an admin `notFound()` lands here) the
 * header's link back to their club.
 *
 * ═══ WHAT IT DELIBERATELY DOES NOT DO ═══
 *
 * It does not guess where you meant to go. A 404 that redirects somewhere
 * plausible turns "this address is wrong" into "you are somewhere unexpected and
 * nobody told you", and the back button stops working the way the reader expects.
 *
 * It offers two ways on instead, as the vendored EmptyState's actions: the
 * place this account lives (its club's diary for a club account, the venues
 * for everyone else) as the primary action, and the home page.
 */
export default async function NotFound() {
  // `getTranslations` with no locale argument resolves from the request, so this
  // honours the NEXT_LOCALE cookie and falls back to bg. A 404 is rendered for a
  // real request, unlike the offline page, which is precached and must bake in
  // the default. `playerChrome` is the header's own read, request-cached.
  const [t, { landing }] = await Promise.all([getTranslations('notFound'), playerChrome()]);
  const club = landing?.club ? { href: landing.href, name: landing.club.tenantName } : null;

  return (
    <PlayerChrome footer>
      <main className="bg-bg-page text-content-default flex flex-1 flex-col items-center justify-center p-8">
        {/* The page's heading, for the outline and the tab's reader; the
            vendored EmptyState draws its title as text, not as a heading. */}
        <Heading level={1} className="sr-only">
          {t('title')}
        </Heading>
        <EmptyState
          variant="no-results"
          title={t('title')}
          description={t('body')}
          primaryAction={
            club
              ? { label: t('backToClub', { club: club.name }), href: club.href }
              : { label: t('backToVenues'), href: '/venues' }
          }
          secondaryAction={{ label: t('home'), href: '/' }}
        />
      </main>
    </PlayerChrome>
  );
}
