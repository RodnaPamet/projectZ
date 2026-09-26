import { NextResponse } from 'next/server';

import { MIN_REASON_LENGTH } from '@/lib/db/platform-admin-context';
import { getRequestId } from '@/lib/observability/context';

/**
 * The stated reason for a platform action, or the 400 that refuses it.
 *
 * ═══ WHY THERE IS NO DEFAULT ═══
 *
 * The first draft of these routes defaulted it — `'routine review of club
 * records'` — when the caller sent none. It satisfied the 12-character minimum,
 * so the audit row was always written and always well-formed.
 *
 * And always useless. The minimum exists because, as
 * `PlatformReasonRequiredError` puts it, "the reason is what makes the row
 * answerable months later, and 'looked at data' answers nothing". A reason the
 * SERVER supplied answers less than nothing: it reads like a statement by the
 * person who looked, and it is not one. Six months on, a row saying "routine
 * review of club records" is indistinguishable from a row where somebody
 * actually meant it.
 *
 * So the parameter is required. That makes the endpoint marginally harder to
 * poke at from a browser bar, which is the correct direction for the highest
 * privilege in the system, and it matches the decision to keep granting on the
 * CLI rather than in a UI.
 *
 * ═══ WHY THE ROUTE CHECKS RATHER THAN LETTING THE BINDING THROW ═══
 *
 * `runAsPlatformAdmin` already refuses a short reason with
 * `PlatformReasonRequiredError` — which is unmapped, and therefore a 500. That
 * is right when a ROUTE hardcoded something useless: a programmer error should
 * be loud. It is wrong when the caller sent `?reason=oops`, which is an
 * ordinary bad request and must not page anybody.
 */
/**
 * ═══ AND AN UPPER BOUND ═══
 *
 * `platform_audit_entry.reason` is `text`, the row is append-only by trigger,
 * and these are GETs — which `defineV1Route` cannot rate-limit, because
 * `resolveRateLimitScope` returns null for a non-mutating method before it
 * reads the options. So a caller holding any live grant could write megabytes
 * into a table nobody can prune, one request at a time.
 *
 * 500 characters is far more than a reason needs and far less than a problem.
 * The failure it prevents is storage, not disclosure, so the cap is generous.
 */
const MAX_REASON_LENGTH = 500;

export type ReasonResult = { ok: true; reason: string } | { ok: false; response: NextResponse };

export function readPlatformReason(params: URLSearchParams): ReasonResult {
  const reason = params.get('reason')?.trim() ?? '';

  // ═══ A BYTE POSTGRES CANNOT STORE ═══
  //
  // `text` rejects U+0000 outright, so a reason containing one makes the INSERT
  // throw — after the request has passed authentication, authority and the
  // capability check. The resulting PrismaClientKnownRequestError is unmapped,
  // so it surfaced as a 500 on an endpoint whose 500s are worth waking for.
  //
  // Checked here with the other input validation, because that is what it is.
  if (reason.includes('\u0000')) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: 'REASON_REQUIRED',
            requestId: getRequestId(),
            message:
              'That reason contains a character the audit log cannot store. Send plain text.',
          },
        },
        { status: 400 },
      ),
    };
  }

  if (reason.length > MAX_REASON_LENGTH) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: 'REASON_TOO_LONG',
            requestId: getRequestId(),
            message:
              `A reason may be at most ${MAX_REASON_LENGTH} characters. It goes into an ` +
              `append-only row that cannot be edited or pruned; put the detail in the ticket ` +
              `and the ticket number here.`,
          },
        },
        { status: 400 },
      ),
    };
  }

  if (reason.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: 'REASON_REQUIRED',
            // The wrapper stamps this on errors it maps; an inline response has
            // to do it itself, and the Error schema promises it is here.
            requestId: getRequestId(),
            message:
              `This endpoint records why it was called, in an append-only row nobody can ` +
              `edit afterwards. Send ?reason= with at least ${MIN_REASON_LENGTH} characters ` +
              `describing what you are looking into.`,
          },
        },
        { status: 400 },
      ),
    };
  }

  return { ok: true, reason };
}
