import type { Locale, SportType } from '@prisma/client';

import { deliver } from '@/app-layer/usecases/notification-outbox';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { resolveLocale } from '@/lib/i18n/locales';
import { translateFor } from '@/lib/i18n/server-messages';
import { dedupeKey } from '@/lib/notifications/dedupe';
import { logger } from '@/lib/observability/logger';
import { getSportConfig } from '@/lib/sports/registry';
import { sportsWithStories, storyDay, storyFor, STORY_TIME_ZONE } from '@/lib/sports/stories';

/**
 * «ФАКТ НА ДЕНЯ»: THE DAILY FACT PUSH (owner 2026-11-13).
 *
 * Once a day, from 10:00 in Sofia, every player with a phone or a browser
 * that takes push gets today's fact about their main sport: the fact
 * `GET /sports/{sport}/story` shows that day, in the player's language.
 *
 *   title  «Факт на деня · Тенис» / "Fact of the day · Tennis"
 *   body   the fact
 *
 * ═══ WHO ═══
 *
 * PLAYER accounts only (a club or a coach account is not here to play), not
 * deleted, with the switch on (`pushSportFacts`, default on), and with at
 * least one device: a bell row a day for somebody nothing can ring would be
 * clutter, not a fact. The main sport is the first sport on their profile, in
 * the order the profile shows them (`/me` sorts by sport), else the sport they
 * booked most, else there is none and they are left out. A sport whose story
 * is not written yet is left out the same way.
 *
 * ═══ ONCE A DAY, HOWEVER OFTEN IT RUNS ═══
 *
 * The bell row's dedupe key names the Sofia day, `sport-fact:2026-11-13`, and
 * the bell is unique per (person, key), so a second run writes nothing and
 * rings nothing (`deliver` pushes only a NEW row). The select also skips
 * whoever already has today's row, so a run after the first one reads only
 * the people still owed theirs. That is why the loop in ops/sweep.compose.yml
 * can simply ask every 15 minutes: before 10:00 the job answers at once, and
 * from 10:00 the first run sends and the rest find nothing to do. A restart,
 * a DST change or a missed run moves the send by minutes, never twice.
 *
 * ═══ WHY THE READ IS SUPERUSER ═══
 *
 * It picks people across every club: their profile sports (owner-only under
 * RLS), their devices (owner-only) and their bookings (each club's). Machine
 * work with no session, as the booking reminders are. It reads ids, a locale
 * and a sport; every write goes through `deliver`, bound to the recipient.
 */

/** The Sofia hour from which the day's fact goes out. */
export const SPORT_FACT_SEND_HOUR = 10;
/** People read and sent per round trip. */
export const SPORT_FACT_BATCH = 200;
/**
 * People one run sends to at most. The next run, 15 minutes later, carries
 * on from where it stopped; `truncated` says that it will.
 */
export const SPORT_FACT_RUN_CAP = 2_000;

export interface SportFactRun {
  /** The Sofia day the run is for. */
  day: string;
  /** Why nothing was tried: too early, or no sport has a story yet. */
  waiting: 'before-send-hour' | 'no-stories' | null;
  /** Bell rows written, so pushes tried. */
  sent: number;
  /** More people are owed today's fact than this run reached. */
  truncated: boolean;
}

/** The hour on the Sofia wall clock, 0–23. */
function sofiaHour(at: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: STORY_TIME_ZONE,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(at),
  );
}

interface Candidate {
  id: string;
  locale: Locale;
  sport: SportType;
}

/** The next people owed today's fact, after `afterId`, with their main sport. */
async function nextCandidates(
  key: string,
  sports: string[],
  afterId: string,
): Promise<Candidate[]> {
  return runAsSuperuser(
    (db) =>
      db.$queryRaw<Candidate[]>`
        SELECT x.id, x.locale, x.sport
        FROM (
          SELECT u.id, u.locale,
            COALESCE(
              -- The first sport on the profile, in the profile's own order.
              (SELECT l.sport FROM "player_sport_level" l
                WHERE l."userId" = u.id
                ORDER BY l.sport LIMIT 1),
              -- Else the sport they booked most; a tie goes to the registry's order.
              (SELECT c.sport FROM "booking" b JOIN "court" c ON c.id = b."resourceId"
                WHERE b."bookedByUserId" = u.id
                  AND b.status IN ('CONFIRMED', 'COMPLETED', 'NO_SHOW')
                GROUP BY c.sport
                ORDER BY count(*) DESC, c.sport LIMIT 1)
            ) AS sport
          FROM "app_user" u
          WHERE u."accountKind" = 'PLAYER'
            AND u."deletedAt" IS NULL
            AND u."pushSportFacts"
            AND (EXISTS (SELECT 1 FROM "device_token" d WHERE d."userId" = u.id)
              OR EXISTS (SELECT 1 FROM "push_subscription" p WHERE p."userId" = u.id))
            AND NOT EXISTS (SELECT 1 FROM "notification" n
                             WHERE n."userId" = u.id AND n."dedupeKey" = ${key})
            AND u.id > ${afterId}
        ) x
        WHERE x.sport::text = ANY(${sports}::text[])
        ORDER BY x.id
        LIMIT ${SPORT_FACT_BATCH}`,
  );
}

/** The push's words for one person, in their language. */
async function factCopy(
  sport: SportType,
  rawLocale: unknown,
  at: Date,
): Promise<{ title: string; body: string } | null> {
  const locale = resolveLocale(rawLocale);
  const story = storyFor(sport, locale, at);
  if (!story) return null;
  const title = await translateFor(locale, 'notifications.sportFact.title', {
    sport: getSportConfig(sport).label[locale],
  });
  return { title, body: story.fact.text };
}

/** Send today's fact to everyone still owed it. Never throws for one person. */
export async function sendSportFacts(now: Date = new Date()): Promise<SportFactRun> {
  const day = storyDay(now);
  if (sofiaHour(now) < SPORT_FACT_SEND_HOUR) {
    return { day, waiting: 'before-send-hour', sent: 0, truncated: false };
  }
  const sports = sportsWithStories();
  if (sports.length === 0) return { day, waiting: 'no-stories', sent: 0, truncated: false };

  const key = dedupeKey('sport-fact', day);
  let sent = 0;
  let reached = 0;
  let afterId = '';
  for (;;) {
    const batch = await nextCandidates(key, sports, afterId);
    for (const person of batch) {
      const copy = await factCopy(person.sport, person.locale, now);
      if (!copy) continue;
      const written = await deliver({
        userId: person.id,
        kind: 'SPORT_FACT',
        dedupeKey: key,
        title: copy.title,
        body: copy.body,
        // The web's list of places to play it. The phone opens the sport's
        // page from `refType`/`refId` (and the push's thread, `sport:<SPORT>`).
        href: `/venues?sport=${person.sport}`,
        refType: 'sport',
        refId: person.sport,
        push: 'sportFacts',
        email: null,
      });
      if (written.bell) sent++;
    }
    reached += batch.length;
    afterId = batch.at(-1)?.id ?? afterId;
    if (batch.length < SPORT_FACT_BATCH) return { day, waiting: null, sent, truncated: false };
    if (reached >= SPORT_FACT_RUN_CAP) {
      logger.warn('sport facts: run cap reached, the next run carries on', {
        component: 'cron',
        day,
        sent,
      });
      return { day, waiting: null, sent, truncated: true };
    }
  }
}
