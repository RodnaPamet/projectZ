import type { PrismaClient } from '@prisma/client';

import { meili } from './client';
import { toCoachDoc, toSessionDoc, toVenueDoc } from './documents';
import { INDEXES } from './indexes';

/**
 * Index sync.
 *
 * ─── The index is a CACHE, never the source of truth ─────────────────
 *
 * Postgres is authoritative. If Meilisearch is down, unreachable, or its
 * volume was deleted, the product must degrade to "search is slow/limited",
 * never to "your booking failed".
 *
 * So every sync call is best-effort and logs on failure rather than throwing
 * into the caller's transaction. A venue update that rolls back because the
 * SEARCH INDEX was unavailable would be an absurd way to lose a write.
 *
 * `reindexAll` exists because a cache you cannot rebuild is not a cache, it is
 * a liability.
 */

export async function syncVenue(db: PrismaClient, venueId: string): Promise<void> {
  const venue = await db.venue.findUnique({
    where: { id: venueId },
    include: { resources: { take: 100 }, amenities: { take: 50 } },
  });

  if (!venue) {
    await meili()
      .index(INDEXES.venues.uid)
      .deleteDocument(venueId)
      .catch(noteFailure('venue delete'));
    return;
  }

  await meili()
    .index(INDEXES.venues.uid)
    .addDocuments([toVenueDoc(venue)])
    .catch(noteFailure('venue upsert'));
}

export async function syncSession(db: PrismaClient, sessionId: string): Promise<void> {
  const session = await db.openPlaySession.findUnique({
    where: { id: sessionId },
    include: { resource: { include: { venue: true } } },
  });

  if (!session) {
    await meili()
      .index(INDEXES.sessions.uid)
      .deleteDocument(sessionId)
      .catch(noteFailure('session delete'));
    return;
  }

  await meili()
    .index(INDEXES.sessions.uid)
    .addDocuments([toSessionDoc(session)])
    .catch(noteFailure('session upsert'));
}

export async function syncCoach(db: PrismaClient, coachId: string): Promise<void> {
  const coach = await db.coach.findUnique({
    where: { id: coachId },
    include: { coachSports: { take: 20 } },
  });

  if (!coach) {
    await meili()
      .index(INDEXES.coaches.uid)
      .deleteDocument(coachId)
      .catch(noteFailure('coach delete'));
    return;
  }

  // The coach's name lives on the global User/PlayerProfile, not on the
  // tenant-scoped Coach row — a coach is a person first.
  const profile = await db.playerProfile.findUnique({ where: { userId: coach.userId } });

  await meili()
    .index(INDEXES.coaches.uid)
    .addDocuments([toCoachDoc(coach, profile?.displayName ?? 'Coach', null)])
    .catch(noteFailure('coach upsert'));
}

/** Disaster recovery: rebuild every index from Postgres. */
export async function reindexAll(
  db: PrismaClient,
): Promise<{ venues: number; sessions: number; coaches: number }> {
  const venues = await db.venue.findMany({
    include: { resources: { take: 100 }, amenities: { take: 50 } },
    take: 10_000,
  });
  const sessions = await db.openPlaySession.findMany({
    include: { resource: { include: { venue: true } } },
    take: 10_000,
  });
  const coaches = await db.coach.findMany({ include: { coachSports: { take: 20 } }, take: 10_000 });

  if (venues.length) {
    await meili().index(INDEXES.venues.uid).addDocuments(venues.map(toVenueDoc)).waitTask();
  }
  if (sessions.length) {
    await meili().index(INDEXES.sessions.uid).addDocuments(sessions.map(toSessionDoc)).waitTask();
  }

  if (coaches.length) {
    const profiles = await db.playerProfile.findMany({
      where: { userId: { in: coaches.map((c) => c.userId) } },
      take: 10_000,
    });
    const nameByUser = new Map(profiles.map((p) => [p.userId, p.displayName]));

    await meili()
      .index(INDEXES.coaches.uid)
      .addDocuments(coaches.map((c) => toCoachDoc(c, nameByUser.get(c.userId) ?? 'Coach', null)))
      .waitTask();
  }

  return { venues: venues.length, sessions: sessions.length, coaches: coaches.length };
}

function noteFailure(what: string) {
  return (err: unknown) => {
    // Deliberately swallowed. The index is a cache; Postgres already has the
    // truth. Throwing here would roll back a legitimate write because a
    // SEARCH server was unavailable.
    // The index is a CACHE — Postgres already holds the truth. Throwing here
    // would roll back a legitimate write because a SEARCH server was down.
    // But a silently-swallowed sync failure is how an index rots unnoticed,
    // so it must leave SOME trace.
     
    console.warn(`[search] ${what} failed (index stale, data safe):`, err); // guardrail-allow: console — a swallowed sync failure needs one signal
  };
}
