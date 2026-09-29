/**
 * How a venue gets its score.
 *
 * ─── Why not just average the stars? ─────────────────────────────────
 *
 * Because a venue with ONE five-star review would outrank a venue with two
 * hundred reviews averaging 4.8. That is not a ranking; it is a reward for
 * having no track record. The first thing a new club would learn is to ask a
 * friend to leave one review and stop.
 *
 * Two different problems, two different tools:
 *
 *   BAYESIAN AVERAGE — for the score we DISPLAY. It pulls a venue with few
 *   reviews toward the global mean and lets it earn its way out. A single
 *   5-star review moves the needle a little; fifty move it a lot.
 *
 *   WILSON LOWER BOUND — for RANKING a list. It asks: given this sample, what
 *   is the LOWEST plausible true score? A venue we know little about ranks
 *   conservatively — not because it is bad, but because we cannot yet say it
 *   is good.
 *
 * Both are ~20 lines. Neither needs a dependency.
 */

/**
 * The prior: what we assume about a venue before it has any reviews.
 *
 * `PRIOR_WEIGHT` is "how many imaginary average reviews does a new venue start
 * with". At 10, a venue needs a real body of feedback before its own score
 * dominates — which is the entire point.
 *
 * Set it too low and one review swings the score. Too high and a genuinely
 * excellent new club looks mediocre for months. Ten is a starting position, not
 * a law of nature; it is one constant, in one place, tunable with data.
 */
export const PRIOR_WEIGHT = 10;

/** The global mean, until we have enough data to compute a real one. */
export const PRIOR_MEAN = 4.0;

export const MIN_RATING = 1;
export const MAX_RATING = 5;

/**
 * The score shown to a human.
 *
 * (prior_weight × prior_mean + Σ ratings) / (prior_weight + n)
 *
 * With PRIOR_WEIGHT=10, PRIOR_MEAN=4.0:
 *   one 5-star review     → (40 + 5)  / 11  = 4.09   (not 5.0)
 *   fifty 5-star reviews  → (40 + 250)/ 60  = 4.83   (earned)
 *   one 1-star review     → (40 + 1)  / 11  = 3.73   (not 1.0)
 *
 * Note the last case: the prior protects venues from a single malicious
 * one-star as much as it protects users from a single friendly five-star. It
 * cuts both ways, which is what makes it fair rather than merely defensive.
 */
export function bayesianAverage(
  ratings: readonly number[],
  opts: { priorWeight?: number; priorMean?: number } = {},
): number {
  const sum = ratings.reduce((a, b) => a + b, 0);
  return bayesianAverageFromTotals(sum, ratings.length, opts);
}

/**
 * The same thing, from a SUM and a COUNT.
 *
 * This is the form the database can answer directly. The array form above needs
 * every review row in memory, which is fine for a club with twelve reviews and
 * an out-of-memory error for one with a hundred thousand — and the average is a
 * function of only the sum and the count, so loading the rows buys nothing.
 */
export function bayesianAverageFromTotals(
  sum: number,
  count: number,
  opts: { priorWeight?: number; priorMean?: number } = {},
): number {
  const w = opts.priorWeight ?? PRIOR_WEIGHT;
  const m = opts.priorMean ?? PRIOR_MEAN;

  const score = (w * m + sum) / (w + count);

  // One decimal place — the column is Decimal(2,1), and a venue rated "4.27"
  // implies a precision we do not have.
  return Math.round(score * 10) / 10;
}

/**
 * The Wilson score lower bound, for RANKING.
 *
 * Standard Wilson is defined for a proportion (positive/total). Stars are not a
 * proportion, so we map a rating onto [0,1] first: a 5 is 1.0, a 1 is 0.0, a 3
 * is 0.5. The "successes" are then the sum of those, and n is the review count.
 *
 * The returned value is the bottom of a 95% confidence interval — the score we
 * are confident the venue is AT LEAST as good as. Ranking by this means:
 *
 *   • a venue with 200 reviews at 4.5 outranks one with 3 reviews at 5.0,
 *     because we KNOW the first is good and merely SUSPECT the second is;
 *   • as reviews accumulate, the bound rises toward the true mean on its own.
 *
 * z = 1.96 is the 95% two-tailed normal quantile. Hard-coded because making it
 * configurable invites someone to "tune" it until their favourite venue ranks
 * first.
 */
const Z = 1.96;

export function wilsonLowerBound(ratings: readonly number[]): number {
  const n = ratings.length;

  // No reviews is not a score of zero — it is the ABSENCE of a score. Returning
  // 0 would rank an unreviewed venue below one with a hundred one-star reviews,
  // which is plainly wrong. The caller decides where to place these.
  if (n === 0) return 0;

  // Map each star to [0,1]: 1★ → 0, 3★ → 0.5, 5★ → 1.
  const positives = ratings.reduce(
    (acc, r) => acc + (r - MIN_RATING) / (MAX_RATING - MIN_RATING),
    0,
  );

  const phat = positives / n;
  const z2 = Z * Z;

  const numerator = phat + z2 / (2 * n) - Z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  const denominator = 1 + z2 / n;

  return numerator / denominator;
}

/**
 * A rating that is not a whole number from 1 to 5.
 *
 * A named class rather than a bare `Error` so the v1 boundary can map it to a
 * 400: the review route reaches it with whatever the client sent, and a bare
 * Error there is a 500 telling the player the server broke.
 */
export class InvalidRatingError extends Error {
  constructor(rating: number) {
    super(`A rating must be a whole number from ${MIN_RATING} to ${MAX_RATING}; got ${rating}.`);
    this.name = 'InvalidRatingError';
  }
}

/**
 * A rating must be an integer from 1 to 5.
 *
 * Rejected, not clamped. A 7-star rating is not a 5-star rating with
 * enthusiasm; it is a client sending us something we did not ask for, and
 * silently coercing it hides the bug that produced it.
 */
export function assertValidRating(rating: number): void {
  if (!Number.isInteger(rating) || rating < MIN_RATING || rating > MAX_RATING) {
    throw new InvalidRatingError(rating);
  }
}
