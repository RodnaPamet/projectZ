import type { PrismaClient } from '@prisma/client';

import {
  NO_SHOW_BLOCK_THRESHOLD,
  NO_SHOW_WINDOW_DAYS,
  noShowStanding,
} from '@/app-layer/usecases/booking-rules';
import { gameChatsFor } from '@/app-layer/usecases/messaging-directory';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { avatarUrlOf } from '@/lib/media/avatar-url';
import { decryptField } from '@/lib/security/encryption';

/**
 * "Изтегли моите данни" (#370): what playerz holds about the signed-in person,
 * as one JSON file. `GET /api/v1/me/export`.
 *
 *   profile        who they are, their sports and player profile
 *   signIn         the address, the second step, every session (when, from
 *                  which IP address and browser) and the security log
 *   devices        the phones and browsers registered for notifications
 *   memberships    their clubs
 *   bookings       as booker (with the note they left, and the contact
 *                  details the club's desk took for them) and as a player
 *   weeklySeries   standing weekly bookings a club entered for them
 *   credit         the balance at each club, and every ledger entry
 *   noShowStanding at each club where they have missed a booking: how many
 *                  count now, and whether online booking is blocked
 *   reviews, notifications (the bell and the emails), notificationSettings,
 *   inviteLinks
 *   messages       (#375) whether they are shown in player search, who they
 *                  blocked, and every conversation they are in — with another
 *                  player or with a club — with every message in it still
 *                  there, theirs and the other side's: they were party to all
 *                  of it, and a conversation of one voice says nothing. A
 *                  retracted message is listed as retracted, without text.
 *   openPlay       (#376) the games they opened (what they asked for, their
 *                  note) and every request they made to join one (the game,
 *                  their note to the booker, where it stands)
 *
 * ═══ WHAT IS NOT IN IT, AND WHY ═══
 *
 * Every read is keyed on the session's user id and selects named columns,
 * never a whole row, so what leaves is what is listed here. Never in it:
 *
 *   - a secret or a credential: password hash, the second factor's seed and
 *     recovery codes, session and refresh token hashes, push endpoints and
 *     keys, device tokens, invite-link hashes, payment and idempotency keys
 *     (tests/guardrails/data-export-excludes-secrets.test.ts lists them and
 *     fails if this file ever selects one). They are what an account is
 *     taken over with, and a file that leaves playerz is no place for them;
 *   - another person's email, phone or contact details. A booking says how
 *     many played, not who. The one place other people's NAMES appear is the
 *     bell's copy ("Петър се включи в играта"): it is what playerz showed this
 *     person, word for word, and leaving it out would make the file not say
 *     what their own inbox said;
 *   - what a club wrote about the person for its own use: its tags, and the
 *     notes its desk keeps on a booking or a weekly series. Those are the
 *     club's working notes; the person's own note on a booking they made
 *     online is in, and so are the contact details the desk took for them and
 *     their no-show standing, which decides what they may do;
 *   - a club's business data. A club account gets its holder's own data
 *     (profile, the membership, settings), not the club's diary or players.
 *
 * ═══ SIGN-IN PROVIDERS ═══
 *
 * playerz keeps no Google or Facebook id and no token. An account is found by
 * its email at every sign-in (src/auth.ts), so the address IS the sign-in
 * record. The one provider id it keeps is Apple's subject (#442, version 7):
 * a person who hid their address behind Apple's relay is found by it, so it
 * is in `providerAccounts`, and that list is otherwise empty.
 *
 * ═══ WHY THIS BINDS SUPERUSER ═══
 *
 * As `listMyBookings`: the person's bookings, places and memberships sit at
 * every club under tenant-scoped RLS, and no binding means "this person,
 * everywhere". Every query names the one user id; nothing is written.
 */

/** Most rows of one kind a file carries. Far beyond any real person's history. */
export const EXPORT_ROW_CAP = 10_000;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
/** A `@db.Date` as its calendar day. */
const day = (d: Date) => d.toISOString().slice(0, 10);

const BOOKING_SELECT = {
  id: true,
  startTs: true,
  endTs: true,
  status: true,
  channel: true,
  totalCents: true,
  currency: true,
  createdAt: true,
  cancelledAt: true,
  resource: {
    select: {
      name: true,
      sport: true,
      resourceType: true,
      venue: { select: { name: true, timezone: true } },
    },
  },
  _count: { select: { participants: true } },
} as const;

/**
 * The bookings the person MADE carry what they, or the desk for them, put on
 * the booking. Never selected for the ones they were added to: there, these
 * columns are the booker's.
 */
const OWN_BOOKING_SELECT = {
  ...BOOKING_SELECT,
  notes: true,
  guestName: true,
  guestPhone: true,
  guestEmail: true,
} as const;

/** Contact details a club's desk took for the person, as one value. */
export interface ContactGivenToClub {
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface PersonalDataExport {
  format: 'playerz.bg personal data';
  version: 8;
  exportedAt: string;
  profile: {
    id: string;
    name: string | null;
    email: string;
    /** The number the caller confirmed by SMS code (#500), or null. */
    phone: string | null;
    phoneConfirmedAt: string | null;
    avatarUrl: string | null;
    language: string;
    accountKind: string | null;
    createdAt: string;
    sports: Array<{ sport: string; level: number }>;
    /** Each version of the terms and the privacy policy the caller accepted (#462). */
    acceptedTerms: Array<{
      document: string;
      version: string;
      language: string;
      acceptedAt: string;
    }>;
    playerProfile: {
      displayName: string;
      bio: string | null;
      dateOfBirth: string | null;
      preferredHand: string | null;
      skillLevel: string;
    } | null;
  };
  signIn: {
    email: string;
    emailVerifiedAt: string | null;
    /**
     * The provider ids playerz keeps (#442): Apple's subject, when the
     * account signs in with Apple. No token is ever stored. See the header.
     */
    providerAccounts: Array<{ provider: 'apple'; subject: string }>;
    twoStepVerification: boolean;
    /** Every session playerz still has on record, newest first. */
    sessions: Array<{
      signedInAt: string;
      lastSeenAt: string;
      expiresAt: string;
      endedAt: string | null;
      ipAddress: string | null;
      userAgent: string | null;
      twoStepVerifiedAt: string | null;
    }>;
    /** The second step's own log (enrolment, step-ups, recovery codes). */
    securityEvents: Array<{
      action: string;
      at: string;
      ipAddress: string | null;
      userAgent: string | null;
      details: unknown;
    }>;
  };
  devices: {
    apps: Array<{
      deviceName: string | null;
      osVersion: string | null;
      app: string;
      registeredAt: string;
      lastNotifiedAt: string | null;
    }>;
    browsers: Array<{
      userAgent: string | null;
      registeredAt: string;
      lastNotifiedAt: string | null;
    }>;
  };
  memberships: Array<{
    club: string;
    role: string;
    status: string;
    since: string;
    acceptedAt: string | null;
    endedAt: string | null;
  }>;
  bookings: {
    asBooker: ExportedOwnBooking[];
    asPlayer: ExportedBooking[];
  };
  weeklySeries: Array<{
    club: string;
    venue: string;
    court: string;
    startTime: string;
    durationMinutes: number;
    timezone: string;
    firstDate: string;
    lastDate: string;
    cancelledFrom: string | null;
    priceCents: number | null;
    createdAt: string;
    contactGivenToClub: { name: string; phone: string };
  }>;
  credit: {
    /** The balance at each club the person has ever had credit at. */
    balances: Array<{ club: string; balanceCents: number; currency: 'EUR' }>;
    ledger: Array<{
      club: string;
      deltaCents: number;
      balanceAfterCents: number;
      reason: string;
      ref: { type: string; id: string } | null;
      at: string;
    }>;
  };
  noShowStanding: Array<{
    club: string;
    /** No-shows that count now: started in the window, after the last lift. */
    recentNoShows: number;
    /** Online booking at this club is blocked until its staff lift it. */
    blocked: boolean;
    countedOverDays: number;
    blockedFrom: number;
    blockLiftedAt: string | null;
  }>;
  reviews: Array<{
    venue: string;
    rating: number;
    text: string | null;
    status: string;
    createdAt: string;
  }>;
  /** The person's reviews of coaches (#551; version 5). */
  coachReviews: Array<{
    /** The coach's name; empty once their account is gone. */
    coach: string;
    rating: number;
    text: string | null;
    status: string;
    createdAt: string;
  }>;
  notifications: {
    bell: Array<{
      kind: string;
      title: string;
      body: string;
      href: string | null;
      at: string;
      readAt: string | null;
    }>;
    email: Array<{
      kind: string;
      category: string;
      subject: string;
      text: string;
      status: string;
      sentAt: string | null;
      at: string;
    }>;
  };
  notificationSettings: {
    email: {
      bookingConfirmations: boolean;
      bookingReminders: boolean;
      clubChanges: boolean;
      messages: boolean;
      openPlay: boolean;
      /** A coach's emails about the lessons they teach (#550). */
      lessonsTaught: boolean;
    };
    /** The same kinds on the phone (#529, version 8). */
    push: {
      bookingConfirmations: boolean;
      bookingReminders: boolean;
      clubChanges: boolean;
      messages: boolean;
      openPlay: boolean;
      lessonsTaught: boolean;
    };
  };
  inviteLinks: Array<{
    bookingId: string;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
  }>;
  messages: {
    /** "Показвай ме в търсенето". */
    shownInPlayerSearch: boolean;
    /** The players this person blocked. */
    blocked: Array<{ name: string | null; at: string }>;
    conversations: Array<{
      /** A player, or a club. */
      /** A player, a club, or a game chat (#376), named after its venue. */
      with: { kind: 'player' | 'club' | 'game'; name: string | null; deletedAccount: boolean };
      startedAt: string;
      messages: Array<{
        mine: boolean;
        /** Who wrote it: a person's name, and the club a staff reply was for. */
        from: { name: string | null; club: string | null };
        text: string | null;
        retracted: boolean;
        at: string;
      }>;
    }>;
  };
  openPlay: {
    /** Bookings they opened to other players. */
    gamesOpened: Array<{
      bookingId: string;
      venue: string;
      start: string;
      spotsWanted: number;
      levelMin: number | null;
      levelMax: number | null;
      note: string | null;
      openedAt: string;
      closedAt: string | null;
    }>;
    /** Their requests to join other people's games. */
    requests: Array<{
      venue: string;
      start: string;
      status: string;
      note: string | null;
      askedAt: string;
      decidedAt: string | null;
    }>;
  };
  /**
   * What the person did as a coach (#552; version 6). Null for an account
   * that never was one. Of the players they taught, only how many: their
   * names and phones are other people's.
   */
  coach: {
    profile: {
      slug: string;
      status: string;
      bio: string | null;
      qualifications: string | null;
      sports: Array<{ sport: string; levelMin: number; levelMax: number }>;
      submittedAt: string | null;
      decidedAt: string | null;
      /** The platform's note on a decline or a removal, as written to them. */
      decisionNote: string | null;
    } | null;
    /**
     * The certificate they uploaded, described: the file itself is the one
     * they sent, kept only while decision 17 or 28 keeps it.
     */
    certificate: {
      fileName: string;
      mimeType: string;
      byteSize: number;
      sha256: string;
      uploadedAt: string;
    } | null;
    /** Where they teach, or asked to: the terms and the weekly hours. */
    venues: Array<{
      club: string;
      venue: string;
      status: string;
      startedBy: string;
      hourlyRateCents: number | null;
      groupRateCents: number | null;
      currency: string;
      lessonMinutes: number[];
      cancelCutoffHours: number;
      hours: Array<{ dayOfWeek: number; open: string; close: string }>;
      createdAt: string;
      decidedAt: string | null;
      endedAt: string | null;
    }>;
    daysOff: Array<{ from: string; to: string; note: string | null }>;
    lessonsTaught: Array<{
      club: string;
      venue: string;
      court: string;
      start: string;
      end: string;
      status: string;
      coachFeeCents: number;
      players: number;
    }>;
    /** Reviews of them (#551), without who wrote each. */
    reviewsReceived: Array<{
      rating: number;
      text: string | null;
      status: string;
      createdAt: string;
    }>;
  } | null;
}

export interface ExportedBooking {
  id: string;
  venue: string;
  court: string;
  sport: string;
  start: string;
  end: string;
  timezone: string;
  price: { cents: number; currency: string };
  status: string;
  madeAt: string;
  /** ONLINE (in the app) or DESK (entered by the club for the person). */
  channel: string;
  cancelledAt: string | null;
  /** How many were added to it besides the booker; never who. */
  addedPlayers: number;
}

export interface ExportedOwnBooking extends ExportedBooking {
  /** The note the person left when booking online. A desk booking's note is the club's. */
  note: string | null;
  /** What the club's desk took down for the person, on a booking it entered. */
  contactGivenToClub: ContactGivenToClub | null;
}

type BookingRow = {
  id: string;
  startTs: Date;
  endTs: Date;
  status: string;
  channel: string;
  totalCents: number;
  currency: string;
  createdAt: Date;
  cancelledAt: Date | null;
  resource: {
    name: string;
    sport: string;
    resourceType: string;
    venue: { name: string; timezone: string };
  };
  _count: { participants: number };
};

type OwnBookingRow = BookingRow & {
  notes: string | null;
  guestName: string | null;
  guestPhone: string | null;
  guestEmail: string | null;
};

function exportBooking(b: BookingRow): ExportedBooking {
  return {
    id: b.id,
    venue: b.resource.venue.name,
    court: b.resource.name,
    sport: b.resource.sport,
    start: b.startTs.toISOString(),
    end: b.endTs.toISOString(),
    timezone: b.resource.venue.timezone,
    price: { cents: b.totalCents, currency: b.currency },
    status: b.status,
    madeAt: b.createdAt.toISOString(),
    channel: b.channel,
    cancelledAt: iso(b.cancelledAt),
    addedPlayers: b._count.participants,
  };
}

function exportOwnBooking(b: OwnBookingRow): ExportedOwnBooking {
  const contact =
    b.guestName || b.guestPhone || b.guestEmail
      ? { name: b.guestName, phone: b.guestPhone, email: b.guestEmail }
      : null;
  return {
    ...exportBooking(b),
    note: b.channel === 'ONLINE' ? b.notes : null,
    contactGivenToClub: contact,
  };
}

/**
 * The confirmed number as the person typed it (#500): the column holds it
 * encrypted. A value this key cannot read is left out rather than exported as
 * ciphertext.
 */
function readablePhone(stored: string | null): string | null {
  if (!stored) return null;
  try {
    return decryptField(stored);
  } catch {
    return null;
  }
}

/** The export, read inside the caller's (superuser) binding. Null: no such account. */
export async function readPersonalData(
  db: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<PersonalDataExport | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      phoneVerifiedAt: true,
      appleSubject: true,
      avatarUrl: true,
      locale: true,
      accountKind: true,
      createdAt: true,
      emailVerified: true,
      mfaEnabledAt: true,
      emailBookingConfirmations: true,
      emailBookingReminders: true,
      emailClubChanges: true,
      emailMessages: true,
      emailOpenPlay: true,
      emailLessonsTaught: true,
      pushBookingConfirmations: true,
      pushBookingReminders: true,
      pushClubChanges: true,
      pushMessages: true,
      pushOpenPlay: true,
      pushLessonsTaught: true,
      searchable: true,
      deletedAt: true,
      sportLevels: { select: { sport: true, level: true }, orderBy: { sport: 'asc' } },
      legalAcceptances: {
        select: { document: true, version: true, locale: true, acceptedAt: true },
        orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }],
      },
      profile: {
        select: {
          displayName: true,
          bio: true,
          dateOfBirth: true,
          preferredHand: true,
          skillLevel: true,
        },
      },
    },
  });
  if (!user || user.deletedAt) return null;

  const [memberships, booked, played, reviews, links, coachReviews] = await Promise.all([
    db.tenantMembership.findMany({
      where: { userId },
      select: {
        role: true,
        status: true,
        createdAt: true,
        acceptedAt: true,
        deactivatedAt: true,
        tenant: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the person's own bookings, by their id.
    db.booking.findMany({
      where: { bookedByUserId: userId },
      select: OWN_BOOKING_SELECT,
      orderBy: [{ startTs: 'desc' }, { id: 'desc' }],
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the bookings the person was added to.
    db.booking.findMany({
      where: { participants: { some: { userId } }, NOT: { bookedByUserId: userId } },
      select: BOOKING_SELECT,
      orderBy: [{ startTs: 'desc' }, { id: 'desc' }],
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the person's own reviews, by their id.
    db.review.findMany({
      where: { authorUserId: userId },
      select: {
        rating: true,
        body: true,
        status: true,
        createdAt: true,
        venue: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the links the person made, by their id.
    db.bookingInviteLink.findMany({
      where: { createdByUserId: userId },
      select: { bookingId: true, createdAt: true, expiresAt: true, revokedAt: true },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the person's own reviews of coaches, by their id.
    db.coachReview.findMany({
      where: { authorUserId: userId },
      select: { coachUserId: true, rating: true, body: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
  ]);
  // The coaches' names, for the person's reviews of them: the name only.
  const coachIds = [...new Set(coachReviews.map((r) => r.coachUserId))];
  const coachNames = new Map(
    coachIds.length === 0
      ? []
      : (
          await db.user.findMany({
            where: { id: { in: coachIds }, deletedAt: null },
            select: { id: true, name: true },
            take: coachIds.length,
          })
        ).map((u) => [u.id, u.name ?? '']),
  );

  const messaging = await readMessaging(db, userId);
  const openPlay = await readOpenPlay(db, userId);
  const coach = await readCoach(db, userId);

  const [sessions, securityEvents, apps, browsers, bell, emails] = await Promise.all([
    // guardrail-allow: cross-tenant — the person's own sessions, by their id.
    db.userSession.findMany({
      where: { userId },
      select: {
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        revokedAt: true,
        ipAddress: true,
        userAgent: true,
        mfaVerifiedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the person's own security log, by their id.
    db.accountSecurityEvent.findMany({
      where: { userId },
      select: {
        action: true,
        createdAt: true,
        ipAddress: true,
        userAgent: true,
        detailsJson: true,
      },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
    db.deviceToken.findMany({
      where: { userId },
      select: {
        deviceName: true,
        osVersion: true,
        bundleId: true,
        createdAt: true,
        lastSuccessAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the person's own browsers, by their id.
    db.pushSubscription.findMany({
      where: { userId },
      select: { userAgent: true, createdAt: true, lastSuccessAt: true },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the person's own bell, by their id.
    db.notification.findMany({
      where: { userId },
      select: { kind: true, title: true, body: true, href: true, createdAt: true, readAt: true },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the email playerz sent the person, by their id.
    db.emailOutbox.findMany({
      where: { userId },
      select: {
        kind: true,
        category: true,
        subject: true,
        text: true,
        status: true,
        sentAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_ROW_CAP,
    }),
  ]);

  const [series, ledger, standings] = await Promise.all([
    // guardrail-allow: cross-tenant — the weekly series clubs entered for the person.
    db.bookingSeries.findMany({
      where: { customerUserId: userId },
      select: {
        tenantId: true,
        startTime: true,
        durationMinutes: true,
        timezone: true,
        firstDate: true,
        lastDate: true,
        cancelledFrom: true,
        priceCents: true,
        createdAt: true,
        customerName: true,
        customerPhone: true,
        resource: { select: { name: true, venue: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the person's credit, at every club.
    db.creditLedgerEntry.findMany({
      where: { userId },
      select: {
        tenantId: true,
        deltaCents: true,
        balanceAfterCents: true,
        reason: true,
        refType: true,
        refId: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the clubs where the person has missed a booking.
    db.playerVenueRelationship.findMany({
      where: {
        playerUserId: userId,
        OR: [{ noShowCount: { gt: 0 } }, { noShowBlockClearedAt: { not: null } }],
      },
      select: { tenantId: true },
      take: EXPORT_ROW_CAP,
    }),
  ]);

  const tenantIds = [
    ...new Set([
      ...series.map((s) => s.tenantId),
      ...ledger.map((l) => l.tenantId),
      ...standings.map((s) => s.tenantId),
    ]),
  ];
  const clubs = tenantIds.length
    ? // guardrail-allow: cross-tenant — the names of the clubs named above.
      await db.venueOrg.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, name: true },
        take: tenantIds.length,
      })
    : [];
  const club = new Map(clubs.map((c) => [c.id, c.name]));
  const clubOf = (tenantId: string) => club.get(tenantId) ?? '';

  const balances = new Map<string, number>();
  for (const l of ledger) balances.set(l.tenantId, (balances.get(l.tenantId) ?? 0) + l.deltaCents);

  const noShows = [];
  for (const s of standings) {
    // One count per club the person missed a booking at: a handful at most.
    const standing = await noShowStanding(db, s.tenantId, userId, now); // guardrail-allow: n-plus-one
    noShows.push({
      club: clubOf(s.tenantId),
      recentNoShows: standing.recentNoShows,
      blocked: standing.blocked,
      countedOverDays: NO_SHOW_WINDOW_DAYS,
      blockedFrom: NO_SHOW_BLOCK_THRESHOLD,
      blockLiftedAt: iso(standing.clearedAt),
    });
  }

  return {
    format: 'playerz.bg personal data',
    version: 8,
    exportedAt: now.toISOString(),
    profile: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: readablePhone(user.phone),
      phoneConfirmedAt: iso(user.phoneVerifiedAt),
      // Our copy's URL (#458), as every page shows it.
      avatarUrl: avatarUrlOf(user.avatarUrl),
      language: user.locale,
      accountKind: user.accountKind,
      createdAt: user.createdAt.toISOString(),
      sports: user.sportLevels.map((s) => ({ sport: s.sport, level: s.level })),
      acceptedTerms: user.legalAcceptances.map((a) => ({
        document: a.document,
        version: a.version,
        language: a.locale,
        acceptedAt: a.acceptedAt.toISOString(),
      })),
      playerProfile: user.profile
        ? {
            displayName: user.profile.displayName,
            bio: user.profile.bio,
            dateOfBirth: iso(user.profile.dateOfBirth),
            preferredHand: user.profile.preferredHand,
            skillLevel: user.profile.skillLevel,
          }
        : null,
    },
    signIn: {
      email: user.email,
      emailVerifiedAt: iso(user.emailVerified),
      providerAccounts: user.appleSubject
        ? [{ provider: 'apple', subject: user.appleSubject }]
        : [],
      twoStepVerification: user.mfaEnabledAt !== null,
      sessions: sessions.map((s) => ({
        signedInAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        endedAt: iso(s.revokedAt),
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        twoStepVerifiedAt: iso(s.mfaVerifiedAt),
      })),
      securityEvents: securityEvents.map((e) => ({
        action: e.action,
        at: e.createdAt.toISOString(),
        ipAddress: e.ipAddress,
        userAgent: e.userAgent,
        details: e.detailsJson,
      })),
    },
    devices: {
      apps: apps.map((d) => ({
        deviceName: d.deviceName,
        osVersion: d.osVersion,
        app: d.bundleId,
        registeredAt: d.createdAt.toISOString(),
        lastNotifiedAt: iso(d.lastSuccessAt),
      })),
      browsers: browsers.map((b) => ({
        userAgent: b.userAgent,
        registeredAt: b.createdAt.toISOString(),
        lastNotifiedAt: iso(b.lastSuccessAt),
      })),
    },
    memberships: memberships.map((m) => ({
      // A club deleted between Prisma's two selects comes back null (#419).
      club: m.tenant?.name ?? '',
      role: m.role,
      status: m.status,
      since: m.createdAt.toISOString(),
      acceptedAt: iso(m.acceptedAt),
      endedAt: iso(m.deactivatedAt),
    })),
    bookings: {
      asBooker: booked.map(exportOwnBooking),
      asPlayer: played.map(exportBooking),
    },
    weeklySeries: series.map((s) => ({
      club: clubOf(s.tenantId),
      venue: s.resource?.venue?.name ?? '',
      court: s.resource?.name ?? '',
      startTime: s.startTime,
      durationMinutes: s.durationMinutes,
      timezone: s.timezone,
      firstDate: day(s.firstDate),
      lastDate: day(s.lastDate),
      cancelledFrom: s.cancelledFrom ? day(s.cancelledFrom) : null,
      priceCents: s.priceCents,
      createdAt: s.createdAt.toISOString(),
      contactGivenToClub: { name: s.customerName, phone: s.customerPhone },
    })),
    credit: {
      balances: [...balances].map(([tenantId, balanceCents]) => ({
        club: clubOf(tenantId),
        balanceCents,
        currency: 'EUR' as const,
      })),
      ledger: ledger.map((l) => ({
        club: clubOf(l.tenantId),
        deltaCents: l.deltaCents,
        balanceAfterCents: l.balanceAfterCents,
        reason: l.reason,
        ref: l.refType && l.refId ? { type: l.refType, id: l.refId } : null,
        at: l.createdAt.toISOString(),
      })),
    },
    noShowStanding: noShows,
    reviews: reviews.map((r) => ({
      venue: r.venue?.name ?? '',
      rating: r.rating,
      text: r.body,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
    coachReviews: coachReviews.map((r) => ({
      coach: coachNames.get(r.coachUserId) ?? '',
      rating: r.rating,
      text: r.body,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
    notifications: {
      bell: bell.map((n) => ({
        kind: n.kind,
        title: n.title,
        body: n.body,
        href: n.href,
        at: n.createdAt.toISOString(),
        readAt: iso(n.readAt),
      })),
      email: emails.map((e) => ({
        kind: e.kind,
        category: e.category,
        subject: e.subject,
        text: e.text,
        status: e.status,
        sentAt: iso(e.sentAt),
        at: e.createdAt.toISOString(),
      })),
    },
    notificationSettings: {
      email: {
        bookingConfirmations: user.emailBookingConfirmations,
        bookingReminders: user.emailBookingReminders,
        clubChanges: user.emailClubChanges,
        messages: user.emailMessages,
        openPlay: user.emailOpenPlay,
        lessonsTaught: user.emailLessonsTaught,
      },
      push: {
        bookingConfirmations: user.pushBookingConfirmations,
        bookingReminders: user.pushBookingReminders,
        clubChanges: user.pushClubChanges,
        messages: user.pushMessages,
        openPlay: user.pushOpenPlay,
        lessonsTaught: user.pushLessonsTaught,
      },
    },
    inviteLinks: links.map((l) => ({
      bookingId: l.bookingId,
      createdAt: l.createdAt.toISOString(),
      expiresAt: l.expiresAt.toISOString(),
      revokedAt: iso(l.revokedAt),
    })),
    messages: { shownInPlayerSearch: user.searchable, ...messaging },
    openPlay,
    coach,
  };
}

/** A wall-clock `time` column, "09:00". */
const hhmm = (d: Date) => d.toISOString().slice(11, 16);

/**
 * The person as a coach (#552): their profile and certificate (described),
 * their links with terms and hours, days off, the lessons they taught and the
 * reviews of them. Null when there is none of it.
 */
async function readCoach(db: PrismaClient, userId: string): Promise<PersonalDataExport['coach']> {
  const [profile, certificate, links, daysOff, lessons, reviews] = await Promise.all([
    db.coachProfile.findUnique({
      where: { userId },
      select: {
        slug: true,
        status: true,
        bio: true,
        qualifications: true,
        submittedAt: true,
        decidedAt: true,
        decisionNote: true,
        sports: {
          select: { sport: true, levelMin: true, levelMax: true },
          orderBy: { sport: 'asc' },
        },
      },
    }),
    db.coachCertificate.findUnique({
      where: { userId },
      // Never the content: the export describes the file.
      select: { fileName: true, mimeType: true, byteSize: true, sha256: true, uploadedAt: true },
    }),
    // guardrail-allow: cross-tenant — the person's own links, at every club, by their id.
    db.coach.findMany({
      where: { userId },
      select: {
        tenantId: true,
        status: true,
        startedBy: true,
        hourlyRateCents: true,
        groupRateCents: true,
        currency: true,
        lessonMinutes: true,
        cancelCutoffHours: true,
        createdAt: true,
        decidedAt: true,
        endedAt: true,
        venue: { select: { name: true } },
        availability: {
          select: { dayOfWeek: true, openTime: true, closeTime: true },
          orderBy: [{ dayOfWeek: 'asc' }, { openTime: 'asc' }],
        },
      },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
    db.coachTimeOff.findMany({
      where: { userId },
      select: { startDate: true, endDate: true, note: true },
      orderBy: { startDate: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the lessons the person taught, at every club, by their id.
    db.coachLesson.findMany({
      where: { coachUserId: userId },
      select: {
        tenantId: true,
        startTs: true,
        endTs: true,
        coachFeeCents: true,
        booking: {
          select: {
            status: true,
            _count: { select: { participants: true } },
            resource: { select: { name: true, venue: { select: { name: true } } } },
          },
        },
      },
      orderBy: { startTs: 'desc' },
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the reviews of the person as a coach, by their id.
    db.coachReview.findMany({
      where: { coachUserId: userId },
      select: { rating: true, body: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
  ]);
  if (!profile && !certificate && links.length === 0 && lessons.length === 0) return null;

  const tenantIds = [...new Set([...links, ...lessons].map((r) => r.tenantId))];
  const clubs = new Map(
    tenantIds.length === 0
      ? []
      : (
          await db.venueOrg.findMany({
            where: { id: { in: tenantIds } },
            select: { id: true, name: true },
            take: tenantIds.length,
          })
        ).map((c) => [c.id, c.name]),
  );
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const day = (d: Date) => d.toISOString().slice(0, 10);

  return {
    profile: profile
      ? {
          slug: profile.slug,
          status: profile.status,
          bio: profile.bio,
          qualifications: profile.qualifications,
          sports: profile.sports,
          submittedAt: iso(profile.submittedAt),
          decidedAt: iso(profile.decidedAt),
          decisionNote: profile.decisionNote,
        }
      : null,
    certificate: certificate
      ? { ...certificate, uploadedAt: certificate.uploadedAt.toISOString() }
      : null,
    venues: links.map((l) => ({
      club: clubs.get(l.tenantId) ?? '',
      venue: l.venue.name,
      status: l.status,
      startedBy: l.startedBy,
      hourlyRateCents: l.hourlyRateCents,
      groupRateCents: l.groupRateCents,
      currency: l.currency,
      lessonMinutes: l.lessonMinutes,
      cancelCutoffHours: l.cancelCutoffHours,
      hours: l.availability.map((h) => ({
        dayOfWeek: h.dayOfWeek,
        open: hhmm(h.openTime),
        close: hhmm(h.closeTime),
      })),
      createdAt: l.createdAt.toISOString(),
      decidedAt: iso(l.decidedAt),
      endedAt: iso(l.endedAt),
    })),
    daysOff: daysOff.map((d) => ({ from: day(d.startDate), to: day(d.endDate), note: d.note })),
    lessonsTaught: lessons.map((l) => ({
      club: clubs.get(l.tenantId) ?? '',
      venue: l.booking.resource.venue.name,
      court: l.booking.resource.name,
      start: l.startTs.toISOString(),
      end: l.endTs.toISOString(),
      status: l.booking.status,
      coachFeeCents: l.coachFeeCents,
      players: 1 + l.booking._count.participants,
    })),
    reviewsReceived: reviews.map((r) => ({
      rating: r.rating,
      text: r.body,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/** Open play (#376): the games the person opened and the requests they made. */
async function readOpenPlay(
  db: PrismaClient,
  userId: string,
): Promise<PersonalDataExport['openPlay']> {
  const where = { select: { name: true } } as const;
  const [games, requests] = await Promise.all([
    // guardrail-allow: cross-tenant — the games the person opened, by their id.
    db.openGame.findMany({
      where: { booking: { bookedByUserId: userId } },
      select: {
        bookingId: true,
        spotsWanted: true,
        levelMin: true,
        levelMax: true,
        note: true,
        openedAt: true,
        closedAt: true,
        booking: { select: { startTs: true, resource: { select: { venue: where } } } },
      },
      orderBy: { openedAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
    // guardrail-allow: cross-tenant — the person's own requests, by their id.
    db.openGameRequest.findMany({
      where: { userId },
      select: {
        status: true,
        note: true,
        askedAt: true,
        decidedAt: true,
        game: {
          select: {
            booking: { select: { startTs: true, resource: { select: { venue: where } } } },
          },
        },
      },
      orderBy: { askedAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
  ]);
  return {
    gamesOpened: games.map((g) => ({
      bookingId: g.bookingId,
      venue: g.booking.resource.venue.name,
      start: g.booking.startTs.toISOString(),
      spotsWanted: g.spotsWanted,
      levelMin: g.levelMin,
      levelMax: g.levelMax,
      note: g.note,
      openedAt: g.openedAt.toISOString(),
      closedAt: g.closedAt?.toISOString() ?? null,
    })),
    requests: requests.map((r) => ({
      venue: r.game.booking.resource.venue.name,
      start: r.game.booking.startTs.toISOString(),
      status: r.status,
      note: r.note,
      askedAt: r.askedAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * The person's conversations (#375): three reads for all of them — their
 * participant rows with the conversations and messages, then the names of
 * the people and clubs on them. Bodies are decrypted here, as the screens
 * decrypt them; a body that does not open is listed without text.
 */
async function readMessaging(
  db: PrismaClient,
  userId: string,
): Promise<Omit<PersonalDataExport['messages'], 'shownInPlayerSearch'>> {
  const [rows, blocks] = await Promise.all([
    db.conversationParticipant.findMany({
      where: { userId, role: { in: ['MEMBER', 'PLAYER'] } },
      select: {
        conversation: {
          select: {
            id: true,
            type: true,
            tenantId: true,
            createdAt: true,
            participants: { select: { userId: true, role: true }, take: 10 },
            messages: {
              select: {
                senderId: true,
                senderTenantId: true,
                body: true,
                deletedAt: true,
                createdAt: true,
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: EXPORT_ROW_CAP,
            },
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
    db.userBlock.findMany({
      where: { blockerId: userId },
      select: { blockedId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_ROW_CAP,
    }),
  ]);

  const peopleIds = new Set<string>(blocks.map((b) => b.blockedId));
  const clubIds = new Set<string>();
  for (const r of rows) {
    const c = r.conversation;
    for (const p of c.participants) peopleIds.add(p.userId);
    for (const m of c.messages) {
      peopleIds.add(m.senderId);
      if (m.senderTenantId) clubIds.add(m.senderTenantId);
    }
    if (c.type === 'CLUB' && c.tenantId) clubIds.add(c.tenantId);
  }
  const [people, clubs] = await Promise.all([
    db.user.findMany({
      where: { id: { in: [...peopleIds] } },
      select: { id: true, name: true, deletedAt: true },
      take: peopleIds.size,
    }),
    // guardrail-allow: cross-tenant — the names of the clubs the person talks to.
    db.venueOrg.findMany({
      where: { id: { in: [...clubIds] } },
      select: { id: true, name: true },
      take: clubIds.size,
    }),
  ]);
  const person = new Map(people.map((u) => [u.id, u]));
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  // The game chats' venues (#376).
  const games = await gameChatsFor(
    rows.flatMap(({ conversation: c }) => (c.type === 'GROUP' ? [c.id] : [])),
    db,
  );
  const nameOf = (id: string) => {
    const u = person.get(id);
    return u && !u.deletedAt ? u.name : null;
  };
  const text = (body: string): string | null => {
    if (!body) return null;
    try {
      return decryptField(body);
    } catch {
      return null;
    }
  };

  return {
    blocked: blocks.map((b) => ({ name: nameOf(b.blockedId), at: b.createdAt.toISOString() })),
    conversations: rows.map(({ conversation: c }) => {
      const otherId =
        c.type === 'DM'
          ? (c.participants.find((p) => p.role === 'MEMBER' && p.userId !== userId)?.userId ?? null)
          : null;
      return {
        with:
          c.type === 'GROUP'
            ? {
                kind: 'game' as const,
                name: games.get(c.id)?.venueName ?? null,
                deletedAccount: false,
              }
            : c.type === 'CLUB'
              ? {
                  kind: 'club' as const,
                  name: clubName.get(c.tenantId ?? '') ?? null,
                  deletedAccount: false,
                }
              : {
                  kind: 'player' as const,
                  name: otherId ? nameOf(otherId) : null,
                  deletedAccount: otherId
                    ? (person.get(otherId)?.deletedAt ?? null) !== null
                    : true,
                },
        startedAt: c.createdAt.toISOString(),
        messages: c.messages.map((m) => ({
          mine: m.senderId === userId,
          from: {
            name: nameOf(m.senderId),
            club: m.senderTenantId ? (clubName.get(m.senderTenantId) ?? null) : null,
          },
          text: m.deletedAt ? null : text(m.body),
          retracted: m.deletedAt !== null,
          at: m.createdAt.toISOString(),
        })),
      };
    }),
  };
}

/** The signed-in person's export. */
export async function exportMyData(userId: string): Promise<PersonalDataExport | null> {
  return runAsSuperuser((db) => readPersonalData(db, userId));
}
