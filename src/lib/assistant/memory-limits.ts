/**
 * Bounds for «Какво помни асистентът», in a leaf module (agri-saas
 * `assistant-memory-limits.ts`): the route's body schema and the use case
 * both need them, and the use case imports the database.
 */

/** The longest a remembered point may be, edited or learned. */
export const REMEMBERED_POINT_MAX_CHARS = 280;

/**
 * At most this many points at once (memory rule 8). Not a page size: a list
 * longer than this means the sweep is accumulating instead of superseding.
 */
export const REMEMBERED_POINT_LIMIT = 50;
