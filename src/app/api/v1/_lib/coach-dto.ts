import type { MyCoachProfile } from '@/app-layer/usecases/coach-profile';
import type {
  CoachApplication,
  CoachApplicationItem,
  CoachDecisionResult,
} from '@/app-layer/usecases/coach-approval';
import type { PublicCoach } from '@/app-layer/usecases/coach-directory';
import type {
  CoachRating,
  CoachReviewsPage,
  CreatedCoachReview,
} from '@/app-layer/usecases/coach-reviews';
import type { MyCoachLink } from '@/app-layer/usecases/coach-links';
import type {
  BookedLesson,
  LessonLink,
  LessonOffer,
  MyLesson,
} from '@/app-layer/usecases/coach-lessons';
import { rfc3339 } from '@/app/api/v1/_lib/dto';
import { bookingCutoffHours } from '@/lib/booking/cutoff';
import { coachFeeCents } from '@/lib/coaches/lessons';

/** The shapes the coach routes answer with (#545): dates as RFC 3339, nothing else changed. */

const at = (d: Date | null) => (d ? rfc3339(d) : null);

const certificate = (
  c: { fileName: string; mimeType: string; byteSize: number; uploadedAt: Date } | null,
) =>
  c
    ? {
        fileName: c.fileName,
        mimeType: c.mimeType,
        byteSize: c.byteSize,
        uploadedAt: rfc3339(c.uploadedAt),
      }
    : null;

export function toMyCoachProfile(p: MyCoachProfile) {
  return {
    state: p.state,
    slug: p.slug,
    bio: p.bio,
    qualifications: p.qualifications,
    sports: p.sports.map((s) => ({ sport: s.sport, levelMin: s.levelMin, levelMax: s.levelMax })),
    certificate: certificate(p.certificate),
    submittedAt: at(p.submittedAt),
    decidedAt: at(p.decidedAt),
    decisionNote: p.decisionNote,
    missing: p.missing,
    canEdit: p.canEdit,
  };
}

export function toCoachApplicationItem(i: CoachApplicationItem) {
  return {
    userId: i.userId,
    name: i.name,
    slug: i.slug,
    status: i.status,
    submittedAt: at(i.submittedAt),
    decidedAt: at(i.decidedAt),
    sports: i.sports.map((s) => ({ sport: s.sport, levelMin: s.levelMin, levelMax: s.levelMax })),
    bio: i.bio,
    qualifications: i.qualifications,
    decisionNote: i.decisionNote,
    certificate: certificate(i.certificate),
    // Lessons not yet started: what removing the coach would cancel.
    upcomingLessons: i.upcomingLessons,
  };
}

export function toCoachApplication(a: CoachApplication) {
  return {
    ...toCoachApplicationItem(a),
    decidedByUserId: a.decidedByUserId,
  };
}

export function toCoachDecision(d: CoachDecisionResult) {
  return {
    userId: d.userId,
    status: d.status,
    decidedAt: rfc3339(d.decidedAt),
    // How many lessons a removal cancelled; 0 for the other decisions.
    cancelledLessons: d.cancelledLessons.length,
  };
}

// ─── A coach and a club's venue (#546) ──────────────────────────────────────

export function toMyCoachLinks(v: { approved: boolean; links: MyCoachLink[] }) {
  return {
    /** Whether the platform approved the coach's profile: asking a club needs it. */
    approved: v.approved,
    links: v.links.map((l) => ({
      id: l.id,
      status: l.status,
      startedBy: l.startedBy,
      club: l.club,
      venue: l.venue,
      lengthOptions: l.lengthOptions,
      hourlyRateCents: l.hourlyRateCents,
      groupRateCents: l.groupRateCents,
      currency: l.currency,
      lessonMinutes: l.lessonMinutes,
      cancelCutoffHours: l.cancelCutoffHours,
      hours: l.hours,
      missing: l.missing,
      createdAt: rfc3339(l.createdAt),
      decidedAt: at(l.decidedAt),
      endedAt: at(l.endedAt),
    })),
  };
}

// ─── Finding a coach (#547) ─────────────────────────────────────────────────

/** A coach as the public sees them. Nothing here needs a date turned into text. */
export function toPublicCoach(c: PublicCoach) {
  return {
    slug: c.slug,
    name: c.name,
    avatarUrl: c.avatarUrl,
    bio: c.bio,
    qualifications: c.qualifications,
    sports: c.sports.map((s) => ({ sport: s.sport, levelMin: s.levelMin, levelMax: s.levelMax })),
    fromRateCents: c.fromRateCents,
    currency: c.currency,
    rating: toCoachRating(c.rating),
    venues: c.venues.map((v) => ({
      linkId: v.linkId,
      venueId: v.venueId,
      name: v.name,
      city: v.city,
      publicSlug: v.publicSlug,
      timezone: v.timezone,
      club: v.club,
      sports: v.sports,
      hourlyRateCents: v.hourlyRateCents,
      groupRateCents: v.groupRateCents,
      currency: v.currency,
      lessonMinutes: v.lessonMinutes,
    })),
  };
}

/** A coach's rating (#551): the weighted average, rounded to one place, and the count. */
export function toCoachRating(r: CoachRating) {
  return { avgRating: Math.round(r.avgRating * 10) / 10, reviewCount: r.reviewCount };
}

/** One page of a coach's published reviews (`GET /coaches/{slug}/reviews`). */
export function toCoachReviewsPage(p: CoachReviewsPage) {
  return {
    rating: toCoachRating(p.rating),
    items: p.reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      body: r.body,
      author: r.author,
      createdAt: rfc3339(r.createdAt),
      mine: r.mine,
    })),
    nextCursor: p.nextCursor,
  };
}
export type CoachReviewsPageDto = ReturnType<typeof toCoachReviewsPage>;

/** The review just written (`POST /me/bookings/{id}/coach-review`). */
export function toCreatedCoachReview(r: CreatedCoachReview) {
  return {
    id: r.id,
    bookingId: r.bookingId,
    rating: r.rating,
    body: r.body,
    status: r.status,
    createdAt: rfc3339(r.createdAt),
  };
}

/** The times a lesson can start on one day (`GET /coaches/{slug}/lesson-times`). */
export function toLessonTimes(input: {
  link: LessonLink;
  date: string;
  minutes: number;
  times: LessonOffer[];
}) {
  const { link } = input;
  return {
    linkId: link.linkId,
    venue: { id: link.venue.id, name: link.venue.name, timezone: link.venue.timezone },
    date: input.date,
    minutes: input.minutes,
    currency: link.currency,
    // One player's fee for this length; the same at every time.
    coachFeeCents: coachFeeCents(link.hourlyRateCents, input.minutes),
    // From the second player on; null when the coach gives no group lessons.
    groupFeeCents:
      link.groupRateCents === null ? null : coachFeeCents(link.groupRateCents, input.minutes),
    // How long before the start the player may still cancel: the stricter of
    // the club's cutoff and the coach's (owner decision 7).
    cancelCutoffHours: bookingCutoffHours(link.venueCutoffHours, link.cancelCutoffHours),
    times: input.times.map((t) => ({
      startTs: rfc3339(t.startTs),
      endTs: rfc3339(t.endTs),
      sport: t.sport,
      court: { id: t.resourceId, name: t.courtName },
      courtPriceCents: t.courtPriceCents,
      totalCents: t.totalCents,
    })),
  };
}

export type LessonTimesDto = ReturnType<typeof toLessonTimes>;

/** The lesson on a booking: who teaches it and what each part costs. */
export function toBookedLesson(l: BookedLesson) {
  return {
    id: l.lessonId,
    coach: { slug: l.coach.slug, name: l.coach.name },
    minutes: l.minutes,
    coachFeeCents: l.coachFeeCents,
    groupFeeCents: l.groupRateCents === null ? null : coachFeeCents(l.groupRateCents, l.minutes),
    courtPriceCents: l.courtPriceCents,
    totalCents: l.totalCents,
    currency: l.currency,
  };
}

export type BookedLessonDto = ReturnType<typeof toBookedLesson>;

/** One lesson as its coach sees it (`GET /me/coach-lessons`). */
export function toMyLesson(l: MyLesson) {
  return {
    id: l.lessonId,
    bookingId: l.bookingId,
    status: l.status,
    startTs: rfc3339(l.startTs),
    endTs: rfc3339(l.endTs),
    venue: { id: l.venue.id, name: l.venue.name, timezone: l.venue.timezone },
    club: l.club,
    court: { name: l.court.name, sport: l.court.sport },
    player: l.player ? { name: l.player.name, level: l.player.level, phone: l.player.phone } : null,
    players: l.players,
    coachFeeCents: l.coachFeeCents,
    currency: l.currency,
  };
}

export type MyLessonDto = ReturnType<typeof toMyLesson>;
