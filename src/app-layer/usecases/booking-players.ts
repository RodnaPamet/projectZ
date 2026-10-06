import { randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { readBookingPlayers, type BookingPlayer } from '@/app-layer/repositories/booking';
import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { isUniqueViolation } from '@/lib/db/pg-errors';
import { runAsSuperuser, runInTenantContext } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';
import { hashForLookup } from '@/lib/security/encryption';

/**
 * Players on a booking (#358, Q29): the booker adds people up to the court's
 * capacity, by a shareable link or by picking somebody they have played with
 * before. Added players see the booking in their Резервации, may leave it, and
 * are who ranking (#378) asks for scores and open play (#376) counts spots
 * against. Payment stays at the club: nobody splits anything in the app.
 *
 * ═══ THE MODEL ═══
 *
 *   position 1           the booker, `booking.bookedByUserId`. NOT a row.
 *   positions 2..cap     `booking_participant` rows, one per added player.
 *   capacity             `court.capacity` (Resource), 4 by default.
 *
 * The booker is not a row because every booking made before #358 has a booker
 * and no rows, and "the booker is bookedByUserId" stays true for all of them
 * with no backfill. `bookingPlayerIds` is the one place that answers "who
 * plays this booking?" for the modules that will ask.
 *
 * ═══ TWO PHASES, AND WHY ONE OF THEM IS SUPERUSER ═══
 *
 * `booking`, `booking_participant` and `booking_invite_link` are tenant-scoped
 * under RLS, and both questions this file starts from span clubs:
 *
 *   - "which club is this booking at?" for a booking the caller is ON, which
 *     may be at any club, and the token does not carry the list of them;
 *   - "which booking is this link for?" from a token, before any club is known
 *     (the staff invite page's chicken-and-egg).
 *
 * So the FIRST phase is one BYPASSRLS read, scoped by the session's user id
 * (a booking they booked or are on) or by `hashForLookup(token)` (a secret the
 * visitor supplied, which cannot enumerate). It returns a tenant id and
 * nothing else. The SECOND phase, every write and every re-check, runs bound
 * to that tenant through `runInTenantContext`, so RLS holds the writes, and
 * re-reads the booking under a row lock: nothing decided in phase one is
 * trusted in phase two.
 *
 * The cross-club reads that are reads only (the invite preview, recent
 * co-players) stay in phase one, scoped the same way.
 *
 * ═══ THE CAPACITY RACE ═══
 *
 * Two people opening the same link for the last spot must not both get it.
 * Every write that adds a player first takes `SELECT … FOR UPDATE` on the
 * booking row, so adds to one booking are serialised: the second waits, then
 * counts the first. Underneath, `@@unique([bookingId, position])` and
 * `@@unique([bookingId, userId])` (P45) refuse what a missed lock would let
 * through, and the use case answers those as "full" and "already on it".
 */

/** How many unrevoked, unexpired links a booking may hold at once. */
export const MAX_LIVE_INVITE_LINKS = 10;

/** How many recent co-players are offered. */
export const CO_PLAYERS_LIMIT = 20;

/** How many of the caller's own recent bookings are searched for co-players. */
const CO_PLAYER_BOOKINGS_SCANNED = 50;

/** 32 random bytes, base64url: 43 characters. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// ─── Errors ─────────────────────────────────────────────────────────────

/**
 * Expired, revoked, never existed, or the booking is cancelled or has started:
 * one answer for all of them, as staff invites do, so live tokens cannot be
 * told apart from dead ones by probing.
 */
export class BookingInviteNotUsableError extends Error {
  constructor() {
    super(
      'That invite link is not usable: it expired at the start of the game, was stopped by ' +
        'the booker, or the booking was cancelled. The cases are deliberately indistinguishable.',
    );
    this.name = 'BookingInviteNotUsableError';
  }
}

/** Every position up to the court's capacity is taken. */
export class BookingFullError extends Error {
  constructor(capacity: number) {
    super(`The booking is full: the court takes ${capacity} players, and every place is taken.`);
    this.name = 'BookingFullError';
  }
}

/** Cancelled, completed, or already started: its players can no longer change. */
export class BookingPlayersClosedError extends Error {
  constructor() {
    super(
      'The players on this booking can no longer change: it has started, ended or been cancelled.',
    );
    this.name = 'BookingPlayersClosedError';
  }
}

/** The caller is on the booking but is not its booker. */
export class BookerOnlyError extends Error {
  constructor() {
    super('Only the person who booked the court can invite or remove players.');
    this.name = 'BookerOnlyError';
  }
}

export class TooManyInviteLinksError extends Error {
  constructor() {
    super(
      `A booking holds at most ${MAX_LIVE_INVITE_LINKS} live invite links. Stop the old ones ` +
        'before making another.',
    );
    this.name = 'TooManyInviteLinksError';
  }
}

/**
 * Joining a game needs a PLAYER account (#263): a club or coach account plays
 * with a separate one. About the caller's own account, never the booking.
 */
export class BookingNeedsPlayerAccountError extends Error {
  constructor() {
    super(
      'Only a player account can join a game. A club or coach account plays with a separate one.',
    );
    this.name = 'BookingNeedsPlayerAccountError';
  }
}

/**
 * The account has not chosen yet whether it is a player or a coach (#360). The
 * client sends it to the chooser, then back to the link.
 */
export class AccountKindRequiredError extends Error {
  constructor() {
    super('Choose whether this account is a player or a coach first.');
    this.name = 'AccountKindRequiredError';
  }
}

/** A participant id that is not on this booking, or a co-player who is not one. */
export class BookingPlayerNotFoundError extends Error {
  constructor() {
    super('No such player on this booking, or among the people you have played with.');
    this.name = 'BookingPlayerNotFoundError';
  }
}

// ─── The notification hook (#367) ───────────────────────────────────────

/** Something that changed who is playing. */
export type BookingPlayersEvent =
  | { type: 'joined'; tenantId: string; bookingId: string; userId: string; via: 'link' | 'booker' }
  | { type: 'left'; tenantId: string; bookingId: string; userId: string }
  | { type: 'removed'; tenantId: string; bookingId: string; userId: string; byUserId: string };

/**
 * ═══ #367 PLUGS IN HERE ═══
 *
 * Called after the transaction that made the change has COMMITTED, never
 * inside it, so a failing mail server cannot undo a join, and a rolled-back
 * join never sends "you are in". Notifications (email + bell) are #367; until
 * it lands this records the event and nothing else. It carries ids only, never
 * a token or a name.
 */
export async function onBookingPlayersChanged(event: BookingPlayersEvent): Promise<void> {
  logger.info('booking players changed', {
    component: 'booking-players',
    event: event.type,
    bookingId: event.bookingId,
  });
}

// ─── Phase one: which club ──────────────────────────────────────────────

type ViewerRole = 'BOOKER' | 'PARTICIPANT';

interface Located {
  tenantId: string;
  role: ViewerRole;
}

/**
 * The club of a booking the caller booked or is on, and which of the two.
 * Null for anything else, which every caller answers 404: somebody else's
 * booking and one that never existed look the same, so ids cannot be probed.
 */
async function locate(userId: string, bookingId: string): Promise<Located | null> {
  // guardrail-allow: cross-tenant — a booking the caller booked or is on, at
  // whichever club; both filters are the session's user id.
  const row = await runAsSuperuser((db) =>
    db.booking.findFirst({
      where: {
        id: bookingId,
        OR: [{ bookedByUserId: userId }, { participants: { some: { userId } } }],
      },
      select: { tenantId: true, bookedByUserId: true },
    }),
  );
  if (!row) return null;
  return { tenantId: row.tenantId, role: row.bookedByUserId === userId ? 'BOOKER' : 'PARTICIPANT' };
}

async function locateAsBooker(userId: string, bookingId: string): Promise<string> {
  const at = await locate(userId, bookingId);
  if (!at) throw new BookingNotFoundForPlayersError();
  if (at.role !== 'BOOKER') throw new BookerOnlyError();
  return at.tenantId;
}

/** Not the caller's booking, or no such booking. The route's 404. */
export class BookingNotFoundForPlayersError extends Error {
  constructor() {
    super('Booking not found');
    this.name = 'BookingNotFoundForPlayersError';
  }
}

// ─── Phase two: the locked booking ──────────────────────────────────────

interface LockedBooking {
  id: string;
  tenantId: string;
  status: string;
  startTs: Date;
  bookedByUserId: string | null;
  capacity: number;
  participants: Array<{ id: string; userId: string | null; position: number }>;
}

/**
 * The booking, re-read under a row lock inside the tenant binding. Every
 * write that changes who plays goes through here first, so two of them on the
 * same booking run one after the other (see the capacity race above).
 */
async function lockBooking(
  tx: PrismaClient,
  tenantId: string,
  bookingId: string,
): Promise<LockedBooking | null> {
  // Parameterised; ids are never concatenated into SQL. RLS applies to the
  // lock as to any read, so a booking at another club locks nothing.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "booking" WHERE id = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE
  `;
  if (locked.length === 0) return null;

  const b = await tx.booking.findFirst({
    where: { id: bookingId, tenantId },
    select: {
      id: true,
      tenantId: true,
      status: true,
      startTs: true,
      bookedByUserId: true,
      resource: { select: { capacity: true } },
      participants: {
        select: { id: true, userId: true, position: true },
        orderBy: { position: 'asc' },
      },
    },
  });
  if (!b) return null;
  return {
    id: b.id,
    tenantId: b.tenantId,
    status: b.status,
    startTs: b.startTs,
    bookedByUserId: b.bookedByUserId,
    capacity: b.resource.capacity,
    participants: b.participants,
  };
}

/** PENDING or CONFIRMED, and not started: the only time its players may change. */
function isOpenForPlayers(b: { status: string; startTs: Date }, now: Date): boolean {
  return (
    (b.status === 'PENDING' || b.status === 'CONFIRMED') && b.startTs.getTime() > now.getTime()
  );
}

/** The lowest free position from 2 up, or null when the court is full. */
function freePosition(b: Pick<LockedBooking, 'participants' | 'capacity'>): number | null {
  const taken = new Set(b.participants.map((p) => p.position));
  for (let p = 2; p <= b.capacity; p++) if (!taken.has(p)) return p;
  return null;
}

async function requirePlayerAccount(db: PrismaClient, userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { accountKind: true } });
  const kind = user?.accountKind ?? null;
  if (kind === null) throw new AccountKindRequiredError();
  if (kind !== 'PLAYER') throw new BookingNeedsPlayerAccountError();
}

/**
 * Add `userId` at the lowest free position, inside a tenant transaction that
 * already holds the booking's lock. The unique indexes are the backstop.
 */
async function insertParticipant(
  tx: PrismaClient,
  b: LockedBooking,
  userId: string,
): Promise<{ joined: boolean; participantId: string | null }> {
  if (b.bookedByUserId === userId) return { joined: false, participantId: null };
  const mine = b.participants.find((p) => p.userId === userId);
  if (mine) return { joined: false, participantId: mine.id };

  const position = freePosition(b);
  if (position === null) throw new BookingFullError(b.capacity);

  try {
    const row = await tx.bookingParticipant.create({
      data: { tenantId: b.tenantId, bookingId: b.id, userId, position },
      select: { id: true },
    });
    return { joined: true, participantId: row.id };
  } catch (err) {
    // Unreachable while the lock holds; if it ever does not, the index answers.
    if (isUniqueViolation(err)) throw new BookingFullError(b.capacity);
    throw err;
  }
}

// ─── Reading the players ────────────────────────────────────────────────

/** Who plays a booking, as ids: the booker first, then each added player by position. */
export function bookingPlayerIds(b: {
  bookedByUserId: string | null;
  participants: ReadonlyArray<{ userId: string | null; position: number }>;
}): string[] {
  const rows = [...b.participants].sort((x, y) => x.position - y.position);
  return [
    ...(b.bookedByUserId ? [b.bookedByUserId] : []),
    ...rows.flatMap((p) => (p.userId && p.userId !== b.bookedByUserId ? [p.userId] : [])),
  ];
}

export interface BookingPlayers {
  /** The caller's relation to the booking. */
  viewerRole: ViewerRole;
  capacity: number;
  /** Places left for added players. 0 when full. */
  spotsLeft: number;
  /** Whether players can be added, left or removed now (open, not started). */
  open: boolean;
  /** Live invite links, for the booker; null for a participant, who cannot see them. */
  liveInviteLinks: number | null;
  players: BookingPlayer[];
}

/**
 * The people on a booking, for anyone ON it: names and avatars, never an
 * email, phone or user id. Null for anyone else (the route's 404), so a
 * stranger holding a booking id learns nothing, not even that it exists.
 */
export async function listBookingPlayers(input: {
  userId: string;
  bookingId: string;
  now?: Date;
}): Promise<BookingPlayers | null> {
  const at = await locate(input.userId, input.bookingId);
  if (!at) return null;
  const now = input.now ?? new Date();

  return runInTenantContext(at.tenantId, async (tx) => {
    const b = await tx.booking.findFirst({
      where: { id: input.bookingId, tenantId: at.tenantId },
      select: {
        status: true,
        startTs: true,
        bookedByUserId: true,
        resource: { select: { capacity: true } },
        participants: {
          select: { id: true, userId: true, guestName: true, position: true },
          orderBy: { position: 'asc' },
        },
      },
    });
    if (!b) return null;

    const [players, liveLinks] = await Promise.all([
      readBookingPlayers(tx, b, input.userId),
      at.role === 'BOOKER'
        ? tx.bookingInviteLink.count({
            where: {
              tenantId: at.tenantId,
              bookingId: input.bookingId,
              revokedAt: null,
              expiresAt: { gt: now },
            },
          })
        : Promise.resolve(null),
    ]);

    return {
      viewerRole: at.role,
      capacity: b.resource.capacity,
      spotsLeft: Math.max(0, b.resource.capacity - 1 - b.participants.length),
      open: isOpenForPlayers(b, now),
      liveInviteLinks: liveLinks,
      players,
    };
  });
}

// ─── Invite links ───────────────────────────────────────────────────────

export interface CreatedInviteLink {
  id: string;
  /** The plaintext token. Returned once, here, and never stored. */
  token: string;
  expiresAt: Date;
}

/**
 * A new link for the booker to share. Valid until the booking starts, unless
 * revoked. The token is returned to the caller and only its HMAC is stored.
 *
 * Several links may be live, so sharing again does not break one already sent
 * to a group chat; `MAX_LIVE_INVITE_LINKS` bounds them. A full booking still
 * gets a link (somebody may leave), and the link says "full" when opened.
 */
export async function createBookingInviteLink(input: {
  userId: string;
  bookingId: string;
  now?: Date;
}): Promise<CreatedInviteLink> {
  const tenantId = await locateAsBooker(input.userId, input.bookingId);
  const now = input.now ?? new Date();

  return runInTenantContext(tenantId, async (tx) => {
    const b = await lockBooking(tx, tenantId, input.bookingId);
    if (!b || b.bookedByUserId !== input.userId) throw new BookingNotFoundForPlayersError();
    if (!isOpenForPlayers(b, now)) throw new BookingPlayersClosedError();
    if (b.capacity < 2) throw new BookingFullError(b.capacity);

    const live = await tx.bookingInviteLink.count({
      where: { tenantId, bookingId: b.id, revokedAt: null, expiresAt: { gt: now } },
    });
    if (live >= MAX_LIVE_INVITE_LINKS) throw new TooManyInviteLinksError();

    const token = randomBytes(32).toString('base64url');
    const link = await tx.bookingInviteLink.create({
      data: {
        tenantId,
        bookingId: b.id,
        tokenHash: hashForLookup(token),
        createdByUserId: input.userId,
        expiresAt: b.startTs,
      },
      select: { id: true, expiresAt: true },
    });

    await appendAuditEntry(tx, {
      tenantId,
      actorUserId: input.userId,
      entity: 'BookingInviteLink',
      entityId: link.id,
      action: AUDIT_ACTIONS.BOOKING_INVITE_LINK_CREATED,
      details: `Invite link for booking ${b.id}`,
      // The token is NOT recorded: an audit row is readable by club staff, and
      // a working link in it would let them add anybody.
      detailsJson: {
        category: 'booking',
        bookingId: b.id,
        expiresAt: link.expiresAt.toISOString(),
      },
    });

    return { id: link.id, token, expiresAt: link.expiresAt };
  });
}

/**
 * Stop links: one by id, or every live one on the booking. Audited, with the
 * count. Revoking an already-dead link is not an error; the answer is how many
 * this call stopped.
 */
export async function revokeBookingInviteLinks(input: {
  userId: string;
  bookingId: string;
  linkId?: string;
  now?: Date;
}): Promise<{ revoked: number }> {
  const tenantId = await locateAsBooker(input.userId, input.bookingId);
  const now = input.now ?? new Date();

  return runInTenantContext(tenantId, async (tx) => {
    if (input.linkId) {
      const exists = await tx.bookingInviteLink.findFirst({
        where: { id: input.linkId, tenantId, bookingId: input.bookingId },
        select: { id: true },
      });
      if (!exists) throw new BookingPlayerNotFoundError();
    }

    const { count } = await tx.bookingInviteLink.updateMany({
      where: {
        tenantId,
        bookingId: input.bookingId,
        revokedAt: null,
        ...(input.linkId ? { id: input.linkId } : {}),
      },
      data: { revokedAt: now, revokedByUserId: input.userId },
    });

    await appendAuditEntry(tx, {
      tenantId,
      actorUserId: input.userId,
      entity: input.linkId ? 'BookingInviteLink' : 'Booking',
      entityId: input.linkId ?? input.bookingId,
      action: AUDIT_ACTIONS.BOOKING_INVITE_LINK_REVOKED,
      details: `Stopped ${count} invite link(s) for booking ${input.bookingId}`,
      detailsJson: { category: 'booking', bookingId: input.bookingId, revoked: count },
    });

    return { revoked: count };
  });
}

/** What a link shows before anyone signs in: nothing private. */
export interface BookingInvitePreview {
  venueName: string;
  venueCity: string;
  sport: string;
  courtName: string;
  startTs: Date;
  endTs: Date;
  timezone: string;
  /** The booker's first name only, or null when they have not set one. */
  bookerFirstName: string | null;
  capacity: number;
  spotsLeft: number;
}

interface LiveLink {
  id: string;
  tenantId: string;
  bookingId: string;
}

/** The link behind a token, if it is live. Phase one: no club is known yet. */
async function findLiveLink(db: PrismaClient, token: string, now: Date): Promise<LiveLink | null> {
  if (!TOKEN_RE.test(token)) return null;
  // guardrail-allow: cross-tenant — by the HMAC of a secret the visitor
  // supplied, which cannot enumerate; this is how the club is discovered.
  const link = await db.bookingInviteLink.findUnique({
    where: { tokenHash: hashForLookup(token) },
    select: { id: true, tenantId: true, bookingId: true, expiresAt: true, revokedAt: true },
  });
  if (!link || link.revokedAt || link.expiresAt.getTime() <= now.getTime()) return null;
  return { id: link.id, tenantId: link.tenantId, bookingId: link.bookingId };
}

/** The booker's first name: the first word of their display name. */
export function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/**
 * What the invite page and `POST /booking-invites/preview` show: where, when,
 * what, and who invited you by first name. Null for every unusable token, and
 * for a booking that is cancelled or has started, which the page shows as one
 * "this link no longer works".
 */
export async function previewBookingInvite(
  token: string,
  now: Date = new Date(),
): Promise<BookingInvitePreview | null> {
  return runAsSuperuser(async (db) => {
    const link = await findLiveLink(db, token, now);
    if (!link) return null;

    const b = await db.booking.findFirst({
      where: { id: link.bookingId, tenantId: link.tenantId },
      select: {
        status: true,
        startTs: true,
        endTs: true,
        bookedByUserId: true,
        _count: { select: { participants: true } },
        resource: {
          select: {
            name: true,
            sport: true,
            capacity: true,
            venue: { select: { name: true, city: true, timezone: true } },
          },
        },
      },
    });
    if (!b || !isOpenForPlayers(b, now)) return null;

    const booker = b.bookedByUserId
      ? await db.user.findUnique({ where: { id: b.bookedByUserId }, select: { name: true } })
      : null;

    return {
      venueName: b.resource.venue.name,
      venueCity: b.resource.venue.city,
      sport: b.resource.sport,
      courtName: b.resource.name,
      startTs: b.startTs,
      endTs: b.endTs,
      timezone: b.resource.venue.timezone,
      bookerFirstName: firstName(booker?.name),
      capacity: b.resource.capacity,
      spotsLeft: Math.max(0, b.resource.capacity - 1 - b._count.participants),
    };
  });
}

/**
 * The signed-in caller joins the booking behind `token`.
 *
 * Adds the caller and nobody else, and only while there is room. Opening a
 * link for a booking you are already on (the booker included) is not an
 * error: `joined` is false and the booking id is returned, so the page can
 * take you to it. Rate-limited at the route.
 */
export async function acceptBookingInvite(input: {
  userId: string;
  token: string;
  now?: Date;
}): Promise<{ bookingId: string; joined: boolean }> {
  const now = input.now ?? new Date();

  const link = await runAsSuperuser((db) => findLiveLink(db, input.token, now));
  if (!link) throw new BookingInviteNotUsableError();

  const result = await runInTenantContext(link.tenantId, async (tx) => {
    // Re-read the link inside the binding: a revoke that committed between the
    // two phases wins.
    const still = await tx.bookingInviteLink.findFirst({
      where: { id: link.id, tenantId: link.tenantId, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });
    if (!still) throw new BookingInviteNotUsableError();

    const b = await lockBooking(tx, link.tenantId, link.bookingId);
    if (!b || !isOpenForPlayers(b, now)) throw new BookingInviteNotUsableError();

    // Already on it: say so before asking anything of the account.
    if (
      b.bookedByUserId === input.userId ||
      b.participants.some((p) => p.userId === input.userId)
    ) {
      return { joined: false };
    }
    await requirePlayerAccount(tx, input.userId);

    const added = await insertParticipant(tx, b, input.userId);

    if (added.joined && added.participantId) {
      await appendAuditEntry(tx, {
        tenantId: link.tenantId,
        actorUserId: input.userId,
        entity: 'BookingParticipant',
        entityId: added.participantId,
        action: AUDIT_ACTIONS.BOOKING_PLAYER_JOINED,
        details: `Joined booking ${b.id} by invite link`,
        detailsJson: { category: 'booking', bookingId: b.id, via: 'link', linkId: link.id },
      });
    }
    return { joined: added.joined };
  });

  if (result.joined) {
    await onBookingPlayersChanged({
      type: 'joined',
      tenantId: link.tenantId,
      bookingId: link.bookingId,
      userId: input.userId,
      via: 'link',
    });
  }
  return { bookingId: link.bookingId, joined: result.joined };
}

// ─── Leaving and removing ───────────────────────────────────────────────

/** The caller leaves a booking they were added to. The booker cancels instead. */
export async function leaveBooking(input: {
  userId: string;
  bookingId: string;
  now?: Date;
}): Promise<void> {
  const at = await locate(input.userId, input.bookingId);
  if (!at) throw new BookingNotFoundForPlayersError();
  // The booker is not a participant: leaving their own booking is cancelling
  // it, which has its own route, cutoff and audit.
  if (at.role === 'BOOKER') throw new BookerCannotLeaveError();
  const now = input.now ?? new Date();

  await runInTenantContext(at.tenantId, async (tx) => {
    const b = await lockBooking(tx, at.tenantId, input.bookingId);
    const mine = b?.participants.find((p) => p.userId === input.userId);
    if (!b || !mine) throw new BookingNotFoundForPlayersError();
    if (!isOpenForPlayers(b, now)) throw new BookingPlayersClosedError();

    await tx.bookingParticipant.deleteMany({ where: { id: mine.id, tenantId: at.tenantId } });
    await appendAuditEntry(tx, {
      tenantId: at.tenantId,
      actorUserId: input.userId,
      entity: 'BookingParticipant',
      entityId: mine.id,
      action: AUDIT_ACTIONS.BOOKING_PLAYER_LEFT,
      details: `Left booking ${b.id}`,
      detailsJson: { category: 'booking', bookingId: b.id, position: mine.position },
    });
  });

  await onBookingPlayersChanged({
    type: 'left',
    tenantId: at.tenantId,
    bookingId: input.bookingId,
    userId: input.userId,
  });
}

export class BookerCannotLeaveError extends Error {
  constructor() {
    super('The booker cannot leave their own booking; cancel it instead.');
    this.name = 'BookerCannotLeaveError';
  }
}

/** The booker takes a player off their booking. Audited. */
export async function removeBookingPlayer(input: {
  userId: string;
  bookingId: string;
  participantId: string;
  now?: Date;
}): Promise<void> {
  const tenantId = await locateAsBooker(input.userId, input.bookingId);
  const now = input.now ?? new Date();

  const removed = await runInTenantContext(tenantId, async (tx) => {
    const b = await lockBooking(tx, tenantId, input.bookingId);
    if (!b || b.bookedByUserId !== input.userId) throw new BookingNotFoundForPlayersError();
    const row = b.participants.find((p) => p.id === input.participantId);
    if (!row) throw new BookingPlayerNotFoundError();
    if (!isOpenForPlayers(b, now)) throw new BookingPlayersClosedError();

    await tx.bookingParticipant.deleteMany({ where: { id: row.id, tenantId } });
    await appendAuditEntry(tx, {
      tenantId,
      actorUserId: input.userId,
      entity: 'BookingParticipant',
      entityId: row.id,
      action: AUDIT_ACTIONS.BOOKING_PLAYER_REMOVED,
      details: `Removed a player from booking ${b.id}`,
      detailsJson: {
        category: 'booking',
        bookingId: b.id,
        removedUserId: row.userId,
        position: row.position,
      },
    });
    return row.userId;
  });

  if (removed) {
    await onBookingPlayersChanged({
      type: 'removed',
      tenantId,
      bookingId: input.bookingId,
      userId: removed,
      byUserId: input.userId,
    });
  }
}

// ─── Players you have played with ───────────────────────────────────────

export interface CoPlayer {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * The people the caller has shared a booking with, most recent first, that
 * are not on THIS booking already: the "add from players you know" list.
 *
 * Cross-club, scoped by the session's user id: their own recent bookings
 * (booked or joined), then the other people on those. PLAYER accounts only,
 * since nobody else can be added. Names and avatars only.
 */
export async function listCoPlayers(input: {
  userId: string;
  bookingId: string;
}): Promise<CoPlayer[]> {
  await locateAsBooker(input.userId, input.bookingId);
  return runAsSuperuser((db) => readCoPlayers(db, input.userId, input.bookingId));
}

async function readCoPlayers(
  db: PrismaClient,
  userId: string,
  excludeBookingId: string,
): Promise<CoPlayer[]> {
  // guardrail-allow: cross-tenant — the caller's own bookings, booked or
  // joined, by the session's user id; bounded.
  const bookings = await db.booking.findMany({
    where: { OR: [{ bookedByUserId: userId }, { participants: { some: { userId } } }] },
    select: {
      id: true,
      bookedByUserId: true,
      participants: { select: { userId: true, position: true } },
    },
    orderBy: [{ startTs: 'desc' }, { id: 'desc' }],
    take: CO_PLAYER_BOOKINGS_SCANNED,
  });

  const current = bookings.find((b) => b.id === excludeBookingId);
  const onThis = new Set(current ? bookingPlayerIds(current) : [userId]);
  onThis.add(userId);

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const b of bookings) {
    if (b.id === excludeBookingId) continue;
    for (const id of bookingPlayerIds(b)) {
      if (onThis.has(id) || seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
  }
  if (ordered.length === 0) return [];

  const users = await db.user.findMany({
    where: { id: { in: ordered }, accountKind: 'PLAYER' },
    select: { id: true, name: true, avatarUrl: true },
    take: ordered.length,
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  return ordered
    .flatMap((id) => {
      const u = byId.get(id);
      return u ? [{ userId: u.id, name: u.name, avatarUrl: u.avatarUrl }] : [];
    })
    .slice(0, CO_PLAYERS_LIMIT);
}

/**
 * The booker adds somebody they have played with. Only a co-player (see
 * `listCoPlayers`) can be added this way, so a user id from anywhere else is
 * refused as "not found": nobody can be put on a stranger's booking by id.
 */
export async function addCoPlayer(input: {
  userId: string;
  bookingId: string;
  playerUserId: string;
  now?: Date;
}): Promise<{ participantId: string | null; joined: boolean }> {
  const tenantId = await locateAsBooker(input.userId, input.bookingId);
  const now = input.now ?? new Date();

  const known = await runAsSuperuser((db) => readCoPlayers(db, input.userId, input.bookingId));
  // Already on this booking is not a co-player to offer, but adding them again
  // is a no-op rather than a 404, and the locked read below answers it.
  const isKnown = known.some((c) => c.userId === input.playerUserId);

  const result = await runInTenantContext(tenantId, async (tx) => {
    const b = await lockBooking(tx, tenantId, input.bookingId);
    if (!b || b.bookedByUserId !== input.userId) throw new BookingNotFoundForPlayersError();
    const already =
      b.bookedByUserId === input.playerUserId ||
      b.participants.some((p) => p.userId === input.playerUserId);
    if (already) {
      const row = b.participants.find((p) => p.userId === input.playerUserId);
      return { participantId: row?.id ?? null, joined: false };
    }
    if (!isKnown) throw new BookingPlayerNotFoundError();
    if (!isOpenForPlayers(b, now)) throw new BookingPlayersClosedError();
    await requirePlayerAccount(tx, input.playerUserId);

    const added = await insertParticipant(tx, b, input.playerUserId);
    if (added.joined && added.participantId) {
      await appendAuditEntry(tx, {
        tenantId,
        actorUserId: input.userId,
        entity: 'BookingParticipant',
        entityId: added.participantId,
        action: AUDIT_ACTIONS.BOOKING_PLAYER_JOINED,
        details: `Added a player to booking ${b.id}`,
        detailsJson: { category: 'booking', bookingId: b.id, via: 'booker' },
      });
    }
    return added;
  });

  if (result.joined) {
    await onBookingPlayersChanged({
      type: 'joined',
      tenantId,
      bookingId: input.bookingId,
      userId: input.playerUserId,
      via: 'booker',
    });
  }
  return result;
}
