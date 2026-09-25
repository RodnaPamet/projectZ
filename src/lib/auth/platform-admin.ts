import { runAsSuperuser } from '@/lib/db/rls-middleware';
import {
  liveCapabilities,
  type PlatformCapability,
  type PlatformGrantSnapshot,
} from '@/lib/platform/capabilities';

/**
 * Resolve a person's platform authority from the database, per request.
 *
 * ═══ WHY NOT FROM THE TOKEN ═══
 *
 * `src/app/api/v1/_lib/context.ts` documents at length why `token.role` and
 * `token.permissions` are ignored: they were minted from `memberships[0]` and a
 * stale claim became a live cross-tenant escalation. A JWT records what was
 * true when it was signed, and nothing more.
 *
 * Platform authority is the highest privilege in the system and the one most
 * likely to be revoked in a hurry — during an incident, or when somebody leaves.
 * A cached claim would keep working until the token expired, which is exactly
 * the failure that history already paid for. So it is read fresh, every time,
 * and revocation takes effect on the next request.
 *
 * ═══ WHY THE READ IS NOT ON EVERY REQUEST ═══
 *
 * Almost nobody holds a grant, so resolving one for every authenticated request
 * would spend an indexed query per request to answer "no" — a real cost for a
 * feature with a handful of users.
 *
 * So the context builder calls this ONLY for requests under
 * `/api/v1/platform/**`. Everywhere else `appPermissions` is `[]`, which is not
 * a shortcut but the truth: no other route may act on platform authority, and a
 * guardrail asserts that platform work lives only under that prefix. If that
 * ever stops being true, this is the decision to revisit — not the guardrail to
 * relax.
 */
export interface ResolvedPlatformAuthority {
  grantId: string | null;
  capabilities: readonly PlatformCapability[];
}

const NONE: ResolvedPlatformAuthority = { grantId: null, capabilities: [] };

/**
 * The live grant for `userId`, or nothing.
 *
 * Reads via `runAsSuperuser` because `platform_admin_grant` denies `app_user`
 * outright — a signed-in member of any club must not be able to enumerate who
 * holds platform authority, since that is a target list.
 *
 * Never throws. A database hiccup here must degrade to "no authority" rather
 * than to a 500: failing closed on the read means a platform route returns 403,
 * which is the safe direction and is indistinguishable from a lapsed grant.
 */
export async function resolvePlatformAuthority(
  userId: string | null,
  now: Date = new Date(),
): Promise<ResolvedPlatformAuthority> {
  if (!userId) return NONE;

  try {
    const grant = await runAsSuperuser(async (db) => {
      const rows = await db.$queryRawUnsafe<
        {
          id: string;
          capabilities: PlatformCapability[];
          expiresAt: Date;
          revokedAt: Date | null;
        }[]
      >(
        // `revokedAt IS NULL` matches the partial unique index exactly, so this
        // is an index-only probe and there can be at most one row.
        `SELECT id, capabilities, "expiresAt", "revokedAt"
           FROM platform_admin_grant
          WHERE "userId" = $1 AND "revokedAt" IS NULL
          LIMIT 1`,
        userId,
      );
      return rows[0] ?? null;
    });

    if (!grant) return NONE;

    // Expiry is checked in application code, not SQL, so the boundary is
    // testable without a database — see tests/unit/platform/capabilities.test.ts,
    // which pins `expiresAt <= now` as expired.
    const snapshot: PlatformGrantSnapshot = {
      id: grant.id,
      capabilities: grant.capabilities,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
    };

    const capabilities = liveCapabilities(snapshot, now);
    // A lapsed grant yields no grantId either: carrying one with an empty
    // capability list would let an audit row name a grant that authorised
    // nothing.
    return capabilities.length > 0 ? { grantId: grant.id, capabilities } : NONE;
  } catch {
    return NONE;
  }
}
