/**
 * "This tab was rendered for one account, and the browser is now signed in as
 * another." The twin of `@/lib/auth/session-expiry`, for #263.
 *
 * Since one person routinely holds a player account and a club account, signing
 * in as the second in another tab is ordinary. Player data keys carry no user
 * id (`/api/v1/t/{slug}/bookings` means "mine"), so without this a stale tab
 * would fetch the NEW account's data and cache it under the old one's page.
 * The fetcher sends the page's user id as `x-playerz-viewer`; the server
 * answers 409 VIEWER_CHANGED when it is not the signed-in user, and the fetcher
 * records it here.
 *
 * Module scope and one-way for the same reasons the session store gives: a
 * revalidation already scheduled closes over its bindings and can never see a
 * `setState`, and nothing short of a reload makes the page right again — it has
 * to be rendered for the person who is signed in now.
 */

let changed = false;
const listeners = new Set<() => void>();

export function isViewerChanged(): boolean {
  return changed;
}

/** Record the change. Listeners fire once, on the false → true transition. */
export function noteViewerChanged(): void {
  if (changed) return;
  changed = true;
  for (const fn of [...listeners]) fn();
}

export function subscribeViewerChanged(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Test-only reset: the store is one-way in production. */
export function __resetViewerForTests(): void {
  changed = false;
  listeners.clear();
}
