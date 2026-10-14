import type { Locale, NotificationKind, OpenGameRequestStatus, Prisma } from '@prisma/client';

import { deliver, type EmailCategory } from '@/app-layer/usecases/notification-outbox';
import { bookingCutoffHours } from '@/lib/booking/cutoff';
import { COACH_PROFILE_HREF } from '@/lib/coaches/hrefs';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import {
  bellCopy,
  bookingEmail,
  bookingHref,
  formatDate,
  GAMES_REQUESTS_HREF,
  lessonCoachEmail,
  openPlayEmail,
  seriesCancelledEmail,
  type BookingBellEvent,
  type BookingFacts,
  type LessonCoachEvent,
} from '@/lib/notifications/booking-copy';
import { dedupeKey } from '@/lib/notifications/dedupe';
import { logger } from '@/lib/observability/logger';
import { absoluteUrl } from '@/lib/seo/site-url';

/**
 * Who hears about a booking, and how (#367, Q22).
 *
 *   event                         bell                      email (category)
 *   ─────────────────────────────────────────────────────────────────────────
 *   booked (online or desk)       the booker                confirmation
 *   weekly series created         the linked player         confirmation
 *   3 hours before the start      booker + added players    reminder
 *   cancelled by the club         booker + added players    clubChanges
 *   series cancelled by the club  the players on it         clubChanges
 *   cancelled by the booker       the added players         —
 *
 * A LESSON (#550) is a booking, so its players hear all of the above, in a
 * lesson's words («Урокът е записан», with the coach and both prices). Its
 * COACH hears too, under a switch of their own (`tellCoach`):
 *
 *   lesson booked                 the coach                 lessonsTaught
 *   3 hours before the start      the coach                 lessonsTaught
 *   cancelled by player or club   the coach                 lessonsTaught
 *   cancelled by the coach        booker + added players    clubChanges
 *   a player joined / left        the booker                —   (#416)
 *   added / removed by booker     that player               —   (#416)
 *
 * The person who did the thing is never told about it.
 *
 * Every function here runs AFTER the change committed and never throws: a
 * notification that fails is logged, and the booking it is about stands.
 * The facts are re-read from the database, so a notification describes the
 * booking as it is, not as a caller remembered it.
 *
 * ═══ WHY THESE READS ARE SUPERUSER ═══
 *
 * The recipients are people, at any club: their locale, their address and
 * their email settings live on `app_user`, and the booking is read by its id
 * together with the tenant the caller just wrote it in. Every id comes from
 * the committed write, never from a request.
 */

interface Recipient {
  id: string;
  name: string | null;
  locale: Locale;
  emailBookingConfirmations: boolean;
  emailBookingReminders: boolean;
  emailClubChanges: boolean;
  emailOpenPlay: boolean;
  emailLessonsTaught: boolean;
}

const RECIPIENT_SELECT = {
  id: true,
  name: true,
  locale: true,
  emailBookingConfirmations: true,
  emailBookingReminders: true,
  emailClubChanges: true,
  emailOpenPlay: true,
  emailLessonsTaught: true,
} satisfies Prisma.UserSelect;

const BOOKING_SELECT = {
  id: true,
  tenantId: true,
  status: true,
  startTs: true,
  endTs: true,
  bookedByUserId: true,
  totalCents: true,
  currency: true,
  participants: { select: { userId: true }, take: 32 },
  resource: {
    select: {
      name: true,
      resourceType: true,
      venue: { select: { name: true, timezone: true, cancellationCutoffHours: true } },
    },
  },
  // The lesson on it (#377, #550): a lesson is cancelled by the stricter of
  // the two cutoffs, its coach is told what happens to it, and the player's
  // own notifications say whose lesson it is and what it costs.
  lesson: { select: { cancelCutoffHours: true, coachUserId: true, coachFeeCents: true } },
} satisfies Prisma.BookingSelect;

type BookingRow = Prisma.BookingGetPayload<{ select: typeof BOOKING_SELECT }>;

/** The names of a lesson's two people, by account; for a plain booking, nobody's. */
type LessonNames = ReadonlyMap<string, string | null>;
const NO_NAMES: LessonNames = new Map();

/**
 * The coach's and the booker's names for the lessons among these bookings:
 * one read, and none at all when no row is a lesson. An account that is gone
 * has no name here, and the copy says "a coach" or "a player" in its place.
 */
async function lessonNames(rows: readonly BookingRow[]): Promise<LessonNames> {
  const ids = [
    ...new Set(
      rows.flatMap((b) =>
        b.lesson ? [b.lesson.coachUserId, ...(b.bookedByUserId ? [b.bookedByUserId] : [])] : [],
      ),
    ),
  ];
  if (ids.length === 0) return NO_NAMES;
  const users = await runAsSuperuser((db) =>
    db.user.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, name: true },
      take: ids.length,
    }),
  );
  return new Map(users.map((u) => [u.id, u.name]));
}

function factsOf(b: BookingRow, names: LessonNames = NO_NAMES): BookingFacts {
  return {
    bookingId: b.id,
    venueName: b.resource.venue.name,
    courtName: b.resource.name,
    resourceType: b.resource.resourceType,
    startTs: b.startTs,
    endTs: b.endTs,
    timezone: b.resource.venue.timezone,
    cutoffHours: bookingCutoffHours(
      b.resource.venue.cancellationCutoffHours,
      b.lesson?.cancelCutoffHours,
    ),
    ...(b.lesson
      ? {
          lesson: {
            coachName: names.get(b.lesson.coachUserId) ?? null,
            playerName: b.bookedByUserId ? (names.get(b.bookedByUserId) ?? null) : null,
            players: 1 + b.participants.length,
            coachFeeCents: b.lesson.coachFeeCents,
            courtPriceCents: b.totalCents,
            currency: b.currency,
          },
        }
      : {}),
  };
}

/**
 * ═══ THE COACH'S SIDE OF A LESSON (#550) ═══
 *
 * A lesson has a third person the booking code does not know: its coach. So
 * the three things that happen to a booking are told to them from here, in
 * the same place the players are told, rather than at each route that books,
 * cancels or reminds: a lesson the coach did not hear about is a coach who is
 * not on court.
 *
 *   booked      LESSON_BOOKED      «Нов урок: …»
 *   cancelled   LESSON_CANCELLED   by the player or the club; never for the
 *                                  coach's own cancel, which is their act
 *   reminder    LESSON_REMINDER    with the players', about three hours before
 *
 * Bell always; email under the coach's own switch, «Уроци, които водя»
 * (`lessonsTaught`, owner decision 22). The bell row points at «Уроци».
 */
async function tellCoach(
  b: BookingRow,
  facts: BookingFacts,
  what: {
    kind: 'LESSON_BOOKED' | 'LESSON_CANCELLED' | 'LESSON_REMINDER';
    event: LessonCoachEvent;
    key: string;
    now?: Date;
  },
): Promise<boolean> {
  if (!b.lesson) return false;
  const coach = (await readRecipients([b.lesson.coachUserId])).get(b.lesson.coachUserId);
  if (!coach) return false;
  await send({
    recipient: coach,
    tenantId: b.tenantId,
    kind: what.kind,
    key: dedupeKey('lesson', b.id, what.key),
    bell: what.event,
    facts,
    href: COACH_PROFILE_HREF,
    email: {
      category: 'lessonsTaught',
      render: () =>
        lessonCoachEmail(coach.locale, what.event, facts, absoluteUrl(COACH_PROFILE_HREF)),
      // Nothing about a lesson is worth sending once it has started.
      expiresAt: b.startTs,
    },
  });
  return true;
}

/** The booker first, then the added players with an account. */
function playersOf(b: BookingRow): string[] {
  const ids = [b.bookedByUserId, ...b.participants.map((p) => p.userId)].filter(
    (id): id is string => !!id,
  );
  return [...new Set(ids)];
}

async function readBookings(tenantId: string | null, ids: string[]): Promise<BookingRow[]> {
  if (ids.length === 0) return [];
  // guardrail-allow: cross-tenant — bookings by the ids a committed write (or
  // the reminder claim) produced; tenant-filtered whenever the caller knows it.
  return runAsSuperuser((db) =>
    db.booking.findMany({
      where: { id: { in: ids }, ...(tenantId ? { tenantId } : {}) },
      select: BOOKING_SELECT,
      take: ids.length,
    }),
  );
}

async function readRecipients(ids: string[]): Promise<Map<string, Recipient>> {
  if (ids.length === 0) return new Map();
  // A deleted account (#370) hears nothing: it is not a recipient at all.
  const rows = await runAsSuperuser((db) =>
    db.user.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: RECIPIENT_SELECT,
      take: ids.length,
    }),
  );
  return new Map(rows.map((r) => [r.id, r]));
}

function wantsEmail(r: Recipient, category: EmailCategory): boolean {
  if (category === 'confirmation') return r.emailBookingConfirmations;
  if (category === 'reminder') return r.emailBookingReminders;
  if (category === 'clubChanges') return r.emailClubChanges;
  if (category === 'openPlay') return r.emailOpenPlay;
  if (category === 'lessonsTaught') return r.emailLessonsTaught;
  return true;
}

interface Send {
  recipient: Recipient;
  tenantId: string;
  kind: NotificationKind;
  key: string;
  bell: BookingBellEvent;
  facts: BookingFacts;
  name?: string | null;
  date?: string;
  /** Where the bell row points and what it is about; the booking by default. */
  href?: string;
  ref?: { type: string; id: string };
  email?: {
    category: EmailCategory;
    render: () => Promise<{ subject: string; text: string }>;
    expiresAt?: Date | null;
  };
}

async function send(s: Send): Promise<void> {
  const copy = await bellCopy(s.recipient.locale, s.bell, s.facts, { name: s.name, date: s.date });
  const email =
    s.email && wantsEmail(s.recipient, s.email.category)
      ? {
          category: s.email.category,
          locale: s.recipient.locale,
          expiresAt: s.email.expiresAt,
          ...(await s.email.render()),
        }
      : null;
  await deliver({
    userId: s.recipient.id,
    tenantId: s.tenantId,
    kind: s.kind,
    dedupeKey: s.key,
    title: copy.title,
    body: copy.body,
    href: s.href ?? bookingHref(s.facts.bookingId),
    refType: s.ref?.type ?? 'booking',
    refId: s.ref?.id ?? s.facts.bookingId,
    email,
  });
}

/** Run a notification step; log and swallow anything it throws. */
async function guarded(what: string, ref: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn('booking notification failed', {
      component: 'notifications',
      what,
      ref,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Booked ─────────────────────────────────────────────────────────────

/**
 * A booking was made, online or at the desk for a linked player. Only a
 * CONFIRMED booking is announced: a PENDING hold (online payment) is not yet a
 * booking, and its checkout has its own notification.
 */
export async function notifyBookingConfirmed(input: {
  tenantId: string;
  bookingId: string;
  now?: Date;
}): Promise<void> {
  await guarded('confirmed', input.bookingId, async () => {
    const [b] = await readBookings(input.tenantId, [input.bookingId]);
    if (!b || b.status !== 'CONFIRMED' || !b.bookedByUserId) return;
    const facts = factsOf(b, await lessonNames([b]));
    // A lesson is said as one, to the player: whose it is and what it costs.
    const event = b.lesson ? 'lessonConfirmed' : 'confirmed';
    const r = (await readRecipients([b.bookedByUserId])).get(b.bookedByUserId);
    if (r) {
      await send({
        recipient: r,
        tenantId: b.tenantId,
        kind: 'BOOKING_CONFIRMED',
        key: dedupeKey('booking', b.id, 'confirmed'),
        bell: event,
        facts,
        email: {
          category: 'confirmation',
          render: () => bookingEmail(r.locale, event, facts, input.now),
          expiresAt: b.startTs,
        },
      });
    }
    await tellCoach(b, facts, { kind: 'LESSON_BOOKED', event: 'coachLessonBooked', key: 'booked' });
  });
}

/** A weekly series for a linked player: one confirmation for the series. */
export async function notifySeriesCreated(input: {
  tenantId: string;
  seriesId: string;
  now?: Date;
}): Promise<void> {
  await guarded('series-created', input.seriesId, async () => {
    // guardrail-allow: cross-tenant — the series the caller just created, in its tenant.
    const first = await runAsSuperuser((db) =>
      db.booking.findFirst({
        where: { tenantId: input.tenantId, seriesId: input.seriesId, status: 'CONFIRMED' },
        orderBy: { startTs: 'asc' },
        select: BOOKING_SELECT,
      }),
    );
    if (!first?.bookedByUserId) return;
    const r = (await readRecipients([first.bookedByUserId])).get(first.bookedByUserId);
    if (!r) return;
    const facts = factsOf(first);
    await send({
      recipient: r,
      tenantId: first.tenantId,
      kind: 'BOOKING_CONFIRMED',
      key: dedupeKey('series', input.seriesId, 'created'),
      bell: 'seriesCreated',
      facts,
      email: {
        category: 'confirmation',
        render: () => bookingEmail(r.locale, 'seriesCreated', facts, input.now),
        expiresAt: first.startTs,
      },
    });
  });
}

/**
 * A linked player's weekly series moved to another time or court (#415): one
 * notice for the move, showing its first moved week.
 */
export async function notifySeriesMoved(input: {
  tenantId: string;
  seriesId: string;
  fromDate: string;
  now?: Date;
}): Promise<void> {
  await guarded('series-moved', input.seriesId, async () => {
    // guardrail-allow: cross-tenant — the series the caller just moved, in its tenant.
    const first = await runAsSuperuser((db) =>
      db.booking.findFirst({
        where: {
          tenantId: input.tenantId,
          seriesId: input.seriesId,
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
        orderBy: { startTs: 'asc' },
        select: BOOKING_SELECT,
      }),
    );
    if (!first?.bookedByUserId) return;
    const r = (await readRecipients([first.bookedByUserId])).get(first.bookedByUserId);
    if (!r) return;
    const facts = factsOf(first);
    await send({
      recipient: r,
      tenantId: first.tenantId,
      kind: 'BOOKING_CONFIRMED',
      key: dedupeKey(
        'series',
        input.seriesId,
        `moved:${input.fromDate}:${(input.now ?? new Date()).getTime()}`,
      ),
      bell: 'seriesMoved',
      facts,
      email: {
        category: 'clubChanges',
        render: () => bookingEmail(r.locale, 'seriesMoved', facts, input.now),
        expiresAt: first.startTs,
      },
    });
  });
}

// ─── Cancelled ──────────────────────────────────────────────────────────

/**
 * A booking was cancelled. By the CLUB (staff): everyone on it hears, by
 * email too. By the BOOKER: the players they had added hear, in the bell.
 *
 * A LESSON (#549) has two more: by its COACH (owner decision 8), and because
 * the platform REMOVED the coach (decision 21). Both are somebody else's act
 * on the player's plans, so, as when the club cancels, everyone on it hears,
 * by email too, and is told the court was released with it.
 */
export async function notifyBookingCancelled(input: {
  tenantId: string;
  bookingId: string;
  by: 'CLUB' | 'BOOKER' | 'COACH' | 'COACH_REMOVED';
  actorUserId: string | null;
  now?: Date;
}): Promise<void> {
  const event =
    input.by === 'CLUB'
      ? 'cancelledByClub'
      : input.by === 'COACH'
        ? 'cancelledByCoach'
        : input.by === 'COACH_REMOVED'
          ? 'cancelledCoachRemoved'
          : null;
  await guarded('cancelled', input.bookingId, async () => {
    const [b] = await readBookings(input.tenantId, [input.bookingId]);
    if (!b || b.status !== 'CANCELLED') return;
    const ids = playersOf(b).filter(
      (id) => id !== input.actorUserId && (event !== null || id !== b.bookedByUserId),
    );
    const people = await readRecipients(ids);
    const facts = factsOf(b, await lessonNames([b]));
    // The club cancelling a LESSON is said as that; the coach's own cancel
    // and a removal already are.
    const said = event === 'cancelledByClub' && b.lesson ? 'lessonCancelledByClub' : event;
    for (const id of ids) {
      const r = people.get(id);
      if (!r) continue;
      await send({
        recipient: r,
        tenantId: b.tenantId,
        kind: 'BOOKING_CANCELLED',
        key: dedupeKey('booking', b.id, 'cancelled'),
        bell: said ?? 'cancelledByBooker',
        facts,
        email: said
          ? {
              category: 'clubChanges',
              render: () => bookingEmail(r.locale, said, facts, input.now),
            }
          : undefined,
      });
    }
    // The coach hears when somebody else cancelled their lesson: the player
    // or the club. Not their own cancel, and not a removal (they are told of
    // that as a decision on their profile).
    if (input.by === 'BOOKER' || input.by === 'CLUB') {
      await tellCoach(b, facts, {
        kind: 'LESSON_CANCELLED',
        event:
          input.by === 'BOOKER' ? 'coachLessonCancelledByPlayer' : 'coachLessonCancelledByClub',
        key: 'cancelled',
      });
    }
  });
  await notifyClosedRequests(input.tenantId, [input.bookingId]);
}

/**
 * The askers whose requests a cancellation closed (#376): `cancelBooking`
 * closes the booking's open game in its transaction. Keyed per request and
 * close, so a request the booker had already closed is not announced again.
 */
async function notifyClosedRequests(tenantId: string, bookingIds: string[]): Promise<void> {
  if (bookingIds.length === 0) return;
  const closed = await runAsSuperuser((db) =>
    db.openGameRequest.findMany({
      where: { tenantId, status: 'CLOSED', game: { bookingId: { in: bookingIds } } },
      select: { id: true },
      take: 1_000,
    }),
  ).catch(() => []);
  for (const c of closed) await notifyOpenPlay({ tenantId, requestId: c.id, event: 'closed' });
}

/**
 * The club cancelled the rest of a weekly series: ONE notification per
 * person for the whole cancel, naming the first week and how many.
 */
export async function notifySeriesCancelled(input: {
  tenantId: string;
  seriesId: string;
  fromDate: string;
  cancelledBookingIds: string[];
  actorUserId: string | null;
}): Promise<void> {
  if (input.cancelledBookingIds.length === 0) return;
  await guarded('series-cancelled', input.seriesId, async () => {
    const rows = await readBookings(input.tenantId, input.cancelledBookingIds.slice(0, 200));
    const sorted = rows.sort((a, b) => a.startTs.getTime() - b.startTs.getTime());
    const first = sorted[0];
    if (!first) return;
    const ids = [...new Set(sorted.flatMap(playersOf))].filter((id) => id !== input.actorUserId);
    const people = await readRecipients(ids);
    const facts = factsOf(first);
    for (const id of ids) {
      const r = people.get(id);
      if (!r) continue;
      const count = sorted.filter((b) => playersOf(b).includes(id)).length;
      await send({
        recipient: r,
        tenantId: first.tenantId,
        kind: 'BOOKING_CANCELLED',
        key: dedupeKey('series', input.seriesId, 'cancelled', input.fromDate),
        bell: 'seriesCancelled',
        facts,
        date: formatDate(r.locale, first.startTs, facts.timezone),
        email: {
          category: 'clubChanges',
          render: () => seriesCancelledEmail(r.locale, facts, first.startTs, count),
        },
      });
    }
  });
  await notifyClosedRequests(input.tenantId, input.cancelledBookingIds.slice(0, 200));
}

// ─── Who is playing (#416) ──────────────────────────────────────────────

export type PlayersEvent =
  | {
      type: 'joined';
      tenantId: string;
      bookingId: string;
      userId: string;
      participantId: string;
      via: 'link' | 'booker';
    }
  | { type: 'left'; tenantId: string; bookingId: string; userId: string; participantId: string }
  | {
      type: 'removed';
      tenantId: string;
      bookingId: string;
      userId: string;
      participantId: string;
      byUserId: string;
    };

/**
 * Bell only. A player who joins by link, or leaves, is news to the booker;
 * a player the booker adds or removes is news to that player.
 */
export async function notifyBookingPlayersChanged(event: PlayersEvent): Promise<void> {
  await guarded(`players-${event.type}`, event.bookingId, async () => {
    const [b] = await readBookings(event.tenantId, [event.bookingId]);
    if (!b) return;

    let to: string | null;
    let about: string;
    let bell: BookingBellEvent;
    let kind: NotificationKind;
    if (event.type === 'joined' && event.via === 'link') {
      [to, about, bell, kind] = [
        b.bookedByUserId,
        event.userId,
        'playerJoined',
        'BOOKING_PLAYER_JOINED',
      ];
    } else if (event.type === 'joined') {
      [to, about, bell, kind] = [
        event.userId,
        b.bookedByUserId ?? '',
        'playerAdded',
        'BOOKING_PLAYER_ADDED',
      ];
    } else if (event.type === 'left') {
      [to, about, bell, kind] = [
        b.bookedByUserId,
        event.userId,
        'playerLeft',
        'BOOKING_PLAYER_LEFT',
      ];
    } else {
      [to, about, bell, kind] = [
        event.userId,
        event.byUserId,
        'playerRemoved',
        'BOOKING_PLAYER_REMOVED',
      ];
    }
    if (!to || to === about) return;

    const people = await readRecipients([to, about].filter(Boolean));
    const r = people.get(to);
    if (!r) return;
    await send({
      recipient: r,
      tenantId: b.tenantId,
      kind,
      key: dedupeKey('booking', b.id, event.type, event.participantId),
      bell,
      facts: factsOf(b),
      name: people.get(about)?.name ?? null,
    });
  });
}

// ─── Open play (#376) ───────────────────────────────────────────────────

/** What happened to a request to join an open game. */
export type OpenPlayEvent = 'requested' | 'accepted' | 'declined' | 'lapsed' | 'closed';

const OPEN_PLAY_KIND: Record<OpenPlayEvent, NotificationKind> = {
  requested: 'OPEN_PLAY_REQUESTED',
  accepted: 'OPEN_PLAY_ACCEPTED',
  declined: 'OPEN_PLAY_DECLINED',
  lapsed: 'OPEN_PLAY_LAPSED',
  closed: 'OPEN_PLAY_CLOSED',
};

/** The state a request is in while each event is still news. */
const OPEN_PLAY_STATE: Record<OpenPlayEvent, OpenGameRequestStatus> = {
  requested: 'PENDING',
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  lapsed: 'LAPSED',
  closed: 'CLOSED',
};

/**
 * Bell and email for one request (#376): a new request is news to the
 * booker, naming the asker; an answer, a lapse or a close is news to the
 * asker, naming nobody. Email under «Игри» (`emailOpenPlay`), never after the
 * game started.
 *
 * Called after the commit with ids only. Re-reads the request and says
 * nothing when it has moved on since (a request withdrawn before its hook ran
 * is not announced to the booker). Keyed per request, event and the moment of
 * that event, so asking again after a withdrawal is news again and a repeated
 * hook is one row. The bell row is about the REQUEST (`refType`
 * open_game_request), which is how deleting the asker's account finds the
 * rows that name them. Never throws.
 */
export async function notifyOpenPlay(input: {
  tenantId: string;
  requestId: string;
  event: OpenPlayEvent;
}): Promise<void> {
  await guarded(`open-play-${input.event}`, input.requestId, async () => {
    const r = await runAsSuperuser((db) =>
      db.openGameRequest.findFirst({
        where: { id: input.requestId, tenantId: input.tenantId },
        select: {
          id: true,
          userId: true,
          status: true,
          askedAt: true,
          decidedAt: true,
          game: { select: { bookingId: true } },
        },
      }),
    );
    if (!r || r.status !== OPEN_PLAY_STATE[input.event]) return;
    const [b] = await readBookings(input.tenantId, [r.game.bookingId]);
    if (!b) return;

    const toBooker = input.event === 'requested';
    const to = toBooker ? b.bookedByUserId : r.userId;
    if (!to || to === (toBooker ? r.userId : b.bookedByUserId)) return;
    const people = await readRecipients(toBooker ? [to, r.userId] : [to]);
    const recipient = people.get(to);
    if (!recipient) return;

    const bell: BookingBellEvent =
      input.event === 'requested'
        ? 'openPlayRequested'
        : input.event === 'accepted'
          ? 'openPlayAccepted'
          : input.event === 'declined'
            ? 'openPlayDeclined'
            : input.event === 'lapsed'
              ? 'openPlayLapsed'
              : b.status === 'CANCELLED'
                ? 'openPlayCancelled'
                : 'openPlayClosed';
    const at = (toBooker ? r.askedAt : (r.decidedAt ?? r.askedAt)).getTime();
    const href = toBooker || input.event === 'accepted' ? bookingHref(b.id) : GAMES_REQUESTS_HREF;
    const facts = factsOf(b);
    const name = toBooker ? (people.get(r.userId)?.name ?? null) : null;

    await send({
      recipient,
      tenantId: b.tenantId,
      kind: OPEN_PLAY_KIND[input.event],
      key: dedupeKey('openplay', r.id, input.event, at),
      bell,
      facts,
      name,
      href,
      ref: { type: 'open_game_request', id: r.id },
      email: {
        category: 'openPlay',
        render: () => openPlayEmail(recipient.locale, bell, facts, { name, href }),
        expiresAt: b.startTs,
      },
    });
  });
}

// ─── The reminder ───────────────────────────────────────────────────────

/** The reminder goes this long before the start (Q22). */
export const REMINDER_LEAD_MS = 3 * 3_600_000;
/**
 * And no later than this before it. A run every 5 minutes reminds 3 h to
 * 2 h 55 min ahead; this lets a cron that was down catch up for an hour, and
 * stops it reminding someone about a game they are already on their way to.
 */
export const REMINDER_LATEST_MS = 2 * 3_600_000;
/** Bookings one run claims at most. */
export const REMINDER_BATCH = 500;

export interface ReminderResult {
  claimed: number;
  notified: number;
}

/**
 * Remind everyone on each CONFIRMED booking that starts in about 3 hours.
 *
 * ═══ EXACTLY ONCE ═══
 *
 * The CLAIM is one statement: `UPDATE booking SET reminderSentAt = now WHERE
 * status = 'CONFIRMED' AND reminderSentAt IS NULL AND startTs in the window`,
 * `FOR UPDATE SKIP LOCKED`. Two overlapping runs cannot both claim a booking;
 * a booking claimed once is never claimed again; and a cancel that commits
 * first leaves it CANCELLED, which the claim does not match. A cancel that
 * commits AFTER the claim is caught at send time (the drain re-checks).
 *
 * Absolute time throughout: "3 hours before" is 3 real hours, so the DST
 * change on 25 October moves nothing. Only the wall clock printed in the
 * email is the club's.
 *
 * A booking made less than 3 hours before its start is not reminded: its
 * confirmation has only just arrived.
 */
export async function sendBookingReminders(opts: { now?: Date } = {}): Promise<ReminderResult> {
  const now = opts.now ?? new Date();
  const latest = new Date(now.getTime() + REMINDER_LEAD_MS);
  const earliest = new Date(now.getTime() + REMINDER_LATEST_MS);

  // guardrail-allow: cross-tenant — the reminder spans every club; machine
  // work with no session, like the completion sweep.
  const claimed = await runAsSuperuser(
    (db) =>
      db.$queryRaw<Array<{ id: string; tenantId: string }>>`
      UPDATE "booking" SET "reminderSentAt" = ${now}
       WHERE "id" IN (
         SELECT "id" FROM "booking"
          WHERE "status" = 'CONFIRMED'
            AND "reminderSentAt" IS NULL
            AND "startTs" > ${earliest}
            AND "startTs" <= ${latest}
            AND "createdAt" <= ("startTs" - interval '3 hours') AT TIME ZONE 'UTC'
          ORDER BY "startTs"
          LIMIT ${REMINDER_BATCH}
          FOR UPDATE SKIP LOCKED
       )
         AND "status" = 'CONFIRMED'
         AND "reminderSentAt" IS NULL
   RETURNING "id", "tenantId"`,
  );
  if (claimed.length === 0) return { claimed: 0, notified: 0 };

  const rows = await readBookings(
    null,
    claimed.map((c) => c.id),
  );
  const people = await readRecipients([...new Set(rows.flatMap(playersOf))]);
  const names = await lessonNames(rows);

  let notified = 0;
  for (const b of rows) {
    const facts = factsOf(b, names);
    const event = b.lesson ? 'lessonReminder' : 'reminder';
    for (const id of playersOf(b)) {
      const r = people.get(id);
      if (!r) continue;
      await guarded('reminder', b.id, () =>
        send({
          recipient: r,
          tenantId: b.tenantId,
          kind: 'BOOKING_REMINDER',
          key: dedupeKey('booking', b.id, 'reminder'),
          bell: event,
          facts,
          email: {
            category: 'reminder',
            render: () => bookingEmail(r.locale, event, facts, now),
            expiresAt: b.startTs,
          },
        }),
      );
      notified++;
    }
    // The coach of a lesson is reminded with its players (#550).
    await guarded('lesson-reminder', b.id, async () => {
      const told = await tellCoach(b, facts, {
        kind: 'LESSON_REMINDER',
        event: 'coachLessonReminder',
        key: 'reminder',
      });
      if (told) notified++;
    });
  }
  return { claimed: claimed.length, notified };
}
