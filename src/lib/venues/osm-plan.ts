import type { SportType } from '@prisma/client';

import { parseOutline, type PlanPoint } from './plan';

/**
 * Courts' outlines from OpenStreetMap (#624): the pitches (`leisure=pitch`)
 * around a venue, in the venue's own frame, and a proposed match to its
 * courts. OSM ways carry no court numbers, so the match is only a proposal:
 * a person confirms it against the sketch, or names their own.
 *
 * Pure: the network and the database are the ops command's.
 */

/** A pitch as Overpass answers it (`out geom`). */
export interface OsmWay {
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

export interface Pitch {
  wayId: number;
  /** OSM's `sport` values for it, e.g. `tennis`, `soccer`. */
  sports: string[];
  outline: PlanPoint[];
  centroid: PlanPoint;
}

export interface CourtToMatch {
  id: string;
  name: string;
  sport: SportType;
}

/** Metres per degree of latitude: close enough across a venue's grounds. */
const M_PER_DEG = 111_320;

/**
 * A point in the venue's frame: metres east (x) and north (y) of its point.
 * Equirectangular around the venue, which is exact to centimetres over the
 * few hundred metres a venue's grounds span.
 */
export function toVenueFrame(
  origin: { lat: number; lng: number },
  p: { lat: number; lon: number },
): PlanPoint {
  const x = (p.lon - origin.lng) * M_PER_DEG * Math.cos((origin.lat * Math.PI) / 180);
  const y = (p.lat - origin.lat) * M_PER_DEG;
  return [x, y];
}

/** OSM's `sport` values for each of ours; a sport OSM has no pitch for maps to none. */
const OSM_SPORT: Partial<Record<SportType, string[]>> = {
  TENNIS: ['tennis'],
  PADEL: ['padel', 'padel_tennis'],
  BADMINTON: ['badminton'],
  TABLE_TENNIS: ['table_tennis'],
  BEACH_TENNIS: ['beach_tennis'],
  PICKLEBALL: ['pickleball'],
  SQUASH: ['squash'],
  FOOTBALL: ['soccer'],
  FOOTBALL5: ['soccer'],
  BASKETBALL: ['basketball'],
  VOLLEYBALL: ['volleyball'],
  BEACH_VOLLEYBALL: ['beachvolleyball', 'beach_volleyball'],
  HANDBALL: ['handball'],
};

export function osmSportsFor(sport: SportType): string[] {
  return OSM_SPORT[sport] ?? [];
}

/** The pitches Overpass found, in the venue's frame; a way that is not a sane polygon is dropped. */
export function pitchesFrom(origin: { lat: number; lng: number }, ways: OsmWay[]): Pitch[] {
  return ways.flatMap((way) => {
    const points = (way.geometry ?? []).map((p) => toVenueFrame(origin, p));
    // A closed way repeats its first node last; the plan's polygon does not.
    const first = points[0];
    const last = points.at(-1);
    if (first && last && points.length > 1 && first[0] === last[0] && first[1] === last[1])
      points.pop();
    const outline = parseOutline(points);
    if (!outline) return [];
    const sports = (way.tags?.sport ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    return [{ wayId: way.id, sports, outline, centroid: centroid(outline) }];
  });
}

export function centroid(points: PlanPoint[]): PlanPoint {
  const x = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const y = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  return [x, y];
}

/** «Корт 2» before «Корт 10». */
const byName = (a: CourtToMatch, b: CourtToMatch) =>
  a.name.localeCompare(b.name, 'bg', { numeric: true, sensitivity: 'base' });

/**
 * Reading order on a plan: rows from north to south, each west to east. Two
 * pitches whose centres are within `rowTolerance` metres north–south share a
 * row, which is how courts in a line are laid out.
 */
export function readingOrder(pitches: Pitch[], rowTolerance = 8): Pitch[] {
  const sorted = [...pitches].sort((a, b) => b.centroid[1] - a.centroid[1]);
  const rows: Pitch[][] = [];
  for (const p of sorted) {
    const row = rows.find((r) => Math.abs(r[0]!.centroid[1] - p.centroid[1]) <= rowTolerance);
    if (row) row.push(p);
    else rows.push([p]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.centroid[0] - b.centroid[0]));
}

/**
 * A proposed court ↔ pitch match: for each sport, the venue's courts by name
 * against the pitches of that sport in reading order. Courts without a pitch
 * stay unmatched; so do pitches without a court. Only a proposal.
 */
export function proposeMatch(
  courts: CourtToMatch[],
  pitches: Pitch[],
): Array<{ courtId: string; wayId: number }> {
  const out: Array<{ courtId: string; wayId: number }> = [];
  const used = new Set<number>();
  const sports = [...new Set(courts.map((c) => c.sport))];
  for (const sport of sports) {
    const wanted = osmSportsFor(sport);
    const mine = courts.filter((c) => c.sport === sport).sort(byName);
    const theirs = readingOrder(
      pitches.filter((p) => !used.has(p.wayId) && p.sports.some((s) => wanted.includes(s))),
    );
    mine.forEach((court, i) => {
      const pitch = theirs[i];
      if (!pitch) return;
      used.add(pitch.wayId);
      out.push({ courtId: court.id, wayId: pitch.wayId });
    });
  }
  return out;
}

/**
 * A text sketch of the pitches, north up, each marked by its number in
 * `labels` (1-based), for a person to check the match against what they know.
 */
export function sketch(
  pitches: Pitch[],
  labels: Map<number, string>,
  width = 60,
  height = 20,
): string {
  if (pitches.length === 0) return '(no pitches)';
  const xs = pitches.flatMap((p) => p.outline.map((q) => q[0]));
  const ys = pitches.flatMap((p) => p.outline.map((q) => q[1]));
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const sx = (width - 1) / Math.max(maxX - minX, 1);
  const sy = (height - 1) / Math.max(maxY - minY, 1);
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ' '));
  for (const p of pitches) {
    for (const [x, y] of p.outline) {
      const col = Math.round((x - minX) * sx);
      const row = height - 1 - Math.round((y - minY) * sy);
      grid[row]![col] = '·';
    }
    const label = labels.get(p.wayId) ?? '?';
    const col = Math.round((p.centroid[0] - minX) * sx);
    const row = height - 1 - Math.round((p.centroid[1] - minY) * sy);
    [...label].forEach((ch, i) => {
      if (grid[row]?.[col + i] !== undefined) grid[row]![col + i] = ch;
    });
  }
  return grid.map((r) => r.join('').trimEnd()).join('\n');
}
