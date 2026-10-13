import type { PrismaClient } from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';

import { CoachAccountRequiredError } from '@/app-layer/usecases/coach-profile';
import { COACH_TIME_OFF_MAX_ROWS, readTimeOff } from '@/lib/coaches/teaching';
import { runAsUserOnly } from '@/lib/db/rls-middleware';

/**
 * A COACH'S DAYS OFF (#546; owner decision 14).
 *
 * A stretch of dates, both ends included, during which the coach teaches
 * nowhere: at every venue at once, because a person on holiday is on holiday
 * everywhere. Weekly hours are per venue (`coach-links.ts`); these are the
 * exceptions to them.
 *
 * The coach's own (owner-only in the database, P71): every function takes a
 * handle bound to the coach. A club sees that a coach is not free on a day,
 * when it looks for a lesson time; it does not read this table.
 *
 * Dates are calendar dates where the clubs are. Every club on the platform is
 * in Bulgaria, so "today" is Sofia's.
 */

export class CoachTimeOffLimitError extends Error {
  constructor() {
    super(`A coach keeps at most ${COACH_TIME_OFF_MAX_ROWS} stretches of days off.`);
    this.name = 'CoachTimeOffLimitError';
  }
}

export class CoachTimeOffNotFoundError extends Error {
  constructor() {
    super('No such days off.');
    this.name = 'CoachTimeOffNotFoundError';
  }
}

export interface TimeOffView {
  id: string;
  /** `YYYY-MM-DD`, both ends included. */
  startDate: string;
  endDate: string;
  note: string | null;
}

export const COACH_TIME_ZONE = 'Europe/Sofia';

/** Today's date where the clubs are, as `YYYY-MM-DD`. */
export const coachToday = (now: Date = new Date()) =>
  formatInTimeZone(now, COACH_TIME_ZONE, 'yyyy-MM-dd');

/** A `date` column as the calendar date it holds. */
const day = (d: Date) => d.toISOString().slice(0, 10);
/** A calendar date as the `date` column takes it. */
const column = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

async function requireCoach(db: PrismaClient, userId: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { accountKind: true, deletedAt: true },
  });
  if (!user || user.deletedAt || user.accountKind !== 'COACH') {
    throw new CoachAccountRequiredError();
  }
}

/** The days off that are not over yet, soonest first. */
export async function listTimeOff(
  db: PrismaClient,
  userId: string,
  today: string = coachToday(),
): Promise<TimeOffView[]> {
  await requireCoach(db, userId);
  const rows = await db.coachTimeOff.findMany({
    where: { userId, endDate: { gte: column(today) } },
    select: { id: true, startDate: true, endDate: true, note: true },
    orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    take: COACH_TIME_OFF_MAX_ROWS,
  });
  return rows.map((r) => ({
    id: r.id,
    startDate: day(r.startDate),
    endDate: day(r.endDate),
    note: r.note,
  }));
}

/** The same, for a page: binds to the caller itself. Null for an account that is not a coach's. */
export async function readMyTimeOff(userId: string): Promise<TimeOffView[] | null> {
  try {
    return await runAsUserOnly(userId, (db) => listTimeOff(db, userId));
  } catch (err) {
    if (err instanceof CoachAccountRequiredError) return null;
    throw err;
  }
}

/**
 * Add a stretch of days off. Stretches that are over are cleared as this
 * runs: they no longer say anything, and they are not history anybody reads.
 */
export async function addTimeOff(
  db: PrismaClient,
  userId: string,
  raw: { startDate?: unknown; endDate?: unknown; note?: unknown },
  today: string = coachToday(),
): Promise<TimeOffView[]> {
  await requireCoach(db, userId);
  const off = readTimeOff(raw, today);

  await db.coachTimeOff.deleteMany({ where: { userId, endDate: { lt: column(today) } } });
  const kept = await db.coachTimeOff.count({ where: { userId } });
  if (kept >= COACH_TIME_OFF_MAX_ROWS) throw new CoachTimeOffLimitError();

  await db.coachTimeOff.create({
    data: {
      userId,
      startDate: column(off.startDate),
      endDate: column(off.endDate),
      note: off.note,
    },
  });
  return listTimeOff(db, userId, today);
}

/** Take a stretch of days off back. */
export async function removeTimeOff(
  db: PrismaClient,
  userId: string,
  id: string,
  today: string = coachToday(),
): Promise<TimeOffView[]> {
  await requireCoach(db, userId);
  const gone = await db.coachTimeOff.deleteMany({ where: { id, userId } });
  if (gone.count === 0) throw new CoachTimeOffNotFoundError();
  return listTimeOff(db, userId, today);
}
