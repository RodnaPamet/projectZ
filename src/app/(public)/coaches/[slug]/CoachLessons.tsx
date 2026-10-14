import { lessonTimesFor } from '@/app-layer/usecases/coach-lessons';
import type { PublicCoach } from '@/app-layer/usecases/coach-directory';
import { readMyCoachProfile } from '@/app-layer/usecases/coach-profile';
import { toLessonTimes } from '@/app/api/v1/_lib/coach-dto';
import { bookingViewer } from '@/components/booking/booking-viewer';
import { CardListSkeleton } from '@/components/loading/shapes';
import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { Skeleton, SkeletonPill } from '@/components/ui/skeleton';
import { bookingDays } from '@/lib/booking/days';
import { ViewerScope } from '@/lib/data/provider';
import { logger } from '@/lib/observability/logger';

import { parseLessonPick } from './lesson-pick';
import { LessonBooking, type LessonVenue } from './LessonBooking';

/**
 * The coach page's second stage (#548): «Запишете урок», server-rendered
 * behind its own Suspense boundary in page.tsx, so who the coach is and what
 * they teach never waits for the times.
 *
 * The first choice's times are computed here by `lessonTimesFor`, the
 * function `GET /api/v1/coaches/{slug}/lesson-times` runs, and mapped by the
 * same `toLessonTimes`. `LessonBooking` holds them under that endpoint's SWR
 * key and revalidates after paint; every other venue, sport, length and day
 * is read through the endpoint when picked.
 *
 * "The first choice" is the coach's first venue (the cheapest), its first
 * sport and shortest lesson, today there; or whatever a sign-in round trip
 * came back with, so the visitor lands on the time they picked.
 */
export async function CoachLessons({
  coach,
  name,
  searchParams,
}: {
  coach: PublicCoach;
  /** The coach's name as the page shows it. */
  name: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const now = new Date();
  const venues: LessonVenue[] = coach.venues.map((v) => ({
    linkId: v.linkId,
    name: v.name,
    club: v.club.name,
    timezone: v.timezone,
    sports: v.sports,
    lessonMinutes: v.lessonMinutes,
    days: bookingDays(now, v.timezone),
  }));
  const pick = parseLessonPick(sp, venues);
  if (!pick) return null;

  const [{ me, kind, viewer }, seed] = await Promise.all([
    bookingViewer(),
    lessonTimesFor({
      linkId: pick.linkId,
      date: pick.day,
      minutes: pick.minutes,
      // One of the venue's own sports, checked by `parseLessonPick`.
      sport: (pick.sport || undefined) as Parameters<typeof lessonTimesFor>[0]['sport'],
      now,
    })
      .then(({ link, times }) =>
        toLessonTimes({ link, date: pick.day, minutes: pick.minutes, times }),
      )
      .catch((err: unknown) => {
        // The page is worth more than its first day of times: the picker
        // reads them again from the endpoint and shows its own retry.
        logger.warn('coach page: the first lesson times could not be read', {
          component: 'coach-page',
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }),
  ]);
  // The coach on their own page: one read, and only for a coach account.
  const own =
    me !== null && kind === 'coach'
      ? (await readMyCoachProfile(me.userId))?.slug === coach.slug
      : false;

  const booking = (
    <LessonBooking
      coach={{ slug: coach.slug, name }}
      venues={venues}
      initialPick={pick}
      seed={seed}
      renderedAt={now.toISOString()}
      viewer={viewer}
      own={own}
    />
  );
  // ViewerScope sends the signed-in user's id with the booking, so a tab left
  // open across a switch to another account is refused 409 VIEWER_CHANGED
  // rather than booking as that account (#263).
  return me ? <ViewerScope viewerId={me.userId}>{booking}</ViewerScope> : booking;
}

/**
 * What stands in for CoachLessons while the times are computed: the title,
 * the day picker and a block of times, the shapes LessonBooking paints. No
 * `data-perf-ready`: the perf harness would time it as the times.
 */
export function CoachLessonsSkeleton() {
  return (
    <RouteSkeleton className="flex flex-col gap-4">
      <Skeleton className="h-6 w-40" />
      <div className="flex gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonPill key={i} />
        ))}
      </div>
      <CardListSkeleton rows={1} lines={3} />
    </RouteSkeleton>
  );
}
