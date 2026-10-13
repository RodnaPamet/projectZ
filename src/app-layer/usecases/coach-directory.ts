import type { CoachSportInput } from '@/lib/coaches/profile';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

/**
 * WHAT ANYBODY ELSE MAY KNOW ABOUT A COACH (#546, and #547's public pages).
 *
 * A coach's profile is owner-only in the database (P71): a club bound as
 * itself reads none of it. This is the one place that reads it for somebody
 * else, and it gives out exactly what the platform owner approved for
 * publication:
 *
 *   an APPROVED coach   the name, the page address, the text, the
 *                       qualifications as text, the sports and levels
 *   anybody else        the name on the account, and that they are not
 *                       approved. Nothing they typed: a draft is theirs, and a
 *                       declined text was declined.
 *
 * NEVER the certificate, its name, or that one exists: that is the platform
 * owner's alone (`coach-approval.ts`, owner decision 17). And never an email
 * or a phone.
 */

export interface CoachCard {
  userId: string;
  /** The name on the account. Null for an account that is gone. */
  name: string | null;
  /** Approved by the platform owner: the rest is filled in only then. */
  approved: boolean;
  slug: string | null;
  bio: string | null;
  qualifications: string | null;
  sports: CoachSportInput[];
}

/** At most this many cards in one read; a club's list is far shorter. */
export const COACH_CARDS_MAX = 200;

/**
 * The public card of each of these accounts. An id that names nobody, or an
 * account that was deleted, has no card.
 */
export async function coachCards(userIds: readonly string[]): Promise<Map<string, CoachCard>> {
  const ids = [...new Set(userIds)].slice(0, COACH_CARDS_MAX);
  if (ids.length === 0) return new Map();

  // guardrail-allow: cross-tenant — a coach's profile belongs to a person, not
  // a club, and is owner-only under RLS; this reads the approved, public part
  // of it for the club or the player who is looking at that coach.
  return runAsSuperuser(async (db) => {
    const [users, profiles] = await Promise.all([
      db.user.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true, name: true },
        take: ids.length,
      }),
      db.coachProfile.findMany({
        where: { userId: { in: ids }, status: 'APPROVED' },
        select: {
          userId: true,
          slug: true,
          bio: true,
          qualifications: true,
          sports: {
            select: { sport: true, levelMin: true, levelMax: true },
            orderBy: { sport: 'asc' },
          },
        },
        take: ids.length,
      }),
    ]);
    const approved = new Map(profiles.map((p) => [p.userId, p]));
    return new Map(
      users.map((u) => {
        const p = approved.get(u.id);
        return [
          u.id,
          {
            userId: u.id,
            name: u.name,
            approved: p !== undefined,
            slug: p?.slug ?? null,
            bio: p?.bio ?? null,
            qualifications: p?.qualifications ?? null,
            sports: p?.sports ?? [],
          },
        ];
      }),
    );
  });
}
