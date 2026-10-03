import { getTranslations } from 'next-intl/server';

import { PublicPrefetchLink } from '@/components/layout/PublicPrefetchLink';
import { PlayerChrome } from '@/components/layout/player-chrome';
import { buttonVariants } from '@/components/ui/button-variants';

export default async function HomePage() {
  const t = await getTranslations('home');
  const tVenues = await getTranslations('venues');

  return (
    // The header is what tells you whether you are signed in. Before it, the
    // homepage read no session at all, so a successful sign-in landed you back
    // on a page identical to the one you left — indistinguishable from a
    // failure, and reported as one. The home page is in the `(home)` group, not
    // under a layout, so it wears the player chrome itself (T20).
    <PlayerChrome>
      {/* flex-1 in the chrome's column: centred in what the header and the
          tab bar leave, with no header height to guess at. */}
      <main className="flex flex-1 flex-col items-center justify-center gap-6 py-10">
        {/* The product name is a brand — the same in both languages, and not a
            catalogue key. Green via text-content-brand, which changes shade
            with the theme; a fixed brand-NNN cannot pass as text in both (#233). */}
        <h1 className="text-content-brand text-4xl font-semibold">playerz.bg</h1>
        {/* A token, not `opacity-70`: faded body text is whatever the page
            behind it makes it, and is not a colour a contrast check can read. */}
        <p className="text-content-muted text-sm">{t('tagline')}</p>

        {/* data-perf-ready: the harness's "this page's content is on screen"
            marker (docs/perf/README.md, "READY markers"). Keep it on whatever
            becomes this page's primary content.
            Fully prefetched (#290): the first visit renders from the router
            cache instead of waiting out the 300 ms reveal throttle.
            The primary button's own recipe, not the #245 alias classes
            (`bg-bg-brand text-content-on-brand h-10 rounded-md`) that drew a
            look-alike: one button material, one hover, one 44 px touch target. */}
        <PublicPrefetchLink
          href="/venues"
          data-perf-ready
          className={buttonVariants({ variant: 'primary' })}
        >
          {tVenues('title')}
        </PublicPrefetchLink>
      </main>
    </PlayerChrome>
  );
}
