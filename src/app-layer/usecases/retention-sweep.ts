import type { PrismaClient } from '@prisma/client';

import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { RETENTION, retentionCutoffs, utcDay, utcWall } from '@/lib/retention/periods';

/**
 * THE PRIVACY POLICY'S PERIODS, ENFORCED (#717).
 *
 * content/legal/{bg,en}/privacy.md (section 13, in force since 2026-11-15)
 * tells people how long each record is kept. Until this job, nothing ended
 * any of those periods. Once a day (`ops/sweep.compose.yml`, `retention-sweep`)
 * it deletes or anonymises what has outlived its period:
 *
 *   bookings        ANONYMISED 5 years after the booking ended. The row stays
 *                   (court, time, price, status, channel): the club's figures
 *                   are counted from it, `club_fee_line` and results name it,
 *                   and deleting it would cascade into match reports,
 *                   tournament matches and lessons. What goes is every link
 *                   to a person: the booker, the names, phone and address the
 *                   desk typed, the note, the free-text cancellation reason
 *                   and the payment provider's reference. In the same
 *                   transaction, on its children: the players' places
 *                   (account, guest name and address cleared; the place stays,
 *                   so "4 played" still reads), the cancellation (who, why),
 *                   check-ins, payments and refunds (provider references,
 *                   failure text, reason), price shares (who, address,
 *                   payment reference), the open game's note; and DELETED: its
 *                   share links and the requests to join its open game, which
 *                   are nothing but a person and a note. `anonymisedAt` marks
 *                   it done (P92).
 *   weeklySeries    ANONYMISED 5 years after its last occurrence: the linked
 *                   account, the name and phone the desk typed, the note.
 *   auditEntries    DELETED 5 years after the change: the club's history of
 *                   booking and staff changes. "5 years after the booking,
 *                   like the bookings themselves": a row about a booking, a
 *                   place on one or a weekly series stays while that booking
 *                   (or the series' last occurrence) is younger than 5 years.
 *   securityEvents  DELETED after 1 year: the team's second-factor attempts.
 *   moderationCases DELETED 5 years after the decision. An open case is never
 *                   swept: nobody has decided it.
 *   contentReports  DELETED 5 years after they were filed, unless a case on
 *                   the same thing is still open.
 *   acceptedTexts   DELETED 5 years after the account was deleted. An account
 *                   that still exists keeps its record of what it accepted.
 *   contactRequests DELETED 2 years after the last contact: the latest
 *                   enquiry from the same email address or phone number is
 *                   the last contact the platform knows of. Replies happen
 *                   in the operator's mailbox, outside it.
 *   contactEmails   the email_outbox copy of each enquiry, DELETED with it
 *                   (and a copy whose enquiry is already gone, after 2 years).
 *   sessions        DELETED 90 days after the session ended: signed out, or
 *                   expired, whichever came first. With them go the IP address
 *                   and User-Agent of every sign-in.
 *
 * ═══ WHAT IT DOES NOT TOUCH ═══
 *
 *   - a credit balance in use. Its movements stay while the person and the
 *     club have a non-zero balance, or moved it in the last 5 years; see
 *     `credit` below for when a history goes.
 *   - `club_fee_line`, `tournament_fee_line`: they name no person.
 *   - match results, ratings and tournament entries: the person's own record,
 *     kept while the account is (and without the name once it is deleted).
 *   - `coach_lesson`: the coach's record of what they taught. The customer is
 *     in the booking, and that is anonymised.
 *   - `platform_audit_entry`: the policy states no period for it.
 *
 * ═══ HOW ═══
 *
 * Each category in batches of `RETENTION_BATCH` rows, each batch its own
 * short transaction, at most `RETENTION_MAX_BATCHES` a run; a category that
 * hit the cap says `truncated`, and the next day finishes it. Every cut-off
 * is computed here from `now`, and for the two append-only logs ALSO by the
 * database's own clock in the same statement: their triggers (P92) admit a
 * delete only of a row past the period by `now()`, so the two must agree.
 *
 * ═══ WHY THIS BINDS SUPERUSER ═══
 *
 * Machine work with no human actor, across every club and every person, as
 * the other sweeps: there is no tenant to bind and no person to bind as, and
 * three of these tables deny app_user outright. The triggers on the two logs
 * require it too.
 */

/** Rows per transaction. */
export const RETENTION_BATCH = 500;
/** Transactions per category per run; the next day carries on. */
export const RETENTION_MAX_BATCHES = 20;

export interface RetentionSweep {
  /** Every row changed or removed, all categories together. */
  total: number;
  /** Some category hit its cap; tomorrow's run continues it. */
  truncated: boolean;
  anonymised: { bookings: number; weeklySeries: number; creditMovements: number };
  deleted: {
    auditEntries: number;
    securityEvents: number;
    moderationCases: number;
    contentReports: number;
    acceptedTexts: number;
    contactRequests: number;
    contactEmails: number;
    sessions: number;
  };
}

type Batch = (db: PrismaClient, limit: number) => Promise<number>;

/** Run one category's batches until it runs dry or reaches the cap. */
async function drain(
  batch: Batch,
  limit: number,
  maxBatches: number,
): Promise<{ count: number; truncated: boolean }> {
  let count = 0;
  for (let i = 0; i < maxBatches; i++) {
    // guardrail-allow: cross-tenant — the platform's own retention periods,
    // across every club and person; it reads ages and ids, and nothing leaves.
    const n = await runAsSuperuser(async (db) => {
      await db.$executeRaw`SELECT set_config('app.retention_sweep', 'on', true)`;
      return batch(db, limit);
    });
    count += n;
    if (n < limit) return { count, truncated: false };
  }
  return { count, truncated: true };
}

export async function sweepRetention(
  now: Date = new Date(),
  opts: { batch?: number; maxBatches?: number } = {},
): Promise<RetentionSweep> {
  const limit = opts.batch ?? RETENTION_BATCH;
  const maxBatches = opts.maxBatches ?? RETENTION_MAX_BATCHES;
  const cut = retentionCutoffs(now);

  // ── Bookings: anonymised ──────────────────────────────────────────────
  const bookingsBefore = cut.bookingsEndedBefore.toISOString();
  const bookings = await drain(
    async (db) => {
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM booking
         WHERE "anonymisedAt" IS NULL
           AND "endTs" < ${bookingsBefore}::timestamptz
         ORDER BY "endTs", id
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);

      await db.$executeRaw`
        UPDATE booking_participant
           SET "userId" = NULL, "guestName" = NULL, "guestEmail" = NULL
         WHERE "bookingId" = ANY(${ids}::text[])`;
      await db.$executeRaw`
        UPDATE cancellation SET "cancelledByUserId" = NULL, reason = NULL
         WHERE "bookingId" = ANY(${ids}::text[])`;
      await db.$executeRaw`
        UPDATE check_in SET "userId" = NULL WHERE "bookingId" = ANY(${ids}::text[])`;
      await db.$executeRaw`
        UPDATE payment SET "providerRefId" = NULL, "failureReasonJson" = NULL
         WHERE "bookingId" = ANY(${ids}::text[])`;
      await db.$executeRaw`
        UPDATE refund SET reason = NULL, "providerRefId" = NULL
         WHERE "bookingId" = ANY(${ids}::text[])`;
      await db.$executeRaw`
        UPDATE booking_split
           SET "userId" = NULL, "inviteEmail" = NULL, "paymentIntentId" = NULL
         WHERE "bookingId" = ANY(${ids}::text[])`;
      await db.$executeRaw`
        DELETE FROM booking_invite_link WHERE "bookingId" = ANY(${ids}::text[])`;
      await db.$executeRaw`
        DELETE FROM open_game_request
         WHERE "gameId" IN (SELECT id FROM open_game WHERE "bookingId" = ANY(${ids}::text[]))`;
      await db.$executeRaw`
        UPDATE open_game SET note = NULL WHERE "bookingId" = ANY(${ids}::text[])`;
      // The refund quote in `cancellationReasonJson` stays, as the record of
      // the money; the free-text reason inside it goes, as account deletion
      // does it.
      return db.$executeRaw`
        UPDATE booking
           SET "bookedByUserId" = NULL,
               "guestName" = NULL,
               "guestEmail" = NULL,
               "guestPhone" = NULL,
               notes = NULL,
               "stripePaymentIntentId" = NULL,
               "cancellationReasonJson" = CASE
                 WHEN "cancellationReasonJson" ->> 'reason' IS NOT NULL
                   THEN jsonb_set("cancellationReasonJson", '{reason}', 'null'::jsonb)
                 ELSE "cancellationReasonJson"
               END,
               "anonymisedAt" = now()
         WHERE id = ANY(${ids}::text[])`;
    },
    limit,
    maxBatches,
  );

  // ── Weekly series: anonymised after their last occurrence ─────────────
  const seriesBefore = utcDay(cut.bookingsEndedBefore);
  const weeklySeries = await drain(
    (db) => db.$executeRaw`
      UPDATE booking_series
         SET "customerUserId" = NULL, "customerName" = '', "customerPhone" = '', notes = NULL
       WHERE id IN (
         SELECT id FROM booking_series
          WHERE LEAST("lastDate", COALESCE("cancelledFrom", "lastDate")) < ${seriesBefore}::date
            AND ("customerUserId" IS NOT NULL OR "customerName" <> ''
                 OR "customerPhone" <> '' OR notes IS NOT NULL)
          ORDER BY "lastDate", id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)`,
    limit,
    maxBatches,
  );

  // ── The club's history: deleted after 5 years ─────────────────────────
  const auditBefore = utcWall(cut.auditBefore);
  const auditBookingBefore = cut.auditBefore.toISOString();
  const auditSeriesBefore = utcDay(cut.auditBefore);
  const auditEntries = await drain(
    (db) => db.$executeRaw`
      DELETE FROM audit_entry
       WHERE id IN (
         SELECT a.id FROM audit_entry a
          WHERE a."createdAt" < ${auditBefore}::timestamp
            AND a."createdAt" < (now() AT TIME ZONE 'UTC') - make_interval(years => ${RETENTION.auditYears}::int)
            AND NOT (a.entity = 'Booking' AND EXISTS (
                  SELECT 1 FROM booking b
                   WHERE b.id = a."entityId" AND b."endTs" >= ${auditBookingBefore}::timestamptz))
            AND NOT (a.entity = 'BookingParticipant' AND EXISTS (
                  SELECT 1 FROM booking_participant p JOIN booking b ON b.id = p."bookingId"
                   WHERE p.id = a."entityId" AND b."endTs" >= ${auditBookingBefore}::timestamptz))
            AND NOT (a.entity = 'BookingSeries' AND EXISTS (
                  SELECT 1 FROM booking_series s
                   WHERE s.id = a."entityId"
                     AND LEAST(s."lastDate", COALESCE(s."cancelledFrom", s."lastDate")) >= ${auditSeriesBefore}::date))
          ORDER BY a."createdAt", a.id
          LIMIT ${limit})`,
    limit,
    maxBatches,
  );

  // ── The team's second-factor attempts: deleted after 1 year ───────────
  const securityBefore = utcWall(cut.securityEventsBefore);
  const securityEvents = await drain(
    (db) => db.$executeRaw`
      DELETE FROM account_security_event
       WHERE id IN (
         SELECT id FROM account_security_event
          WHERE "createdAt" < ${securityBefore}::timestamp
            AND "createdAt" < (now() AT TIME ZONE 'UTC') - make_interval(years => ${RETENTION.securityEventYears}::int)
          ORDER BY "createdAt", id
          LIMIT ${limit})`,
    limit,
    maxBatches,
  );

  // ── Moderation: decided cases and filed reports, after 5 years ────────
  const moderationBefore = utcWall(cut.moderationBefore);
  const moderationCases = await drain(
    (db) => db.$executeRaw`
      DELETE FROM moderation_case
       WHERE id IN (
         SELECT id FROM moderation_case
          WHERE status <> 'OPEN'
            AND COALESCE("resolvedAt", "updatedAt") < ${moderationBefore}::timestamp
          ORDER BY "createdAt", id
          LIMIT ${limit})`,
    limit,
    maxBatches,
  );
  const contentReports = await drain(
    (db) => db.$executeRaw`
      DELETE FROM content_report
       WHERE id IN (
         SELECT r.id FROM content_report r
          WHERE r."createdAt" < ${moderationBefore}::timestamp
            AND NOT EXISTS (
              SELECT 1 FROM moderation_case c
               WHERE c.status = 'OPEN'
                 AND c."subjectType" = r."subjectType"
                 AND c."subjectId" = r."subjectId")
          ORDER BY r."createdAt", r.id
          LIMIT ${limit})`,
    limit,
    maxBatches,
  );

  // ── Accepted texts: 5 years after the account was deleted ─────────────
  const acceptedBefore = utcWall(cut.acceptedTextsDeletedBefore);
  const acceptedTexts = await drain(
    (db) => db.$executeRaw`
      DELETE FROM legal_acceptance
       WHERE id IN (
         SELECT la.id FROM legal_acceptance la
           JOIN app_user u ON u.id = la."userId"
          WHERE u."deletedAt" < ${acceptedBefore}::timestamp
          ORDER BY la.id
          LIMIT ${limit})`,
    limit,
    maxBatches,
  );

  // ── "For clubs" enquiries: 2 years after the last contact ─────────────
  const contactBefore = cut.contactBefore.toISOString();
  let contactEmailCount = 0;
  const contactRequests = await drain(
    async (db) => {
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT c.id FROM contact_request c
         WHERE c."createdAt" < ${contactBefore}::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM contact_request later
              WHERE later."createdAt" >= ${contactBefore}::timestamptz
                AND (
                  (c.email IS NOT NULL AND lower(later.email) = lower(c.email))
                  OR (c.phone IS NOT NULL
                      AND regexp_replace(c.phone, '[^0-9]', '', 'g') <> ''
                      AND regexp_replace(later.phone, '[^0-9]', '', 'g')
                          = regexp_replace(c.phone, '[^0-9]', '', 'g'))
                ))
         ORDER BY c."createdAt", c.id
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);
      contactEmailCount += await db.$executeRaw`
        DELETE FROM email_outbox
         WHERE "refType" = 'contact_request' AND "refId" = ANY(${ids}::text[])`;
      return db.$executeRaw`DELETE FROM contact_request WHERE id = ANY(${ids}::text[])`;
    },
    limit,
    maxBatches,
  );
  // A copy whose enquiry the operator already deleted on request.
  const contactWall = utcWall(cut.contactBefore);
  const orphanEmails = await drain(
    (db) => db.$executeRaw`
      DELETE FROM email_outbox
       WHERE id IN (
         SELECT o.id FROM email_outbox o
          WHERE o.category = 'contact'
            AND o."createdAt" < ${contactWall}::timestamp
            AND NOT EXISTS (SELECT 1 FROM contact_request c WHERE c.id = o."refId")
          ORDER BY o."createdAt", o.id
          LIMIT ${limit})`,
    limit,
    maxBatches,
  );

  // ── Sessions: 90 days after they ended ────────────────────────────────
  const sessionsBefore = utcWall(cut.sessionsEndedBefore);
  const sessions = await drain(
    (db) => db.$executeRaw`
      DELETE FROM user_session
       WHERE id IN (
         SELECT id FROM user_session
          WHERE "expiresAt" < ${sessionsBefore}::timestamp
             OR "revokedAt" < ${sessionsBefore}::timestamp
          ORDER BY "expiresAt", id
          LIMIT ${limit})`,
    limit,
    maxBatches,
  );

  // ── Credit movements: anonymised, a whole zero balance at a time ──────
  //
  // Owner 2026-11-27. A balance is the SUM of a person's `deltaCents` at a
  // club, so moving only some rows would change a sum somebody still reads.
  // A history goes whole: the balance is zero AND its newest movement is
  // over 5 years old. `userId` becomes 'anonymised' and the reference to
  // what was paid is cleared; amounts, reasons and times stay for the club's
  // figures (a zero history adds zero to them). P93's trigger admits exactly
  // this update and nothing else. Batches count histories, so a long one is
  // never split across runs.
  const creditBefore = utcWall(cut.creditLastMovementBefore);
  let creditMovements = 0;
  const credit = await drain(
    async (db, n) => {
      const [r] = await db.$queryRaw<Array<{ histories: number; movements: number }>>`
        WITH g AS (
          SELECT "tenantId", "userId"
            FROM credit_ledger_entry
           WHERE "userId" <> 'anonymised'
           GROUP BY "tenantId", "userId"
          HAVING SUM("deltaCents") = 0
             AND MAX("createdAt") < ${creditBefore}::timestamp
             AND MAX("createdAt") < (now() AT TIME ZONE 'UTC') - make_interval(years => ${RETENTION.creditYears}::int)
           ORDER BY MAX("createdAt")
           LIMIT ${n}
        ), u AS (
          UPDATE credit_ledger_entry e
             SET "userId" = 'anonymised', "refType" = NULL, "refId" = NULL
            FROM g
           WHERE e."tenantId" = g."tenantId" AND e."userId" = g."userId"
          RETURNING e.id
        )
        SELECT (SELECT count(*) FROM g)::int AS histories, (SELECT count(*) FROM u)::int AS movements`;
      creditMovements += r?.movements ?? 0;
      return r?.histories ?? 0;
    },
    limit,
    maxBatches,
  );

  const anonymised = {
    bookings: bookings.count,
    weeklySeries: weeklySeries.count,
    creditMovements,
  };
  const deleted = {
    auditEntries: auditEntries.count,
    securityEvents: securityEvents.count,
    moderationCases: moderationCases.count,
    contentReports: contentReports.count,
    acceptedTexts: acceptedTexts.count,
    contactRequests: contactRequests.count,
    contactEmails: contactEmailCount + orphanEmails.count,
    sessions: sessions.count,
  };
  const total = [...Object.values(anonymised), ...Object.values(deleted)].reduce(
    (a, b) => a + b,
    0,
  );
  const truncated = [
    bookings,
    weeklySeries,
    credit,
    auditEntries,
    securityEvents,
    moderationCases,
    contentReports,
    acceptedTexts,
    contactRequests,
    orphanEmails,
    sessions,
  ].some((c) => c.truncated);

  return { total, truncated, anonymised, deleted };
}
