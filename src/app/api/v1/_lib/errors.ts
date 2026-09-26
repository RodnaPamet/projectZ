import { AppError, toApiErrorResponse, type ApiErrorResponse } from '@/lib/errors/types';

/**
 * Domain errors → HTTP.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 *
 * Thirty domain errors extend plain `Error`, not `AppError`. `toApiErrorResponse`
 * therefore maps every one of them to 500 INTERNAL: a player spending credit they
 * do not have gets "an unexpected internal server error occurred", and the client
 * cannot tell a rule it broke from an outage on our side.
 *
 * The fix is NOT to make the app layer extend `AppError`. `src/app-layer` imports
 * nothing from Next and knows nothing about HTTP — that is why it is portable to a
 * worker, a CLI, or an iOS-facing API in the first place. A use case should not
 * have an opinion about 409 versus 422.
 *
 * So the translation lives here, at the boundary where HTTP starts.
 *
 * ═══ WHY IT MATCHES ON `name`, NOT `instanceof` ═══
 *
 * `instanceof` would mean importing all thirty modules into every route bundle,
 * dragging Prisma, Stripe and the chess engine behind them. Every class in this
 * codebase assigns `this.name = '...'` explicitly in its constructor (verified:
 * 31 classes, 31 assignments), so the name survives minification, which is the
 * usual objection to matching on it.
 *
 * The cost is honest: renaming a class without updating this table silently
 * downgrades its route to a 500. `api-v1-error-map` pins the table against the
 * classes that actually exist.
 */

export interface ErrorMapping {
  status: number;
  /** Stable, machine-readable. A client switches on this, never on `message`. */
  code: string;
  /**
   * Sent to the client INSTEAD of the error's own message.
   *
   * The mapper otherwise echoes `error.message` verbatim, which is right for a
   * domain error whose message is written for the person who caused it —
   * "that slot is taken" explains itself.
   *
   * It is wrong when the message is written for a DEVELOPER. The platform
   * errors below say things like "asPlatformAdmin() was called without a live
   * platform grant. Platform authority is a row in platform_admin_grant with an
   * expiry, re-read from the database on every request." Useful in a stack
   * trace; free reconnaissance in a 403 body for anyone probing
   * `/api/v1/platform/*`.
   *
   * This repo already draws that line elsewhere: the 429 body deliberately
   * omits which limiter bucket was exhausted, because naming it "maps our
   * rate-limiting topology for anyone willing to trip it".
   */
  clientMessage?: string;
}

/**
 * The table.
 *
 * `expose` is not a field here: everything in this map is a rule the caller
 * broke, so the message is theirs to see. Anything NOT in the map falls through
 * to `toApiErrorResponse`, which defaults to a 500 with a generic message —
 * failing closed on disclosure, which is the right default for an error nobody
 * has classified yet.
 */
export const DOMAIN_ERROR_MAP: Readonly<Record<string, ErrorMapping>> = {
  // ── 400: the request itself is malformed ──────────────────────────
  InvalidBookingSpanError: { status: 400, code: 'INVALID_BOOKING_SPAN' },
  InvalidChannelIdError: { status: 400, code: 'INVALID_CHANNEL_ID' },
  InvalidCoordinateError: { status: 400, code: 'INVALID_COORDINATES' },
  RangeTooWideError: { status: 400, code: 'RANGE_TOO_WIDE' },
  // 400: the club asked for a role an Entra group may never grant. Retrying
  // with the same body cannot succeed.
  RoleNotMappableError: { status: 400, code: 'ROLE_NOT_MAPPABLE' },
  // 400, not 409. The club never offered that time — outside opening hours,
  // off the step grid, or not a whole number of billable units. Retrying
  // unchanged will never succeed, which is exactly what separates this from
  // SlotTakenError below.
  SlotNotBookableError: { status: 400, code: 'SLOT_NOT_BOOKABLE' },
  ShareSumMismatchError: { status: 400, code: 'SHARE_SUM_MISMATCH' },
  EmptyMessageError: { status: 400, code: 'EMPTY_MESSAGE' },
  UnsupportedCapabilityError: { status: 400, code: 'UNSUPPORTED_CAPABILITY' },
  GuestContactRequiredError: { status: 400, code: 'GUEST_CONTACT_REQUIRED' },
  PasswordBreachedError: { status: 400, code: 'PASSWORD_BREACHED' },
  WebhookSignatureError: { status: 400, code: 'WEBHOOK_SIGNATURE_INVALID' },

  // ── 402: the rule is about money, and the client can fix it ───────
  //
  // Not 403. A wallet that is short is not a permissions problem, and a client
  // that cannot tell them apart will show "access denied" for "top up first".
  InsufficientCreditError: { status: 402, code: 'INSUFFICIENT_CREDIT' },

  // ── 403: you may not, and retrying will not help ──────────────────
  AccountLockedError: { status: 403, code: 'ACCOUNT_LOCKED' },
  StravaTosViolationError: { status: 403, code: 'STRAVA_TOS_VIOLATION' },
  NotAParticipantError: { status: 403, code: 'NOT_A_PARTICIPANT' },
  UserBlockedError: { status: 403, code: 'USER_BLOCKED' },
  // You cannot review a venue you never visited. A precondition on the actor,
  // not on the payload — hence 403 rather than 400.
  NoProofOfVisitError: { status: 403, code: 'NO_PROOF_OF_VISIT' },

  // ── 400: a malformed platform request ─────────────────────────────
  //
  // An unknown cursor otherwise returns zero rows and therefore a null
  // nextCursor, which tells the caller the walk finished when it read nothing.
  // See platform-cursor.ts.
  UnknownPlatformCursorError: {
    status: 400,
    code: 'INVALID_CURSOR',
    // Spelled out here rather than imported from platform-cursor.ts, which
    // pulls in `next/server`. This module is imported by jsdom unit tests,
    // where `Request` does not exist — the same import-time-runtime mismatch
    // context.ts documents for `pg` and TextEncoder, and it fails the whole
    // suite rather than one assertion.
    clientMessage:
      'That cursor does not name a row. It may be from a different endpoint, or the row ' +
      'may have been removed. Start again from the first page.',
  },

  // ── 403: platform authority ───────────────────────────────────────
  //
  // These were UNMAPPED, and therefore 500s. `MissingPlatformGrantError` in
  // `src/app/api/v1/_lib/bind.ts` states in its own message that "an expired or
  // revoked grant is an ordinary 403" — so the routine denial path would have
  // paged somebody, and a probe would have been indistinguishable from a bug.
  //
  // Unreachable until the first platform route exists, which is why it had not
  // bitten. Each carries a clientMessage because their own messages are written
  // for whoever is debugging the binding, not for whoever was refused.
  MissingPlatformGrantError: {
    status: 403,
    code: 'PLATFORM_AUTHORITY_REQUIRED',
    clientMessage: 'Platform authority is required for this endpoint.',
  },
  MissingPlatformCapabilityError: {
    status: 403,
    code: 'PLATFORM_CAPABILITY_REQUIRED',
    // Deliberately does not name the missing capability: an enumeration of what
    // the caller lacks is a map of what exists. Somebody who needs to know what
    // their grant carries asks whoever can run the CLI — `--list` prints EVERY
    // live grant, not the caller's own, so it is not a self-service answer.
    clientMessage: 'Your platform grant does not carry the capability this endpoint needs.',
  },
  PlatformWriteNotEnabledError: {
    status: 403,
    code: 'PLATFORM_WRITE_NOT_ENABLED',
    clientMessage: 'Cross-club writes are not enabled.',
  },

  // ── 404: it is not there, or not there for you ────────────────────
  UnknownPlayerRatingError: { status: 404, code: 'UNKNOWN_PLAYER_RATING' },
  MappingNotFoundError: { status: 404, code: 'MAPPING_NOT_FOUND' },
  WearableNotConnectedError: { status: 404, code: 'WEARABLE_NOT_CONNECTED' },

  // ── 409: the world moved; the request was fine ────────────────────
  //
  // These are the ones a mobile client MUST distinguish, because every one of
  // them is "try again with fresh data", not "you did something wrong".
  SlotTakenError: { status: 409, code: 'SLOT_TAKEN' },
  AlreadyJoinedError: { status: 409, code: 'ALREADY_JOINED' },
  SessionFullError: { status: 409, code: 'SESSION_FULL' },
  TournamentStateError: { status: 409, code: 'TOURNAMENT_STATE' },
  IdempotencyRaceError: { status: 409, code: 'IDEMPOTENCY_RACE' },
  // The expiry sweeper (or another tab) moved the booking out of a cancellable
  // state between our read and our write. Refetch and the client will see why.
  BookingNotCancellableError: { status: 409, code: 'BOOKING_NOT_CANCELLABLE' },
  DuplicateGroupMappingError: { status: 409, code: 'DUPLICATE_GROUP_MAPPING' },
  PayoutsNotEnabledError: { status: 409, code: 'PAYOUTS_NOT_ENABLED' },
  VenueNotPayableError: { status: 409, code: 'VENUE_NOT_PAYABLE' },

  // ── 503: ours, not theirs, and retryable ──────────────────────────
  EngineUnavailableError: { status: 503, code: 'ENGINE_UNAVAILABLE' },
  ModerationUnavailableError: { status: 503, code: 'MODERATION_UNAVAILABLE' },

  // ── Deliberately ABSENT ───────────────────────────────────────────
  //
  // InvalidTenantIdError, InvalidUserIdError and NestedTenantContextError are
  // programmer errors on the tenancy path. They mean a caller wired something
  // wrong, never that the request was bad. They fall through to a 500 with a
  // generic message ON PURPOSE: the detail would describe our tenancy internals
  // to whoever triggered it, and a 4xx would invite a client to "fix" it.
};

/**
 * Translate any thrown value into the canonical envelope.
 *
 * `AppError` is checked FIRST: it already carries its own status and expose
 * flag, and a subclass that happened to share a name with a table entry must
 * not be silently re-mapped.
 */
export function toV1ErrorResponse(
  error: unknown,
  requestId?: string,
): { payload: ApiErrorResponse; status: number } {
  if (error instanceof AppError) return toApiErrorResponse(error, requestId);

  const name = error instanceof Error ? error.name : '';
  const mapped = DOMAIN_ERROR_MAP[name];

  if (!mapped) return toApiErrorResponse(error, requestId);

  return {
    status: mapped.status,
    payload: {
      error: {
        code: mapped.code,
        // The mapping's own wording wins when it has one — see ErrorMapping.
        message: mapped.clientMessage ?? (error as Error).message,
        requestId,
      },
    },
  };
}
