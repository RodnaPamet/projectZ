import { computePrice, type PriceContext, type PricingRuleRow } from '@/app-layer/usecases/pricing';

const BASE = 1000;

const rule = (o: Partial<PricingRuleRow> & { id: string }): PricingRuleRow => ({
  name: o.id,
  priority: 100,
  conditionsJson: {},
  multiplier: null,
  fixedPriceCents: null,
  ...o,
});

/** Wed 20:00–21:00 by default. */
const ctx = (o: Partial<PriceContext> = {}): PriceContext => ({
  basePriceCents: BASE,
  localDayOfWeek: 3,
  localStartMinutes: 20 * 60,
  localEndMinutes: 21 * 60,
  ...o,
});

describe('pricing rule engine', () => {
  it('1. no rules → base price', () => {
    const r = computePrice([], ctx());
    expect(r.finalPriceCents).toBe(BASE);
    expect(r.appliedRuleId).toBeNull();
  });

  it('2. one matching rule applies', () => {
    const r = computePrice([rule({ id: 'a', multiplier: 1.5 })], ctx());
    expect(r.finalPriceCents).toBe(1500);
    expect(r.appliedRuleId).toBe('a');
  });

  it('3. higher priority wins', () => {
    const r = computePrice(
      [
        rule({ id: 'low', priority: 100, multiplier: 1.2 }),
        rule({ id: 'high', priority: 200, multiplier: 2 }),
      ],
      ctx(),
    );
    expect(r.appliedRuleId).toBe('high');
    expect(r.finalPriceCents).toBe(2000);
  });

  it('3b. priority wins even when the rules arrive out of order', () => {
    // The engine sorts rather than trusting the caller's ORDER BY. A repo
    // refactor dropping the order clause would otherwise silently charge
    // the wrong price, and nothing would fail.
    const r = computePrice(
      [
        rule({ id: 'high', priority: 200, multiplier: 2 }),
        rule({ id: 'low', priority: 100, multiplier: 1.2 }),
      ].reverse(),
      ctx(),
    );
    expect(r.appliedRuleId).toBe('high');
  });

  it('4. a weekend rule does not fire on a Wednesday', () => {
    const r = computePrice(
      [rule({ id: 'weekend', conditionsJson: { dayOfWeek: [0, 6] }, multiplier: 1.5 })],
      ctx({ localDayOfWeek: 3 }),
    );
    expect(r.finalPriceCents).toBe(BASE);
    expect(r.ruleTrace[0]!.matched).toBe(false);
    expect(r.ruleTrace[0]!.reason).toMatch(/dayOfWeek/);
  });

  it('5. a booking fully inside the peak window IS charged peak', () => {
    const r = computePrice(
      [
        rule({
          id: 'peak',
          conditionsJson: { timeRange: { from: '18:00', to: '22:00' } },
          multiplier: 1.5,
        }),
      ],
      ctx({ localStartMinutes: 20 * 60, localEndMinutes: 21 * 60 }),
    );
    expect(r.finalPriceCents).toBe(1500);
  });

  it('6. a booking that only CLIPS the peak window is NOT charged peak', () => {
    // 17:00–18:30 overlaps peak (18:00–22:00) by 30 minutes. Charging the
    // peak rate for a booking that is mostly off-peak is a bug the player
    // will (rightly) complain about. The rule must SPAN the booking.
    const r = computePrice(
      [
        rule({
          id: 'peak',
          conditionsJson: { timeRange: { from: '18:00', to: '22:00' } },
          multiplier: 1.5,
        }),
      ],
      ctx({ localStartMinutes: 17 * 60, localEndMinutes: 18 * 60 + 30 }),
    );
    expect(r.finalPriceCents).toBe(BASE);
    expect(r.ruleTrace[0]!.reason).toMatch(/not fully inside/);
  });

  it('7. a MEMBER tag matches', () => {
    const r = computePrice(
      [rule({ id: 'member', conditionsJson: { playerTags: ['MEMBER'] }, multiplier: 0.8 })],
      ctx({ playerTags: ['MEMBER'] }),
    );
    expect(r.finalPriceCents).toBe(800);
  });

  it('8. a non-member skips the member rule', () => {
    const r = computePrice(
      [rule({ id: 'member', conditionsJson: { playerTags: ['MEMBER'] }, multiplier: 0.8 })],
      ctx({ playerTags: [] }),
    );
    expect(r.finalPriceCents).toBe(BASE);
  });

  it('9. fixedPriceCents OVERRIDES multiplier when both are set', () => {
    // "€40 flat on holidays" must not also get the ×1.5 weekend surcharge
    // stapled on top.
    const r = computePrice([rule({ id: 'flat', multiplier: 1.5, fixedPriceCents: 4000 })], ctx());
    expect(r.finalPriceCents).toBe(4000);
  });

  it('10. multiplier 1.5 on 1000 → 1500', () => {
    expect(computePrice([rule({ id: 'x', multiplier: 1.5 })], ctx()).finalPriceCents).toBe(1500);
  });

  it('11. off-peak multiplier 0.5 → 500', () => {
    expect(computePrice([rule({ id: 'x', multiplier: 0.5 })], ctx()).finalPriceCents).toBe(500);
  });

  it('11c. rounds the number the arithmetic MEANT, not the float it produced', () => {
    // ═══ THE CENT THE CLUB WAS LOSING ═══
    //
    // `1290 * 1.15` is 1483.4999999999998 in binary floating point. The exact
    // answer is 1483.5, which rounds to 1484 — but `Math.round` on the float
    // gives 1483, so a EUR 12.90 court with a x1.15 peak rule under-charged a
    // cent on every peak booking.
    //
    // Not a stray multiplier: 472 of 30 856 realistic (price, multiplier)
    // pairs disagreed with exact arithmetic, always in the club's disfavour,
    // and it never reconciles because nothing compares the two.
    expect(
      computePrice([rule({ id: 'x', multiplier: 1.15 })], ctx({ basePriceCents: 1290 }))
        .finalPriceCents,
    ).toBe(1484);
    expect(Math.round(1290 * 1.15)).toBe(1483);

    expect(
      computePrice([rule({ id: 'x', multiplier: 0.29 })], ctx({ basePriceCents: 1450 }))
        .finalPriceCents,
    ).toBe(421);
    expect(Math.round(1450 * 0.29)).toBe(420);
  });

  it('11b. a fractional cent ROUNDS rather than truncating', () => {
    // Flooring systematically under-charges by up to a cent on every
    // booking. Small, but it is the club's money and it never reconciles.
    expect(computePrice([rule({ id: 'x', multiplier: 1.115 })], ctx()).finalPriceCents).toBe(1115);

    // 999 × 1.001 = 999.999 → 1000. Truncating would give 999 and quietly
    // hand the player a free cent on every single booking.
    expect(
      computePrice([rule({ id: 'x', multiplier: 1.001 })], ctx({ basePriceCents: 999 }))
        .finalPriceCents,
    ).toBe(1000);

    // …and it rounds DOWN when it should: 999 × 1.0004 = 999.3996 → 999.
    expect(
      computePrice([rule({ id: 'x', multiplier: 1.0004 })], ctx({ basePriceCents: 999 }))
        .finalPriceCents,
    ).toBe(999);
  });

  it('12. ruleTrace explains EVERY rule considered, matched or not', () => {
    // When a player asks "why did this cost €36?", support needs an answer.
    // "The engine decided" is not one.
    const r = computePrice(
      [
        rule({
          id: 'weekend',
          priority: 200,
          conditionsJson: { dayOfWeek: [0, 6] },
          multiplier: 1.5,
        }),
        rule({ id: 'always', priority: 150, multiplier: 1.2 }),
        rule({
          id: 'member',
          priority: 100,
          conditionsJson: { playerTags: ['MEMBER'] },
          multiplier: 0.8,
        }),
      ],
      ctx({ localDayOfWeek: 3, playerTags: ['MEMBER'] }),
    );

    expect(r.ruleTrace).toHaveLength(3);
    expect(r.appliedRuleId).toBe('always');

    const [weekend, always, member] = r.ruleTrace;
    expect(weekend!.matched).toBe(false);
    expect(weekend!.reason).toMatch(/dayOfWeek/);

    expect(always!.matched).toBe(true);

    // `member` WOULD have matched, but a higher-priority rule already won.
    // The trace must say that, not silently report it as a non-match — the
    // difference matters when a club is debugging its own pricing.
    expect(member!.matched).toBe(false);
    expect(member!.reason).toMatch(/higher-priority rule already matched/);
  });
});
