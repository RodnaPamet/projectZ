import type { PrismaClient } from '@prisma/client';

import {
  NO_SHOW_BLOCK_THRESHOLD,
  NO_SHOW_WINDOW_DAYS,
  noShowStanding,
} from '@/app-layer/usecases/booking-rules';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

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
 * playerz keeps no provider account: no Google or Facebook id, no token. An
 * account is found by its email at every sign-in (src/auth.ts), so the
 * address IS the sign-in record, and `providerAccounts` is empty by
 * construction. Saying so beats leaving the section out.
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
  version: 2;
  exportedAt: string;
  profile: {
    id: string;
    name: string | null;
    email: string;
    phone: string | null;
    avatarUrl: string | null;
    language: string;
    accountKind: string | null;
    createdAt: string;
    sports: Array<{ sport: string; level: number }>;
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
    /** Always empty: no provider id or token is stored. See the header. */
    providerAccounts: never[];
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
    email: { bookingConfirmations: boolean; bookingReminders: boolean; clubChanges: boolean };
  };
  inviteLinks: Array<{
    bookingId: string;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
  }>;
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
      avatarUrl: true,
      locale: true,
      accountKind: true,
      createdAt: true,
      emailVerified: true,
      mfaEnabledAt: true,
      emailBookingConfirmations: true,
      emailBookingReminders: true,
      emailClubChanges: true,
      deletedAt: true,
      sportLevels: { select: { sport: true, level: true }, orderBy: { sport: 'asc' } },
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

  const [memberships, booked, played, reviews, links] = await Promise.all([
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
  ]);

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
    version: 2,
    exportedAt: now.toISOString(),
    profile: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      language: user.locale,
      accountKind: user.accountKind,
      createdAt: user.createdAt.toISOString(),
      sports: user.sportLevels.map((s) => ({ sport: s.sport, level: s.level })),
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
      providerAccounts: [],
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
      },
    },
    inviteLinks: links.map((l) => ({
      bookingId: l.bookingId,
      createdAt: l.createdAt.toISOString(),
      expiresAt: l.expiresAt.toISOString(),
      revokedAt: iso(l.revokedAt),
    })),
  };
}

/** The signed-in person's export. */
export async function exportMyData(userId: string): Promise<PersonalDataExport | null> {
  return runAsSuperuser((db) => readPersonalData(db, userId));
}
