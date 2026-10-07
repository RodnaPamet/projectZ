import type { Metadata } from 'next';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';

import { previewBookingInvite } from '@/app-layer/usecases/booking-players';
import { readMyAccountKind } from '@/app-layer/usecases/account-kind';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Caption, Heading } from '@/components/ui/typography';
import { requireSignedIn } from '@/lib/auth/page-context';
import { KIND_CHOOSER_PATH } from '@/lib/auth/landing';
import { bookingInvitePath } from '@/lib/booking/invite-path';
import { ViewerScope } from '@/lib/data/provider';
import { resourceNoun } from '@/lib/sports/resource-kinds';

import { JoinBookingButton } from './JoinBookingButton';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('bookingInvite');
  return {
    title: t('metaTitle'),
    // The URL is a working invitation. No referrer leaves this page with it,
    // and no search engine keeps it.
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
  };
}

/**
 * /invite/booking/{token}: a booking invite link (#358, Q29).
 *
 * Beside the staff invite (`/invite/{token}`), not inside it: that one adds a
 * member to a club, this one adds a player to a game, and the static
 * `booking` segment keeps the two routes apart.
 *
 * ═══ THE GAME FIRST, THEN THE SIGN-IN ═══
 *
 * Signed out is the normal case. The page shows where and when, the court and
 * who invited you by first name (`previewBookingInvite`, nothing private),
 * then asks the visitor to sign in with `?next=` back here, so the link is
 * not lost on the round trip. A bare sign-in screen from a chat link reads
 * like phishing.
 *
 * Signed in: "Включи се" adds the caller, and only the caller, through
 * `POST /api/v1/booking-invites/accept` (rate-limited), then opens the
 * booking. An account that has not chosen player or coach yet (#360) is sent
 * to the chooser first, and back here after.
 *
 * Every unusable link (expired at the start, stopped by the booker, the game
 * cancelled, never existed) is the same "this invitation no longer works", so
 * live links cannot be told from dead ones.
 */
export default async function BookingInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [t, tSports, format] = await Promise.all([
    getTranslations('bookingInvite'),
    getTranslations('sports'),
    getFormatter(),
  ]);

  const preview = await previewBookingInvite(token);

  if (!preview) {
    return (
      <div className="bg-bg-page text-content-default safe-area-x flex-1">
        <div className="in-shell:p-0 mx-auto max-w-md px-4 py-10 md:px-6 md:py-16">
          <EmptyState
            title={t('invalid.title')}
            description={t('invalid.description')}
            data-testid="booking-invite-invalid"
          />
        </div>
      </div>
    );
  }

  const userId = await requireSignedIn();
  const kind = userId ? await readMyAccountKind(userId) : undefined;
  const here = bookingInvitePath(token);

  const timeZone = preview.timezone;
  const date = format.dateTime(preview.startTs, { dateStyle: 'full', timeZone });
  const from = format.dateTime(preview.startTs, { timeStyle: 'short', timeZone });
  const to = format.dateTime(preview.endTs, { timeStyle: 'short', timeZone });

  return (
    <div className="bg-bg-page text-content-default safe-area-x flex-1">
      <div className="gap-section in-shell:p-0 mx-auto flex max-w-md flex-col px-4 py-10 md:px-6 md:py-16">
        <Heading level={1} className="break-words">
          {preview.bookerFirstName
            ? t('title', { name: preview.bookerFirstName })
            : t('titleNoName')}
        </Heading>

        <Card elevation="flat" density="compact" className="gap-compact flex flex-col">
          <div>
            <Caption>{t('when')}</Caption>
            <p className="text-content-default text-sm">{date}</p>
            <p className="text-content-default text-sm">
              {from} – {to}
            </p>
          </div>
          <div>
            <Caption>{t('where')}</Caption>
            <p className="text-content-default text-sm">{preview.venueName}</p>
            <p className="text-content-muted text-sm">{preview.venueCity}</p>
          </div>
          <div>
            <Caption>
              {t(resourceNoun(preview.resourceType) === 'track' ? 'track.court' : 'court')}
            </Caption>
            <p className="text-content-default text-sm">
              {preview.courtName} · {tSports(preview.sport as never)}
            </p>
          </div>
        </Card>

        <div className="gap-tight flex flex-col">
          <Caption data-testid="booking-invite-spots">
            {t('spotsLeft', { count: preview.spotsLeft })}
          </Caption>
          <Caption>{t('payAtClub')}</Caption>
        </div>

        {!userId ? (
          <div className="gap-tight flex flex-col">
            {/* `next` carries the link back through sign-in. A query-string
                link: auto prefetch, per the router-cache policy. */}
            <Link
              href={`/login?next=${encodeURIComponent(here)}`}
              className={buttonVariants({ variant: 'primary' })}
              data-testid="booking-invite-sign-in"
            >
              {t('signInToJoin')}
            </Link>
            <Caption>{t('signInNote')}</Caption>
          </div>
        ) : kind === null ? (
          <div className="gap-tight flex flex-col">
            <Link
              href={`${KIND_CHOOSER_PATH}?next=${encodeURIComponent(here)}`}
              className={buttonVariants({ variant: 'primary' })}
              data-testid="booking-invite-choose-kind"
            >
              {t('chooseKindFirst')}
            </Link>
            <Caption>{t('chooseKindNote')}</Caption>
          </div>
        ) : (
          <ViewerScope viewerId={userId}>
            <JoinBookingButton token={token} full={preview.spotsLeft <= 0} />
          </ViewerScope>
        )}
      </div>
    </div>
  );
}
