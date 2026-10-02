import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/**
 * A SERVER MODULE MAY RENDER WHAT A 'use client' MODULE EXPORTS — NEVER CALL IT.
 *
 * ═══ THE 500 THIS EXISTS FOR ═══
 *
 * `AppNav.tsx` was `'use client'`, and it exported two plain functions beside
 * the component: `playerNav(slug)` and `adminNav(slug)`. The club layout, a
 * Server Component, imported and CALLED them. Under React Server Components
 * every export of a client module is a client reference on the server, and
 * calling one throws:
 *
 *   Attempted to call playerNav() from the server but playerNav is on the
 *   client. It's not possible to invoke a client function from the server.
 *
 * So every page under `/t/[slug]` — the whole club UI — answered 500 from the
 * day the layout landed (#195) until #227 loaded one in a real server.
 *
 * Nothing else could have caught it. jest does not enforce the client
 * boundary, so a test calling the layout would pass; `tsc` sees an ordinary
 * function; `next build` compiles it happily, because the throw happens at
 * request time. A static rule is the only check that runs before a person does.
 *
 * ═══ THE RULE ═══
 *
 * A module WITHOUT `'use client'` may import from a module WITH it:
 *
 *   - types — `import type { … }`, or a `type X` specifier;
 *   - components — PascalCase names, which it can only render as JSX.
 *
 * Anything else — a function, a hook, a constant — is a value the server
 * cannot use. Put it in a module with no directive, which both sides can
 * import (see `src/components/layout/nav-items.ts`).
 *
 * Stricter than React by one case: RSC will let a server component PASS a
 * client function as a prop without calling it. Nothing here does that. If
 * something ever must, allowlist it below with the reason.
 *
 * Test files are exempt: jest runs them outside any client boundary.
 */

const ALLOWED: Record<string, string> = {};

const DIRECTIVE = /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*['"]use (client|server)['"]/;

function directiveOf(source: string): 'client' | 'server' | null {
  return (DIRECTIVE.exec(source)?.[1] as 'client' | 'server' | undefined) ?? null;
}

const isTestFile = (f: string) => /(?:\/__tests__\/|\.(?:test|spec)\.tsx?$)/.test(f);

/** `@/x` → `src/x`; `./y` against the importer. Packages are not ours. */
function resolveImport(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join('src', spec.slice(2));
  else if (spec.startsWith('.')) base = normalize(join(dirname(fromFile), spec));
  else return null;

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const clientCache = new Map<string, boolean>();
function isClientModule(file: string): boolean {
  if (!clientCache.has(file)) {
    clientCache.set(file, directiveOf(readFileSync(file, 'utf8')) === 'client');
  }
  return clientCache.get(file)!;
}

/** A component: PascalCase, and not an ALL_CAPS constant. */
const isComponentName = (name: string) =>
  /^[A-Z][A-Za-z0-9]*$/.test(name) && !/^[A-Z0-9_]+$/.test(name);

interface Crossing {
  target: string;
  names: string[];
}

/** Every value this source imports from a client module, grouped by module. */
export function valuesImportedFromClient(source: string, fromFile: string): Crossing[] {
  const out: Crossing[] = [];

  const named =
    /import\s+(type\s+)?(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(named)) {
    if (m[1]) continue; // `import type { … }`
    const target = resolveImport(m[4]!, fromFile);
    if (!target || !isClientModule(target)) continue;

    const names = m[3]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('type '))
      .map((s) => s.split(/\s+as\s+/)[0]!.trim());
    if (m[2]) names.push(m[2]); // `import Default, { … }`

    out.push({ target, names });
  }

  const defaultOnly = /import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(defaultOnly)) {
    if (m[1] === 'type') continue;
    const target = resolveImport(m[2]!, fromFile);
    if (!target || !isClientModule(target)) continue;
    out.push({ target, names: [m[1]!] });
  }

  return out;
}

const SERVER_SIDE = globSync('src/**/*.{ts,tsx}')
  .map((f) => f.toString())
  .filter((f) => !isTestFile(f))
  .filter((f) => directiveOf(readFileSync(f, 'utf8')) !== 'client');

describe('the client boundary', () => {
  const crossings = SERVER_SIDE.flatMap((file) =>
    valuesImportedFromClient(readFileSync(file, 'utf8'), file).map((c) => ({ file, ...c })),
  );

  it('the scan is not vacuous', () => {
    // A resolver that resolved nothing would find no crossings and pass.
    expect(SERVER_SIDE.length).toBeGreaterThan(300);
    expect(crossings.length).toBeGreaterThan(10);
    // The club admin layout renders the client shell across the boundary —
    // legitimately (T19; it was the old club layout rendering AppNav).
    expect(crossings).toContainEqual(
      expect.objectContaining({
        file: 'src/app/(app)/t/[slug]/admin/layout.tsx',
        target: 'src/components/layout/club-admin-shell.tsx',
        names: ['ClubAdminShell'],
      }),
    );
  });

  it('server modules import only components and types from client modules', () => {
    const violations = crossings
      .flatMap(({ file, target, names }) =>
        names.filter((n) => !isComponentName(n)).map((n) => `${file}: ${n} from ${target}`),
      )
      .filter((v) => !(v in ALLOWED));

    if (violations.length > 0) {
      throw new Error(
        `A server module imports a non-component VALUE from a 'use client' module:\n\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nOn the server every export of a client module is a client reference. Calling\n` +
          `one throws at REQUEST time — not in tsc, not in jest, not in next build — and the\n` +
          `page answers 500. That is how every club page was down from #195 to #227.\n\n` +
          `Move the function or constant into a module with no directive, and import it\n` +
          `from there on both sides.`,
      );
    }
  });

  it('every allowlist entry states a reason', () => {
    expect(Object.values(ALLOWED).filter((why) => why.trim().length < 20)).toEqual([]);
  });

  // ── Negative controls ──────────────────────────────────────────────
  describe('the detector', () => {
    const LAYOUT = 'src/app/(app)/t/[slug]/admin/layout.tsx';
    const bad = (src: string) =>
      valuesImportedFromClient(src, LAYOUT)
        .flatMap((c) => c.names)
        .filter((n) => !isComponentName(n));

    it('fires on the shape of the import that took the club UI down', () => {
      // #195-#227 imported `{ AppNav, adminNav, playerNav }` from the client
      // AppNav.tsx. AppNav is gone (T19); the client shell stands in for it,
      // because a resolvable 'use client' target is what the detector needs.
      expect(
        bad(
          `import { ClubAdminShell, clubAdminNav, platformNav } from '@/components/layout/club-admin-shell';`,
        ),
      ).toEqual(['clubAdminNav', 'platformNav']);
    });

    it('fires across line breaks, on aliases, and on hooks and constants', () => {
      expect(
        bad(
          [
            'import {',
            '  ClubAdminShell,',
            '  clubAdminNav as nav,',
            "} from '@/components/layout/club-admin-shell';",
            "import { SignOutButton, SOMETHING } from '@/components/layout/SignOutButton';",
          ].join('\n'),
        ),
      ).toEqual(['clubAdminNav', 'SOMETHING']);
    });

    it('does not fire on components or types', () => {
      const SHELL = `'@/components/layout/club-admin-shell'`;
      expect(bad(`import { ClubAdminShell } from ${SHELL};`)).toEqual([]);
      expect(bad(`import type { NavItem } from ${SHELL};`)).toEqual([]);
      expect(bad(`import { type NavItem, ClubAdminShell } from ${SHELL};`)).toEqual([]);
    });

    it('does not fire on a module without the directive', () => {
      expect(
        bad(`import { clubAdminNav, platformNav } from '@/components/layout/nav-items';`),
      ).toEqual([]);
    });

    it('reads the directive past a leading comment, and nowhere else', () => {
      expect(directiveOf(`/** doc */\n'use client';\nexport const x = 1;`)).toBe('client');
      expect(directiveOf(`// note\n"use server";`)).toBe('server');
      expect(directiveOf(`export const x = 1;\n'use client';`)).toBeNull();
    });
  });
});
