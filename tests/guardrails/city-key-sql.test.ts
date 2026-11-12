import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CITY_SPELLINGS } from '@/lib/geo/cities';

/**
 * `venue.cityKey` is filled by `venue_city_key_for` (P86, #667), a SQL copy of
 * CITY_SPELLINGS. A spelling added to the TypeScript list and not to SQL
 * would leave new venues of that city without a key, and the phone would
 * show them under the typed text. This holds the LATEST definition of the
 * function to the list: adding a city means a migration that replaces it.
 */
describe('venue_city_key_for matches CITY_SPELLINGS', () => {
  const dir = join(process.cwd(), 'prisma/migrations');
  const latest = readdirSync(dir)
    .sort()
    .map((m) => readFileSync(join(dir, m, 'migration.sql'), 'utf8'))
    .filter((sql) => sql.includes('FUNCTION venue_city_key_for'))
    .at(-1);

  it('is defined by a migration', () => {
    expect(latest).toBeDefined();
  });

  it('maps exactly every spelling, lower-cased, to its key', () => {
    const fn = latest!.slice(latest!.indexOf('FUNCTION venue_city_key_for'));
    const sql = [...fn.matchAll(/WHEN '((?:[^']|'')+)' THEN '(\w+)'/g)].map(
      ([, spelling, key]) => [spelling!.replace(/''/g, "'"), key] as const,
    );
    const ts = Object.entries(CITY_SPELLINGS).flatMap(([key, names]) =>
      names.map((n) => [n.toLocaleLowerCase('bg'), key] as const),
    );
    expect(new Map(sql)).toEqual(new Map(ts));
    expect(sql).toHaveLength(ts.length);
  });
});
