import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function HomePage() {
  const t = await getTranslations('home');
  const tVenues = await getTranslations('venues');
  const tLogin = await getTranslations('login');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      {/* The product name is a brand — the same in both languages, and not a
          catalogue key. */}
      <h1 className="text-brand-600 text-4xl font-semibold">playerz.bg</h1>
      <p className="text-sm opacity-70">{t('tagline')}</p>

      {/*
        ═══ THE ONLY WAY INTO THE APP ═══

        Until this existed, NOTHING on the site linked to /login. Not the
        homepage, not /venues — the single reference anywhere in src/ was the
        invite page, which you can only reach from an invitation email. The
        login page worked perfectly and was unreachable: you had to already
        know the URL.

        That is a worse failure than a broken page, because every automated
        check passes. /login renders, /api/ready is green, the buttons are
        there. There is simply no door.

        Labels come from the existing catalogue rather than new keys, so this
        is translated in both languages the day it ships: `venues.title` is
        "Играй", `login.title` is "Вход".
      */}
      <nav className="flex items-center gap-3">
        <Link
          href="/venues"
          className="bg-bg-brand text-content-on-brand inline-flex h-10 items-center rounded-md px-4 text-sm font-medium"
        >
          {tVenues('title')}
        </Link>
        <Link
          href="/login"
          className="border-border-default inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium"
        >
          {tLogin('title')}
        </Link>
      </nav>
    </main>
  );
}
