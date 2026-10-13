/**
 * Leave for another page of this site with a full load, not a router push.
 *
 * For the rare moment the session cookie has just changed in a way the
 * client router's cache cannot know about (#462: the terms were accepted, and
 * the router may still hold the redirect that sent the person to the step).
 * A new request with the new cookie is the one thing certain to get past it.
 *
 * Its own module so a test can stand in for it: jsdom does not navigate.
 */
export function loadPage(to: string): void {
  window.location.assign(to);
}
