import { DRAFT_CERTIFICATE_KEPT_DAYS } from '@/lib/coaches/certificate-limits';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

/**
 * A CERTIFICATE NOBODY WILL LOOK AT IS NOT KEPT (#557; owner decision 28).
 *
 * A coach uploads a certificate before sending the profile for approval. If
 * the profile is never sent, or is declined and never corrected, the
 * document is a personal one that nobody has looked at or will, kept in the
 * database and every backup of it. Decision 17 keeps a certificate while the
 * coach is active; a draft is not an active coach.
 *
 * So once a day: the certificate of a profile that has been DRAFT or
 * DECLINED for 30 days with no change, uploaded 30 days ago or more, is
 * deleted. A certificate with no profile at all goes the same way. The text
 * and the sports stay; the coach uploads again when they come back, and the
 * profile page says so beforehand. A profile waiting for a decision, and an
 * approved one, keep theirs.
 */

export { DRAFT_CERTIFICATE_KEPT_DAYS };
/** At most this many in one run; a backlog is finished by the next. */
export const CERTIFICATE_SWEEP_MAX = 500;

export interface CertificateSweep {
  deleted: number;
  /** What is left, for the operator to see growth: how many, and their bytes. */
  stored: number;
  storedBytes: number;
}

export async function sweepStaleCertificates(now: Date = new Date()): Promise<CertificateSweep> {
  const cutoff = new Date(now.getTime() - DRAFT_CERTIFICATE_KEPT_DAYS * 86_400_000);
  // `coach_profile.updatedAt` is a timestamp without a zone, written in UTC;
  // `coach_certificate.uploadedAt` has one. Each is compared as what it is.
  const cutoffUtcWall = cutoff.toISOString().slice(0, 23);
  const cutoffInstant = cutoff.toISOString();

  // guardrail-allow: cross-tenant — certificates are a person's and owner-only
  // under RLS; the platform deletes the ones decision 28 says not to keep,
  // and counts the rest. Nothing is read out of them.
  return runAsSuperuser(async (db) => {
    const stale = await db.$queryRaw<Array<{ userId: string }>>`
      SELECT c."userId"
        FROM coach_certificate c
        LEFT JOIN coach_profile p ON p."userId" = c."userId"
       WHERE c."uploadedAt" < ${cutoffInstant}::timestamptz
         AND (
               p."userId" IS NULL
            OR (p.status IN ('DRAFT', 'DECLINED') AND p."updatedAt" < ${cutoffUtcWall}::timestamp)
             )
       ORDER BY c."uploadedAt"
       LIMIT ${CERTIFICATE_SWEEP_MAX}`;
    const deleted =
      stale.length === 0
        ? 0
        : (
            await db.coachCertificate.deleteMany({
              where: { userId: { in: stale.map((s) => s.userId) } },
            })
          ).count;
    const left = await db.coachCertificate.aggregate({ _count: true, _sum: { byteSize: true } });
    return { deleted, stored: left._count, storedBytes: left._sum.byteSize ?? 0 };
  });
}
