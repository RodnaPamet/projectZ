import type { AccountKind, Locale, Role, SportType } from '@prisma/client';

import { readMemberships } from '@/app-layer/usecases/landing';
import { decideLanding, type LandingMembership, type LandingReason } from '@/lib/auth/landing';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { avatarUrlOf } from '@/lib/media/avatar-url';

/**
 * Who the signed-in person is, and where their account sends them:
 * `GET /api/v1/me` (#252, decided by account kind since #263).
 *
 * ═══ THE REASON, NOT THE HREF ═══
 *
 * `decideLanding` answers with a web path — `/t/{slug}/admin/calendar`,
 * `/me/bookings`, `/` — and a reason. The path is the web's own routing and
 * means nothing to the iOS client, which has screens, not URLs; handing it one
 * would invite a client to parse our route table, and break the day a page
 * moves. So the path is dropped here and the REASON goes out: each client maps
 * `player | club | club-unavailable | coach | undecided` to a screen of its
 * own. The decision itself is not restated — it is `decideLanding`, the same
 * function `/start` and the site header ask.
 *
 * ═══ ONE TRANSACTION, SO THE KIND AND THE LANDING AGREE ═══
 *
 * `resolveLanding` reads the account and its memberships and returns only the
 * decision. Calling it beside a separate profile read would be two snapshots:
 * an account decided between them could report `accountKind: "CLUB"` with
 * `reason: "undecided"`, a pair no client should have to reconcile. So this
 * reads the profile, the kind and the memberships together, through the same
 * `readMemberships` landing uses, and feeds `decideLanding` itself. It also
 * keeps the club's ROLE, which the decision does not carry and the response
 * does.
 *
 * ═══ WHY THIS BINDS SUPERUSER ═══
 *
 * For the reason `usecases/landing` does, and over the same rows: a CLUB
 * account's club can be any club, and `tenant_membership` carries FORCE row
 * security keyed on `app.tenant_id` alone, so an unbound read returns ZERO
 * ROWS — an owner would be told they have no club. Every query is scoped by
 * `userId`, which the route takes from a verified session and never from the
 * request: it can only describe the person asking, and it writes nothing.
 */

export interface Me {
  id: string;
  name: string | null;
  email: string;
  /** The sign-in provider's picture (Google, Facebook), or null. */
  avatarUrl: string | null;
  locale: Locale;
  /**
   * The sports this person plays, each at the level they declared, 1–7
   * (#359, Q37). In the sport enum's order; empty until they pick some.
   */
  sports: Array<{ sport: SportType; level: number }>;
  /** Null = undecided: an account #263's migration would not decide by rule. */
  accountKind: AccountKind | null;
  landing: {
    reason: LandingReason;
    /** The club the account lands on, when there is one, and its role there. */
    club: { slug: string; name: string; role: Role } | null;
  };
}

/** Null when the account row is gone or deleted — the route answers that as signed out. */
export async function getMe(userId: string): Promise<Me | null> {
  return runAsSuperuser(async (db) => {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
        locale: true,
        accountKind: true,
        deletedAt: true,
        // The person's own levels (#359), by the session-derived id like
        // everything else here; the enum's order, so the list is stable.
        sportLevels: { select: { sport: true, level: true }, orderBy: { sport: 'asc' } },
      },
    });
    // A deleted account (#370) is no account: its sessions are gone, so this is
    // unreachable through a route, and "signed out" is the answer if it is not.
    if (!user || user.deletedAt) return null;

    // A PLAYER is decided by its kind alone, as in `resolveLanding`: its
    // memberships are all PLAYER rows, which decide nothing, so it costs one
    // indexed read and not two.
    const memberships: LandingMembership[] =
      user.accountKind === 'PLAYER' ? [] : await readMemberships(db, userId);

    const decision = decideLanding({ kind: user.accountKind, memberships });

    // One membership per (user, club) — `@@unique([userId, tenantId])` — so the
    // tenant id names the row the decision chose.
    const chosen = decision.club
      ? memberships.find((m) => m.tenantId === decision.club!.tenantId)
      : undefined;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: avatarUrlOf(user.avatarUrl),
      locale: user.locale,
      sports: user.sportLevels.map((s) => ({ sport: s.sport, level: s.level })),
      accountKind: user.accountKind,
      landing: {
        reason: decision.reason,
        club:
          decision.club && chosen
            ? { slug: decision.club.tenantSlug, name: decision.club.tenantName, role: chosen.role }
            : null,
      },
    };
  });
}
