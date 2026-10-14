import type { CoachProfileStatus, PrismaClient } from '@prisma/client';

import { cancelBooking } from '@/app-layer/usecases/booking';
import { deliver, queueOperatorEmail } from '@/app-layer/usecases/notification-outbox';
import { openCertificate, type CertificateMime } from '@/lib/coaches/certificate';
import {
  COACH_DECISION_NOTE_MAX,
  tidyCoachText,
  type CoachSportInput,
} from '@/lib/coaches/profile';
import { runAsUserOnly } from '@/lib/db/rls-middleware';
import { contactInboxAddress } from '@/lib/email/contact-inbox';
import {
  coachBellCopy,
  coachDecisionEmail,
  coachSubmittedOperatorEmail,
  COACH_PROFILE_HREF,
  type CoachDecisionEvent,
} from '@/lib/notifications/coach-copy';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * WHO MAY TEACH HERE: the platform owner's side of a coach's profile (#545,
 * #377; owner decisions 13 and 17).
 *
 * ═══ WHO RUNS THIS ═══
 *
 * Every function that takes a `db` takes the one `asPlatformAdmin` hands out
 * under COACH_APPROVE: a live grant, a fresh second factor, and an audit row
 * already written naming the admin and the action. That handle is the only
 * one in the product that can write a decision (the database refuses it from
 * any other, P72) and the only one besides the coach's that can read the
 * certificate.
 *
 * ═══ THE THREE DECISIONS ═══
 *
 *   APPROVE   a SUBMITTED profile becomes APPROVED
 *   DECLINE   a SUBMITTED profile becomes DECLINED, with a note for the coach,
 *             who corrects it and sends it again. The certificate stays: it
 *             may be the thing to replace, and that is the coach's to do.
 *   REMOVE    an APPROVED coach becomes DECLINED, with a note. The certificate
 *             is DELETED (it is kept only while the coach is active, decision
 *             17), the coach's links to venues are ended, and every lesson
 *             they have not yet started is CANCELLED with it (decision 21):
 *             the courts are released and each player is told, by bell and
 *             email, after the removal commits. The queue shows how many
 *             lessons that is before the owner confirms.
 */

export class CoachApplicationNotFoundError extends Error {
  constructor() {
    super('No such coach profile.');
    this.name = 'CoachApplicationNotFoundError';
  }
}

/** The decision does not apply to the state the profile is in. */
export class CoachApplicationStateError extends Error {
  constructor(readonly status: CoachProfileStatus) {
    super(`That decision does not apply to a ${status} coach profile.`);
    this.name = 'CoachApplicationStateError';
  }
}

/**
 * More lessons still to teach than one removal cancels. Not a number a coach
 * reaches by teaching; it is there so that one request never tries to cancel
 * an unbounded number of bookings in one transaction.
 */
export class CoachHasUpcomingLessonsError extends Error {
  constructor(readonly lessons: number) {
    super(`The coach has ${lessons} lessons still to teach, more than one removal cancels.`);
    this.name = 'CoachHasUpcomingLessonsError';
  }
}

/** The most lessons one removal cancels. */
export const MAX_LESSONS_CANCELLED = 500;

export type CoachDecision = 'APPROVE' | 'DECLINE' | 'REMOVE';
export const COACH_DECISIONS: readonly CoachDecision[] = ['APPROVE', 'DECLINE', 'REMOVE'];

/** The states the queue lists. A draft is nobody's business but the coach's. */
export type CoachQueueStatus = Exclude<CoachProfileStatus, 'DRAFT'>;
export const COACH_QUEUE_STATUSES: readonly CoachQueueStatus[] = [
  'SUBMITTED',
  'APPROVED',
  'DECLINED',
];

export const COACH_QUEUE_PAGE_SIZE = 50;

interface CertificateMeta {
  fileName: string;
  mimeType: CertificateMime;
  byteSize: number;
  uploadedAt: Date;
}

/**
 * A profile as the queue lists it: everything the owner reads to decide,
 * so deciding takes one audited read of the list and one of the certificate,
 * not a third per coach.
 */
export interface CoachApplicationItem {
  userId: string;
  name: string | null;
  slug: string;
  status: CoachQueueStatus;
  submittedAt: Date | null;
  decidedAt: Date | null;
  sports: CoachSportInput[];
  bio: string | null;
  qualifications: string | null;
  /** The note with the last decline or removal. */
  decisionNote: string | null;
  /** What was uploaded; the file itself is `openCoachCertificate`. */
  certificate: CertificateMeta | null;
  /**
   * Lessons booked with them that have not started. Removing the coach
   * cancels exactly these (decision 21), so the queue says how many first.
   */
  upcomingLessons: number;
}

export interface CoachApplication extends CoachApplicationItem {
  decidedByUserId: string | null;
}

const CERT_META = { fileName: true, mimeType: true, byteSize: true, uploadedAt: true } as const;

const SPORTS = {
  select: { sport: true, levelMin: true, levelMax: true },
  orderBy: { sport: 'asc' },
} as const;

async function namesOf(db: PrismaClient, ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
    take: ids.length,
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

/**
 * One page of the queue. Waiting profiles oldest first (whoever sent theirs
 * first is read first); decided ones newest first. Keyset on the sort moment
 * and the account id.
 */
export async function listCoachApplications(
  db: PrismaClient,
  opts: { status: CoachQueueStatus; limit?: number; after?: string | null; now?: Date },
): Promise<{ items: CoachApplicationItem[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(opts.limit ?? COACH_QUEUE_PAGE_SIZE, COACH_QUEUE_PAGE_SIZE));
  const waiting = opts.status === 'SUBMITTED';
  const by = waiting ? ('submittedAt' as const) : ('decidedAt' as const);
  const dir = waiting ? ('asc' as const) : ('desc' as const);

  let cursor: { at: Date; userId: string } | null = null;
  if (opts.after) {
    const row = await db.coachProfile.findUnique({
      where: { userId: opts.after },
      select: { userId: true, status: true, submittedAt: true, decidedAt: true },
    });
    const at = row?.[by];
    // A cursor that no longer names a row of this list: the row was decided
    // or taken back since. The caller starts again rather than skip a page.
    if (!row || row.status !== opts.status || !at) throw new CoachApplicationNotFoundError();
    cursor = { at, userId: row.userId };
  }
  const beyond = cursor
    ? waiting
      ? {
          OR: [
            { submittedAt: { gt: cursor.at } },
            { submittedAt: cursor.at, userId: { gt: cursor.userId } },
          ],
        }
      : {
          OR: [
            { decidedAt: { lt: cursor.at } },
            { decidedAt: cursor.at, userId: { lt: cursor.userId } },
          ],
        }
    : {};

  const rows = await db.coachProfile.findMany({
    where: { status: opts.status, ...beyond },
    select: {
      userId: true,
      slug: true,
      status: true,
      submittedAt: true,
      decidedAt: true,
      bio: true,
      qualifications: true,
      decisionNote: true,
      sports: SPORTS,
    },
    orderBy: [{ [by]: dir }, { userId: dir }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const ids = page.map((r) => r.userId);
  const [names, certificates, lessons] = await Promise.all([
    namesOf(db, ids),
    db.coachCertificate.findMany({
      where: { userId: { in: ids } },
      // Never `content`: the list carries what was uploaded, not the file.
      select: { userId: true, ...CERT_META },
      take: COACH_QUEUE_PAGE_SIZE,
    }),
    // guardrail-allow: cross-tenant — how many lessons a removal would
    // cancel, at every club, counted by the coaches' accounts under the
    // platform admin's audited handle.
    db.coachLesson.groupBy({
      by: ['coachUserId'],
      where: { coachUserId: { in: ids }, ...notStarted(opts.now ?? new Date()) },
      _count: { _all: true },
    }),
  ]);
  const lessonsOf = new Map(lessons.map((l) => [l.coachUserId, l._count._all]));
  const certificateOf = new Map(
    certificates.map(({ userId, ...meta }) => [
      userId,
      { ...meta, mimeType: meta.mimeType as CertificateMime },
    ]),
  );
  return {
    items: page.map((r) => ({
      userId: r.userId,
      name: names.get(r.userId) ?? null,
      slug: r.slug,
      status: r.status as CoachQueueStatus,
      submittedAt: r.submittedAt,
      decidedAt: r.decidedAt,
      sports: r.sports,
      bio: r.bio,
      qualifications: r.qualifications,
      decisionNote: r.decisionNote,
      certificate: certificateOf.get(r.userId) ?? null,
      upcomingLessons: lessonsOf.get(r.userId) ?? 0,
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.userId ?? null) : null,
  };
}

/** The live links to venues one removal ends, at most. */
const MAX_LIVE_LINKS = 500;

/** How many lessons the coach still has to teach, at every club. */
/**
 * A lesson that is still on and has not started: what a removal cancels. One
 * already under way is left to finish; it is being taught as this runs.
 */
const notStarted = (now: Date) => ({ active: true, startTs: { gt: now } });

const upcomingLessons = (db: PrismaClient, userId: string, now: Date) =>
  // guardrail-allow: cross-tenant — a coach teaches at several clubs and is
  // removed from all of them at once; counted by the coach's account, under
  // the platform admin's audited handle.
  db.coachLesson.count({ where: { coachUserId: userId, ...notStarted(now) } });

/** One profile, as the owner reads it before deciding. Never a draft. */
export async function coachApplication(
  db: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<CoachApplication> {
  const [profile, certificate, names, lessons] = await Promise.all([
    db.coachProfile.findUnique({
      where: { userId },
      select: {
        userId: true,
        slug: true,
        bio: true,
        qualifications: true,
        status: true,
        submittedAt: true,
        decidedAt: true,
        decidedByUserId: true,
        decisionNote: true,
        sports: SPORTS,
      },
    }),
    db.coachCertificate.findUnique({ where: { userId }, select: CERT_META }),
    namesOf(db, [userId]),
    upcomingLessons(db, userId, now),
  ]);
  if (!profile || profile.status === 'DRAFT') throw new CoachApplicationNotFoundError();
  return {
    userId: profile.userId,
    name: names.get(userId) ?? null,
    slug: profile.slug,
    status: profile.status,
    submittedAt: profile.submittedAt,
    decidedAt: profile.decidedAt,
    decidedByUserId: profile.decidedByUserId,
    decisionNote: profile.decisionNote,
    bio: profile.bio,
    qualifications: profile.qualifications,
    sports: profile.sports,
    certificate: certificate
      ? { ...certificate, mimeType: certificate.mimeType as CertificateMime }
      : null,
    upcomingLessons: lessons,
  };
}

/**
 * The certificate itself, opened. The caller's audit row says who opened
 * whose and why; this returns the bytes to hand back as a download and keeps
 * no copy. A draft's certificate is not the owner's to read: nothing was sent.
 */
export async function openCoachCertificate(
  db: PrismaClient,
  userId: string,
): Promise<{ fileName: string; mimeType: CertificateMime; bytes: Buffer }> {
  const [profile, certificate] = await Promise.all([
    db.coachProfile.findUnique({ where: { userId }, select: { status: true } }),
    db.coachCertificate.findUnique({
      where: { userId },
      select: { fileName: true, mimeType: true, content: true },
    }),
  ]);
  if (!profile || profile.status === 'DRAFT' || !certificate) {
    throw new CoachApplicationNotFoundError();
  }
  return {
    fileName: certificate.fileName,
    mimeType: certificate.mimeType as CertificateMime,
    bytes: openCertificate(certificate.content),
  };
}

const EVENT: Record<CoachDecision, CoachDecisionEvent> = {
  APPROVE: 'approved',
  DECLINE: 'declined',
  REMOVE: 'removed',
};

export interface CoachDecisionResult {
  userId: string;
  status: 'APPROVED' | 'DECLINED';
  event: CoachDecisionEvent;
  decidedAt: Date;
  /**
   * The lessons a removal cancelled, for the caller to tell their players
   * about once the removal has committed. Empty for the other decisions.
   */
  cancelledLessons: Array<{ tenantId: string; bookingId: string }>;
}

/**
 * Decide. `note` is the caller's stated reason, already checked for length:
 * it is the audit row's reason for all three, and for a decline or a removal
 * it is also what the coach is shown and sent. An approval keeps no note on
 * the profile.
 *
 * The profile row is locked for the decision, so two admins deciding at once
 * get one decision and one refusal.
 */
export async function decideCoachApplication(
  db: PrismaClient,
  input: {
    userId: string;
    decision: CoachDecision;
    note: string;
    actorUserId: string;
    now?: Date;
  },
): Promise<CoachDecisionResult> {
  const now = input.now ?? new Date();
  const locked = await db.$queryRaw<Array<{ status: CoachProfileStatus }>>`
    SELECT "status"::text AS "status" FROM "coach_profile"
    WHERE "userId" = ${input.userId} FOR UPDATE`;
  const status = locked[0]?.status;
  if (!status || status === 'DRAFT') throw new CoachApplicationNotFoundError();

  const expected: CoachProfileStatus = input.decision === 'REMOVE' ? 'APPROVED' : 'SUBMITTED';
  if (status !== expected) throw new CoachApplicationStateError(status);

  if (input.decision === 'APPROVE') {
    // Nothing is approved on a document that is not there.
    const certificate = await db.coachCertificate.count({ where: { userId: input.userId } });
    if (certificate === 0) throw new CoachApplicationStateError(status);
  }

  const cancelledLessons: CoachDecisionResult['cancelledLessons'] = [];
  if (input.decision === 'REMOVE') {
    // ═══ THEIR LESSONS ARE CANCELLED WITH THEM (owner decision 21) ═══
    //
    // Every lesson not yet started, at every club: the booking is cancelled
    // by `cancelBooking`, as any cancellation is, so the court is released,
    // the club's record says the platform did it, and anything paid online
    // is returned. All of it inside this one audited transaction: a removal
    // that fails half way leaves no lesson cancelled.
    // guardrail-allow: cross-tenant — found by the coach's account, under
    // the platform admin's audited handle.
    const lessons = await db.coachLesson.findMany({
      where: { coachUserId: input.userId, ...notStarted(now) },
      select: { tenantId: true, bookingId: true },
      orderBy: [{ startTs: 'asc' }, { id: 'asc' }],
      take: MAX_LESSONS_CANCELLED + 1,
    });
    if (lessons.length > MAX_LESSONS_CANCELLED) {
      throw new CoachHasUpcomingLessonsError(await upcomingLessons(db, input.userId, now));
    }
    for (const lesson of lessons) {
      await cancelBooking(db, lesson.tenantId, {
        bookingId: lesson.bookingId,
        actor: 'PLATFORM',
        cancelledByUserId: input.actorUserId,
        reason: 'The coach was removed from the platform',
        now,
      });
      cancelledLessons.push(lesson);
    }

    await db.coachCertificate.deleteMany({ where: { userId: input.userId } });
    // guardrail-allow: cross-tenant — a removed coach stops teaching at every
    // club at once; the links are found by the coach's account, under the
    // platform admin's audited handle.
    const links = await db.coach.findMany({
      where: { userId: input.userId, status: { in: ['REQUESTED', 'INVITED', 'ACTIVE'] } },
      select: { id: true },
      // One link per venue; nobody teaches at this many.
      take: MAX_LIVE_LINKS,
    });
    if (links.length > 0) {
      const ids = links.map((l) => l.id);
      // guardrail-allow: cross-tenant — the same links, by id.
      await db.coachAvailability.deleteMany({ where: { coachId: { in: ids } } });
      // guardrail-allow: cross-tenant — the same links, by id.
      await db.coach.updateMany({
        where: { id: { in: ids } },
        data: { status: 'ENDED', endedAt: now, endedByUserId: input.actorUserId },
      });
    }
  }

  const note =
    input.decision === 'APPROVE'
      ? null
      : (tidyCoachText(sanitizePlainText(input.note))?.slice(0, COACH_DECISION_NOTE_MAX) ?? null);
  const next = input.decision === 'APPROVE' ? ('APPROVED' as const) : ('DECLINED' as const);
  await db.coachProfile.update({
    where: { userId: input.userId },
    data: {
      status: next,
      decidedAt: now,
      decidedByUserId: input.actorUserId,
      decisionNote: note,
    },
  });
  return {
    userId: input.userId,
    status: next,
    event: EVENT[input.decision],
    decidedAt: now,
    cancelledLessons,
  };
}

// ─── Telling people ────────────────────────────────────────────────────────

/**
 * Bell and email for the coach, after the decision committed. Reads the
 * profile again, bound to the coach, and says nothing if it has moved on
 * since (declined, corrected and sent again before this ran). Keyed on the
 * decision's own moment, so a hook that runs twice is one row and a second
 * decline later is news again. Never throws.
 */
export async function notifyCoachDecision(d: CoachDecisionResult): Promise<void> {
  try {
    const seen = await runAsUserOnly(d.userId, async (db) => {
      const [user, profile] = await Promise.all([
        db.user.findUnique({ where: { id: d.userId }, select: { locale: true, deletedAt: true } }),
        db.coachProfile.findUnique({
          where: { userId: d.userId },
          select: { status: true, decidedAt: true, decisionNote: true },
        }),
      ]);
      return { user, profile };
    });
    const { user, profile } = seen;
    if (!user || user.deletedAt || !profile) return;
    if (profile.status !== d.status || profile.decidedAt?.getTime() !== d.decidedAt.getTime()) {
      return;
    }

    const [copy, email] = await Promise.all([
      coachBellCopy(user.locale, d.event),
      coachDecisionEmail(user.locale, d.event, profile.decisionNote),
    ]);
    await deliver({
      userId: d.userId,
      tenantId: null,
      kind: d.event === 'approved' ? 'COACH_PROFILE_APPROVED' : 'COACH_PROFILE_DECLINED',
      dedupeKey: `coach:${d.event}:${d.decidedAt.getTime()}`,
      title: copy.title,
      body: copy.body,
      href: COACH_PROFILE_HREF,
      refType: 'coach_profile',
      refId: d.userId,
      email: { category: 'account', locale: user.locale, ...email },
    });
  } catch (err) {
    logger.warn('coach decision not announced', {
      component: 'notifications',
      event: d.event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Tell the operator a profile is waiting, after the submission committed.
 * One email per submission, to `CONTACT_INBOX_EMAIL` (none set, none queued,
 * as for an enquiry from the landing page); it names nobody (see
 * `coachSubmittedOperatorEmail`). Never throws.
 */
export async function notifyCoachProfileSubmitted(input: {
  userId: string;
  submittedAt: Date;
}): Promise<void> {
  // No inbox configured, nobody to tell: the queue itself still shows it.
  if (!contactInboxAddress()) return;
  try {
    const email = await coachSubmittedOperatorEmail();
    await queueOperatorEmail({
      kind: 'COACH_PROFILE_SUBMITTED',
      dedupeKey: `coach-submitted:${input.userId}:${input.submittedAt.getTime()}`,
      ...email,
    });
  } catch (err) {
    logger.warn('coach submission not announced', {
      component: 'notifications',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
