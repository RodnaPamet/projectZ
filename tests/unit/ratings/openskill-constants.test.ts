import { displayRating, newRating, rateTeams, winProbabilities } from '@/lib/ratings/openskill';

/**
 * THE LIBRARY'S NUMBERS, PINNED.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `src/lib/ratings/openskill.ts` passes NO options — no mu, no sigma, no beta,
 * no epsilon. Every value comes from the library's defaults, which means a
 * dependency bump can change what every player is rated without one line of
 * our code changing.
 *
 * That is not hypothetical. Between openskill 4.1.1 and 5.0.1:
 *
 *   epsilon   1e-4  ->  0.1          (a 1000x change; it is the draw margin)
 *   sigma     mu/z  ->  25/3         (derived -> hardcoded)
 *   beta      sigma/2 -> 25/6
 *   tau       mu/300 -> 25/300
 *   preventSigmaIncrease             (alias removed)
 *
 * The upgrade turned out to be safe — `ordinal` and `predictWin` are
 * byte-identical, and `rate` diverges only in the 4th-6th decimal — but
 * NOTHING IN THE REPO WOULD HAVE SAID SO. The version number moved; no test
 * disagreed.
 *
 * ═══ WHY IT MATTERS MORE HERE THAN ELSEWHERE ═══
 *
 * mu and sigma are PERSISTED (skill_rating.mu Decimal(8,4), sigma
 * Decimal(8,6)). A rating is not recomputed from history — it is accumulated.
 * So a library that quietly starts producing different numbers does not
 * produce a visible failure; it produces a ledger where early matches were
 * rated under one model and later ones under another, and no amount of
 * subtraction undoes it.
 *
 * ═══ WHAT TO DO WHEN THIS FAILS ═══
 *
 * A failure here is not a reason to change these numbers to match. It means a
 * dependency changed the rating model. Decide deliberately whether to accept
 * it — and whether existing stored ratings are still comparable with new ones
 * — before touching this file.
 */
describe('openskill defaults are pinned', () => {
  it('a new player starts at mu 25, sigma 25/3', () => {
    // Changing these shifts every rating that has not yet converged, and
    // shifts the scale that every displayed number sits on.
    const r = newRating();

    expect(r.mu).toBe(25);
    expect(r.sigma).toBeCloseTo(8.333333, 6);
  });

  it('a brand-new player DISPLAYS as 0', () => {
    // ordinal is mu - 3*sigma: 25 - 3*(25/3) = 0. If this moves, every
    // player's visible number moves with it, with no match played.
    expect(displayRating(newRating())).toBe(0);
  });

  it.each([
    [30.5, 4.2, 17.9],
    [18.9, 2.0, 12.9],
    [25.0, 8.333333, 0.0],
    [40.0, 0.5, 38.5],
  ])('ordinal(mu=%s, sigma=%s) === %s', (mu, sigma, expected) => {
    // The displayed rating, on values shaped like real stored rows. These are
    // identical across openskill 4.1.1 and 5.0.1 — verified by running both.
    expect(displayRating({ mu, sigma })).toBeCloseTo(expected, 2);
  });

  it('a 2v2 result moves the NEWCOMER far more than the veteran', () => {
    // The property the library was chosen FOR, asserted as a property rather
    // than as exact arithmetic: openskill scales each update by that player's
    // own sigma^2. If a bump ever flattened that, averaging-the-team would be
    // back and the module's whole rationale would be void — while every
    // numeric assertion above still passed.
    const veteran = { mu: 30.0, sigma: 2.0 };
    const newcomer = { mu: 25.0, sigma: 8.333333 };

    const [winners] = rateTeams([
      [veteran, newcomer],
      [
        { mu: 27.0, sigma: 3.0 },
        { mu: 26.0, sigma: 3.0 },
      ],
    ]);

    const vetMove = Math.abs(winners![0]!.mu - veteran.mu);
    const newMove = Math.abs(winners![1]!.mu - newcomer.mu);

    expect(newMove).toBeGreaterThan(vetMove * 5);
  });

  it('win probabilities are symmetric and sum to 1', () => {
    const p = winProbabilities([[{ mu: 30, sigma: 2 }], [{ mu: 30, sigma: 2 }]]);

    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(p[0]).toBeCloseTo(0.5, 6);
  });

  it('an evenly-matched 2v2 predicts close to even', () => {
    const p = winProbabilities([
      [
        { mu: 30.0, sigma: 2.0 },
        { mu: 25.0, sigma: 8.33 },
      ],
      [
        { mu: 27.0, sigma: 3.0 },
        { mu: 26.0, sigma: 3.0 },
      ],
    ]);

    // 0.570661 on both 4.1.1 and 5.0.1. Pinned loosely enough to survive a
    // floating-point nudge, tightly enough to catch a model change.
    expect(p[0]).toBeCloseTo(0.5707, 3);
  });
});
