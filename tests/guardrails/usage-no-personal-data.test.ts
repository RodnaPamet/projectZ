import { readFileSync } from 'node:fs';

import { allMigrationSql, parseSchemaModels } from '../helpers/prisma-schema-models';
import { PERSONAL } from '../helpers/usage-personal';

/**
 * THE USAGE COUNTERS NAME NOBODY (#371, owner decision Q48).
 *
 * Our own server-side counts, no tracker, no analytics cookie, and so no
 * consent banner beyond the essentials: that holds only while what is counted
 * cannot be tied to a person. `usage_daily` is a daily aggregate per (day,
 * event, venue). The day a column that could hold a user, an IP address, a
 * user agent, a session or a device is added, it becomes a tracking table and
 * the decision is void, silently. So the columns are pinned here, in the
 * schema AND in every migration that touches the table.
 *
 * tests/integration/usage-counts.test.ts asks the live catalogue the same
 * question, for a column added by hand.
 */

const ALLOWED_COLUMNS = ['day', 'event', 'venueId', 'clubId', 'count'];

describe('usage_daily holds no personal data', () => {
  const model = parseSchemaModels().find((m) => m.name === 'UsageDaily');

  it('finds the model', () => {
    expect(model).toBeDefined();
    expect(model!.table).toBe('usage_daily');
  });

  it('has exactly the aggregate columns', () => {
    expect([...model!.fields].sort()).toEqual([...ALLOWED_COLUMNS].sort());
  });

  it('no column could name or follow a person', () => {
    expect(model!.fields.filter((f) => PERSONAL.test(f))).toEqual([]);
  });

  it('no migration adds a column to it beyond those', () => {
    const sql = allMigrationSql();
    const create = /CREATE TABLE "usage_daily" \(([\s\S]*?)\n\);/.exec(sql);
    expect(create).not.toBeNull();
    const created = [...create![1]!.matchAll(/^\s*"([^"]+)"\s/gm)].map((m) => m[1]!);
    expect(created.sort()).toEqual([...ALLOWED_COLUMNS].sort());

    const added = [...sql.matchAll(/ALTER TABLE "usage_daily"[^;]*ADD COLUMN\s+"?([A-Za-z_]+)/g)];
    expect(added.map((m) => m[1])).toEqual([]);
  });

  it('the pattern fires on what it is for', () => {
    for (const bad of ['userId', 'ip', 'ipAddress', 'userAgent', 'ua', 'sessionId', 'deviceId']) {
      expect(PERSONAL.test(bad)).toBe(true);
    }
    for (const fine of ALLOWED_COLUMNS) expect(PERSONAL.test(fine)).toBe(false);
  });

  it('the beacon route stores nothing from the request but the event', () => {
    const route = readFileSync('src/app/api/v1/venues/[id]/usage-events/route.ts', 'utf8');
    // It never reads a cookie, never sets one, and never resolves who is calling.
    expect(route).not.toMatch(/cookies\(|set-cookie|contextFromRequest|getToken/i);
  });
});
