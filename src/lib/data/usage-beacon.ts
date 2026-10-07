import type { BeaconEvent } from '@/lib/usage/events';

import { V1 } from './keys';

/**
 * Tell the server a funnel step happened that only the browser sees (#371):
 * a slot picked, or the confirm sheet opened, on one venue's page.
 *
 * ═══ AS LITTLE AS A REQUEST CAN CARRY ═══
 *
 * The body is the event's name. `credentials: 'omit'` keeps even the session
 * cookie off it, so the server could not tell who sent it if it wanted to,
 * and the route sets no cookie (Q48: no tracker, no analytics cookie, so no
 * consent banner). `keepalive` lets it finish if the tap navigates away.
 *
 * ═══ FIRE AND FORGET ═══
 *
 * Called from the tap's handler, never from an effect; never awaited, and
 * every failure is swallowed. It is not `v1Fetch` on purpose: that one sends
 * the viewer header and marks the session stores, and this must carry and
 * change nothing. Counting must never break or slow the page.
 */
export function sendUsageBeacon(venueId: string, event: BeaconEvent): void {
  try {
    void fetch(V1.usageEvents(venueId), {
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
    }).catch(() => {});
  } catch {
    // No fetch (an old browser, a test runtime): nothing to count with.
  }
}
