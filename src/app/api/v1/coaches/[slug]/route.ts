import { type NextRequest } from 'next/server';

import { publicCoachBySlug } from '@/app-layer/usecases/coach-directory';
import { toPublicCoach } from '@/app/api/v1/_lib/coach-dto';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError } from '@/lib/errors/types';

/**
 * GET /api/v1/coaches/{slug}
 *
 * One coach's public page (#547), by its address. Public: no sign-in.
 *
 * Answers for any coach the platform approved, with the text, qualifications,
 * sports and levels, the picture, and the venues where a lesson can be booked
 * with them, each with the rates and lesson lengths there. `venues` is empty,
 * and `fromRateCents` null, for an approved coach who teaches nowhere yet:
 * they have a page and are not in the list.
 *
 * 404 `NOT_FOUND` for an address that names nobody, a coach who is not
 * approved (a draft is theirs alone), and an account that is gone. The three
 * are not told apart.
 */
async function handler(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const coach = await publicCoachBySlug(slug);
  if (!coach) throw new NotFoundError('Coach not found');
  return ok(toPublicCoach(coach));
}

export const GET = defineV1Route(handler);
