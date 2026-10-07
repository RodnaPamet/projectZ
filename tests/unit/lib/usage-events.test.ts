import { isBeaconEvent, isBot, usageDay } from '@/lib/usage/events';
import { emptyCounts, funnelSteps, trendOf } from '@/lib/usage/funnel';
import { monthKey, onlineShare } from '@/app-layer/usecases/usage-report';

/** The pure half of #371's counting: crawlers, Sofia days, the funnel's arithmetic. */

describe('isBot', () => {
  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'WhatsApp/2.23.20.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0 Safari/537.36',
    'curl/8.4.0',
    'python-requests/2.32.0',
    'Go-http-client/1.1',
    '',
    '   ',
    null,
    undefined,
  ])('%s is not a person', (ua) => {
    expect(isBot(ua)).toBe(true);
  });

  it.each([
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0',
    'playerz/1.0 (bg.playerz.app; build:42) CFNetwork/1568 Darwin/24.0.0',
  ])('%s is a person', (ua) => {
    expect(isBot(ua)).toBe(false);
  });
});

describe('usageDay', () => {
  it('is the calendar day in Sofia, whatever the host’s zone', () => {
    expect(usageDay(new Date('2026-10-06T20:59:59Z'))).toBe('2026-10-06'); // 23:59 EEST
    expect(usageDay(new Date('2026-10-06T21:00:00Z'))).toBe('2026-10-07'); // 00:00 EEST
    expect(usageDay(new Date('2026-12-31T22:00:00Z'))).toBe('2027-01-01'); // 00:00 EET
  });
});

describe('isBeaconEvent', () => {
  it('admits only the two steps the browser sees', () => {
    expect(isBeaconEvent('SLOT_PICKED')).toBe(true);
    expect(isBeaconEvent('SHEET_OPENED')).toBe(true);
    expect(isBeaconEvent('BOOKING_CREATED')).toBe(false);
    expect(isBeaconEvent('VENUE_VIEW')).toBe(false);
    expect(isBeaconEvent(42)).toBe(false);
  });
});

describe('the funnel and the share', () => {
  it('converts each step from the one before, and never divides by zero', () => {
    const counts = { ...emptyCounts(), VENUES_VIEW: 200, VENUE_VIEW: 100, SLOT_PICKED: 0 };
    expect(funnelSteps(counts).map((s) => [s.event, s.count, s.fromPrevious])).toEqual([
      ['VENUES_VIEW', 200, null],
      ['VENUE_VIEW', 100, 0.5],
      ['SLOT_PICKED', 0, 0],
      ['SHEET_OPENED', 0, null],
      ['BOOKING_CREATED', 0, null],
    ]);
  });

  it('a share needs a booking; a trend needs two shares and more than half a point', () => {
    expect(onlineShare({ online: 3, desk: 1 })).toBe(0.75);
    expect(onlineShare({ online: 0, desk: 0 })).toBeNull();
    expect(trendOf(0.6, 0.5)).toBe('up');
    expect(trendOf(0.5, 0.6)).toBe('down');
    expect(trendOf(0.503, 0.5)).toBe('flat');
    expect(trendOf(0.5, null)).toBeNull();
  });

  it('counts months in Sofia, across a year end', () => {
    const newYearsEve = new Date('2026-12-31T22:30:00Z'); // 00:30 on 1 January in Sofia
    expect(monthKey(newYearsEve)).toBe('2027-01');
    expect(monthKey(newYearsEve, -1)).toBe('2026-12');
    expect(monthKey(newYearsEve, -13)).toBe('2025-12');
  });
});
