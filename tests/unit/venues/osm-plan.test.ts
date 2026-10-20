import {
  osmSportsFor,
  pitchesFrom,
  proposeMatch,
  readingOrder,
  sketch,
  toVenueFrame,
  type OsmWay,
} from '@/lib/venues/osm-plan';

/** Courts' outlines from OpenStreetMap (#624): the frame, the match, the sketch. */
const ORIGIN = { lat: 42.68, lng: 23.34 };
const M_PER_DEG = 111_320;
const dLat = (m: number) => m / M_PER_DEG;
const dLon = (m: number) => m / (M_PER_DEG * Math.cos((ORIGIN.lat * Math.PI) / 180));

/** A closed rectangular way, `w` × `h` metres, its south-west corner at (x, y). */
function way(id: number, sport: string, x: number, y: number, w = 11, h = 24): OsmWay {
  const corners = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y],
  ];
  return {
    id,
    tags: { leisure: 'pitch', sport },
    geometry: corners.map(([cx, cy]) => ({
      lat: ORIGIN.lat + dLat(cy!),
      lon: ORIGIN.lng + dLon(cx!),
    })),
  };
}

describe('the venue frame', () => {
  it('puts metres east in x and north in y', () => {
    const [x, y] = toVenueFrame(ORIGIN, {
      lat: ORIGIN.lat + dLat(30),
      lon: ORIGIN.lng + dLon(-20),
    });
    expect(x).toBeCloseTo(-20, 6);
    expect(y).toBeCloseTo(30, 6);
  });

  it('drops the repeated closing node and keeps the rectangle', () => {
    const [pitch] = pitchesFrom(ORIGIN, [way(1, 'tennis', 0, 0)]);
    expect(pitch!.outline).toHaveLength(4);
    expect(pitch!.outline[2]![0]).toBeCloseTo(11, 1);
    expect(pitch!.outline[2]![1]).toBeCloseTo(24, 1);
    expect(pitch!.centroid[0]).toBeCloseTo(5.5, 1);
  });

  it('leaves out a way that is not a polygon, or is far away', () => {
    const line: OsmWay = {
      id: 2,
      tags: { sport: 'tennis' },
      geometry: [
        { lat: 42.68, lon: 23.34 },
        { lat: 42.681, lon: 23.34 },
      ],
    };
    expect(pitchesFrom(ORIGIN, [line, way(3, 'tennis', 5000, 0)])).toEqual([]);
  });
});

describe('the proposed match', () => {
  // Two rows of tennis courts and a football pitch; OSM lists them out of order.
  const ways = [
    way(13, 'tennis', 30, 0),
    way(11, 'tennis', 0, 30),
    way(14, 'tennis', 0, 0),
    way(12, 'tennis', 15, 31),
    way(20, 'soccer', 60, 0, 40, 60),
  ];
  const pitches = pitchesFrom(ORIGIN, ways);

  it('reads rows north to south, each west to east', () => {
    expect(
      readingOrder(pitches.filter((p) => p.sports.includes('tennis'))).map((p) => p.wayId),
    ).toEqual([11, 12, 14, 13]);
  });

  it('matches courts by sport and name order, numbers sorting as numbers', () => {
    const courts = [
      { id: 'c10', name: 'Корт 10', sport: 'TENNIS' as const },
      { id: 'c2', name: 'Корт 2', sport: 'TENNIS' as const },
      { id: 'c1', name: 'Корт 1', sport: 'TENNIS' as const },
      { id: 'f', name: 'Игрище', sport: 'FOOTBALL5' as const },
      { id: 'sq', name: 'Скуош', sport: 'SQUASH' as const },
    ];
    expect(proposeMatch(courts, pitches)).toEqual([
      { courtId: 'c1', wayId: 11 },
      { courtId: 'c2', wayId: 12 },
      { courtId: 'c10', wayId: 14 },
      { courtId: 'f', wayId: 20 },
    ]);
  });

  it('knows which OSM sports are ours', () => {
    expect(osmSportsFor('FOOTBALL5')).toEqual(['soccer']);
    expect(osmSportsFor('KARTING')).toEqual([]);
  });

  it('sketches every pitch with its label, north up', () => {
    const text = sketch(
      pitches,
      new Map([
        [11, '1'],
        [20, 'F'],
      ]),
    );
    const lines = text.split('\n');
    const row = (label: string) => lines.findIndex((l) => l.includes(label));
    expect(row('1')).toBeGreaterThanOrEqual(0);
    expect(text).toContain('F');
    // Court 1 lies north of the football pitch's centre.
    expect(row('1')).toBeLessThan(row('F'));
  });
});
