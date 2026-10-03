/**
 * What a failed v1 call throws in the browser.
 *
 * ═══ WHY A CLASS WITH `status` AS A PROPERTY ═══
 *
 * Upstream learned this the expensive way (#2222 in its session-expiry seam):
 * three of its fetchers threw `new Error(\`upcoming-count ${res.status}\`)`,
 * with the status in the MESSAGE, and the SWR `onError` that reads
 * `err.status` could never see them — so the 401 seam it was written for was
 * dead for exactly the pollers that motivated it. Every v1 failure here is an
 * `ApiClientError`, so the seam, the viewer check and the UI all switch on the
 * same two fields: `status` and the envelope's `code`, never on `message`.
 *
 * `status` 0 with code NETWORK is a request that never got an answer (offline,
 * DNS, a CORS refusal). An abort is NOT wrapped: an `AbortError` is the caller
 * cancelling, and SWR and React both expect to see it as one.
 */
export class ApiClientError extends Error {
  readonly status: number;
  /** The envelope's machine-readable code: `SLOT_TAKEN`, `VIEWER_CHANGED`, … or `NETWORK`/`UNKNOWN`. */
  readonly code: string;
  /** From the body when the server put one there, else the `x-request-id` header. */
  readonly requestId: string | null;
  readonly details: unknown;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    requestId?: string | null;
    details?: unknown;
  }) {
    super(input.message);
    this.name = 'ApiClientError';
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId ?? null;
    this.details = input.details;
  }
}

export function isApiClientError(e: unknown): e is ApiClientError {
  return e instanceof ApiClientError;
}
