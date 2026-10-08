import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { Heading } from '@/components/ui/typography';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/lib/i18n/locales';
import { LEGAL_HREF, readLegalText, type LegalSlug } from '@/lib/legal/texts';

import { LegalDocument, legalTitle } from './LegalDocument';

/**
 * What /privacy, /terms and /cookies share (#370): read the text for the
 * request's language, 404 without one, and draw it.
 */

async function requestLocale(): Promise<Locale> {
  const locale = await getLocale();
  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

export interface LoadedLegalPage {
  slug: LegalSlug;
  markdown: string;
  /** The text's own `# title`, or the page's name from the catalogue. */
  title: string;
}

/** The page's text in the request's language, or a 404 when there is none. */
export async function loadLegalPage(slug: LegalSlug): Promise<LoadedLegalPage> {
  const markdown = await readLegalText(slug, await requestLocale());
  if (!markdown) notFound();
  const t = await getTranslations('legal');
  return { slug, markdown, title: legalTitle(markdown) ?? t(`${slug}.title`) };
}

/** The `<title>`, and a canonical address: a missing text has no metadata worth giving. */
export async function legalMetadata(slug: LegalSlug): Promise<Metadata> {
  const markdown = await readLegalText(slug, await requestLocale());
  const t = await getTranslations('legal');
  return {
    title: (markdown && legalTitle(markdown)) || t(`${slug}.title`),
    alternates: { canonical: LEGAL_HREF[slug] },
  };
}

/**
 * The page body: the text at a readable width, in the chrome's own padding.
 * A text without its own `# title` gets the page's name as its heading, so the
 * page always has one.
 */
export function LegalArticle({ page }: { page: LoadedLegalPage }) {
  return (
    <article
      className="in-shell:p-0 gap-section mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-8 md:px-6 md:py-12"
      data-testid={`legal-${page.slug}`}
    >
      {legalTitle(page.markdown) === null ? <Heading level={1}>{page.title}</Heading> : null}
      <LegalDocument markdown={page.markdown} />
    </article>
  );
}
