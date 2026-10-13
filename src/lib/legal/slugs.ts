/**
 * The legal texts' names and where each is served (#370).
 *
 * On their own, with no import, so the middleware can name the pages a
 * person may always open (src/lib/auth/owed-step.ts) without pulling in the
 * file reads of `texts.ts`. The ONE place a legal page's path is spelled out:
 * every link takes its href from `legalHrefs(locale)` in texts.ts, which is
 * null until the text exists (the `legal-pages` guardrail holds both).
 */

export const LEGAL_SLUGS = ['privacy', 'terms', 'cookies'] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

/** Where each text is served. */
export const LEGAL_HREF: Readonly<Record<LegalSlug, string>> = {
  privacy: '/privacy',
  terms: '/terms',
  cookies: '/cookies',
};
