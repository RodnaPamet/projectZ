import { resolveLocale } from '@/lib/i18n/locales';
import { runAsUserOnly } from '@/lib/db/rls-middleware';
import {
  ACCEPTED_DOCUMENTS,
  currentLegalVersions,
  legalDocumentsDue,
  type AcceptedDocument,
  type LegalVersions,
} from '@/lib/legal/versions';

/**
 * Who accepted which version of the terms and the privacy policy (#462).
 *
 * ═══ WHEN A ROW IS WRITTEN ═══
 *
 *   first sign-in     continuing from "Играч или треньор?" (`/start/kind`),
 *                     under the line "Продължавайки, приемате …"
 *   a new version     the step at `/start/terms`, once per version (owner
 *                     decision 2026-10-13)
 *
 * Both record the versions in force at that moment
 * (content/legal-versions.json), for the signed-in account and nobody else:
 * the account's id comes from the session, never from the request.
 *
 * ═══ WHAT "ACCEPTED" MEANS ═══
 *
 * A person owes a step while a text in force has no row of theirs at exactly
 * that version. An earlier version they accepted does not count for the new
 * one, and stays in the table as the record of what they agreed to then.
 *
 * The rows are the platform's, not a club's: `legal_acceptance` has no tenant.
 * Its policy is owner-only (P64): bound to a person, a query reads and adds
 * that person's rows and nobody else's, and nothing bound to a person can
 * change or delete one. So every call here is `runAsUserOnly`, never the
 * superuser handle.
 */

/**
 * Of the versions in force, the ones this account has accepted. What the
 * session token's `legal` claim carries (src/auth.ts).
 */
export async function acceptedCurrentVersions(
  userId: string,
  current: LegalVersions = currentLegalVersions(),
): Promise<LegalVersions> {
  const wanted = ACCEPTED_DOCUMENTS.flatMap((document) =>
    current[document] ? [{ document, version: current[document] }] : [],
  );
  // No version in force (the owner's texts are not published yet): no read.
  if (wanted.length === 0) return {};

  const rows = await runAsUserOnly(userId, (db) =>
    db.legalAcceptance.findMany({
      where: { userId, OR: wanted },
      select: { document: true, version: true },
      take: wanted.length,
    }),
  );
  const accepted: LegalVersions = {};
  for (const row of rows) accepted[row.document as AcceptedDocument] = row.version;
  return accepted;
}

export interface LegalStanding {
  /** The versions in force. */
  current: LegalVersions;
  /** Of those, the ones this account has accepted. */
  accepted: LegalVersions;
  /** The texts in force this account has not accepted at that version. */
  due: AcceptedDocument[];
}

export async function legalStanding(
  userId: string,
  current: LegalVersions = currentLegalVersions(),
): Promise<LegalStanding> {
  const accepted = await acceptedCurrentVersions(userId, current);
  return { current, accepted, due: legalDocumentsDue(current, accepted) };
}

/**
 * Record that this account accepts every text in force, in the language it
 * read them in. Safe to repeat: a version already accepted keeps its first
 * row and its first moment. Returns what the account has now accepted.
 */
export async function acceptCurrentLegal(
  userId: string,
  rawLocale: unknown,
  current: LegalVersions = currentLegalVersions(),
): Promise<LegalVersions> {
  const locale = resolveLocale(rawLocale);
  const rows = ACCEPTED_DOCUMENTS.flatMap((document) =>
    current[document] ? [{ userId, document, version: current[document], locale }] : [],
  );
  if (rows.length === 0) return {};

  await runAsUserOnly(userId, (db) =>
    db.legalAcceptance.createMany({ data: rows, skipDuplicates: true }),
  );
  return acceptedCurrentVersions(userId, current);
}
