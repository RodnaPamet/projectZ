import { globSync, readFileSync } from 'node:fs';

/**
 * EVERY CROSS-TENANT VENUE READ GOES THROUGH `publicVenueFilter` (#298).
 *
 * A venue is public when the venue is ACTIVE and its CLUB is ACTIVE. Before
 * #298 each read wrote `status: ACTIVE` by hand. The sitemap and the club page
 * remembered the club as well; the index, the filters, `near` and the v1
 * detail did not, so a suspended club's venues stayed listed and their cards
 * led to a 404. `src/app-layer/repositories/public-venue.ts` is now the one
 * definition, and this keeps it that way.
 *
 * ═══ THE RULE ═══
 *
 * A Prisma read of `venue` whose `where` names no `tenantId` spans clubs, and
 * a read that spans clubs is a public read unless it says otherwise. It must
 * use `publicVenue.where` (from `publicVenueFilter`), or carry
 *
 *     // public-venue-filter: not a public read — <why>
 *
 * on the call or the lines above it. The same goes for raw SQL reading
 * `"venue"` (`publicVenue.sql(alias)`), and for a relation filter
 * `venue: { status … }` written by hand inside another model's read.
 *
 * A tenant-scoped read (`tenantId` in its where) is about one club the caller
 * already resolved and is out of scope: the club page checks its club's status
 * before it reads that club's venues.
 */

const MARKER = /public-venue-filter:\s*not a public read/;
const USES_FILTER = /\bpublicVenue\.where\b/;
const USES_SQL_FILTER = /\bpublicVenue\.sql\(/;

const VENUE_CALL =
  /\b\w+\.venue\.(findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|aggregate|groupBy)\s*\(/g;
const RAW_VENUE = /FROM\s+"venue"/g;
const HAND_RELATION_FILTER = /\bvenue:\s*\{\s*status\b/g;

interface Finding {
  file: string;
  line: number;
  kind: 'venue read' | 'raw venue SQL' | 'hand-written venue filter';
  snippet: string;
}

/** The text from `open` (an opening bracket) to its match, inclusive. */
function balanced(s: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '`': '`' };
  const close = pairs[s[open]!]!;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === close && (close !== '`' || i > open)) {
      if (close === '`' || --depth === 0) return s.slice(open, i + 1);
    } else if (s[i] === s[open] && close !== '`') depth++;
  }
  return s.slice(open);
}

/** Comments blanked to spaces, so offsets and line numbers still line up. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p: string) => p + ' '.repeat(m.length - p.length));
}

/** The `where: { … }` of a call body, or '' when it has none. */
function whereClause(body: string): string {
  const at = body.search(/\bwhere:\s*\{/);
  if (at === -1) return '';
  return balanced(body, body.indexOf('{', at));
}

export function scanSource(file: string, source: string): Finding[] {
  const code = stripComments(source);
  const findings: Finding[] = [];
  const lineOf = (i: number) => code.slice(0, i).split('\n').length;
  // The marker is a comment, so it is looked for in the ORIGINAL source: on
  // the call's own span or the six lines above it.
  const marked = (start: number, end: number) => {
    const from = source.lastIndexOf('\n', start);
    const lines = source.slice(0, Math.max(0, from)).split('\n');
    return MARKER.test(lines.slice(-6).join('\n')) || MARKER.test(source.slice(start, end));
  };
  const add = (i: number, kind: Finding['kind']) =>
    findings.push({
      file,
      line: lineOf(i),
      kind,
      snippet: source.split('\n')[lineOf(i) - 1]!.trim().slice(0, 100),
    });

  for (const m of code.matchAll(VENUE_CALL)) {
    const open = m.index + m[0].length - 1;
    const body = balanced(code, open);
    if (/\btenantId\b/.test(whereClause(body))) continue;
    if (USES_FILTER.test(body) || marked(m.index, open + body.length)) continue;
    add(m.index, 'venue read');
  }

  for (const m of code.matchAll(RAW_VENUE)) {
    // The enclosing template literal: from the last backtick before the match.
    const tick = code.lastIndexOf('`', m.index);
    const sql = tick === -1 ? code.slice(m.index) : balanced(code, tick);
    if (USES_SQL_FILTER.test(sql) || marked(m.index, m.index + sql.length)) continue;
    add(m.index, 'raw venue SQL');
  }

  for (const m of code.matchAll(HAND_RELATION_FILTER)) {
    if (marked(m.index, m.index + m[0].length)) continue;
    add(m.index, 'hand-written venue filter');
  }

  return findings;
}

describe('public venue reads go through publicVenueFilter (#298)', () => {
  const files = globSync('src/**/*.{ts,tsx}')
    .map(String)
    .filter((f) => !f.startsWith('src/generated/'));

  it('the scan found the source tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('every cross-tenant venue read uses the shared predicate or says why not', () => {
    const findings = files.flatMap((f) => scanSource(f, readFileSync(f, 'utf8')));
    const report = findings
      .map((x) => `  ${x.file}:${x.line}  [${x.kind}]  ${x.snippet}`)
      .join('\n');
    expect(findings.length === 0 ? '' : report).toBe('');
  });

  it('the predicate itself still requires the CLUB to be active', () => {
    // The guardrail above trusts `publicVenueFilter`; this pins what it means.
    const src = readFileSync('src/app-layer/repositories/public-venue.ts', 'utf8');
    expect(src).toMatch(/venueOrg\.findMany\(\{\s*where:\s*\{\s*status:\s*\{\s*not:\s*'ACTIVE'/);
    expect(src).toMatch(/tenantId:\s*\{\s*notIn:/);
    expect(src).toMatch(/"tenantId" NOT IN/);
  });

  describe('the detector itself', () => {
    // A scan that passes because it stopped detecting is worse than none.
    const scan = (src: string) => scanSource('synthetic.ts', src);

    it('FLAGS a cross-tenant venue read filtered on status alone', () => {
      expect(
        scan(`const v = await db.venue.findMany({ where: { status: 'ACTIVE' }, take: 5 });`),
      ).toEqual([expect.objectContaining({ kind: 'venue read', line: 1 })]);
    });

    it('FLAGS one whose only tenantId is in the select, not the where', () => {
      expect(
        scan(
          [
            'await db.venue.findMany({',
            "  where: { status: 'ACTIVE' },",
            '  select: { tenantId: true },',
            '  take: 5,',
            '});',
          ].join('\n'),
        ),
      ).toHaveLength(1);
    });

    it('accepts the shared predicate', () => {
      expect(
        scan(`await db.venue.findFirst({ where: { AND: [{ id }, publicVenue.where] } });`),
      ).toEqual([]);
    });

    it('accepts a tenant-scoped read', () => {
      expect(
        scan(
          `await db.venue.findMany({ where: { tenantId: club.id, status: 'ACTIVE' }, take: 5 });`,
        ),
      ).toEqual([]);
    });

    it('accepts the marker above the call, and not a marker that is missing its reason', () => {
      const call = `await db.venue.findMany({ where: { id: { in: ids } }, take: 5 });`;
      expect(
        scan(`// public-venue-filter: not a public read — the platform queue\n${call}`),
      ).toEqual([]);
      expect(scan(`// public-venue-filter\n${call}`)).toHaveLength(1);
    });

    it('FLAGS raw SQL on "venue" without publicVenue.sql, and accepts it with', () => {
      expect(scan('db.$queryRaw`SELECT id FROM "venue" v WHERE v.status = \'ACTIVE\'`')).toEqual([
        expect.objectContaining({ kind: 'raw venue SQL' }),
      ]);
      expect(
        scan('db.$queryRaw(Prisma.sql`SELECT id FROM "venue" v WHERE ${publicVenue.sql(\'v\')}`)'),
      ).toEqual([]);
    });

    it('FLAGS a hand-written relation filter on venue status', () => {
      expect(
        scan(`db.resource.findMany({ where: { venue: { status: 'ACTIVE' } }, take: 5 });`),
      ).toEqual([expect.objectContaining({ kind: 'hand-written venue filter' })]);
      expect(
        scan(`db.resource.findMany({ where: { venue: publicVenue.where }, take: 5 });`),
      ).toEqual([]);
    });

    it('ignores the pattern inside a comment', () => {
      expect(scan(`// db.venue.findMany({ where: { status: 'ACTIVE' } })`)).toEqual([]);
    });
  });
});
