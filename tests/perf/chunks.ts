import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { firstLoadFiles } from './report';

/**
 * What a route's First Load JS is MADE OF (#340).
 *
 * `perf:bundle` says how big each route's first load is, and a CI gate keeps
 * it from growing. Neither says what the bytes are. When #340 asked why `/`
 * had gone from 196 to 281 KB gzip, the only way to answer was to bisect
 * builds. This is the other way: read the build's own source maps and add up,
 * for every chunk the route loads, how many bytes came from which package and
 * which folder of ours.
 *
 *   PERF_SOURCEMAPS=1 npm run build
 *   npm run perf:chunks -- / /venues            the top of each route
 *   npm run perf:chunks -- --top 60 /           more rows
 *   npm run perf:chunks -- --files /            every source file, not groups
 *
 * `PERF_SOURCEMAPS=1` turns on `productionBrowserSourceMaps` for that one
 * build (next.config.mjs). A normal build has no maps, and this exits 2 saying
 * so, rather than printing an empty table that looks like an answer.
 *
 * ═══ HOW A BYTE IS ATTRIBUTED ═══
 *
 * A source map lists, for each line of the minified chunk, segments: "from
 * this column on, the code came from that source file". The bytes between one
 * segment's column and the next belong to its file. The sum over a chunk is
 * the chunk's size, give or take the glue the bundler adds (a few percent,
 * reported as unattributed). Sizes are of the MINIFIED file, before gzip:
 * gzip does not divide by source, so each row's gzip is estimated from the
 * route's own ratio and marked `~`.
 *
 * The file set is `firstLoadFiles()`, the same one the budget measures.
 */

// ─── Source maps ────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VALUE = new Map([...B64].map((c, i) => [c, i]));

/**
 * Decode a source map's `mappings`: per generated line, its segments as
 * `[generatedColumn, sourceIndex]` (absolute). Segments with no source (the
 * one-field kind) keep `sourceIndex` -1. Original line and column are read
 * past, since nothing here needs them.
 */
export function decodeMappings(mappings: string): Array<Array<[number, number]>> {
  const lines: Array<Array<[number, number]>> = [];
  let source = 0;
  for (const line of mappings.split(';')) {
    const segments: Array<[number, number]> = [];
    let column = 0;
    for (const seg of line.split(',')) {
      if (seg === '') continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of seg) {
        const digit = B64_VALUE.get(ch);
        if (digit === undefined) throw new Error(`not a base64 VLQ digit: ${ch}`);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      column += fields[0] ?? 0;
      if (fields.length >= 4) {
        source += fields[1]!;
        segments.push([column, source]);
      } else {
        segments.push([column, -1]);
      }
    }
    lines.push(segments);
  }
  return lines;
}

interface RawMap {
  sources: string[];
  mappings: string;
}
interface SourceMap extends Partial<RawMap> {
  /** An index map: several maps, each placed at an offset in the file. */
  sections?: Array<{ offset: { line: number; column: number }; map: RawMap }>;
}

/** Bytes of `js` per source file, from its map. Unmapped bytes are under `''`. */
export function bytesBySource(js: string, map: SourceMap): Map<string, number> {
  const out = new Map<string, number>();
  const add = (key: string, n: number) => {
    if (n > 0) out.set(key, (out.get(key) ?? 0) + n);
  };
  const lines = js.split('\n');
  const sections = map.sections ?? [
    {
      offset: { line: 0, column: 0 },
      map: { sources: map.sources ?? [], mappings: map.mappings ?? '' },
    },
  ];
  let mapped = 0;
  for (const section of sections) {
    decodeMappings(section.map.mappings).forEach((segments, i) => {
      const text = lines[section.offset.line + i] ?? '';
      const base = i === 0 ? section.offset.column : 0;
      segments.forEach(([column, source], k) => {
        const start = base + column;
        const end = k + 1 < segments.length ? base + segments[k + 1]![0] : text.length;
        const width = Math.max(0, Math.min(end, text.length) - start);
        if (source >= 0) {
          add(section.map.sources[source] ?? '?', width);
          mapped += width;
        }
      });
    });
  }
  add('', Math.max(0, js.length - mapped));
  return out;
}

// ─── Grouping ───────────────────────────────────────────────────────────────

/** `turbopack:///[project]/src/x.tsx` → `src/x.tsx`. */
export function projectPath(source: string): string {
  return source
    .replace(/^.*?\[project\]\//, '')
    .replace(/^[a-z-]+:\/\/\/?/, '')
    .replace(/^\.\//, '');
}

/**
 * The row a source file is counted under: its npm package, or for our own
 * code the folder that names what it is (`src/components/ui/icons`, one level
 * below `src/components/<area>` and `src/lib`, two below `src` elsewhere).
 */
export function groupOf(source: string): string {
  if (source === '') return '(bundler glue, unattributed)';
  const path = projectPath(source);
  const nm = path.lastIndexOf('node_modules/');
  if (nm >= 0) {
    const rest = path.slice(nm + 'node_modules/'.length).split('/');
    return `npm:${rest[0]!.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]}`;
  }
  const parts = path.split('/');
  if (parts[0] === 'src') {
    const depth = parts[1] === 'components' || parts[1] === 'lib' ? 4 : 3;
    // A file directly in the folder is its own row; a deeper one is its folder's.
    return parts.slice(0, Math.min(depth, parts.length)).join('/');
  }
  return parts.slice(0, 2).join('/');
}

// ─── A route ────────────────────────────────────────────────────────────────

export interface RouteChunks {
  route: string;
  files: number;
  rawBytes: number;
  gzipBytes: number;
  /** Raw bytes per row, largest first. */
  rows: Array<{ name: string; bytes: number }>;
  /** Chunks that had no source map: their bytes are in no row. */
  unmappedBytes: number;
}

export function analyseRoute(
  route: string,
  files: readonly string[],
  nextDir: string,
  by: (source: string) => string,
): RouteChunks {
  const totals = new Map<string, number>();
  let rawBytes = 0;
  let gzipBytes = 0;
  let unmappedBytes = 0;
  let count = 0;

  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    count++;
    const path = join(nextDir, file);
    const js = readFileSync(path, 'utf8');
    rawBytes += Buffer.byteLength(js);
    gzipBytes += gzipSync(js, { level: 9 }).length;

    // The chunk names its own map; Turbopack's map files are not `<chunk>.map`.
    const ref = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(js.slice(-500));
    const mapPath = ref ? join(dirname(path), decodeURIComponent(ref[1]!)) : `${path}.map`;
    if (!existsSync(mapPath)) {
      unmappedBytes += Buffer.byteLength(js);
      continue;
    }
    const map = JSON.parse(readFileSync(mapPath, 'utf8')) as SourceMap;
    for (const [source, bytes] of bytesBySource(js, map)) {
      const name = by(source);
      totals.set(name, (totals.get(name) ?? 0) + bytes);
    }
  }

  return {
    route,
    files: count,
    rawBytes,
    gzipBytes,
    unmappedBytes,
    rows: [...totals].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes),
  };
}

const kb = (bytes: number) => (bytes / 1024).toFixed(1);

export function chunkTable(r: RouteChunks, top: number): string {
  const ratio = r.rawBytes > 0 ? r.gzipBytes / r.rawBytes : 0;
  const lines = [
    `### \`${r.route}\`: ${kb(r.gzipBytes)} KB gzip (${kb(r.rawBytes)} KB minified, ${r.files} files)`,
    '',
    '| Minified KB | Share | ~gzip KB | From |',
    '| ---: | ---: | ---: | --- |',
    ...r.rows
      .slice(0, top)
      .map(
        (row) =>
          `| ${kb(row.bytes)} | ${((100 * row.bytes) / r.rawBytes).toFixed(1)}% | ~${kb(row.bytes * ratio)} | \`${row.name}\` |`,
      ),
  ];
  const rest = r.rows.slice(top);
  if (rest.length > 0) {
    const bytes = rest.reduce((n, row) => n + row.bytes, 0);
    lines.push(
      `| ${kb(bytes)} | ${((100 * bytes) / r.rawBytes).toFixed(1)}% | ~${kb(bytes * ratio)} | ${rest.length} more rows |`,
    );
  }
  return lines.join('\n');
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(argv: string[]): number {
  let top = 30;
  let byFile = false;
  const wanted: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--top') top = Math.max(1, Number(argv[++i]) || 30);
    else if (a === '--files') byFile = true;
    else wanted.push(a);
  }

  const nextDir = '.next';
  const all = firstLoadFiles(nextDir);
  if (all.size === 0) {
    console.error('No build found in .next. Run: PERF_SOURCEMAPS=1 npm run build');
    return 2;
  }
  if (wanted.length === 0) {
    console.error(
      `Usage: npm run perf:chunks -- [--top N] [--files] <route>…\n\nRoutes in this build:\n  ${[...all.keys()].sort().join('\n  ')}`,
    );
    return 2;
  }

  let status = 0;
  for (const route of wanted) {
    const files = all.get(route);
    if (!files) {
      console.error(`No such route in this build: ${route}`);
      status = 2;
      continue;
    }
    const r = analyseRoute(route, files, nextDir, byFile ? projectPath : groupOf);
    if (r.unmappedBytes === r.rawBytes) {
      console.error(
        `${route}: this build has no browser source maps, so nothing can be attributed.\n` +
          `Build with them (local only, never an image): PERF_SOURCEMAPS=1 npm run build`,
      );
      return 2;
    }
    console.log(`${chunkTable(r, top)}\n`);
    if (r.unmappedBytes > 0) {
      console.log(`${kb(r.unmappedBytes)} KB of it is in chunks with no source map.\n`);
    }
  }
  return status;
}

if (process.argv[1] && /chunks\.ts$/.test(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
