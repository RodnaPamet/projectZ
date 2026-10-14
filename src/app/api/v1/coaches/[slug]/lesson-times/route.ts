import { type NextRequest } from 'next/server';

import { lessonTimesFor, LessonLinkNotFoundError } from '@/app-layer/usecases/coach-lessons';
import { toLessonTimes } from '@/app/api/v1/_lib/coach-dto';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { sportParam } from '@/app/api/v1/_lib/sport-param';
import { ValidationError } from '@/lib/errors/types';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9]{8,64}$/;

/**
 * GET /api/v1/coaches/{slug}/lesson-times?linkId=&date=&minutes=&sport=
 *
 * The times a lesson can start on one calendar day at the venue (#548): where
 * the coach works, has no other lesson at any club, and a court is free for
 * the whole length. Public, as a venue's free slots are: no account needed to
 * look. Each time carries the court it would be on and what it would cost one
 * player; the coach's fee is the same at every time and is given once.
 *
 * `linkId` is the coach at one venue, from `GET /coaches/{slug}` (`venues[]`).
 * `minutes` is one of that link's `lessonMinutes`; any other is 400 with the
 * ones offered. `sport` narrows to that sport's courts.
 *
 * A snapshot, not a hold: a time shown here can be gone by the time it is
 * booked, and `POST …/lessons` says which of the two went.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const sp = req.nextUrl.searchParams;

  const linkId = sp.get('linkId') ?? '';
  if (!ID.test(linkId)) throw new ValidationError('`linkId` is required', { field: 'linkId' });
  const date = sp.get('date') ?? '';
  if (!DATE.test(date)) {
    throw new ValidationError('Invalid date: expected YYYY-MM-DD', { field: 'date' });
  }
  const minutes = Number(sp.get('minutes'));
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 240) {
    throw new ValidationError('`minutes` must be a whole number from 15 to 240', {
      field: 'minutes',
    });
  }
  const sport = sportParam(sp.get('sport'));

  const { link, times } = await lessonTimesFor({ linkId, date, minutes, sport });
  // The link is named under the coach it belongs to; under any other it is not there.
  if (link.coach.slug !== slug) throw new LessonLinkNotFoundError();

  return ok(toLessonTimes({ link, date, minutes, times }));
}

export const GET = defineV1Route(handler);
