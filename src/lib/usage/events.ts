import { formatInTimeZone } from 'date-fns-tz';

/**
 * The usage events (#371), and the two pure decisions made when one is
 * counted: is the caller a crawler, and which day is it.
 *
 * No directive and no server-only import: the venue page's client island
 * imports `BEACON_EVENTS` and the event type from here, and nothing in this
 * file touches the database.
 */

/** Mirrors `enum UsageEvent` (prisma/schema/usage.prisma). */
export const USAGE_EVENTS = [
  'VENUES_VIEW',
  'VENUE_VIEW',
  'SLOTS_VIEW',
  'SLOT_PICKED',
  'SHEET_OPENED',
  'BOOKING_CREATED',
] as const;

export type UsageEventName = (typeof USAGE_EVENTS)[number];

/**
 * The funnel, in order: `/venues` → a venue page → a slot picked → the confirm
 * sheet opened → a booking created. `SLOTS_VIEW` is left out on purpose: it
 * counts the venue page's own refresh after paint and every day flicked
 * through, so it is activity, not a step a visitor passes once.
 */
export const FUNNEL_STEPS = [
  'VENUES_VIEW',
  'VENUE_VIEW',
  'SLOT_PICKED',
  'SHEET_OPENED',
  'BOOKING_CREATED',
] as const satisfies readonly UsageEventName[];

/**
 * The two steps that happen only in the browser, and so arrive by the venue
 * page's one-line beacon (`POST /api/v1/venues/{id}/usage-events`). Everything
 * else is counted on the server where it already happens.
 */
export const BEACON_EVENTS = ['SLOT_PICKED', 'SHEET_OPENED'] as const;
export type BeaconEvent = (typeof BEACON_EVENTS)[number];

export function isBeaconEvent(v: unknown): v is BeaconEvent {
  return typeof v === 'string' && (BEACON_EVENTS as readonly string[]).includes(v);
}

/** The zone a usage day is told in. The pilot is Sofia (Q40). */
export const USAGE_TIME_ZONE = 'Europe/Sofia';

/** `YYYY-MM-DD` of `now` in Sofia: the counter row an event lands in. */
export function usageDay(now: Date): string {
  return formatInTimeZone(now, USAGE_TIME_ZONE, 'yyyy-MM-dd');
}

/**
 * Crawlers, link previewers, monitors and scripted clients, by user agent.
 *
 * Generous on purpose: a missed bot inflates the top of the funnel and makes
 * every conversion look worse, while a person misread as a bot costs one count.
 * An absent or empty user agent is not a browser either. Headless Chrome is
 * here too, which keeps the Playwright suites and the perf harness out of the
 * numbers.
 *
 * The user agent is read for this check and nowhere else; it is never stored.
 */
const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|archiver|facebookexternalhit|facebookcatalog|embedly|preview|whatsapp|telegram|discord|skypeuripreview|headless|lighthouse|pagespeed|pingdom|uptime|monitor|statuscake|datadog|newrelic|curl\/|wget\/|python-|aiohttp|httpx|go-http-client|okhttp|axios\/|node-fetch|undici|java\/|libwww|httpclient|postman|insomnia|scrapy|phantomjs|selenium|puppeteer|playwright/i;

export function isBot(userAgent: string | null | undefined): boolean {
  const ua = userAgent?.trim();
  if (!ua) return true;
  return BOT_UA.test(ua);
}
