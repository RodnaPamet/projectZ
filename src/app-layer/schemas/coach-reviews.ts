import { z } from 'zod';

import { COACH_REVIEW_MAX_LENGTH } from '@/lib/coaches/reviews';

/**
 * A review of a coach (#551). The range of `rating` is the use case's rule
 * (400 INVALID_RATING); here only its type. A text longer than the limit is
 * refused, not cut: a client that sent more must be told.
 */
export const coachReviewBodySchema = z
  .object({
    rating: z.number().int(),
    body: z.string().max(COACH_REVIEW_MAX_LENGTH).nullable().optional(),
  })
  .strict();
