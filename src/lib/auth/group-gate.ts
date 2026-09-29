import type { PrismaClient, Role } from '@prisma/client';

import { readGroupGateFlag } from '@/app-layer/schemas/entra-provider';

/**
 * The Entra group gate, applied where membership is decided.
 *
 * A club that federates with Entra can switch on `enforceGroupGate`: "you must
 * be in one of our mapped directory groups to reach this club". Only an Entra
 * sign-in can prove that — the proof is the `groups` claim on Microsoft's
 * token, which exists for the length of one callback — so the answer is a
 * property of the SESSION, not of the membership row.
 *
 * ═══ WHY THIS FILE EXISTS (#250) ═══
 *
 * Until #250 the gate had no enforcement of its own. `src/auth.ts` DROPPED a
 * gated club from `token.memberships`, and the edge read the absence as "not a
 * member" and answered 403. The membership row was untouched, on purpose.
 *
 * #250 is precisely that absence stops meaning "not a member": native tokens
 * list no clubs and #229 creates memberships after sign-in, so a missing claim
 * is now resolved against the database — which says "member", because the row
 * is untouched. Without this file, every gated club would have opened to every
 * session the gate had refused, at the moment the edge stopped refusing them.
 *
 * So the gate now has a mechanism rather than a side effect. The token carries
 * what the session PROVED — `groupGateCleared`, the clubs whose gate an Entra
 * sign-in passed — and every resolver that turns (user, club) into standing
 * asks this function before it answers.
 *
 * ═══ AN ALLOW-LIST, NOT A DENY-LIST ═══
 *
 * Carrying "the clubs the gate refused" would have been the smaller diff, and
 * it fails open in exactly the cases that matter: a club the session never
 * evaluated. A native password sign-in evaluates nothing. A membership created
 * after sign-in — an invite accepted, a court booked (#229) — was not there to
 * be evaluated. A club that switches the gate on at noon has refused nobody
 * signed in at eleven. A deny-list admits all three.
 *
 * An allow-list refuses all three, because the rule is read NOW, from the
 * club's configuration, and only a proof can satisfy it. That matches the
 * gate's own contract: "a sign-in that cannot prove group membership does not
 * get that club".
 *
 * ═══ WHAT IS NOT GATED ═══
 *
 *   - OWNER, always. A configuration mistake must not leave a club with nobody
 *     able to get in and correct it — the same immunity `entra-group-sync`
 *     grants, for the same reason.
 *   - a club with no ENABLED Entra provider, or with the flag off. The flag is
 *     read with `readGroupGateFlag`, which tolerates a corrupt config without
 *     switching the gate off.
 */

/**
 * May this session reach this club, as far as the group gate is concerned?
 *
 * Takes the caller's `db` rather than opening its own binding: it is called
 * from inside the resolvers' existing `runAsSuperuser`, where
 * `tenant_identity_provider` — tenant-scoped, FORCE RLS — is readable before
 * any tenant is bound. It adds no BYPASSRLS call site of its own.
 *
 * One indexed read (`@@unique([tenantId, type])`), skipped for an OWNER and for
 * a club the session has already cleared.
 */
export async function groupGateAdmits(
  db: PrismaClient,
  input: { tenantId: string; role: Role; cleared: readonly string[] },
): Promise<boolean> {
  if (input.role === 'OWNER') return true;
  if (input.cleared.includes(input.tenantId)) return true;

  const provider = await db.tenantIdentityProvider.findFirst({
    where: { tenantId: input.tenantId, type: 'ENTRA_ID', enabled: true },
    select: { configJson: true },
  });

  return !provider || !readGroupGateFlag(provider.configJson);
}

/**
 * The `groupGateCleared` claim, read off a decoded token.
 *
 * Defensively, because it is a value off a JWT rather than one this process
 * produced: a token minted before the claim existed has none, and anything that
 * is not an array of strings clears nothing. The failure direction is the gate
 * applying, never the gate lifting.
 */
export function groupGateClearedFrom(token: { groupGateCleared?: unknown } | null): string[] {
  const raw = token?.groupGateCleared;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}
