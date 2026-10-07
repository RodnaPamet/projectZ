import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { listMyBookings } from '@/app-layer/usecases/my-bookings';
import { REVIEW_MAX_LENGTH } from '@/app-layer/usecases/reviews';
import { toMyBookingDto } from '@/app/api/v1/_lib/dto';
import { playerChrome } from '@/components/layout/player-chrome';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { KIND_CHOOSER_PATH } from '@/lib/auth/landing';
import { requireSignedIn } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';

import { MyBookingsTabs } from './MyBookingsTabs';
import { bookingTabFrom } from './tabs';

export async function generateMetadata() {
  const t = await getTranslations('myBookings');
  return { title: t('metaTitle') };
}

/**
 * The first page a signed-in player has that is about THEM.
 *
 * Until now every authenticated route was tenant admin, gated on a membership
 * a new player does not hold — so signing in led nowhere at all (#224).
 *
 * ═══ IT SPANS CLUBS, AND THAT IS THE POINT ═══
 *
 * `/api/v1/t/{slug}/bookings` is per club, because a club's API should be. A
 * PERSON's list is not: they booked padel at one club and tennis at another,
 * and a list showing one of them is wrong in a way they cannot see — the
 * missing booking looks like one that failed. `GET /api/v1/me/bookings` (T16)
 * is the cross-club list, for the web and the native app alike.
 *
 * ═══ A SERVER SEED, THEN THE SAME ENDPOINT AS iOS (T22) ═══
 *
 * This page reads page one on the server, through the same use case and the
 * same mapper (`toMyBookingDto`) as `GET /api/v1/me/bookings`, so the first
 * paint is the list and not a skeleton. `MyBookingsList` then holds it under
 * that endpoint's SWR key and revalidates once after paint (one GET), on tab
 * focus, and after a review; "load more" follows the endpoint's cursor. Seed
 * and endpoint share one mapper, with dates as RFC 3339 strings, so the first
 * revalidation cannot swap one shape for another under the person's thumb.
 *
 * The review write goes to `POST /api/v1/t/{slug}/bookings/{id}/review`, the
 * route the native app calls; the Server Action that used to carry it is
 * gone. It could not, before EDGE-250 (#265): the edge refused that route to a
 * token without the club in its memberships, and a player who joined a club BY
 * booking it had no such claim until they signed in again.
 *
 * ViewerScope sends this page's user id with every read and write, so a tab
 * left open across a switch to another account (#263) is refused 409
 * VIEWER_CHANGED rather than shown, or reviewing as, the other account.
 *
 * A CLUB account is redirected to its own landing: it has no bookings to
 * make (#263).
 *
 * ═══ IT IS WHERE A PLAYER LANDS (#227) ═══
 *
 * Until the player UI exists (#224) this is `PLAYER_HOME` — the page sign-in
 * sends every player to. So it wears the player chrome, from
 * `(public)/layout.tsx` (the player's AppShell since #362): without one a
 * player landed on a page with no sign-out.
 */
export default async function MyBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const userId = await requireSignedIn();
  if (!userId) redirect('/login?next=/me/bookings');

  // Предстоящи or Минали (#359). Only the open tab is seeded; see MyBookingsTabs.
  const tab = bookingTabFrom((await searchParams).tab);

  // ═══ NOT A PAGE FOR A CLUB ACCOUNT (#263, audit C12) ═══
  //
  // A CLUB account cannot book (PLAYER_ACCOUNT_REQUIRED), so a list inviting
  // it to "choose a court and book" is a promise the API then breaks. It is
  // sent where it lands after sign-in: its club's diary, or home when its club
  // is not live. The read is the chrome's, request-cached, so it costs no
  // second query.
  const { kind, landing } = await playerChrome();
  if (kind === 'club' && landing) redirect(landing.href);
  // An account that has not chosen player or coach (#360, audit U01) is asked
  // first, rather than shown an empty list it has no reason to be on.
  if (landing?.href === KIND_CHOOSER_PATH) redirect(KIND_CHOOSER_PATH);
  // A coach has the player UI until the coach profile ships (#377), and is told so.
  const coach = landing?.reason === 'coach';

  const [t, page] = await Promise.all([
    getTranslations('myBookings'),
    // No cursor and no limit: the endpoint's own defaults, so the seed is
    // exactly what the tab's key, `/api/v1/me/bookings?when=…`, answers.
    listMyBookings({ userId, when: tab }),
  ]);

  const seed = { items: page.items.map((b) => toMyBookingDto(b)), nextCursor: page.nextCursor };

  return (
    // The chrome, its <main> and the notch inset are the layout's (#362).
    // safe-area-x and px-6 on DIFFERENT elements: `.safe-area-x` is unlayered
    // CSS and beats Tailwind's px-6, which on a phone with no side inset set
    // the gutter to 0 (see venues/page.tsx). Inside the shell the frame pads.
    <div className="bg-bg-page text-content-default safe-area-x flex-1">
      <div className="in-shell:p-0 px-6 py-10">
        <Heading level={1} className="mb-section">
          {t('title')}
        </Heading>

        {coach ? (
          <InlineNotice variant="info" className="mb-section" data-testid="coach-notice">
            {t('coachNotice')}
          </InlineNotice>
        ) : null}

        <ViewerScope viewerId={userId}>
          <MyBookingsTabs initialTab={tab} seed={seed} reviewMaxLength={REVIEW_MAX_LENGTH} />
        </ViewerScope>
      </div>
    </div>
  );
}
