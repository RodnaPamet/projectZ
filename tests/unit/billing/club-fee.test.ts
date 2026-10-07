import {
  bpsToPercent,
  chargeFor,
  feeCentsFor,
  isCalendarDate,
  isMonth,
  percentToBps,
} from '@/lib/billing/club-fee';
import { centsCell, percentCell, statementFilename, textCell } from '@/lib/billing/statement-csv';

/**
 * The club fee's arithmetic (#372): integer cents, a rate in basis points, and
 * one half-up rounding per line.
 */

describe('the fee on a line', () => {
  it('is the price times the rate, rounded half-up to the cent', () => {
    expect(feeCentsFor(2400, 1000)).toBe(240); // 10% of 24.00
    expect(feeCentsFor(2400, 1250)).toBe(300); // 12.5% exactly
    expect(feeCentsFor(4, 1250)).toBe(1); // 0.5 c rounds UP
    expect(feeCentsFor(3, 1250)).toBe(0); // 0.375 c rounds down
    expect(feeCentsFor(5, 999)).toBe(0); // 0.4995 c rounds down
    expect(feeCentsFor(3333, 1500)).toBe(500); // 499.95 → 500
    expect(feeCentsFor(3329, 1500)).toBe(499); // 499.35 → 499
    expect(feeCentsFor(0, 3000)).toBe(0);
    expect(feeCentsFor(2400, 0)).toBe(0);
  });

  it('never goes through a float: a large price stays exact', () => {
    // 99 999 999.99 € at 29.99% — far past anything real, still an exact integer.
    expect(feeCentsFor(9_999_999_999, 2999)).toBe(2_999_000_000);
  });

  it('refuses what is not a price or a rate', () => {
    expect(() => feeCentsFor(-1, 1000)).toThrow(RangeError);
    expect(() => feeCentsFor(1.5, 1000)).toThrow(RangeError);
    expect(() => feeCentsFor(100, 3001)).toThrow(RangeError);
    expect(() => feeCentsFor(100, 12.5)).toThrow(RangeError);
  });

  it('is 0 in the free period, and still records the rate', () => {
    expect(chargeFor({ priceCents: 2400, bps: 1000, free: true })).toEqual({
      feeBps: 1000,
      freePeriod: true,
      feeCents: 0,
    });
    expect(chargeFor({ priceCents: 2400, bps: 1000, free: false }).feeCents).toBe(240);
  });

  it('summing rounded lines is what the statement shows, not a percentage of the sum', () => {
    // Three 0.5 c fees: each line rounds to 1 c, so the total is 3 c. A
    // percentage of the summed price (15 c × 10% = 1.5 c → 2 c) would disagree
    // with the lines the reader can add up.
    const lines = [5, 5, 5].map((p) => feeCentsFor(p, 1000));
    expect(lines.reduce((a, b) => a + b, 0)).toBe(3);
    expect(feeCentsFor(15, 1000)).toBe(2);
  });
});

describe('percentages', () => {
  it('parse from the decimal string, never through a float', () => {
    expect(percentToBps('12.5')).toBe(1250);
    expect(percentToBps('12.50')).toBe(1250);
    expect(percentToBps('0.29')).toBe(29); // 0.29 * 100 is 28.999… as a float
    expect(percentToBps(10)).toBe(1000);
    expect(percentToBps('0')).toBe(0);
    expect(percentToBps('30')).toBe(3000);
  });

  it('refuse out of range, negative, too precise or not a number', () => {
    for (const bad of ['30.01', '31', '-1', '12.345', 'abc', '', '1e1', '12,5', ' ']) {
      expect(percentToBps(bad)).toBeNull();
    }
  });

  it('format back with two decimals', () => {
    expect(bpsToPercent(1250)).toBe('12.50');
    expect(bpsToPercent(5)).toBe('0.05');
    expect(bpsToPercent(0)).toBe('0.00');
  });

  it('dates and months are validated as calendar values', () => {
    expect(isMonth('2026-10')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isCalendarDate('2027-02-28')).toBe(true);
    expect(isCalendarDate('2027-02-29')).toBe(false);
    expect(isCalendarDate('2026-1-01')).toBe(false);
  });
});

describe('CSV cells', () => {
  it('money with a decimal comma, from integer cents', () => {
    expect(centsCell(2400)).toBe('24,00');
    expect(centsCell(5)).toBe('0,05');
    expect(centsCell(-240)).toBe('-2,40');
    expect(centsCell(123456)).toBe('1234,56');
    expect(percentCell(1250)).toBe('12,50');
  });

  it('defuses a formula in club-typed text', () => {
    expect(textCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(textCell('+359 court')).toBe("'+359 court");
    expect(textCell('-1')).toBe("'-1");
    expect(textCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(textCell('\tTab')).toBe("'\tTab");
    expect(textCell('Корт 1')).toBe('Корт 1');
  });

  it('quotes the separator, quotes and line breaks', () => {
    expect(textCell('A;B')).toBe('"A;B"');
    expect(textCell('Say "hi"')).toBe('"Say ""hi"""');
    expect(textCell('two\nlines')).toBe('"two\nlines"');
  });

  it('names the file in ASCII', () => {
    expect(statementFilename('sofia-padel', '2026-10')).toBe('playerz-sofia-padel-2026-10.csv');
    expect(statementFilename('a/b"c', '2026-10')).toBe('playerz-a-b-c-2026-10.csv');
  });
});
