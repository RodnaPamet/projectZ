import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { SiteHeader } from '@/components/layout/SiteHeader';

export default async function HomePage() {
  const t = await getTranslations('home');
  const tVenues = await getTranslations('venues');

  return (
    <>
      {/*
        The header is what tells you whether you are signed in. Before it, the
        homepage read no session at all, so a successful sign-in landed you back
        on a page identical to the one you left — indistinguishable from a
        failure, and reported as one.

        The sign-in link lives THERE now rather than here, so there is one place
        to look on every page instead of a link that exists only on this one.
      */}
      <SiteHeader />

      {/* min-h-screen would now overflow by the height of the header. */}
      <main className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center gap-6">
        {/* The product name is a brand — the same in both languages, and not a
            catalogue key. Green via text-content-brand, which changes shade
            with the theme; a fixed brand-NNN cannot pass as text in both (#233). */}
        <h1 className="text-content-brand text-4xl font-semibold">playerz.bg</h1>
        <p className="text-sm opacity-70">{t('tagline')}</p>

        {/* data-perf-ready: the harness's "this page's content is on screen"
            marker (docs/perf/README.md, "READY markers"). Keep it on whatever
            becomes this page's primary content. */}
        <Link
          href="/venues"
          data-perf-ready
          className="bg-bg-brand text-content-on-brand inline-flex h-10 items-center rounded-md px-4 text-sm font-medium"
        >
          {tVenues('title')}
        </Link>
      </main>
    </>
  );
}
