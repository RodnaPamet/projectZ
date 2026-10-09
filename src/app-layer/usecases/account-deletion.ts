import { Prisma, type PrismaClient, type ResourceType } from '@prisma/client';

import { listUpcomingBookingsForUser } from '@/app-layer/repositories/booking';
import { tombstoneEmail } from '@/lib/account/deleted-user';
import { playerCancellableUntil, playerMayCancel } from '@/lib/booking/cutoff';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { purgeAvatarObjects } from '@/lib/media/avatar-objects';
import { getMediaStorage } from '@/lib/media/storage';
import { logger } from '@/lib/observability/logger';

import { carryNoShowStanding } from './no-show-carry';
import { recomputeVenueRating } from './reviews';

/**
 * Deleting an account (#370, owner decisions 2026-10-08).
 *
 *   1. A player or coach with upcoming bookings cancels them first: the ones
 *      they booked and the ones they were added to. Inside a club's
 *      cancellation cutoff they cannot cancel, so they wait until it has been
 *      played. A club never loses a booking without notice.
 *   2. Deletion happens at once and cannot be undone. Past bookings stay in
 *      the club's records as "Изтрит потребител", because the club's
 *      statements and the platform fee are computed from them.
 *   3. A CLUB account cannot delete itself. It asks through the contact form
 *      and the platform deletes it.
 *   4. A COACH account is a player's case: the coach module does not exist yet.
 *   5. Unused credit at a club is lost with the account. The person is told
 *      how much, at which club, and may still delete (#370 review: warn, then
 *      allow).
 *   6. A no-show standing is not escaped by deleting the account: what still
 *      counts at each club carries to the next account made with the same
 *      address, for as long as it would have counted (#370 review, P53).
 *
 * What happens to every table is decided, with the reason, in
 * src/lib/account/deletion-plan.ts; `deleteAccount` below is that list in code,
 * in ONE transaction, and tests/integration/account-deletion.test.ts holds the
 * two to each other.
 *
 * ═══ ONE CODE PATH ═══
 *
 * The person (`DELETE /api/v1/me`) and the operator (`scripts/delete-account.ts`,
 * for a deletion asked for by email) both call `deleteAccount` with a handle
 * bound to app_superuser. The rules are checked inside it, not by the callers,
 * so neither path can skip one.
 *
 * ═══ WHY THIS BINDS SUPERUSER ═══
 *
 * A person's rows sit at every club they played at, under tenant-scoped RLS,
 * and on owner-only tables keyed on `app.user_id`. There is no binding that
 * means "this person, everywhere". Every statement is keyed on the one user id,
 * which the route takes from a verified session and the script from the
 * address the operator typed, and the transaction starts by locking that row.
 */

/** Most upcoming bookings one refusal lists; the rule counts them all. */
export const UPCOMING_LISTED = 25;

/** What the profile page and the refusal say about one upcoming booking. */
export interface UpcomingBooking {
  bookingId: string;
  venueName: string;
  courtName: string;
  resourceType: ResourceType;
  timezone: string;
  startTs: Date;
  endTs: Date;
  /** The person's side of it: they booked it, or were added to it. */
  role: 'BOOKER' | 'PARTICIPANT';
  /**
   * What frees the account, now: `cancel` (the booker, before the club's
   * cutoff), `leave` (an added player, before the start), or `wait` (too late
   * for either: it has to be played first).
   */
  cure: 'cancel' | 'leave' | 'wait';
  /** The last moment the booker may cancel it in the app (#354). */
  cancellableUntil: Date;
  /**
   * From when deletion becomes possible if nothing is done: the moment the
   * booking is over. Always set; the profile page says it for `wait`.
   */
  deletableFrom: Date;
}

/**
 * Unused credit at one club, which the account loses when it is deleted. The
 * owner's decision (#370 review): warn, then allow. The ledger itself is kept,
 * naming the tombstone (deletion-plan.ts); the balance is simply nobody's.
 */
export interface ClubCredit {
  tenantId: string;
  club: string;
  /** Positive: a club with nothing left, or a debt, is not listed. */
  balanceCents: number;
}

export type DeletionStanding =
  | { kind: 'allowed'; credit: ClubCredit[] }
  | { kind: 'club' }
  | { kind: 'blocked'; bookings: UpcomingBooking[]; total: number; credit: ClubCredit[] };

/** A CLUB account, or one that runs a club: deleted by the platform on request. */
export class ClubAccountDeletionRefusedError extends Error {
  constructor() {
    super(
      'A club account is not deleted from the app. Ask through the contact form on playerz.bg and the platform deletes it.',
    );
    this.name = 'ClubAccountDeletionRefusedError';
  }
}

/** Upcoming bookings first: cancel or leave them, or wait until they are played. */
export class UpcomingBookingsError extends Error {
  constructor(
    readonly bookings: UpcomingBooking[],
    readonly total: number,
  ) {
    super(
      `The account still has ${total} upcoming booking(s). Cancel them, or leave the ones you were added to, and try again.`,
    );
    this.name = 'UpcomingBookingsError';
  }
}

/** No such account, or it was deleted already. */
export class AccountNotFoundForDeletionError extends Error {
  constructor() {
    super('No such account.');
    this.name = 'AccountNotFoundForDeletionError';
  }
}

/** The rows a deletion changed, by plan entry: what the operator's dry run prints. */
export type DeletionSummary = Record<string, number>;

const CLUB_ROLES = ['OWNER', 'MANAGER', 'STAFF'] as const;

const REVOKE_REASON = 'The account was deleted by its holder (#370).';
const REVOKE_REASON_OPERATOR = 'The account was deleted by the platform, on request (#370).';

function describeUpcoming(
  rows: Awaited<ReturnType<typeof listUpcomingBookingsForUser>>,
  userId: string,
  now: Date,
): UpcomingBooking[] {
  return rows.map((b) => {
    const role = b.bookedByUserId === userId ? 'BOOKER' : 'PARTICIPANT';
    const cutoff = b.resource.venue.cancellationCutoffHours;
    const cure =
      role === 'BOOKER'
        ? playerMayCancel(b.startTs, cutoff, now)
          ? 'cancel'
          : 'wait'
        : b.startTs.getTime() > now.getTime()
          ? 'leave'
          : 'wait';
    return {
      bookingId: b.id,
      venueName: b.resource.venue.name,
      courtName: b.resource.name,
      resourceType: b.resource.resourceType,
      timezone: b.resource.venue.timezone,
      startTs: b.startTs,
      endTs: b.endTs,
      role,
      cure,
      cancellableUntil: playerCancellableUntil(b.startTs, cutoff),
      deletableFrom: b.endTs,
    };
  });
}

/** Whether the account holds a club role: a CLUB account, or an undecided one from p37. */
async function runsAClub(db: PrismaClient, userId: string, kind: string | null): Promise<boolean> {
  if (kind === 'CLUB') return true;
  const roles = await db.tenantMembership.count({
    where: { userId, status: 'ACTIVE', role: { in: [...CLUB_ROLES] } },
  });
  return roles > 0;
}

async function upcoming(db: PrismaClient, userId: string, now: Date) {
  const rows = await listUpcomingBookingsForUser(db, { userId, now, take: UPCOMING_LISTED + 1 });
  // The rule counts every one; the list names the first UPCOMING_LISTED.
  const total =
    rows.length > UPCOMING_LISTED
      ? await db.booking.count({
          // guardrail-allow: cross-tenant — the person's own bookings, by their id.
          where: {
            OR: [{ bookedByUserId: userId }, { participants: { some: { userId } } }],
            status: { in: ['PENDING', 'CONFIRMED'] },
            endTs: { gt: now },
          },
        })
      : rows.length;
  return { bookings: describeUpcoming(rows.slice(0, UPCOMING_LISTED), userId, now), total };
}

/**
 * The person's positive credit at each club, by club name. The balance is the
 * sum of the ledger's deltas, as the club's players list reads it.
 */
async function creditAtClubs(db: PrismaClient, userId: string): Promise<ClubCredit[]> {
  // guardrail-allow: cross-tenant — the person's own credit, at every club.
  const sums = await db.creditLedgerEntry.groupBy({
    by: ['tenantId'],
    where: { userId },
    _sum: { deltaCents: true },
  });
  const positive = sums.filter((s) => (s._sum.deltaCents ?? 0) > 0);
  if (positive.length === 0) return [];
  // guardrail-allow: cross-tenant — the names of the clubs that hold it.
  const clubs = await db.venueOrg.findMany({
    where: { id: { in: positive.map((s) => s.tenantId) } },
    select: { id: true, name: true },
    take: positive.length,
  });
  const names = new Map(clubs.map((c) => [c.id, c.name]));
  return positive
    .map((s) => ({
      tenantId: s.tenantId,
      club: names.get(s.tenantId) ?? '',
      balanceCents: s._sum.deltaCents ?? 0,
    }))
    .sort((a, b) => a.club.localeCompare(b.club, 'bg'));
}

/**
 * May this account delete itself now, and if not, why: what the profile page
 * draws. Read-only. `deleteAccount` decides again, under the row lock.
 *
 * Credit never blocks it: it is listed, so the person is told what they lose.
 */
export async function deletionStanding(
  db: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<DeletionStanding> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { accountKind: true, deletedAt: true },
  });
  if (!user || user.deletedAt) throw new AccountNotFoundForDeletionError();
  if (await runsAClub(db, userId, user.accountKind)) return { kind: 'club' };
  const { bookings, total } = await upcoming(db, userId, now);
  const credit = await creditAtClubs(db, userId);
  return total > 0 ? { kind: 'blocked', bookings, total, credit } : { kind: 'allowed', credit };
}

/** `deletionStanding` for the signed-in person, bound as the deletion is. */
export async function readMyDeletionStanding(userId: string): Promise<DeletionStanding> {
  return runAsSuperuser((db) => deletionStanding(db, userId));
}

/**
 * Delete the account, inside the caller's transaction (bound to
 * app_superuser): every rule checked, then every table, then the tombstone.
 *
 * Throws, writing nothing, for a club account
 * (`ClubAccountDeletionRefusedError`), an account with an upcoming booking
 * (`UpcomingBookingsError`) or one that does not exist or is already deleted
 * (`AccountNotFoundForDeletionError`).
 */
export async function deleteAccount(
  db: PrismaClient,
  input: { userId: string; by: 'self' | 'operator'; now?: Date },
): Promise<DeletionSummary> {
  const { userId } = input;
  const now = input.now ?? new Date();
  const summary: DeletionSummary = {};
  const count = (key: string, n: number) => {
    if (n > 0) summary[key] = (summary[key] ?? 0) + n;
  };

  // ═══ 1. LOCK THE PERSON, THEN DECIDE ═══
  //
  // FOR UPDATE on the app_user row, before anything is read: every writer of a
  // booking, a place on one, a series or a membership takes FOR KEY SHARE on
  // the same row (P52's `account_not_deleted`), so none can slip a booking in
  // between the check below and the commit.
  const [locked] = await db.$queryRaw<
    Array<{ id: string; email: string; accountKind: string | null; deletedAt: Date | null }>
  >`SELECT id, email, "accountKind"::text AS "accountKind", "deletedAt"
      FROM app_user WHERE id = ${userId} FOR UPDATE`;
  if (!locked || locked.deletedAt) throw new AccountNotFoundForDeletionError();

  if (await runsAClub(db, userId, locked.accountKind)) throw new ClubAccountDeletionRefusedError();

  const pending = await upcoming(db, userId, now);
  if (pending.total > 0) throw new UpcomingBookingsError(pending.bookings, pending.total);

  // ═══ 2. PLATFORM AUTHORITY ENDS WITH THE ACCOUNT ═══
  //
  // A grant row is never deleted (P31's trigger refuses it), so a live one is
  // revoked: the only change its trigger admits.
  count(
    'PlatformAdminGrant.revoked',
    // guardrail-allow: cross-tenant — the person's own grant; it names no club.
    (
      await db.platformAdminGrant.updateMany({
        where: { userId, revokedAt: null },
        data: {
          revokedAt: now,
          revokedByUserId: userId,
          revokeReason: input.by === 'self' ? REVOKE_REASON : REVOKE_REASON_OPERATOR,
        },
      })
    ).count,
  );

  // ═══ 3. SIGNING IN: EVERY SESSION, EVERY CREDENTIAL ═══
  //
  // guardrail-allow: cross-tenant — the person's own sessions and credentials,
  // by their id; a session row's tenant is only the club it last addressed.
  count('UserSession', (await db.userSession.deleteMany({ where: { userId } })).count);
  count(
    // guardrail-allow: cross-tenant — the person's own reset tokens.
    'PasswordResetToken',
    (await db.passwordResetToken.deleteMany({ where: { userId } })).count,
  );
  count(
    // guardrail-allow: cross-tenant — the person's own recovery codes.
    'MfaRecoveryCode',
    (await db.mfaRecoveryCode.deleteMany({ where: { userId } })).count,
  );

  // The security log's addresses go last, after the tombstone (step 10): P52's
  // trigger admits that one update only for an account already deleted.

  // ═══ 4. THE PERSON'S OWN DATA ═══
  count('PlayerProfile', (await db.playerProfile.deleteMany({ where: { userId } })).count);
  count('PlayerSportLevel', (await db.playerSportLevel.deleteMany({ where: { userId } })).count);
  count('DeviceToken', (await db.deviceToken.deleteMany({ where: { userId } })).count);
  count(
    // guardrail-allow: cross-tenant — the person's own browsers, by their id.
    'PushSubscription',
    (await db.pushSubscription.deleteMany({ where: { userId } })).count,
  );
  count(
    // guardrail-allow: cross-tenant — the person's own email, by their id.
    'EmailOutbox',
    (await db.emailOutbox.deleteMany({ where: { userId } })).count,
  );

  // Other people's bell rows that name this person (#358, #416). Their copy
  // carries the name:
  //
  //   joined, left    to the booker, naming the player: "{name} напусна играта"
  //   added, removed  to the player, naming the booker: "{name} ви добави в игра"
  //
  // A joined or left row is keyed `booking:<bookingId>:<event>:<placeId>`
  // (booking-notifications.ts). The place is often gone by now: leaving and
  // being removed delete it, and the profile page tells a blocked player to
  // leave their games first. So the person's places are read from the club's
  // audit log as well, which keeps them: a place they joined by link or left
  // (they are the actor), or one the booker took them off (`removedUserId`).
  // Every row names its booking, which is how the bell rows are found.
  count(
    'Notification.namingTheAccount',
    await db.$executeRaw`
      WITH places AS (
        SELECT p.id AS place, p."bookingId" AS booking
          FROM booking_participant p
         WHERE p."userId" = ${userId}
        UNION
        SELECT a."entityId", a."detailsJson" ->> 'bookingId'
          FROM audit_entry a
         WHERE a.entity = 'BookingParticipant'
           AND (
             (a.action IN ('BOOKING_PLAYER_JOINED', 'BOOKING_PLAYER_LEFT')
               AND a."actorUserId" = ${userId})
             OR (a.action = 'BOOKING_PLAYER_REMOVED'
               AND a."detailsJson" ->> 'removedUserId' = ${userId})
           )
      )
      DELETE FROM notification n
       USING places
       WHERE n."userId" <> ${userId}
         AND n."refType" = 'booking'
         AND n."refId" = places.booking
         AND n.kind IN ('BOOKING_PLAYER_JOINED', 'BOOKING_PLAYER_LEFT')
         AND split_part(n."dedupeKey", ':', 4) = places.place`,
  );
  // The booker's side: every added or removed row on a booking they made.
  count(
    'Notification.namingTheAccount',
    await db.$executeRaw`
      DELETE FROM notification n
       WHERE n."userId" <> ${userId}
         AND n."refType" = 'booking'
         AND n.kind IN ('BOOKING_PLAYER_ADDED', 'BOOKING_PLAYER_REMOVED')
         AND n."refId" IN (SELECT id FROM booking WHERE "bookedByUserId" = ${userId})`,
  );
  count(
    // guardrail-allow: cross-tenant — the person's own bell, by their id.
    'Notification',
    (await db.notification.deleteMany({ where: { userId } })).count,
  );

  // ═══ 5. CLUBS ═══
  //
  // First the no-show standing, while the clubs' lifted blocks are still
  // there to read: what still counts at each club waits for the next account
  // made with this address (P53, owner decision: "carry the no-show block
  // over"). Nothing is kept when nothing counts.
  count('NoShowCarry', await carryNoShowStanding(db, { userId, email: locked.email, now }));
  count('TenantMembership', (await db.tenantMembership.deleteMany({ where: { userId } })).count);
  count(
    'TenantMembership.invitedBy',
    (
      await db.tenantMembership.updateMany({
        where: { invitedById: userId },
        data: { invitedById: null },
      })
    ).count,
  );
  count(
    'Invite',
    // guardrail-allow: cross-tenant — invitations addressed to this person, at any club.
    // In any case: a club types the address, and MARIA@ is still Maria.
    (
      await db.invite.deleteMany({
        where: { email: { equals: locked.email, mode: 'insensitive' } },
      })
    ).count,
  );
  count(
    'Invite.invitedBy',
    // guardrail-allow: cross-tenant — invitations this person sent, at any club.
    (await db.invite.updateMany({ where: { invitedById: userId }, data: { invitedById: null } }))
      .count,
  );
  count(
    'ApiKey.createdBy',
    // guardrail-allow: cross-tenant — keys this person made, at any club.
    (
      await db.apiKey.updateMany({
        where: { createdByUserId: userId },
        data: { createdByUserId: null },
      })
    ).count,
  );
  count(
    'PlayerVenueRelationship',
    // guardrail-allow: cross-tenant — every club's notes on this person, by their id.
    (await db.playerVenueRelationship.deleteMany({ where: { playerUserId: userId } })).count,
  );
  count(
    'PlayerVenueRelationship.clearedBy',
    // guardrail-allow: cross-tenant — blocks this person lifted as staff, at any club.
    (
      await db.playerVenueRelationship.updateMany({
        where: { noShowBlockClearedByUserId: userId },
        data: { noShowBlockClearedByUserId: null },
      })
    ).count,
  );

  // ═══ 6. BOOKINGS STAY; WHAT NAMES THE PERSON ON THEM GOES ═══
  count(
    'Booking.scrubbed',
    // guardrail-allow: cross-tenant — the bookings this person booked, at every club.
    (
      await db.booking.updateMany({
        where: {
          bookedByUserId: userId,
          OR: [
            { guestName: { not: null } },
            { guestPhone: { not: null } },
            { guestEmail: { not: null } },
            { notes: { not: null } },
          ],
        },
        data: { guestName: null, guestPhone: null, guestEmail: null, notes: null },
      })
    ).count,
  );
  count(
    'Booking.cancellationReason',
    await db.$executeRaw`
      UPDATE booking
         SET "cancellationReasonJson" = jsonb_set("cancellationReasonJson", '{reason}', 'null'::jsonb)
       WHERE "bookedByUserId" = ${userId}
         AND "cancellationReasonJson" ->> 'reason' IS NOT NULL`,
  );
  count(
    'BookingSeries.scrubbed',
    // guardrail-allow: cross-tenant — the series linked to this person, at every club.
    (
      await db.bookingSeries.updateMany({
        where: { customerUserId: userId },
        data: { customerName: '', customerPhone: '', notes: null },
      })
    ).count,
  );
  count(
    'BookingInviteLink',
    // guardrail-allow: cross-tenant — the links this person made, at every club.
    (await db.bookingInviteLink.deleteMany({ where: { createdByUserId: userId } })).count,
  );
  count(
    'BookingInviteLink.revokedBy',
    // guardrail-allow: cross-tenant — links this person stopped, at every club.
    (
      await db.bookingInviteLink.updateMany({
        where: { revokedByUserId: userId },
        data: { revokedByUserId: null },
      })
    ).count,
  );
  count(
    'BookingSplit.inviteEmail',
    // guardrail-allow: cross-tenant — this person's shares, at every club.
    (
      await db.bookingSplit.updateMany({
        where: { userId, inviteEmail: { not: null } },
        data: { inviteEmail: null },
      })
    ).count,
  );

  // ═══ 7. REVIEWS: DELETED, AND EVERY RATING THEY MOVED RECOMPUTED ═══
  // guardrail-allow: cross-tenant — this person's reviews, at every club.
  const reviews = await db.review.findMany({
    where: { authorUserId: userId },
    select: { tenantId: true, venueId: true },
    take: 10_000,
  });
  // guardrail-allow: cross-tenant — the same rows, by their author.
  count('Review', (await db.review.deleteMany({ where: { authorUserId: userId } })).count);
  const venues = new Map(reviews.map((r) => [r.venueId, r.tenantId]));
  for (const [venueId, tenantId] of venues) {
    // One per venue the person reviewed, and a person reviews a venue once:
    // bounded by their own reviews, in the transaction that deleted them.
    await recomputeVenueRating(db, { tenantId, venueId }); // guardrail-allow: n-plus-one
  }
  count(
    'ModerationCase.reportedBy',
    // guardrail-allow: cross-tenant — cases this person reported.
    (
      await db.moderationCase.updateMany({
        where: { reportedByUserId: userId },
        data: { reportedByUserId: null },
      })
    ).count,
  );
  count(
    'ContentReport',
    // guardrail-allow: cross-tenant — this person's own reports.
    (await db.contentReport.deleteMany({ where: { reporterUserId: userId } })).count,
  );

  // ═══ 8. THE MODULES NOT BUILT YET ═══
  //
  // No route writes these today. Decided anyway, so the day one does, a
  // deletion already does the right thing (deletion-plan.ts).
  // guardrail-allow: cross-tenant — this person's coach profiles, at every club.
  const coaches = await db.coach.findMany({ where: { userId }, select: { id: true }, take: 500 });
  count(
    'CoachReview',
    // guardrail-allow: cross-tenant — reviews by this person, and of their coach profiles.
    (
      await db.coachReview.deleteMany({
        where: { OR: [{ authorUserId: userId }, { coachId: { in: coaches.map((c) => c.id) } }] },
      })
    ).count,
  );
  count(
    'Coach.closed',
    // guardrail-allow: cross-tenant — this person's coach profiles, at every club.
    (
      await db.coach.updateMany({
        where: { userId },
        data: { bio: null, certificationsJson: [], status: 'CLOSED' },
      })
    ).count,
  );
  count(
    'CoachBooking.notes',
    // guardrail-allow: cross-tenant — this person's coach bookings, at every club.
    (
      await db.coachBooking.updateMany({
        where: { playerUserId: userId, notes: { not: null } },
        data: { notes: null },
      })
    ).count,
  );
  count('XpEvent', (await db.xpEvent.deleteMany({ where: { userId } })).count); // guardrail-allow: cross-tenant — the person's own points
  count('UserAchievement', (await db.userAchievement.deleteMany({ where: { userId } })).count);
  count(
    'SkillRatingHistory',
    (await db.skillRatingHistory.deleteMany({ where: { userId } })).count,
  );
  count(
    'SessionParticipant',
    (await db.sessionParticipant.deleteMany({ where: { userId } })).count,
  );
  count(
    'SessionChatMessage',
    // guardrail-allow: cross-tenant — this person's own messages.
    (await db.sessionChatMessage.deleteMany({ where: { senderUserId: userId } })).count,
  );
  count(
    'ConversationParticipant.left',
    (
      await db.conversationParticipant.updateMany({
        where: { userId, leftAt: null },
        data: { leftAt: now },
      })
    ).count,
  );
  await db.chatMessage.updateMany({
    where: { senderId: userId, deletedAt: null },
    data: { deletedAt: now },
  });
  count(
    'ChatMessage.emptied',
    (
      await db.chatMessage.updateMany({
        where: { senderId: userId },
        data: { body: '', attachmentsJson: Prisma.DbNull },
      })
    ).count,
  );
  count(
    'UserBlock',
    (
      await db.userBlock.deleteMany({
        where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      })
    ).count,
  );
  count(
    'WearableConnection',
    // guardrail-allow: cross-tenant — the person's own links.
    (await db.wearableConnection.deleteMany({ where: { userId } })).count,
  );
  count(
    'Activity',
    // guardrail-allow: cross-tenant — the person's own runs and rides.
    (await db.activity.deleteMany({ where: { userId } })).count,
  );

  // ═══ 9. THE TOMBSTONE ═══
  //
  // ONE update. P52's CHECK refuses a deleted row with anything personal left
  // on it, and its trigger refuses ever clearing `deletedAt` again.
  // `sessionVersion` moves too, so a token minted before this, by an instance
  // that never wrote a session row, is stale as well.
  await db.user.update({
    where: { id: userId },
    data: {
      email: tombstoneEmail(userId),
      name: null,
      phone: null,
      avatarUrl: null,
      passwordHash: null,
      emailVerified: null,
      mfaSecret: null,
      mfaEnabledAt: null,
      mfaLastUsedStep: null,
      emailBookingConfirmations: false,
      emailBookingReminders: false,
      emailClubChanges: false,
      locale: DEFAULT_LOCALE,
      sessionVersion: { increment: 1 },
      deletedAt: now,
    },
  });
  summary.User = 1;

  // ═══ 10. THE SECURITY LOG KEEPS THE EVENT AND LOSES THE ADDRESS ═══
  //
  // P52's trigger admits this one update, for this one account, under this
  // setting, and only once the account is a tombstone: step 9 first.
  await db.$executeRawUnsafe(`SELECT set_config('app.erasure_user_id', $1, true)`, userId);
  count(
    'AccountSecurityEvent.erased',
    // guardrail-allow: cross-tenant — the person's own security log; it names no club.
    (
      await db.accountSecurityEvent.updateMany({
        where: { userId, OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }] },
        data: { ipAddress: null, userAgent: null },
      })
    ).count,
  );

  return summary;
}

/**
 * The profile picture's copy (#458), after the deletion has committed: every
 * object under the account's `avatars/{userId}/`. Storage is not part of the
 * transaction, so it goes once the rows are gone, and a failure here does not
 * undo a deletion: it is logged, and the daily media sweep deletes a copy that
 * a deleted account still has. Returns how many objects went.
 */
export async function purgeAccountMedia(userId: string): Promise<number> {
  const storage = getMediaStorage();
  if (!storage) return 0;
  try {
    return await purgeAvatarObjects(storage, userId);
  } catch (error) {
    logger.error('account deletion: the profile picture was not deleted from storage', {
      component: 'account',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return 0;
  }
}

/**
 * The signed-in person deletes their own account: `DELETE /api/v1/me`. Every
 * statement in one transaction; on any throw, nothing changed. Then the
 * picture's copy (`purgeAccountMedia`).
 */
export async function deleteMyAccount(userId: string): Promise<DeletionSummary> {
  const summary = await runAsSuperuser((db) => deleteAccount(db, { userId, by: 'self' }));
  const pictures = await purgeAccountMedia(userId);
  if (pictures > 0) summary['media.avatars'] = pictures;
  return summary;
}
