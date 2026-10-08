/**
 * A deleted account (#370): what its tombstone looks like, and how a screen
 * tells one apart.
 *
 * Pure: no Prisma, no server. The repositories, the DTO mappers and client
 * components all ask the same question, and a client bundle must not pull a
 * database client in to ask it.
 */

/**
 * The address a tombstone carries instead of the person's. `.invalid` is a
 * reserved top-level domain (RFC 2606): it never resolves and never delivers.
 * The CHECK `app_user_deleted_is_scrubbed` (P52) pins exactly this shape.
 */
export const DELETED_EMAIL_DOMAIN = 'deleted.playerz.invalid';

export function tombstoneEmail(userId: string): string {
  return `deleted-${userId}@${DELETED_EMAIL_DOMAIN}`;
}

/** A row carrying `deletedAt`: the account was deleted. */
export function isDeletedAccount(row: { deletedAt?: Date | string | null } | null | undefined) {
  return row?.deletedAt != null;
}

/**
 * The address a tombstone carries, recognised without the row: for a read that
 * has only the email (a list built before `deletedAt` was selected, a log).
 */
export function isTombstoneEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.endsWith(`@${DELETED_EMAIL_DOMAIN}`);
}

/** `where` for the accounts that still exist. */
export const LIVE_ACCOUNT = { deletedAt: null } as const;
