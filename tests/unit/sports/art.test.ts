import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SPORTS } from '@/lib/sports/registry';
import { sportArt } from '@/lib/sports/art';

describe('sportArt', () => {
  it('every sport has its own banner, and the file is in public/', () => {
    const paths = Object.keys(SPORTS).map((s) => sportArt(s));
    expect(paths.every(Boolean)).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(existsSync(join(process.cwd(), 'public', p!))).toBe(true);
  });

  it('maps the server names to the file names', () => {
    expect(sportArt('FOOTBALL5')).toBe('/sports/football-5x5.webp');
    expect(sportArt('TABLE_TENNIS')).toBe('/sports/table-tennis.webp');
  });

  it('has none for an unknown sport or none at all', () => {
    expect(sportArt('CURLING')).toBeNull();
    expect(sportArt(null)).toBeNull();
  });
});
