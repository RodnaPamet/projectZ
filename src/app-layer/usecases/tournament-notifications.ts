import type { Role } from '@prisma/client';

import { deliver } from '@/app-layer/usecases/notification-outbox';
import { runAsSuperuser, runAsUserOnly } from '@/lib/db/rls-middleware';
import { dedupeKey } from '@/lib/notifications/dedupe';
import { tournamentCopy, type TournamentNotice } from '@/lib/notifications/tournament-copy';
import { logger } from '@/lib/observability/logger';
import { roleHasPermission } from '@/lib/permissions';
import { absoluteUrl } from '@/lib/seo/site-url';

/**
 * A tournament's entries, told to the people they concern (#579).
 *
 *   event                         who hears                         kind
 *   ───────────────────────────────────────────────────────────────────────────────
 *   a player entered              the club's desk (who confirms)    TOURNAMENT_ENTRY_RECEIVED
 *   …naming a partner (50)        the partner, who may withdraw     TOURNAMENT_PARTNER_NAMED
 *   the club confirmed/declined   both of the pair                  TOURNAMENT_ENTRY_DECIDED
 *   the club cancelled it         both of every live pair           TOURNAMENT_ENTRY_DECIDED
 *   one of a pair withdrew        the other; the desk, if confirmed TOURNAMENT_ENTRY_WITHDRAWN
 *
 * The bell always. What a person has to act on or turn up for also goes by
 * email under the booking emails' switch, and rings the phone: being named
 * as a partner, the club's answer, a cancellation. The desk's notices are the
 * bell only: a busy sign-up would ring every phone at the club.
 *
 * All of it runs after the change committed, and none of it throws.
 */

const ZONE = 'Europe/Sofia';
const DESK_ROLES: Role[] = (
  ['OWNER', 'MANAGER', 'COACH', 'STAFF', 'PLAYER'] as const satisfies readonly Role[]
).filter((r) => roleHasPermission(r, 'bookings.view_all'));
const DESK_MAX = 50;

function warn(event: string, err: unknown): void {
  logger.warn('tournament notification failed', {
    component: 'tournaments',
    event,
    error: err instanceof Error ? err.message : String(err),
  });
}

async function readerOf(
  userId: string,
): Promise<{ locale: 'bg' | 'en'; name: string | null } | null> {
  const user = await runAsUserOnly(userId, (db) =>
    db.user.findUnique({
      where: { id: userId },
      select: { locale: true, name: true, deletedAt: true },
    }),
  );
  if (!user || user.deletedAt) return null;
  return { locale: user.locale, name: user.name };
}

const day = (locale: 'bg' | 'en', at: Date) =>
  new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'bg-BG', {
    day: 'numeric',
    month: 'short',
    timeZone: ZONE,
  }).format(at);

interface EntryFacts {
  tenantId: string;
  tournamentId: string;
  tournament: string;
  startsAt: Date;
  venue: string;
  slug: string;
  entryId: string;
  playerUserId: string;
  partnerUserId: string | null;
  withdrawnByUserId: string | null;
  status: string;
  names: Map<string, string | null>;
}

async function entryFacts(entryId: string): Promise<EntryFacts | null> {
  // guardrail-allow: cross-tenant — one entry by id, its tournament, club and
  // the two names on it: what its notices say, to the people on it.
  return runAsSuperuser(async (db) => {
    const e = await db.tournamentEntry.findUnique({
      where: { id: entryId },
      select: {
        tenantId: true,
        playerUserId: true,
        partnerUserId: true,
        withdrawnByUserId: true,
        status: true,
        tournament: {
          select: { id: true, name: true, startsAt: true, venue: { select: { name: true } } },
        },
      },
    });
    if (!e) return null;
    const ids = e.partnerUserId ? [e.playerUserId, e.partnerUserId] : [e.playerUserId];
    const [club, users] = await Promise.all([
      db.venueOrg.findUnique({ where: { id: e.tenantId }, select: { slug: true } }),
      db.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, deletedAt: true },
        take: ids.length,
      }),
    ]);
    return {
      tenantId: e.tenantId,
      tournamentId: e.tournament.id,
      tournament: e.tournament.name,
      startsAt: e.tournament.startsAt,
      venue: e.tournament.venue?.name ?? '',
      slug: club?.slug ?? '',
      entryId,
      playerUserId: e.playerUserId,
      partnerUserId: e.partnerUserId,
      withdrawnByUserId: e.withdrawnByUserId,
      status: e.status,
      names: new Map(users.map((u) => [u.id, u.deletedAt ? null : u.name])),
    };
  });
}

const tournamentHref = (id: string) => `/tournaments/${encodeURIComponent(id)}`;
const adminHref = (slug: string, id: string) =>
  `/t/${encodeURIComponent(slug)}/admin/tournaments/${encodeURIComponent(id)}`;

/** One notice to one person, in their language. */
async function tell(
  userId: string,
  f: EntryFacts,
  notice: TournamentNotice,
  opts: {
    kind:
      | 'TOURNAMENT_ENTRY_RECEIVED'
      | 'TOURNAMENT_PARTNER_NAMED'
      | 'TOURNAMENT_ENTRY_DECIDED'
      | 'TOURNAMENT_ENTRY_WITHDRAWN'
      | 'TOURNAMENT_ROUND';
    href: string;
    event: string;
    /** Email and push: something this person acts on or turns up for. */
    loud: boolean;
  },
): Promise<void> {
  try {
    const reader = await readerOf(userId);
    if (!reader) return;
    const facts = { tournament: f.tournament, day: day(reader.locale, f.startsAt), venue: f.venue };
    const copy = await tournamentCopy(
      reader.locale,
      facts,
      notice,
      opts.loud ? absoluteUrl(opts.href) : null,
    );
    await deliver({
      userId,
      tenantId: f.tenantId,
      kind: opts.kind,
      dedupeKey: dedupeKey('tournament', f.entryId, opts.event),
      title: copy.title,
      body: copy.body,
      href: opts.href,
      refType: 'tournament',
      refId: f.tournamentId,
      email:
        opts.loud && copy.email
          ? {
              category: 'confirmation',
              locale: reader.locale,
              subject: copy.email.subject,
              text: copy.email.text,
            }
          : null,
      push: opts.loud ? 'confirmation' : null,
    });
  } catch (err) {
    warn(opts.event, err);
  }
}

async function deskOf(tenantId: string): Promise<string[]> {
  // guardrail-allow: cross-tenant — the club's own desk, by its tenant id.
  const rows = await runAsSuperuser((db) =>
    db.tenantMembership.findMany({
      where: { tenantId, status: 'ACTIVE', role: { in: DESK_ROLES } },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
      take: DESK_MAX,
    }),
  );
  return rows.map((r) => r.userId);
}

const nameOf = (f: EntryFacts, id: string | null) => (id ? (f.names.get(id) ?? '—') : '—');
const pairOf = (f: EntryFacts) =>
  f.partnerUserId
    ? `${nameOf(f, f.playerUserId)} / ${nameOf(f, f.partnerUserId)}`
    : nameOf(f, f.playerUserId);

/** A player entered: the desk is told; a named partner is told and may withdraw. */
export async function notifyEntryReceived(entryId: string): Promise<void> {
  try {
    const f = await entryFacts(entryId);
    if (!f || f.status !== 'PENDING') return;
    for (const userId of await deskOf(f.tenantId)) {
      await tell(
        userId,
        f,
        { kind: 'received', players: pairOf(f) },
        {
          kind: 'TOURNAMENT_ENTRY_RECEIVED',
          href: adminHref(f.slug, f.tournamentId),
          event: `received-${userId}`,
          loud: false,
        },
      );
    }
    if (f.partnerUserId) {
      await tell(
        f.partnerUserId,
        f,
        { kind: 'partner', entrant: nameOf(f, f.playerUserId) },
        {
          kind: 'TOURNAMENT_PARTNER_NAMED',
          href: tournamentHref(f.tournamentId),
          event: 'partner',
          loud: true,
        },
      );
    }
  } catch (err) {
    warn('received', err);
  }
}

/** The club confirmed or declined an entry: both of the pair hear it. */
export async function notifyEntryDecided(entryId: string): Promise<void> {
  try {
    const f = await entryFacts(entryId);
    if (!f || (f.status !== 'CONFIRMED' && f.status !== 'DECLINED')) return;
    const notice: TournamentNotice = { kind: f.status === 'CONFIRMED' ? 'confirmed' : 'declined' };
    for (const userId of [f.playerUserId, f.partnerUserId].filter((x): x is string => !!x)) {
      await tell(userId, f, notice, {
        kind: 'TOURNAMENT_ENTRY_DECIDED',
        href: tournamentHref(f.tournamentId),
        event: `${notice.kind}-${userId}`,
        loud: true,
      });
    }
  } catch (err) {
    warn('decided', err);
  }
}

/** The club cancelled the tournament: every live pair hears it. */
export async function notifyTournamentCancelled(entryIds: readonly string[]): Promise<void> {
  for (const entryId of entryIds) {
    try {
      const f = await entryFacts(entryId);
      if (!f) continue;
      for (const userId of [f.playerUserId, f.partnerUserId].filter((x): x is string => !!x)) {
        await tell(
          userId,
          f,
          { kind: 'cancelled' },
          {
            kind: 'TOURNAMENT_ENTRY_DECIDED',
            href: tournamentHref(f.tournamentId),
            event: `cancelled-${userId}`,
            loud: true,
          },
        );
      }
    } catch (err) {
      warn('cancelled', err);
    }
  }
}

/** One of a pair withdrew: the other hears it, and the desk if the club had confirmed it. */
export async function notifyEntryWithdrawn(entryId: string, wasConfirmed: boolean): Promise<void> {
  try {
    const f = await entryFacts(entryId);
    if (!f || f.status !== 'WITHDRAWN') return;
    const who = nameOf(f, f.withdrawnByUserId);
    const other = f.withdrawnByUserId === f.playerUserId ? f.partnerUserId : f.playerUserId;
    if (other && other !== f.withdrawnByUserId) {
      await tell(
        other,
        f,
        { kind: 'withdrawn', who },
        {
          kind: 'TOURNAMENT_ENTRY_WITHDRAWN',
          href: tournamentHref(f.tournamentId),
          event: 'withdrawn',
          loud: false,
        },
      );
    }
    if (wasConfirmed) {
      for (const userId of await deskOf(f.tenantId)) {
        await tell(
          userId,
          f,
          { kind: 'withdrawnDesk', players: pairOf(f) },
          {
            kind: 'TOURNAMENT_ENTRY_WITHDRAWN',
            href: adminHref(f.slug, f.tournamentId),
            event: `withdrawn-desk-${userId}`,
            loud: false,
          },
        );
      }
    }
  } catch (err) {
    warn('withdrawn', err);
  }
}

/**
 * The draw is made (#580): every confirmed entry's players are told, and the
 * entries that waited and did not get in are told the club's answer.
 */
export async function notifyDrawMade(
  tournamentId: string,
  declined: readonly string[],
): Promise<void> {
  try {
    // guardrail-allow: cross-tenant — one tournament's confirmed entries, by id.
    const entries = await runAsSuperuser((db) =>
      db.tournamentEntry.findMany({
        where: { tournamentId, status: 'CONFIRMED' },
        select: { id: true },
        take: 512,
      }),
    );
    for (const { id } of entries) {
      const f = await entryFacts(id);
      if (!f) continue;
      for (const userId of [f.playerUserId, f.partnerUserId].filter((x): x is string => !!x)) {
        await tell(
          userId,
          f,
          { kind: 'drawn' },
          {
            kind: 'TOURNAMENT_ROUND',
            href: tournamentHref(f.tournamentId),
            event: `drawn-${userId}`,
            loud: true,
          },
        );
      }
    }
    for (const id of declined) await notifyEntryDecided(id);
  } catch (err) {
    warn('drawn', err);
  }
}

/** A match is on a court (#580, decision 40): its players are told where and when. */
export async function notifyMatchScheduled(matchId: string): Promise<void> {
  try {
    // guardrail-allow: cross-tenant — one match by id, its booking's court and
    // time, and the two entries on it.
    const m = await runAsSuperuser((db) =>
      db.tournamentMatch.findUnique({
        where: { id: matchId },
        select: {
          entryAId: true,
          entryBId: true,
          entryA2Id: true,
          entryB2Id: true,
          booking: { select: { id: true, startTs: true, resource: { select: { name: true } } } },
        },
      }),
    );
    if (!m?.booking) return;
    const booking = m.booking;
    for (const entryId of [m.entryAId, m.entryA2Id, m.entryBId, m.entryB2Id].filter(
      (x): x is string => !!x,
    )) {
      const f = await entryFacts(entryId);
      if (!f) continue;
      for (const userId of [f.playerUserId, f.partnerUserId].filter((x): x is string => !!x)) {
        const reader = await readerOf(userId);
        const when = new Intl.DateTimeFormat(reader?.locale === 'en' ? 'en-GB' : 'bg-BG', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: ZONE,
        }).format(booking.startTs);
        await tell(
          userId,
          // One notice a booking: a match moved is told again.
          { ...f, entryId: `${matchId}-${booking.id}` },
          { kind: 'scheduled', when, court: booking.resource.name },
          {
            kind: 'TOURNAMENT_ROUND',
            href: `/me/bookings/${encodeURIComponent(booking.id)}`,
            event: `scheduled-${userId}`,
            loud: true,
          },
        );
      }
    }
  } catch (err) {
    warn('scheduled', err);
  }
}
