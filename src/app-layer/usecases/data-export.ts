import type { PrismaClient } from '@prisma/client';

import { runAsSuperuser } from '@/lib/db/rls-middleware';

/**
 * "Изтегли моите данни" (#370): everything playerz holds about the signed-in
 * person, as one JSON file. `GET /api/v1/me/export`.
 *
 * ═══ THE PERSON'S, AND NOBODY ELSE'S ═══
 *
 * Every read is keyed on the session's user id and selects named columns,
 * never a whole row, so what leaves is what is listed here. Never in it:
 *
 *   - a secret or a credential: password hash, the second factor's seed and
 *     recovery codes, session and refresh token hashes, push keys, device
 *     tokens, invite-link hashes, payment and idempotency keys
 *     (tests/guardrails/data-export-excludes-secrets.test.ts lists them and
 *     fails if this file ever selects one);
 *   - another person's email or phone, or their name: a booking says how many
 *     played, not who. The co-players are their own people, and the booking
 *     page, which the person can still open, already shows them; a file that
 *     leaves playerz is no place for other people's data;
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

export interface PersonalDataExport {
  format: 'playerz.bg personal data';
  version: 1;
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
    asBooker: ExportedBooking[];
    asPlayer: ExportedBooking[];
  };
  reviews: Array<{
    venue: string;
    rating: number;
    text: string | null;
    status: string;
    createdAt: string;
  }>;
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
      select: BOOKING_SELECT,
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

  return {
    format: 'playerz.bg personal data',
    version: 1,
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
      asBooker: booked.map(exportBooking),
      asPlayer: played.map(exportBooking),
    },
    reviews: reviews.map((r) => ({
      venue: r.venue?.name ?? '',
      rating: r.rating,
      text: r.body,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
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
