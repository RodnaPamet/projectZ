import { type NextRequest } from 'next/server';

import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { noContent } from '@/app/api/v1/_lib/envelope';
import { API_MUTATION_LIMIT } from '@/lib/security/rate-limit';
import { isBeaconEvent } from '@/lib/usage/events';
import { countUsage } from '@/lib/usage/record';

/**
 * POST /api/v1/venues/{id}/usage-events — "a slot was picked" or "the confirm
 * sheet was opened" on this venue's page (#371).
 *
 * ═══ THE ONE FUNNEL STEP THE BROWSER REPORTS ═══
 *
 * Every other usage event is counted on the server where it already happens
 * (the pages, the availability read, the booking). These two happen only in
 * the browser, so the venue page sends one small POST with `{ "event": … }`
 * and nothing else: no user, no session, no device id. The browser sends it
 * with `credentials: 'omit'` (src/lib/data/usage-beacon.ts), so not even the
 * session cookie comes along, and this route reads no cookie and sets none.
 *
 * ═══ IT ALWAYS ANSWERS 204 ═══
 *
 * Whatever the body, and whether or not the venue exists or is public: the
 * caller is a fire-and-forget beacon that never reads the answer, and a
 * different answer for an unknown venue would turn this into a probe. An
 * unknown or hidden venue simply counts nothing (`recordUsage` inserts only
 * for a publicly listed venue). The count itself is written after the
 * response, and crawlers are not counted.
 *
 * ═══ ITS OWN RATE-LIMIT BUCKET ═══
 *
 * The default mutation limit, in a scope of its own: someone tapping through
 * forty slots must never spend the budget their booking POST draws on.
 *
 * No database binding here: `countUsage` binds its own (src/lib/usage/record.ts).
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body: unknown = await req.json().catch(() => null);
  const event = body && typeof body === 'object' ? (body as { event?: unknown }).event : null;

  if (isBeaconEvent(event) && id.length > 0 && id.length <= 64) {
    countUsage(event, { venueId: id }, { userAgent: req.headers.get('user-agent') });
  }
  return noContent();
}

export const POST = defineV1Route(handler, {
  rateLimit: { config: API_MUTATION_LIMIT, scope: 'usage-beacon' },
});
