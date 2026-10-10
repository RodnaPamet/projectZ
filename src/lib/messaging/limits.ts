/**
 * Messaging's numbers (#375), in a module with no imports so the contract test
 * and the screens can read them without the database.
 */

/**
 * A message longer than this, AFTER sanitising, is a document, not a message.
 * The OpenAPI spec is pinned to it rather than restating it
 * (tests/unit/messaging-body-bound.test.ts): in Agrent the two drifted by
 * exactly 2x, and a client trusting the document was refused with a code the
 * document did not list (agri-saas #1391).
 */
export const MAX_BODY_LENGTH = 4000;

/**
 * The request validator's outer bound, LOOSER on purpose: the use case
 * measures after sanitising, and a validator at 4000 would refuse first with a
 * generic 400, making `MESSAGE_TOO_LONG` — the code a client switches on —
 * unreachable.
 */
export const BODY_VALIDATOR_MAX = 8000;
