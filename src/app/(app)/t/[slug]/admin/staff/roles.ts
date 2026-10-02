import type { Role } from '@prisma/client';

/**
 * The roles the staff page offers, shared by the board (which draws them) and
 * the actions (which refuse anything else). No directive: a plain module both a
 * client component and a server action may import.
 */

/** Every role, in rank order — the role change lists them all and disables the rest. */
export const ROLES = [
  'OWNER',
  'MANAGER',
  'COACH',
  'STAFF',
  'PLAYER',
] as const satisfies readonly Role[];

/**
 * The roles a club may INVITE to, from this page (#278).
 *
 * Narrower than `INVITABLE_ROLES` in the use case, on purpose:
 *
 * - OWNER never: an invite is accepted by whoever holds the link, and
 *   ownership carries the two-party protection the staff list enforces.
 * - COACH not until #269: a coach is its own kind of account (#263), and
 *   nothing creates one yet, so acceptance refused every COACH invite — and
 *   COACH was the form's DEFAULT, so the first choice offered was one that
 *   always failed.
 * - PLAYER not: players join a club by booking (#229), and a PLAYER invite
 *   accepted by a club account is refused by kind.
 *
 * The use case keeps the wider list because acceptance ranks an invite against
 * an existing role by its position there; open invites already sent for COACH
 * or PLAYER must still rank, and still refuse, the way they did.
 */
export const INVITE_ROLES = ['MANAGER', 'STAFF'] as const satisfies readonly Role[];

/** What the invite form starts on: the least privilege it offers. */
export const DEFAULT_INVITE_ROLE: (typeof INVITE_ROLES)[number] = 'STAFF';

export function isInviteRole(role: string): role is (typeof INVITE_ROLES)[number] {
  return (INVITE_ROLES as readonly string[]).includes(role);
}
