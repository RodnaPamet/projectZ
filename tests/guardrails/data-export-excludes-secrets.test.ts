import { readFileSync } from 'node:fs';

import { EXPORT_EXCLUDED_COLUMNS } from '../helpers/export-excluded';

/**
 * THE PERSONAL-DATA EXPORT NEVER SELECTS A SECRET (#370).
 *
 * `GET /api/v1/me/export` hands a file to whoever holds the session. A file
 * that carried the password hash, the second factor's seed, a session or
 * refresh token hash, push keys or a device token would turn one stolen
 * session into a stolen account, and it would leave playerz with the person
 * who downloaded it. So the export reads named columns only, and this pins
 * that none of them is one of these.
 *
 * Text-level, over the use case and its route: a column that appears as an
 * object key in code (`passwordHash: true`, `tokenHash: row.tokenHash`) is a
 * finding. tests/integration/data-export.test.ts checks a real file for the
 * same names and for the seeded values themselves.
 */
const FILES = ['src/app-layer/usecases/data-export.ts', 'src/app/api/v1/me/export/route.ts'];

/** The file with comments removed: a comment may name a column it excludes. */
function code(path: string): string {
  let inBlock = false;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (inBlock) {
        if (t.includes('*/')) inBlock = false;
        return false;
      }
      if (t.startsWith('/*')) {
        if (!t.includes('*/')) inBlock = true;
        return false;
      }
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

const selects = (src: string, column: string) =>
  new RegExp(`(^|[\\s{,])${column}\\s*:`, 'm').test(src);

describe('the personal-data export selects no secret (#370)', () => {
  it('reads the export’s files', () => {
    for (const f of FILES) expect(code(f).length).toBeGreaterThan(200);
  });

  it.each(FILES)('%s names none of the excluded columns', (file) => {
    const src = code(file);
    const found = EXPORT_EXCLUDED_COLUMNS.filter((c) => selects(src, c));
    expect(found).toEqual([]);
  });

  it('the list covers every credential column in the schema', () => {
    // A credential added to the schema later must be added to the list too.
    const schema = readFileSync('prisma/schema/auth.prisma', 'utf8').concat(
      readFileSync('prisma/schema/notifications.prisma', 'utf8'),
      readFileSync('prisma/schema/devices.prisma', 'utf8'),
      readFileSync('prisma/schema/wearables.prisma', 'utf8'),
    );
    const credentials = [
      ...schema.matchAll(/^\s+(\w*(?:[Hh]ash|[Ss]ecret|Enc|[Tt]oken|p256dh|auth))\s/gm),
    ].map((m) => m[1]!);
    const missing = [...new Set(credentials)].filter(
      (c) => !(EXPORT_EXCLUDED_COLUMNS as readonly string[]).includes(c),
    );
    expect(missing).toEqual([]);
  });

  // ── Negative control ───────────────────────────────────────────────
  it('the detector fires on a select of one', () => {
    expect(selects('select: { id: true, passwordHash: true }', 'passwordHash')).toBe(true);
    expect(selects('  tokenHash: row.tokenHash,', 'tokenHash')).toBe(true);
    expect(selects('select: { id: true, name: true }', 'passwordHash')).toBe(false);
    // A column whose name merely CONTAINS an excluded one is not it.
    expect(selects('refreshTokenHash: true', 'tokenHash')).toBe(false);
  });
});
