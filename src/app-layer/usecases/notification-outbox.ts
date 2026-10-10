import type { NotificationKind, Prisma } from '@prisma/client';

import { runAsSuperuser, runAsUserOnly } from '@/lib/db/rls-middleware';
import { contactInboxAddress } from '@/lib/email/contact-inbox';
import {
  emailProvider,
  headerSafe,
  isDeliverableAddress,
  type EmailProvider,
} from '@/lib/email/provider';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * The notification outbox (#367).
 *
 * ═══ ONE TRANSACTION PER RECIPIENT, AFTER THE EVENT COMMITTED ═══
 *
 * A booking, a cancel or a join commits first, in its club's binding. Then,
 * for each person to tell, `deliver` writes the bell row and (when the person
 * wants that email) the outbox row together, in ONE transaction bound to that
 * person (`runAsUserOnly`): both tables are owner-only under RLS. Either both
 * exist or neither does; a crash in between costs a notification, never a
 * booking (see `notifyAfterCommit` in `notifications.ts` for why the club's
 * transaction cannot write them).
 *
 * ═══ IDEMPOTENT PER (EVENT, RECIPIENT) ═══
 *
 * Both rows carry a dedupe key, unique per user, and are written with
 * `skipDuplicates` (`ON CONFLICT DO NOTHING`). A hook that fires twice writes
 * once. See `src/lib/notifications/dedupe.ts`.
 *
 * ═══ THE DRAIN ═══
 *
 * `drainEmailOutbox` (cron, every minute) claims due rows with `FOR UPDATE
 * SKIP LOCKED`, pushing `nextAttemptAt` a lease ahead, so two overlapping runs
 * never send one row twice and a run that dies mid-send is retried after the
 * lease. Each row is re-checked before sending: the booking must still be
 * live for a confirmation or a reminder, the person must still want the
 * category and still have an address. A failure is retried with backoff
 * (`EMAIL_BACKOFF_SECONDS`), and dead-lettered (`DEAD`) after
 * `EMAIL_MAX_ATTEMPTS`, or at once when the provider refuses the message for
 * good.
 *
 * ═══ ONE ROW HAS NO RECIPIENT USER: THE OPERATOR'S (#369) ═══
 *
 * Category `contact` is a landing-page enquiry emailed to the operator. It has
 * no `userId` (P50 allows NULL for that category alone) and no stored address:
 * the drain sends it to `CONTACT_INBOX_EMAIL` as read at send time, and skips
 * it ('no-address') when that is unset. It is written by
 * `usecases/contact-requests.ts`, BYPASSRLS, in the enquiry's own transaction.
 */

export type EmailCategory = 'confirmation' | 'reminder' | 'clubChanges' | 'messages' | 'contact';

export const NOTIFICATION_TITLE_MAX = 80;
export const NOTIFICATION_BODY_MAX = 200;
export const EMAIL_SUBJECT_MAX = 150;

/** Attempts before a row is dead-lettered. */
export const EMAIL_MAX_ATTEMPTS = 6;
/** The wait after attempt n fails (1-based): 1 min, 5 min, 15 min, 1 h, 3 h. */
export const EMAIL_BACKOFF_SECONDS = [60, 300, 900, 3600, 3 * 3600] as const;
/** How long a claimed row is held before another drain may take it. */
export const EMAIL_LEASE_MS = 5 * 60_000;
/** Rows one drain run sends at most. */
export const EMAIL_DRAIN_BATCH = 50;

export interface Delivery {
  userId: string;
  tenantId?: string | null;
  kind: NotificationKind;
  dedupeKey: string;
  title: string;
  body: string;
  href?: string | null;
  refType?: string | null;
  refId?: string | null;
  /** Null: bell only. Given: an outbox row too, if the person wants it. */
  email?: {
    category: EmailCategory;
    subject: string;
    text: string;
    locale: 'bg' | 'en';
    /** After this the row is skipped, not sent (a reminder after the start). */
    expiresAt?: Date | null;
    /**
     * Not sent before this (#375: a message's email waits about ten minutes,
     * and the drain re-checks that it is still unread then).
     */
    notBefore?: Date | null;
    /**
     * At most one email of this category about this `refId` per this many
     * milliseconds (#375: one an hour per conversation). A row already
     * PENDING or SENT inside the window means none is written now. Serialised
     * per (person, ref) with a transaction-scoped advisory lock, so two
     * messages landing together cannot both pass the check.
     */
    atMostOncePer?: number | null;
  } | null;
}

/** Persist the bell row and, when wanted, its email. Never throws. */
export async function deliver(d: Delivery): Promise<{ bell: boolean; email: boolean }> {
  try {
    return await runAsUserOnly(d.userId, async (db) => {
      const bell = await db.notification.createMany({
        data: [
          {
            tenantId: d.tenantId ?? null,
            userId: d.userId,
            kind: d.kind,
            // Sanitised on the way in: a title can carry a venue's or a
            // player's name, and the bell renders it.
            title: sanitizePlainText(d.title).slice(0, NOTIFICATION_TITLE_MAX),
            body: sanitizePlainText(d.body).slice(0, NOTIFICATION_BODY_MAX),
            href: d.href ?? null,
            refType: d.refType ?? null,
            refId: d.refId ?? null,
            dedupeKey: d.dedupeKey,
          },
        ],
        skipDuplicates: true,
      });

      let email = false;
      if (d.email && d.email.atMostOncePer && d.refId) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`outbox:${d.userId}:${d.email.category}:${d.refId}`}))`;
        // guardrail-allow: cross-tenant — the person's own outbox rows, owner-only
        // under RLS (`email_outbox_owner_only`); an email belongs to no club.
        const recent = await db.emailOutbox.count({
          where: {
            userId: d.userId,
            category: d.email.category,
            refType: d.refType ?? null,
            refId: d.refId,
            status: { in: ['PENDING', 'SENT'] },
            createdAt: { gt: new Date(Date.now() - d.email.atMostOncePer) },
          },
        });
        if (recent > 0) return { bell: bell.count > 0, email: false };
      }
      if (d.email) {
        const out = await db.emailOutbox.createMany({
          data: [
            {
              userId: d.userId,
              kind: d.kind,
              category: d.email.category,
              dedupeKey: d.dedupeKey,
              locale: d.email.locale,
              // One header line, whatever a venue is called.
              subject: headerSafe(d.email.subject).slice(0, EMAIL_SUBJECT_MAX),
              text: d.email.text,
              refType: d.refType ?? null,
              refId: d.refId ?? null,
              expiresAt: d.email.expiresAt ?? null,
              ...(d.email.notBefore ? { nextAttemptAt: d.email.notBefore } : {}),
            },
          ],
          skipDuplicates: true,
        });
        email = out.count > 0;
      }
      return { bell: bell.count > 0, email };
    });
  } catch (err) {
    logger.warn('notification not written', {
      component: 'notifications',
      kind: d.kind,
      refType: d.refType,
      refId: d.refId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { bell: false, email: false };
  }
}

// ─── The drain ──────────────────────────────────────────────────────────

export interface DrainResult {
  provider: EmailProvider['name'];
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  skipped: number;
}

interface Claimed {
  id: string;
  /** Null only for category `contact`: the operator, not a user. */
  userId: string | null;
  kind: NotificationKind;
  category: string;
  subject: string;
  text: string;
  refType: string | null;
  refId: string | null;
  attempts: number;
  expiresAt: Date | null;
}

/** Whether the person still wants this category. */
function wants(
  user: {
    emailBookingConfirmations: boolean;
    emailBookingReminders: boolean;
    emailClubChanges: boolean;
    emailMessages: boolean;
  },
  category: string,
): boolean {
  switch (category) {
    case 'messages':
      return user.emailMessages;
    case 'confirmation':
      return user.emailBookingConfirmations;
    case 'reminder':
      return user.emailBookingReminders;
    case 'clubChanges':
      return user.emailClubChanges;
    default:
      return true;
  }
}

export function backoffSeconds(attempts: number): number {
  return EMAIL_BACKOFF_SECONDS[Math.min(attempts, EMAIL_BACKOFF_SECONDS.length) - 1] ?? 60;
}

export async function drainEmailOutbox(
  opts: { now?: Date; limit?: number; provider?: EmailProvider } = {},
): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? EMAIL_DRAIN_BATCH, 200));
  const provider = opts.provider ?? emailProvider();
  const result: DrainResult = {
    provider: provider.name,
    claimed: 0,
    sent: 0,
    retried: 0,
    dead: 0,
    skipped: 0,
  };

  // guardrail-allow: cross-tenant — the outbox spans every user and every club;
  // this is machine work with no session, the same shape as the booking sweeps.
  const claimed = await runAsSuperuser(
    (db) => db.$queryRaw<Claimed[]>`
      UPDATE "email_outbox"
         SET "nextAttemptAt" = ${new Date(now.getTime() + EMAIL_LEASE_MS)},
             "attempts" = "attempts" + 1,
             "updatedAt" = ${now}
       WHERE "id" IN (
         SELECT "id" FROM "email_outbox"
          WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${now}
          ORDER BY "nextAttemptAt"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
   RETURNING "id", "userId", "kind", "category", "subject", "text", "refType", "refId",
             "attempts", "expiresAt"`,
  );
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  // Everything the re-checks need, in two reads for the whole batch.
  const userIds = [...new Set(claimed.flatMap((c) => (c.userId ? [c.userId] : [])))];
  const bookingIds = [
    ...new Set(claimed.flatMap((c) => (c.refType === 'booking' && c.refId ? [c.refId] : []))),
  ];
  const [users, bookings] = await runAsSuperuser(async (db) =>
    Promise.all([
      db.user.findMany({
        // A deleted account (#370) has no address: its rows are skipped.
        where: { id: { in: userIds }, deletedAt: null },
        select: {
          id: true,
          email: true,
          emailBookingConfirmations: true,
          emailBookingReminders: true,
          emailClubChanges: true,
          emailMessages: true,
        },
        take: userIds.length,
      }),
      // guardrail-allow: cross-tenant — ids from the outbox rows just claimed.
      bookingIds.length === 0
        ? Promise.resolve([])
        : db.booking.findMany({
            where: { id: { in: bookingIds } },
            select: { id: true, status: true, startTs: true },
            take: bookingIds.length,
          }),
    ]),
  );
  const userById = new Map(users.map((u) => [u.id, u]));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  // A message's email goes only while the message is still unread (#375).
  const stillUnread = await unreadAtSendTime(
    claimed.flatMap((c) =>
      c.category === 'messages' && c.refType === 'conversation' && c.userId && c.refId
        ? [{ userId: c.userId, conversationId: c.refId }]
        : [],
    ),
  );

  let configLogged = false;

  for (const row of claimed) {
    const user = row.userId ? userById.get(row.userId) : undefined;
    // The operator's enquiry email: the inbox as configured NOW.
    const operator = row.category === 'contact' && row.userId === null;
    const to = operator ? contactInboxAddress() : (user?.email ?? null);
    const skip =
      skipReason(row, now, operator ? to : user, bookingById) ??
      (row.category === 'messages' &&
      row.refType === 'conversation' &&
      !stillUnread.has(`${row.userId}:${row.refId}`)
        ? 'read'
        : null);
    if (skip || !to) {
      await finish(row.id, { status: 'SKIPPED', lastError: skip ?? 'no-address' });
      result.skipped++;
      continue;
    }

    const outcome = await provider.send({
      to,
      subject: row.subject,
      text: row.text,
      // Stable per row: a retry after a timeout that DID deliver is deduped
      // by the provider rather than sent twice.
      idempotencyKey: `outbox-${row.id}`,
      ref: row.id,
    });

    if (outcome.ok) {
      await finish(row.id, {
        status: 'SENT',
        sentAt: now,
        provider: provider.name,
        lastError: null,
      });
      result.sent++;
      continue;
    }

    if (outcome.permanent || row.attempts >= EMAIL_MAX_ATTEMPTS) {
      await finish(row.id, { status: 'DEAD', provider: provider.name, lastError: outcome.error });
      result.dead++;
      logger.error('email dead-lettered', {
        component: 'email',
        outboxId: row.id,
        kind: row.kind,
        attempts: row.attempts,
        error: outcome.error,
      });
      continue;
    }

    await finish(row.id, {
      status: 'PENDING',
      provider: provider.name,
      lastError: outcome.error,
      nextAttemptAt: new Date(now.getTime() + backoffSeconds(row.attempts) * 1000),
    });
    result.retried++;
    if (!configLogged) {
      configLogged = true;
      logger.warn('email send failed; will retry', {
        component: 'email',
        provider: provider.name,
        error: outcome.error,
      });
    }
  }

  return result;
}

function skipReason(
  row: Claimed,
  now: Date,
  /** The recipient user, or for the operator's row the inbox address (or null). */
  user:
    | {
        email: string;
        emailBookingConfirmations: boolean;
        emailBookingReminders: boolean;
        emailClubChanges: boolean;
        emailMessages: boolean;
      }
    | string
    | null
    | undefined,
  bookings: Map<string, { status: string; startTs: Date }>,
): string | null {
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return 'expired';
  // The operator has no settings to re-check: an inbox, or nothing.
  if (typeof user === 'string' || user === null) {
    return user && isDeliverableAddress(user) ? null : 'no-address';
  }
  if (!user || !isDeliverableAddress(user.email)) return 'no-address';
  if (!wants(user, row.category)) return 'opted-out';

  // A confirmation or a reminder is about a booking that is still on. The
  // reminder racing a cancel lands here: the cancel committed after the
  // reminder was written, and the email is not sent.
  if (
    (row.category === 'confirmation' || row.category === 'reminder') &&
    row.refType === 'booking'
  ) {
    const b = row.refId ? bookings.get(row.refId) : undefined;
    if (!b || (b.status !== 'CONFIRMED' && b.status !== 'PENDING')) return 'booking-not-live';
    if (row.category === 'reminder' && b.startTs.getTime() <= now.getTime()) return 'started';
  }
  return null;
}

/**
 * Which of these (person, conversation) pairs still have something unread for
 * the person, as `${userId}:${conversationId}`: the drain sends a message's
 * email only then (#375). One read for the whole batch.
 *
 *   a player in it   a message from somebody else after their read pointer
 *   club staff       the player's newest message, read by no colleague and
 *                    answered by none: the club is one inbox, and an email
 *                    about what a colleague already handled is noise
 *
 * A blocked or closed conversation sends nothing.
 */
async function unreadAtSendTime(
  pairs: Array<{ userId: string; conversationId: string }>,
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  // guardrail-allow: cross-tenant — the conversations named by the outbox
  // rows just claimed, and their read pointers; machine work with no session.
  const rows = await runAsSuperuser(
    (db) => db.$queryRaw<Array<{ uid: string; cid: string }>>`
      SELECT x.uid, x.cid
        FROM unnest(${pairs.map((p) => p.userId)}::text[],
                    ${pairs.map((p) => p.conversationId)}::text[]) AS x(uid, cid)
        JOIN "conversation" c ON c."id" = x.cid AND c."blockedAt" IS NULL
       WHERE EXISTS (
               SELECT 1 FROM "conversation_participant" p
                 JOIN "chat_message" m ON m."conversationId" = p."conversationId"
                WHERE p."conversationId" = x.cid AND p."userId" = x.uid
                  AND p."role" IN ('MEMBER', 'PLAYER')
                  AND m."deletedAt" IS NULL AND m."senderId" <> x.uid
                  AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt"))
          OR (
               NOT EXISTS (
                 SELECT 1 FROM "conversation_participant" p
                  WHERE p."conversationId" = x.cid AND p."userId" = x.uid
                    AND p."role" IN ('MEMBER', 'PLAYER'))
               AND EXISTS (
                 SELECT 1 FROM "chat_message" m
                  WHERE m."conversationId" = x.cid AND m."deletedAt" IS NULL
                    AND m."senderTenantId" IS NULL
                    AND m."createdAt" > COALESCE(
                      (SELECT max(s."lastReadAt") FROM "conversation_participant" s
                        WHERE s."conversationId" = x.cid AND s."role" = 'STAFF'),
                      'epoch'::timestamp)
                    AND m."createdAt" > COALESCE(
                      (SELECT max(r."createdAt") FROM "chat_message" r
                        WHERE r."conversationId" = x.cid AND r."senderTenantId" IS NOT NULL),
                      'epoch'::timestamp)))`,
  );
  return new Set(rows.map((r) => `${r.uid}:${r.cid}`));
}

async function finish(id: string, data: Prisma.EmailOutboxUpdateInput): Promise<void> {
  // guardrail-allow: cross-tenant — one outbox row by its id, claimed above.
  await runAsSuperuser((db) => db.emailOutbox.update({ where: { id }, data }));
}
