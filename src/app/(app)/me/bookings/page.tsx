import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { canReview, listMyBookings } from '@/app-layer/usecases/my-bookings';
import { REVIEW_MAX_LENGTH } from '@/app-layer/usecases/reviews';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { requireSignedIn } from '@/lib/auth/page-context';

import { ReviewForm } from './ReviewForm';

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
 * missing booking looks like one that failed.
 *
 * ═══ EVERY TIME IS RENDERED IN THE VENUE'S TIMEZONE ═══
 *
 * Not the browser's, and not the server's. A court booked for 19:00 in Sofia
 * is at 19:00 in Sofia whoever is reading the page and wherever they are
 * standing — a player checking their booking from abroad must not be shown
 * 17:00 and turn up two hours late. `Venue.timezone` is stored per venue for
 * exactly this, and `startTs` is `timestamptz`, so the conversion is the only
 * step that can be got wrong.
 *
 * ═══ A PLAYED BOOKING IS WHERE A REVIEW STARTS ═══
 *
 * A COMPLETED booking — the proof of visit — offers "rate this venue" until the
 * player has reviewed that venue; after that it shows the review they left and
 * whether a moderator has passed it. One review per venue, so a second visit to
 * the same club shows the first review rather than a form that could only be
 * refused.
 *
 * ═══ IT IS WHERE A PLAYER LANDS (#227) ═══
 *
 * Until the player UI exists (#224) this is `PLAYER_HOME` — the page sign-in
 * sends every player to. So it carries the site header: without it a player
 * landed on a page with no sign-out, and anyone who also runs a club had no
 * switcher to get there.
 */
export default async function MyBookingsPage() {
  const userId = await requireSignedIn();
  if (!userId) redirect('/login?next=/me/bookings');

  const [t, tSports, locale] = await Promise.all([
    getTranslations('myBookings'),
    getTranslations('sports'),
    getLocale(),
  ]);

  const { items } = await listMyBookings({ userId });

  return (
    // The safe-area padding moves up a level so it clears the notch for the
    // site header rather than only for the content under it.
    <div className="bg-bg-page text-content-default safe-area-top safe-area-x min-h-screen">
      <SiteHeader />
      <main className="px-6 py-10">
        <header className="mb-8">
          <h1 className="text-content-emphasis text-3xl font-semibold">{t('title')}</h1>
        </header>

        {items.length === 0 ? (
          <div className="space-y-4">
            <EmptyState title={t('empty.title')} description={t('empty.description')} />
            <Link
              href="/venues"
              className="bg-bg-brand text-content-on-brand inline-flex h-10 items-center rounded-md px-4 text-sm font-medium"
            >
              {t('browse')}
            </Link>
          </div>
        ) : (
          <ul className="space-y-3">
            {items.map((b) => {
              if (!b) return null;
              const tz = b.resource.venue.timezone;

              const when = new Intl.DateTimeFormat(locale, {
                dateStyle: 'full',
                timeStyle: 'short',
                timeZone: tz,
              }).format(b.startTs);

              const until = new Intl.DateTimeFormat(locale, {
                timeStyle: 'short',
                timeZone: tz,
              }).format(b.endTs);

              const price = new Intl.NumberFormat(locale, {
                style: 'currency',
                currency: b.currency,
              }).format(b.totalCents / 100);

              return (
                <li
                  key={b.id}
                  className="border-border-subtle bg-bg-default rounded-lg border px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-content-emphasis font-medium">{b.resource.venue.name}</p>
                      <p className="text-content-muted text-sm">
                        {b.resource.name} · {tSports(b.resource.sport as never)}
                      </p>
                    </div>
                    <span className="text-content-muted shrink-0 text-xs">
                      {t(`status.${b.status}` as never)}
                    </span>
                  </div>

                  <p className="text-content-default mt-2 text-sm">
                    {when} – {until}
                  </p>
                  <p className="text-content-muted mt-1 text-sm">{price}</p>

                  {b.venueReview?.bookingId === b.id ? (
                    <p className="text-content-default mt-3 text-sm">
                      {t('review.yours', { rating: b.venueReview.rating })}{' '}
                      <span className="text-content-muted">
                        · {t(`review.status.${b.venueReview.status}` as never)}
                      </span>
                    </p>
                  ) : b.venueReview && b.status === 'COMPLETED' ? (
                    <p className="text-content-muted mt-3 text-sm">
                      {t('review.alreadyThisVenue')}
                    </p>
                  ) : canReview(b) && b.clubSlug ? (
                    <ReviewForm slug={b.clubSlug} bookingId={b.id} maxLength={REVIEW_MAX_LENGTH} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
