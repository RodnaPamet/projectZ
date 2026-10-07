import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEFAULT_ROOTS, analyseReachability } from '../../scripts/ui-sync/reachability.mjs';

/**
 * EVERY COMPONENT FILE IS RUN BY THE PRODUCT, OR SAYS WHY NOT (#225, T29).
 *
 * ═══ WHY ═══
 *
 * #225 measured 439 of 488 files under src/components imported by nothing,
 * most of them another product's screens and vocabulary. A file nothing runs
 * still costs: it is type-checked, linted, scanned by every guardrail and by
 * Tailwind, and read by whoever greps the tree, and its words look like
 * playerz's. T28 deleted 74 such component files. This keeps the count where
 * T28 left it.
 *
 * ═══ THE THREE KINDS OF FILE ═══
 *
 * scripts/ui-sync/reachability.mjs walks imports symbol by symbol from
 * src/app/**, src/*.ts and scripts/** (a named import through a barrel keeps
 * only the file that defines the name). Every file under src/components/ is:
 *
 *   reachable      the product runs it;
 *   heldByBarrel   nothing runs it, but a used barrel re-exports it, so it is
 *                  compiled and deleting it breaks the build. These are the
 *                  leaves of the vendored ui/hooks and ui/icons barrels (326
 *                  of them at T28), byte-identical to upstream: they go when
 *                  upstream's components import by module path and the barrels
 *                  are re-copied. The count may only fall;
 *   orphaned       imported by nothing that is built. Deleting it breaks
 *                  nothing, so it must be deleted, or be on the list below
 *                  with a reason.
 *
 * The brief's target was "unreachable = 0". That is the target for orphans,
 * which this enforces. Held files cannot reach 0 from this repo without
 * editing a vendored barrel, so they are a ratchet instead.
 */

/** Orphans kept on purpose. */
const KEPT: Record<string, string> = {
  'src/components/chess/EngineAttribution.tsx':
    'the Stockfish GPL attribution, a licence condition gpl-isolation.test.ts requires a UI ' +
    'surface to render; it is mounted when the chess analysis page lands',
  'src/components/reports/online-share-card.tsx':
    'the club’s "Онлайн резервации" card (#371). The club admin page that mounts it, ' +
    '"Отчети и такса", is #372’s, built in parallel; the card goes into that page’s marked ' +
    'slot when #372 merges, and this entry goes with it',
};

/** heldByBarrel at T29. Lower it when a re-sync drops a barrel line; never raise it. */
const HELD_CEILING = 326;

const SCOPE = ['src/components/'];

describe('component reachability', () => {
  const r = analyseReachability({ roots: DEFAULT_ROOTS, scope: SCOPE });

  it('the walk is not vacuous', () => {
    // A broken root glob or resolver makes everything unreachable, and a
    // broken scope makes nothing so: both are caught by these.
    expect(r.seeds).toBeGreaterThan(50);
    expect(r.reachable).toBeGreaterThan(80);
    expect(r.files).toBe(r.reachable + r.unreachable.length);
    expect(r.unreachable.length).toBe(r.heldByBarrel.length + r.orphaned.length);
    expect(r.unresolvedSymbols).toEqual([]);
    for (const live of [
      'src/components/ui/button.tsx',
      'src/components/layout/club-admin-shell.tsx',
      'src/components/layout/BottomTabBar.tsx',
    ])
      expect(r.unreachable).not.toContain(live);
  });

  it('has no orphaned component file outside the kept list', () => {
    const orphans = r.orphaned.filter((f: string) => !(f in KEPT));
    if (orphans.length > 0) {
      throw new Error(
        `${orphans.length} component file(s) nothing imports:\n\n  ${orphans.join('\n  ')}\n\n` +
          `Delete them (and their tests). If one is about to be used, land it with its\n` +
          `first caller instead. If it must stay unused, add it to KEPT with the reason.\n` +
          `Reproduce: node scripts/ui-sync/reachability.mjs`,
      );
    }
  });

  it('every kept file is still an orphan, and says why', () => {
    for (const [file, why] of Object.entries(KEPT)) {
      expect(r.orphaned).toContain(file);
      expect(why.length).toBeGreaterThan(40);
    }
  });

  it('the barrel-held count only falls', () => {
    if (r.heldByBarrel.length > HELD_CEILING) {
      throw new Error(
        `${r.heldByBarrel.length} files are compiled only because a barrel re-exports them ` +
          `(ceiling ${HELD_CEILING}). A new export in a vendored barrel is an upstream change; ` +
          `import the module by its path instead of adding to a barrel.`,
      );
    }
    expect(r.heldByBarrel.length).toBeLessThanOrEqual(HELD_CEILING);
  });
});

// ── Negative control ─────────────────────────────────────────────────

describe('a new unreachable file fails', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'component-reach-'));
    const files: Record<string, string> = {
      'src/app/page.tsx': "import { Used } from '@/components/ui';\nexport default Used;",
      'src/components/ui/index.ts': "export { Used } from './used';\nexport * from './leaf';",
      'src/components/ui/used.tsx': 'export const Used = 1;',
      'src/components/ui/leaf.tsx': 'export const Leaf = 1;',
      'src/components/ui/new-orphan.tsx': 'export const Orphan = 1;',
    };
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), `${text}\n`);
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('an unimported component is an orphan; a barrel leaf is held, not orphaned', () => {
    const r = analyseReachability({ root, roots: DEFAULT_ROOTS, scope: SCOPE });
    expect(r.orphaned).toEqual(['src/components/ui/new-orphan.tsx']);
    expect(r.heldByBarrel).toEqual(['src/components/ui/leaf.tsx']);
    expect(r.unreachable.sort()).toEqual([
      'src/components/ui/leaf.tsx',
      'src/components/ui/new-orphan.tsx',
    ]);
  });
});
