import type { PrismaClient } from '@prisma/client';

import { groupGateAdmits } from '@/lib/auth/group-gate';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { translateFor } from '@/lib/i18n/server-messages';
import { logger } from '@/lib/observability/logger';

/**
 * Which club a signed-in player is acting at, resolved authoritatively.
 *
 * ═══ WHY THE TOKEN IS NOT ENOUGH ═══
 *
 * `contextFromRequest` reads memberships from the JWT and returns
 * `tenantId: null` when the slug is absent from that list. Its own comment
 * says why that is not a denial:
 *
 *   "Absent from a TRUNCATED list proves nothing — the caller may hold a
 *    membership we could not fit in the token. […] the route resolves
 *    membership authoritatively against the database."
 *
 * No route did. `bookings/route.ts` wrote `ctx.tenantId!` — a non-null
 * assertion on a value that is genuinely null — and `inTenant` then threw
 * `MissingTenantError`. So a player whose membership did not fit in the token
 * could not book at their own club, and the error said the route had made a
 * mistake upstream, which it had.
 *
 * This is that authoritative resolution. Since #250 `contextFromRequest`
 * resolves membership from the database as well, so the token is no longer
 * the problem; this remains the resolver for the player routes because it
 * answers the questions they need and the context does not — is the CLUB
 * active, and may a non-member join it.
 *
 * ═══ WHY IT RUNS AS SUPERUSER ═══
 *
 * The same reason sign-in does: there is no tenant bound yet, and this query
 * is what decides which one to bind. A tenant-scoped read here would return
 * zero rows and be indistinguishable from "not a member".
 *
 * The read is narrow — one membership for one user at one slug — and it can
 * only ever tell the caller about themselves, because `userId` comes from a
 * verified session and never from the request.
 */
export interface PlayerTenant {
  tenantId: string;
  /** True when this call created the membership rather than finding it. */
  joined: boolean;
}

export class ClubNotBookableError extends Error {
  constructor(slug: string) {
    super(`No bookable club at "${slug}"`);
    this.name = 'ClubNotBookableError';
  }
}

/**
 * Booking a court needs a PLAYER account (#263).
 *
 * The message is already in the caller's own language — their stored
 * `User.locale`, as notifications do — because it is the one thing a player
 * needs to read to fix it: "sign in with your player account". The code,
 * `PLAYER_ACCOUNT_REQUIRED`, is what a client switches on.
 */
export class PlayerAccountRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayerAccountRequiredError';
  }
}

/**
 * Resolve — and optionally create — the caller's PLAYER standing at a club.
 *
 * ═══ WHY BOOKING CREATES A MEMBERSHIP ═══
 *
 * Owner's decision: any signed-in player may book at any active club, without
 * an invitation. Before this, the only writer of `TenantMembership` was
 * `acceptInvite`, so booking required a club to have invited you by email
 * first — and `/venues` lists every club publicly, which promised something
 * the API refused.
 *
 * The alternative was to let a route bind a tenant the caller has no
 * membership for. That is a worse trade: `contextFromRequest` derives
 * permissions from the matched membership precisely so a stale or absent one
 * cannot become authority at the wrong club, and punching through it for
 * convenience would put a hole in the mechanism that exists to prevent exactly
 * that.
 *
 * So the membership becomes real. It is honest — you booked a court at this
 * club, you are a player at this club — and it keeps every downstream
 * assumption intact: RLS binds normally, `listOwnBookings` works, and the club
 * sees the player in its members list rather than a booking from a stranger.
 *
 * ROLE IS ALWAYS `PLAYER`, never inherited and never elevated. An existing
 * membership is returned untouched.
 *
 * ═══ ONLY A PLAYER ACCOUNT BOOKS (#263) ═══
 *
 * "It's either or — player or club owner/manager/staff." `createIfAbsent` is
 * the booking route, and booking a court is playing, so it needs a PLAYER
 * account — a stranger to the club, or already a player there. A CLUB account
 * is refused even at its own club, where it would not have to join: an owner
 * who wants to play books with their player account, which is the whole point
 * of there being two. COACH accounts get their own booking system later, and
 * an account the migration could not decide is refused until a person does.
 *
 * Checked BEFORE the club is looked up, so the refusal is the same for every
 * slug — it is about the caller's account, and must not become a way to learn
 * which clubs exist. The database refuses the join as well
 * (`account_kind_membership_trg`), without the message.
 *
 * Reading, reviewing and cancelling are not refused: those are about bookings
 * an account already has, and the migration kept a club account's old ones.
 *
 * ═══ THE ENTRA GROUP GATE APPLIES HERE TOO (#250) ═══
 *
 * A club that enforces its group gate admits only sessions that proved
 * directory-group membership at sign-in (`@/lib/auth/group-gate`). Until #250
 * the edge enforced that, and it also happened to make joining impossible for
 * everyone. Now that joining works, a gated club must refuse a join the gate
 * would refuse — otherwise any stranger could enrol in a closed club by
 * booking one of its courts, and would then be refused on every request after
 * the one that enrolled them. An existing membership the gate refuses reads as
 * no standing, like a suspended one.
 */
export async function resolvePlayerTenant(
  userId: string,
  slug: string,
  opts: {
    createIfAbsent: boolean;
    /** The session's `groupGateCleared` — `ctx.groupGateCleared` at a route. */
    groupGateCleared: readonly string[];
  },
): Promise<PlayerTenant | null> {
  return runAsSuperuser(async (db: PrismaClient) => {
    if (opts.createIfAbsent) {
      const account = await db.user.findUnique({
        where: { id: userId },
        select: { accountKind: true, locale: true },
      });
      if (account?.accountKind !== 'PLAYER') {
        throw new PlayerAccountRequiredError(
          await translateFor(account?.locale, 'accountKind.booking.playerAccountRequired'),
        );
      }
    }

    const club = await db.venueOrg.findUnique({
      where: { slug },
      select: { id: true, status: true },
    });

    // A suspended or closed club is not bookable, and must not be joinable
    // either — a membership created here would outlive the suspension.
    if (!club || club.status !== 'ACTIVE') return null;

    const existing = await db.tenantMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId: club.id } },
      select: { status: true, role: true },
    });

    if (existing) {
      // SUSPENDED is the club's deliberate act. Silently reactivating it by
      // booking a court would undo a moderation decision, so it reads as "no
      // standing here" rather than being upgraded.
      if (existing.status !== 'ACTIVE') return null;

      const admitted = await groupGateAdmits(db, {
        tenantId: club.id,
        role: existing.role,
        cleared: opts.groupGateCleared,
      });
      if (!admitted) return null;

      return { tenantId: club.id, joined: false };
    }

    if (!opts.createIfAbsent) return null;

    // Judged as the PLAYER this would create. Only an Entra sign-in that was
    // already a member when it signed in can have cleared a gate, so in
    // practice a gated club is not joinable by booking at all — it admits
    // members by invitation, and the gate decides which of them may come in.
    const joinable = await groupGateAdmits(db, {
      tenantId: club.id,
      role: 'PLAYER',
      cleared: opts.groupGateCleared,
    });
    if (!joinable) return null;

    // `create`, not `upsert`: the findUnique above already handled the found
    // case, and a race between two first bookings is resolved by the
    // @@unique([userId, tenantId]) constraint — caught below rather than
    // papered over, so the second request still gets a usable tenant.
    try {
      await db.tenantMembership.create({
        data: {
          userId,
          tenantId: club.id,
          role: 'PLAYER',
          status: 'ACTIVE',
          // Joining by booking IS the acceptance. Leaving this null would make
          // the membership look like an invitation nobody answered.
          acceptedAt: new Date(),
        },
      });
      logger.info('player joined a club by booking', {
        component: 'membership',
        tenantId: club.id,
      });
    } catch {
      // The unique constraint fired, so a concurrent request created it. That
      // is the correct outcome, not a failure.
    }

    return { tenantId: club.id, joined: true };
  });
}
