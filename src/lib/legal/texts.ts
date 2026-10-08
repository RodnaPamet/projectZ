import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { cache } from 'react';

import type { Locale } from '@/lib/i18n/locales';

/**
 * The legal texts (#370): the privacy policy, the terms and the cookie policy,
 * in Bulgarian and English, written by the owner or a lawyer and never by us.
 *
 * ═══ A TEXT IS A FILE ═══
 *
 *   content/legal/{bg,en}/{privacy,terms,cookies}.md
 *
 * Markdown, because a lawyer's DOCX converts to it in one command (pandoc, see
 * docs/legal-pages.md) and a person can still read the diff. It is rendered on
 * the server (`LegalDocument`); nothing parses it in the browser.
 *
 * ═══ A MISSING TEXT IS A PAGE THAT DOES NOT EXIST ═══
 *
 * Until the file for the page's language is there, its route answers 404 and
 * every link to it is hidden: the footer's, the landing page's contact form,
 * the first-sign-in line and the profile's. An empty file counts as missing.
 * Nothing stands in for a text, not even a placeholder: a draft that reads like
 * a policy is a policy somebody can quote.
 *
 * Read from disk at request time, once per request (React `cache`). The image
 * carries `content/` (Dockerfile), so adding a text is a commit and a deploy.
 */

export const LEGAL_SLUGS = ['privacy', 'terms', 'cookies'] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

/** Where each text is served. */
export const LEGAL_HREF: Readonly<Record<LegalSlug, string>> = {
  privacy: '/privacy',
  terms: '/terms',
  cookies: '/cookies',
};

/**
 * The directory the texts live in. `LEGAL_CONTENT_DIR` points a test at a
 * fixture; nothing in a deployment sets it.
 */
export function legalContentRoot(): string {
  return process.env.LEGAL_CONTENT_DIR ?? path.join(process.cwd(), 'content', 'legal');
}

export function legalTextPath(slug: LegalSlug, locale: Locale, root = legalContentRoot()): string {
  return path.join(root, locale, `${slug}.md`);
}

/** The text, or null when its file is missing or holds nothing but whitespace. */
async function readText(slug: LegalSlug, locale: Locale): Promise<string | null> {
  try {
    const text = await readFile(legalTextPath(slug, locale), 'utf8');
    return text.trim() === '' ? null : text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export const readLegalText = cache(readText);

/** Which texts exist in `locale`: the answer every link to them is drawn from. */
export const legalTextsAvailable = cache(
  async (locale: Locale): Promise<Readonly<Record<LegalSlug, boolean>>> => {
    const found = await Promise.all(LEGAL_SLUGS.map((slug) => readLegalText(slug, locale)));
    return {
      privacy: found[0] !== null,
      terms: found[1] !== null,
      cookies: found[2] !== null,
    };
  },
);

/** The hrefs of the texts that exist in `locale`, and null for those that do not. */
export async function legalHrefs(locale: Locale): Promise<Record<LegalSlug, string | null>> {
  const available = await legalTextsAvailable(locale);
  return {
    privacy: available.privacy ? LEGAL_HREF.privacy : null,
    terms: available.terms ? LEGAL_HREF.terms : null,
    cookies: available.cookies ? LEGAL_HREF.cookies : null,
  };
}
