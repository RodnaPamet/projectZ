import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getMyBooking } from '@/app-layer/usecases/my-bookings';
import { toMyBookingDetailDto } from '@/app/api/v1/_lib/dto';
import { bookingsCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { playerChrome } from '@/components/layout/player-chrome';
import { requireSignedIn } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';

import { BookingDetail } from './BookingDetail';

export async function generateMetadata() {
  const t = await getTranslations('myBookings.detail');
  return { title: t('metaTitle') };
}

/**
 * The server's clock at render: the first paint's "has the cancellation cutoff
 * passed?", so the browser hydrates the same answer the server rendered. A
 * request-time read on a dynamic page, once per render.
 */
function renderedAt(): number {
  return Date.now();
}

/**
 * /me/bookings/{id}: one of the player's own bookings (#359, audit P04).
 *
 * Read on the server through `getMyBooking` and `toMyBookingDetailDto`, the
 * use case and mapper behind `GET /api/v1/me/bookings/{id}`, so the first
 * paint is the booking and the client's revalidation cannot change its shape.
 *
 * Somebody else's booking, or an id that never existed, is the app's 404, the
 * answer the API gives: the read is scoped to the session's own bookings, so
 * there is nothing else it could find. A CLUB account is sent where it lands,
 * as on the list (#263).
 */
export default async function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireSignedIn();
  if (!userId) redirect(`/login?next=${encodeURIComponent(`/me/bookings/${id}`)}`);

  const { kind, landing } = await playerChrome();
  if (kind === 'club' && landing) redirect(landing.href);

  const [booking, tNav] = await Promise.all([
    getMyBooking({ userId, bookingId: id }),
    getTranslations('common.nav'),
  ]);
  if (!booking) notFound();
  const seed = toMyBookingDetailDto(booking);

  return (
    <div className="bg-bg-page text-content-default safe-area-x flex flex-1 flex-col">
      {/* Резервации / the booking's venue, its heading (#362), in the top bar
          from md. Not inline on a phone: the page's "‹ Резервации" is its own
          way back there, and a second one would say it twice. */}
      <PageBreadcrumbs items={bookingsCrumbs(tNav, seed.venue.name)} className="hidden" />
      <ViewerScope viewerId={userId}>
        <BookingDetail seed={seed} serverNow={renderedAt()} />
      </ViewerScope>
    </div>
  );
}
