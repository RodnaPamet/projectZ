import published from '../../../content/legal-versions.json';

/**
 * Which version of the terms and of the privacy policy is in force (#462).
 *
 * ═══ A VERSION IS A LINE IN A FILE ═══
 *
 *   content/legal-versions.json     { "terms": "2026-11-01", "privacy": "2026-11-01" }
 *
 * Beside content/legal, not in it: that directory holds the texts and nothing
 * else, because every file in it is published.
 *
 * One version per text, for both languages: the Bulgarian and the English
 * file are the same terms. It is written by whoever publishes the text
 * (docs/legal-pages.md), and changed only when a change is MATERIAL: people
 * are asked to accept a new version once, so a corrected typo keeps the
 * version it had. The date the text takes effect is the convention.
 *
 * A text with no version here is accepted by nobody and asked of nobody,
 * which is the state before the owner's texts exist. The guardrail
 * `legal-versions` fails the build when a version names a text whose file is
 * missing in either language: a person cannot accept what they cannot read.
 *
 * ═══ WHO ACCEPTED WHAT ═══
 *
 * `legal_acceptance` holds a row per person, text and version
 * (src/app-layer/usecases/legal-acceptance.ts). The session token carries the
 * versions the person has accepted, in `legal`, so the middleware can tell
 * that a step is owed without a database read; the step page asks the
 * database before it asks the person.
 *
 * No Node import and no database: the middleware reads this.
 */

/** The texts a person accepts. The cookie policy informs; nothing in it is accepted. */
export const ACCEPTED_DOCUMENTS = ['terms', 'privacy'] as const;
export type AcceptedDocument = (typeof ACCEPTED_DOCUMENTS)[number];
export type LegalVersions = Partial<Record<AcceptedDocument, string>>;

/** A version: a short token, so it is safe in a cookie, a URL and a log line. */
export const LEGAL_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/;

/** The page where an account accepts the texts it has not accepted yet. */
export const LEGAL_STEP_PATH = '/start/terms';

/** Only the texts we know, and only well-formed versions; anything else is dropped. */
export function parseLegalVersions(value: unknown): LegalVersions {
  const out: LegalVersions = {};
  if (!value || typeof value !== 'object') return out;
  for (const doc of ACCEPTED_DOCUMENTS) {
    const v = (value as Record<string, unknown>)[doc];
    if (typeof v === 'string' && LEGAL_VERSION_PATTERN.test(v)) out[doc] = v;
  }
  return out;
}

/** The versions in force, from content/legal-versions.json (bundled at build). */
export function currentLegalVersions(): LegalVersions {
  return parseLegalVersions(published);
}

/** `terms=2026-11-01;privacy=2026-11-01`, in the fixed order of ACCEPTED_DOCUMENTS. */
export function encodeLegalVersions(versions: LegalVersions): string {
  return ACCEPTED_DOCUMENTS.flatMap((doc) =>
    versions[doc] ? [`${doc}=${versions[doc]}`] : [],
  ).join(';');
}

/** The reverse, tolerant of anything a stale or foreign token might hold. */
export function decodeLegalVersions(claim: unknown): LegalVersions {
  if (typeof claim !== 'string' || claim === '') return {};
  const pairs: Record<string, string> = {};
  for (const part of claim.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) pairs[part.slice(0, at)] = part.slice(at + 1);
  }
  return parseLegalVersions(pairs);
}

/** The texts in force that `accepted` does not hold at exactly that version. */
export function legalDocumentsDue(
  current: LegalVersions,
  accepted: LegalVersions,
): AcceptedDocument[] {
  return ACCEPTED_DOCUMENTS.filter((doc) => current[doc] && accepted[doc] !== current[doc]);
}
