/**
 * Where the coaches module lives (#377), in one place: the navigation, the
 * breadcrumbs, the sitemap and the notifications all point here, and a
 * notification must not import the layout to learn an address.
 */

/** «Треньори»: the coaches a player can book. Public. */
export const COACHES_HREF = '/coaches';

/** One coach's public page, by their page address. */
export function coachPath(slug: string): string {
  return `${COACHES_HREF}/${encodeURIComponent(slug)}`;
}

/** A coach's own profile, clubs and days off. */
export const COACH_PROFILE_HREF = '/me/coach';

/** The platform owner's queue of coach profiles. */
export const PLATFORM_COACHES_HREF = '/platform/coaches';
