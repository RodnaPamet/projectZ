import { getTranslations } from 'next-intl/server';

export default async function HomePage() {
  const t = await getTranslations('home');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      {/* The product name is a brand — the same in both languages, and not a
          catalogue key. */}
      <h1 className="text-brand-600 text-4xl font-semibold">playerz.bg</h1>
      <p className="text-sm opacity-70">{t('tagline')}</p>
    </main>
  );
}
