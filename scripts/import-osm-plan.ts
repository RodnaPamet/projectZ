/**
 * Courts' outlines from OpenStreetMap onto a venue's plan (#624).
 *
 * Owner, 2026-10-20: positions come from OSM, then the club adjusts. OSM ways
 * carry no court numbers, so this PROPOSES a match (by sport, courts by name
 * against the pitches in reading order), prints it with a sketch, and writes
 * nothing unless told to. A person who knows the venue confirms it, or names
 * the match themselves with --map.
 *
 *   # What is mapped near a point, no database:
 *   npx tsx scripts/import-osm-plan.ts --at 42.6835,23.3368
 *
 *   # The proposed match for a venue (dry run):
 *   npx tsx scripts/import-osm-plan.ts --venue <venueId>
 *
 *   # Write it, as proposed or with a person's own match:
 *   npx tsx scripts/import-osm-plan.ts --venue <id> --apply
 *   npx tsx scripts/import-osm-plan.ts --venue <id> --map <courtId>=<wayId>,... --apply
 *
 * Outlines from OSM are ODbL: the plan credits «© OpenStreetMap contributors»
 * while one is shown (`GET /venues/{id}/plan` says so). A court the club has
 * drawn itself (`CLUB`) is never overwritten. See docs/onboarding/runbook.md.
 */
import { parseArgs } from 'node:util';

import {
  pitchesFrom,
  proposeMatch,
  sketch,
  type OsmWay,
  type Pitch,
} from '../src/lib/venues/osm-plan';

import { assertOwnerRole, die, ownerConnection } from './lib/onboarding-common';

const OVERPASS = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';

const { values } = parseArgs({
  options: {
    venue: { type: 'string' },
    at: { type: 'string' },
    radius: { type: 'string', default: '200' },
    map: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
});

const radius = Number(values.radius);
if (!Number.isFinite(radius) || radius < 20 || radius > 1000)
  die('--radius is metres, 20 to 1000.');

async function overpass(lat: number, lng: number): Promise<OsmWay[]> {
  const query = `[out:json][timeout:25];way["leisure"="pitch"](around:${radius},${lat},${lng});out tags geom;`;
  const res = await fetch(OVERPASS, {
    method: 'POST',
    // Overpass refuses a request that does not say what it wants back (406),
    // and asks a client to name itself.
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': 'playerz.bg venue plan import (https://playerz.bg)',
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok)
    die(`Overpass answered ${res.status}. Try again in a minute, or set OVERPASS_URL to a mirror.`);
  const body = (await res.json()) as { elements?: OsmWay[] };
  return body.elements ?? [];
}

function describe(p: Pitch, n: number): string {
  const [w, h] = extent(p);
  return `  ${String(n).padStart(2)}. way ${p.wayId}  ${p.sports.join(';') || '(no sport)'}  ~${w}×${h} m  at (${p.centroid[0].toFixed(0)}, ${p.centroid[1].toFixed(0)})`;
}

function extent(p: Pitch): [number, number] {
  const xs = p.outline.map((q) => q[0]);
  const ys = p.outline.map((q) => q[1]);
  return [
    Math.round(Math.max(...xs) - Math.min(...xs)),
    Math.round(Math.max(...ys) - Math.min(...ys)),
  ];
}

function listPitches(pitches: Pitch[]): Map<number, string> {
  const labels = new Map<number, string>();
  pitches.forEach((p, i) => {
    labels.set(p.wayId, String(i + 1));
    console.log(describe(p, i + 1));
  });
  return labels;
}

async function preview(at: string): Promise<void> {
  const [lat, lng] = at.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) die('--at is "lat,lng".');
  const pitches = pitchesFrom({ lat: lat!, lng: lng! }, await overpass(lat!, lng!));
  console.log(
    `\n${pitches.length} pitches within ${radius} m of ${lat},${lng} (x east, y north, metres):\n`,
  );
  const labels = listPitches(pitches);
  console.log(`\n${sketch(pitches, labels)}\n`);
}

function parseMap(raw: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const pair of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [court, way] = pair.split('=');
    const wayId = Number(way);
    if (!court || !Number.isInteger(wayId))
      die(`--map pairs are <courtId>=<wayId>; "${pair}" is not.`);
    out.set(court, wayId);
  }
  return out;
}

async function forVenue(venueId: string): Promise<void> {
  const prisma = ownerConnection();
  try {
    await assertOwnerRole(prisma);
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: {
        id: true,
        name: true,
        lat: true,
        lng: true,
        resources: {
          where: { status: 'ACTIVE' },
          select: { id: true, name: true, sport: true, isIndoor: true, planSource: true },
        },
      },
    });
    if (!venue) die(`No venue ${venueId}.`);
    const origin = { lat: Number(venue.lat), lng: Number(venue.lng) };
    const pitches = pitchesFrom(origin, await overpass(origin.lat, origin.lng));
    console.log(
      `\n${venue.name}: ${pitches.length} pitches within ${radius} m (x east, y north, metres):\n`,
    );
    const labels = listPitches(pitches);
    console.log(`\n${sketch(pitches, labels)}\n`);

    // Indoor courts are drawn in the club's editor (#626), and a club's own
    // drawing is never replaced by OSM's.
    const candidates = venue.resources.filter((r) => !r.isIndoor && r.planSource !== 'CLUB');
    const chosen = values.map
      ? [...parseMap(values.map)].map(([courtId, wayId]) => ({ courtId, wayId }))
      : proposeMatch(candidates, pitches);

    const byWay = new Map(pitches.map((p) => [p.wayId, p]));
    const byCourt = new Map(venue.resources.map((r) => [r.id, r]));
    console.log(
      values.map ? 'The match given:' : 'The proposed match (check it against the sketch):',
    );
    for (const { courtId, wayId } of chosen) {
      const court = byCourt.get(courtId);
      if (!court) die(`No active court ${courtId} at this venue.`);
      if (court.planSource === 'CLUB')
        die(`${court.name} has the club's own outline: not replaced.`);
      if (!byWay.has(wayId)) die(`Way ${wayId} is not among the pitches found.`);
      console.log(`  ${court.name.padEnd(20)} ← pitch ${labels.get(wayId)} (way ${wayId})`);
    }
    const unmatched = venue.resources.filter((r) => !chosen.some((c) => c.courtId === r.id));
    for (const r of unmatched) {
      console.log(
        `  ${r.name.padEnd(20)}   ${r.isIndoor ? 'indoor: the club draws it' : r.planSource === 'CLUB' ? 'the club’s own outline' : 'no pitch'}`,
      );
    }

    if (!values.apply) {
      console.log('\nDRY RUN: nothing was written. Re-run with --apply, or --map … --apply.\n');
      return;
    }
    await prisma.$transaction(
      chosen.map(({ courtId, wayId }) =>
        prisma.resource.update({
          where: { id: courtId },
          data: {
            planOutline: byWay.get(wayId)!.outline,
            planSource: 'OSM',
            planOsmWayId: BigInt(wayId),
          },
        }),
      ),
    );
    console.log(`\n✓ ${chosen.length} outlines written from OpenStreetMap.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  if (values.venue) return forVenue(values.venue);
  if (values.at) return preview(values.at);
  die('Give --venue <id>, or --at lat,lng to look without a database. See the header.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
