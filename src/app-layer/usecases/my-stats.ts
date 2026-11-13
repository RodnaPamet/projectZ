import type { PrismaClient, SportType } from '@prisma/client';

import { clubLeaderboard, type LeaderboardRow } from '@/app-layer/usecases/leaderboards';
import { blockedEitherWay } from '@/app-layer/usecases/messaging-directory';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { avatarUrlOf } from '@/lib/media/avatar-url';
import { isProvisional, levelOfMean } from '@/lib/ratings/levels';

/**
 * A PLAYER'S OWN STATISTICS (#688; owner 2026-11-13: "a personal stat
 * aficionado delight", Courtly's Progress page as the reference).
 *
 * Everything is computed from what the results module already keeps, never
 * from a counter of its own (the reason `playerStats` gives in ratings.ts):
 *
 *   match_participant     who played, on which side, and how it ended
 *   skill_rating_history  the level after each counted match
 *   match_report          the score and the booking (venue, time) behind it
 *   player_sport_level    the level the player declared, where ratings start
 *
 * For the player alone. Partners and rivals are people they played with or
 * against; nobody in a block with them is listed, and a deleted account is
 * left out. The club standing is the club's leaderboard (#578) with its own
 * rules, read as the player would read it.
 */

/** The matches read for one player in one sport: generous for a pilot. */
export const STATS_MATCHES_MAX = 2_000;
/** Partners, rivals and venues listed. */
export const STATS_PEOPLE_MAX = 5;
/** Results in the form row. */
export const FORM_LENGTH = 10;
/** Months in the activity bars, this one included. */
export const ACTIVITY_MONTHS = 12;
/** Rows of the standing shown around the player. */
const STANDING_AROUND = 2;
const MATCH_MILESTONES = [10, 25, 50, 100, 250, 500, 1000];
const SPORTS_MAX = 40;
const DEFAULT_ZONE = 'Europe/Sofia';
const DAY = 86_400_000;

export type Outcome = 'WIN' | 'LOSS' | 'DRAW';

export interface StatsPerson {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface PersonRecord {
  person: StatsPerson;
  games: number;
  wins: number;
}

export interface StatsVenue {
  id: string;
  name: string;
  city: string;
  cityKey: string | null;
}

/** One counted match, from the player's side. */
export interface MyMatch {
  matchId: string;
  playedAt: Date;
  outcome: Outcome;
  venue: StatsVenue | null;
  partners: StatsPerson[];
  opponents: StatsPerson[];
  /** Each set (or part) as [mine, theirs]; null without a reported score. */
  score: [number, number][] | null;
  /** The level before and after it; null where no rating moved. */
  levelBefore: number | null;
  levelAfter: number | null;
  tournament: { id: string; name: string } | null;
}

export type MilestoneKind =
  | 'PEAK_LEVEL'
  | 'BEST_WIN_STREAK'
  | 'MATCHES_PLAYED'
  | 'TOP_PARTNER'
  | 'CLUBS_WON_AT'
  | 'FIRST_WIN';

export interface Milestone {
  kind: MilestoneKind;
  value: number;
  at: Date | null;
  person: StatsPerson | null;
}

export interface MyStats {
  /** Sports with a declared level or a counted match, in the enum's order. */
  sports: SportType[];
  sport: SportType | null;
  rating: {
    level: number;
    provisional: boolean;
    declaredLevel: number | null;
    matchesRated: number;
    /** The level after each counted match, oldest first. */
    series: { at: Date; level: number }[];
    peak: { level: number; at: Date } | null;
    /** The level now minus the level 30 days ago; null before a first match. */
    change30d: number | null;
  } | null;
  performance: {
    games: number;
    wins: number;
    losses: number;
    draws: number;
    /** Wins over games, 0–1; null before a first match. */
    winRate: number | null;
    currentStreak: { outcome: Outcome; length: number } | null;
    bestWinStreak: number;
  };
  /** Newest first. */
  form: { matchId: string; outcome: Outcome; at: Date }[];
  sets: {
    scoredMatches: number;
    setsWon: number;
    setsLost: number;
    gamesWon: number;
    gamesLost: number;
    /** Sets that went to 7 (7–5, 7–6). */
    closeSetsWon: number;
    closeSetsLost: number;
  } | null;
  partners: PersonRecord[];
  rivals: PersonRecord[];
  activity: {
    /** Oldest first, `YYYY-MM` in Sofia, this month last. */
    months: { month: string; games: number }[];
    /** Monday first, on the venue's clock. */
    weekdays: number[];
    hours: number[];
    venues: (StatsVenue & { games: number; wins: number })[];
  };
  standing: {
    club: { slug: string; name: string };
    /** Null while the player is not on the board. */
    rank: number | null;
    /** Why not: a level still provisional, or one the player hides. */
    absent: 'PROVISIONAL' | 'HIDDEN' | null;
    total: number;
    rows: LeaderboardRow[];
  } | null;
  milestones: Milestone[];
}

interface Played {
  matchId: string;
  tenantId: string | null;
  teamIndex: number;
  outcome: Outcome;
  recordedAt: Date;
  sides: { userId: string; teamIndex: number }[];
}

interface Report {
  sides: string[][];
  score: [number, number][] | null;
  startTs: Date;
  venue: (StatsVenue & { timezone: string }) | null;
  tournament: { id: string; name: string } | null;
}

/** What one player's statistics are read from, in one sport. */
interface Source {
  sports: SportType[];
  sport: SportType | null;
  declaredLevel: number | null;
  played: Played[];
  reports: Map<string, Report>;
  history: { level: number; matchesPlayed: number; at: Date }[];
  people: Map<string, StatsPerson>;
  clubs: Map<string, { slug: string; name: string }>;
  ratingPublic: boolean;
}

function sidesOf(json: unknown): string[][] {
  if (!Array.isArray(json)) return [];
  return json.map((side) =>
    Array.isArray(side) ? side.filter((id): id is string => typeof id === 'string') : [],
  );
}

function scoreOf(json: unknown): [number, number][] | null {
  if (!Array.isArray(json)) return null;
  const pairs = json.filter(
    (p): p is [number, number] =>
      Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number'),
  );
  return pairs.length > 0 ? pairs : null;
}

async function read(db: PrismaClient, userId: string, asked: SportType | null): Promise<Source> {
  const [declared, bySport, user] = await Promise.all([
    db.playerSportLevel.findMany({
      where: { userId },
      select: { sport: true, level: true },
      take: SPORTS_MAX,
    }),
    // guardrail-allow: cross-tenant — the player's own matches at every club.
    db.matchParticipant.groupBy({
      by: ['sport'],
      where: { userId },
      _count: { _all: true },
      orderBy: { sport: 'asc' },
    }),
    db.user.findUnique({ where: { id: userId }, select: { ratingPublic: true } }),
  ]);
  const sports = [...new Set([...declared.map((d) => d.sport), ...bySport.map((s) => s.sport)])];
  // The enum's order, as the leaderboards list sports.
  const order = new Map(bySport.map((s, i) => [s.sport, i]));
  sports.sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || (a < b ? -1 : 1));
  const mostPlayed = [...bySport].sort((a, b) => b._count._all - a._count._all)[0]?.sport;
  const sport = asked && sports.includes(asked) ? asked : (mostPlayed ?? sports[0] ?? null);

  const empty: Source = {
    sports,
    sport,
    declaredLevel: null,
    played: [],
    reports: new Map(),
    history: [],
    people: new Map(),
    clubs: new Map(),
    ratingPublic: user?.ratingPublic ?? true,
  };
  if (!sport) return empty;

  const [rows, history] = await Promise.all([
    db.matchParticipant.findMany({
      where: { userId, sport },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      take: STATS_MATCHES_MAX,
      select: {
        matchId: true,
        teamIndex: true,
        outcome: true,
        recordedAt: true,
        match: {
          select: { tenantId: true, participants: { select: { userId: true, teamIndex: true } } },
        },
      },
    }),
    db.skillRatingHistory.findMany({
      where: { userId, sport },
      orderBy: [{ computedAt: 'asc' }, { matchesPlayed: 'asc' }],
      take: STATS_MATCHES_MAX,
      select: { engine: true, mu: true, matchesPlayed: true, computedAt: true },
    }),
  ]);
  const played: Played[] = rows.map((r) => ({
    matchId: r.matchId,
    tenantId: r.match.tenantId,
    teamIndex: r.teamIndex,
    outcome: r.outcome,
    recordedAt: r.recordedAt,
    sides: r.match.participants,
  }));

  const matchIds = played.map((p) => p.matchId);
  const others = [...new Set(played.flatMap((p) => p.sides.map((s) => s.userId)))].filter(
    (id) => id !== userId,
  );
  const tenantIds = [...new Set(played.map((p) => p.tenantId).filter((t): t is string => !!t))];

  const [reports, users, blocked, orgs] = await Promise.all([
    matchIds.length === 0
      ? []
      : // guardrail-allow: cross-tenant — the reports of the player's own counted matches.
        db.matchReport.findMany({
          where: { matchResultId: { in: matchIds } },
          take: matchIds.length,
          select: {
            matchResultId: true,
            kind: true,
            sidesJson: true,
            scoreJson: true,
            booking: {
              select: {
                startTs: true,
                resource: {
                  select: {
                    venue: {
                      select: { id: true, name: true, city: true, cityKey: true, timezone: true },
                    },
                  },
                },
                tournamentMatch: {
                  select: { tournament: { select: { id: true, name: true } } },
                },
              },
            },
          },
        }),
    others.length === 0
      ? []
      : db.user.findMany({
          where: { id: { in: others }, deletedAt: null },
          select: { id: true, name: true, avatarUrl: true },
          take: others.length,
        }),
    blockedEitherWay(db, userId),
    tenantIds.length === 0
      ? []
      : db.venueOrg.findMany({
          where: { id: { in: tenantIds }, status: 'ACTIVE' },
          select: { id: true, slug: true, name: true },
          take: tenantIds.length,
        }),
  ]);

  const hidden = new Set(blocked);
  const people = new Map<string, StatsPerson>();
  for (const u of users) {
    if (hidden.has(u.id)) continue;
    people.set(u.id, { userId: u.id, name: u.name, avatarUrl: avatarUrlOf(u.avatarUrl) });
  }

  const byMatch = new Map<string, Report>();
  for (const r of reports) {
    if (!r.matchResultId) continue;
    const venue = r.booking.resource.venue;
    byMatch.set(r.matchResultId, {
      sides: sidesOf(r.sidesJson),
      score: r.kind === 'SCORE' ? scoreOf(r.scoreJson) : null,
      startTs: r.booking.startTs,
      venue: venue
        ? {
            id: venue.id,
            name: venue.name,
            city: venue.city,
            cityKey: venue.cityKey,
            timezone: venue.timezone,
          }
        : null,
      tournament: r.booking.tournamentMatch?.tournament ?? null,
    });
  }

  return {
    ...empty,
    declaredLevel: declared.find((d) => d.sport === sport)?.level ?? null,
    played,
    reports: byMatch,
    history: history.map((h) => ({
      level: levelOfMean(h.engine, Number(h.mu)),
      matchesPlayed: h.matchesPlayed,
      at: h.computedAt,
    })),
    people,
    clubs: new Map(orgs.map((o) => [o.id, { slug: o.slug, name: o.name }])),
  };
}

/** `YYYY-MM`, weekday (Monday 0) and hour of `at` in `zone`. */
function clock(at: Date, zone: string): { month: string; weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    month: `${part('year')}-${part('month')}`,
    weekday: Math.max(0, weekdays.indexOf(part('weekday'))),
    hour: Number(part('hour')) % 24,
  };
}

/** The side of `report` that `userId` played on, or null. */
function sideOf(report: Report, userId: string): number | null {
  const i = report.sides.findIndex((side) => side.includes(userId));
  return i === -1 ? null : i;
}

/** Each set as [mine, theirs]. */
function myScore(report: Report, userId: string): [number, number][] | null {
  const side = sideOf(report, userId);
  if (!report.score || side === null || side > 1) return null;
  return report.score.map(([a, b]) => (side === 0 ? [a, b] : [b, a]));
}

/** The player's matches, oldest first, as `MyMatch`. */
function matchesOf(source: Source, userId: string): MyMatch[] {
  const levelAfter = new Map(source.history.map((h) => [h.matchesPlayed, h.level]));
  return source.played.map((p, i) => {
    const report = source.reports.get(p.matchId) ?? null;
    const after = levelAfter.get(i + 1) ?? null;
    const before = i === 0 ? source.declaredLevel : (levelAfter.get(i) ?? null);
    const person = (id: string) =>
      source.people.get(id) ?? { userId: id, name: null, avatarUrl: null };
    const others = p.sides.filter((s) => s.userId !== userId);
    return {
      matchId: p.matchId,
      playedAt: report?.startTs ?? p.recordedAt,
      outcome: p.outcome,
      venue: report?.venue
        ? {
            id: report.venue.id,
            name: report.venue.name,
            city: report.venue.city,
            cityKey: report.venue.cityKey,
          }
        : null,
      // A blocked or deleted player keeps their place on the side, without a name.
      partners: others.filter((s) => s.teamIndex === p.teamIndex).map((s) => person(s.userId)),
      opponents: others.filter((s) => s.teamIndex !== p.teamIndex).map((s) => person(s.userId)),
      score: report ? myScore(report, userId) : null,
      levelBefore: after === null ? null : (before ?? null),
      levelAfter: after,
      tournament: report?.tournament ?? null,
    };
  });
}

function compute(source: Source, userId: string, now: Date): Omit<MyStats, 'standing'> {
  const matches = matchesOf(source, userId);
  const games = matches.length;
  const count = (o: Outcome) => matches.filter((m) => m.outcome === o).length;
  const wins = count('WIN');

  // Streaks, oldest to newest.
  let bestWinStreak = 0;
  let bestWinStreakAt: Date | null = null;
  let run = 0;
  for (const m of matches) {
    run = m.outcome === 'WIN' ? run + 1 : 0;
    if (run > bestWinStreak) {
      bestWinStreak = run;
      bestWinStreakAt = m.playedAt;
    }
  }
  let currentStreak: MyStats['performance']['currentStreak'] = null;
  const last = matches.at(-1);
  if (last) {
    let length = 0;
    for (let i = matches.length - 1; i >= 0 && matches[i]!.outcome === last.outcome; i--) length++;
    currentStreak = { outcome: last.outcome, length };
  }

  // The level.
  const latest = source.history.at(-1);
  let rating: MyStats['rating'] = null;
  if (latest) {
    const cutoff = now.getTime() - 30 * DAY;
    const before = [...source.history].reverse().find((h) => h.at.getTime() <= cutoff);
    const then = before?.level ?? source.declaredLevel ?? source.history[0]!.level;
    const peak = source.history.reduce((best, h) => (h.level > best.level ? h : best));
    rating = {
      level: latest.level,
      provisional: isProvisional(latest.matchesPlayed, latest.at, now),
      declaredLevel: source.declaredLevel,
      matchesRated: latest.matchesPlayed,
      series: source.history.map((h) => ({ at: h.at, level: h.level })),
      peak: { level: peak.level, at: peak.at },
      change30d: Math.round((latest.level - then) * 10) / 10,
    };
  } else if (source.declaredLevel !== null) {
    rating = {
      level: source.declaredLevel,
      provisional: true,
      declaredLevel: source.declaredLevel,
      matchesRated: 0,
      series: [],
      peak: null,
      change30d: null,
    };
  }

  // Sets and games.
  let sets: MyStats['sets'] = null;
  for (const m of matches) {
    if (!m.score) continue;
    sets ??= {
      scoredMatches: 0,
      setsWon: 0,
      setsLost: 0,
      gamesWon: 0,
      gamesLost: 0,
      closeSetsWon: 0,
      closeSetsLost: 0,
    };
    sets.scoredMatches++;
    for (const [mine, theirs] of m.score) {
      sets.gamesWon += mine;
      sets.gamesLost += theirs;
      if (mine === theirs) continue;
      const won = mine > theirs;
      if (won) sets.setsWon++;
      else sets.setsLost++;
      if (Math.max(mine, theirs) >= 7) {
        if (won) sets.closeSetsWon++;
        else sets.closeSetsLost++;
      }
    }
  }

  // Partners and rivals: named people only.
  const tally = (pick: (m: MyMatch) => StatsPerson[]) => {
    const by = new Map<string, PersonRecord & { lastAt: number }>();
    for (const m of matches) {
      for (const p of pick(m)) {
        if (!source.people.has(p.userId)) continue;
        const row = by.get(p.userId) ?? { person: p, games: 0, wins: 0, lastAt: 0 };
        row.games++;
        if (m.outcome === 'WIN') row.wins++;
        row.lastAt = Math.max(row.lastAt, m.playedAt.getTime());
        by.set(p.userId, row);
      }
    }
    return [...by.values()]
      .sort((a, b) => b.games - a.games || b.wins - a.wins || b.lastAt - a.lastAt)
      .slice(0, STATS_PEOPLE_MAX)
      .map(({ person, games: g, wins: w }) => ({ person, games: g, wins: w }));
  };
  const partners = tally((m) => m.partners);
  const rivals = tally((m) => m.opponents);

  // Activity.
  const months: { month: string; games: number }[] = [];
  const nowClock = clock(now, DEFAULT_ZONE);
  let [y, mo] = nowClock.month.split('-').map(Number) as [number, number];
  for (let i = 0; i < ACTIVITY_MONTHS; i++) {
    months.unshift({ month: `${y}-${String(mo).padStart(2, '0')}`, games: 0 });
    mo--;
    if (mo === 0) {
      mo = 12;
      y--;
    }
  }
  const monthIndex = new Map(months.map((m, i) => [m.month, i]));
  const weekdays = Array<number>(7).fill(0);
  const hours = Array<number>(24).fill(0);
  const venues = new Map<string, StatsVenue & { games: number; wins: number }>();
  for (const m of matches) {
    const report = source.reports.get(m.matchId);
    const zone = report?.venue?.timezone ?? DEFAULT_ZONE;
    const at = clock(m.playedAt, zone);
    const month = monthIndex.get(clock(m.playedAt, DEFAULT_ZONE).month);
    if (month !== undefined) months[month]!.games++;
    weekdays[at.weekday]!++;
    hours[at.hour]!++;
    if (m.venue) {
      const row = venues.get(m.venue.id) ?? { ...m.venue, games: 0, wins: 0 };
      row.games++;
      if (m.outcome === 'WIN') row.wins++;
      venues.set(m.venue.id, row);
    }
  }

  // Milestones.
  const milestones: Milestone[] = [];
  if (rating?.peak) {
    milestones.push({
      kind: 'PEAK_LEVEL',
      value: rating.peak.level,
      at: rating.peak.at,
      person: null,
    });
  }
  if (bestWinStreak >= 2) {
    milestones.push({
      kind: 'BEST_WIN_STREAK',
      value: bestWinStreak,
      at: bestWinStreakAt,
      person: null,
    });
  }
  const reached = MATCH_MILESTONES.filter((n) => n <= games).at(-1);
  if (reached) {
    milestones.push({
      kind: 'MATCHES_PLAYED',
      value: reached,
      at: matches[reached - 1]!.playedAt,
      person: null,
    });
  }
  if (partners[0] && partners[0].games >= 2) {
    milestones.push({
      kind: 'TOP_PARTNER',
      value: partners[0].games,
      at: null,
      person: partners[0].person,
    });
  }
  const firstWin = matches.find((m) => m.outcome === 'WIN');
  if (firstWin)
    milestones.push({ kind: 'FIRST_WIN', value: 1, at: firstWin.playedAt, person: null });
  const wonAt = new Map<string, Date>();
  for (const [i, m] of matches.entries()) {
    const tenant = source.played[i]!.tenantId;
    if (m.outcome === 'WIN' && tenant && !wonAt.has(tenant)) wonAt.set(tenant, m.playedAt);
  }
  if (wonAt.size >= 2) {
    milestones.push({
      kind: 'CLUBS_WON_AT',
      value: wonAt.size,
      at: [...wonAt.values()].at(-1)!,
      person: null,
    });
  }

  return {
    sports: source.sports,
    sport: source.sport,
    rating,
    performance: {
      games,
      wins,
      losses: count('LOSS'),
      draws: count('DRAW'),
      winRate: games === 0 ? null : Math.round((wins / games) * 1000) / 1000,
      currentStreak,
      bestWinStreak,
    },
    form: matches
      .slice(-FORM_LENGTH)
      .reverse()
      .map((m) => ({ matchId: m.matchId, outcome: m.outcome, at: m.playedAt })),
    sets,
    partners,
    rivals,
    activity: {
      months,
      weekdays,
      hours,
      venues: [...venues.values()]
        .sort((a, b) => b.games - a.games || b.wins - a.wins)
        .slice(0, STATS_PEOPLE_MAX),
    },
    milestones,
  };
}

/** The club this player has played most at, in this sport, if it is public. */
function homeClub(source: Source): { slug: string; name: string } | null {
  const counts = new Map<string, number>();
  for (const p of source.played) {
    if (p.tenantId && source.clubs.has(p.tenantId)) {
      counts.set(p.tenantId, (counts.get(p.tenantId) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? source.clubs.get(top[0])! : null;
}

/**
 * The player's statistics in `sport` (or the sport they play most). For the
 * player alone.
 */
export async function myStats(
  userId: string,
  sport: SportType | null,
  now: Date = new Date(),
): Promise<MyStats> {
  // guardrail-allow: cross-tenant — a player's record follows them between
  // clubs (as `playerStats` and the ratings do), and their results live under
  // each club's RLS. Every read is scoped to THIS player's own matches.
  const source = await runAsSuperuser((db) => read(db, userId, sport));
  const stats = compute(source, userId, now);

  let standing: MyStats['standing'] = null;
  const club = source.sport ? homeClub(source) : null;
  if (club && source.sport) {
    const board = await clubLeaderboard(club.slug, userId, source.sport, now);
    if (board && board.sport === source.sport) {
      const at = board.rows.findIndex((r) => r.userId === userId);
      const from = at === -1 ? 0 : Math.max(0, at - STANDING_AROUND);
      standing = {
        club,
        rank: at === -1 ? null : board.rows[at]!.rank,
        // Not on it: a hidden level, a provisional one, or below its last row.
        absent:
          at !== -1
            ? null
            : !source.ratingPublic
              ? 'HIDDEN'
              : (stats.rating?.provisional ?? true)
                ? 'PROVISIONAL'
                : null,
        total: board.rows.length,
        rows: board.rows.slice(from, from + STANDING_AROUND * 2 + 1),
      };
    }
  }
  return { ...stats, standing };
}

/** The player's counted matches in `sport`, newest first, a page at a time. */
export async function myMatches(
  userId: string,
  sport: SportType | null,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<{ sport: SportType | null; items: MyMatch[]; nextCursor: string | null }> {
  // guardrail-allow: cross-tenant — as `myStats`: this player's own matches.
  const source = await runAsSuperuser((db) => read(db, userId, sport));
  const all = matchesOf(source, userId).reverse();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  // A cursor is the last match of the page before; one that is not among
  // the player's matches is the end, not the start again.
  const start = opts.cursor ? all.findIndex((m) => m.matchId === opts.cursor) + 1 : 0;
  if (opts.cursor && start === 0) return { sport: source.sport, items: [], nextCursor: null };
  const items = all.slice(start, start + limit);
  const more = start + limit < all.length;
  return { sport: source.sport, items, nextCursor: more ? (items.at(-1)?.matchId ?? null) : null };
}
