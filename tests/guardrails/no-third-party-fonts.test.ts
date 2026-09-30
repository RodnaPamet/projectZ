import { globSync, readFileSync } from 'node:fs';

/**
 * NO FONT FROM ANOTHER ORIGIN (#266).
 *
 * globals.css opened with `@import url(https://fonts.googleapis.com/…)`. That
 * is a render-blocking CHAIN, not one request: the browser parses our CSS,
 * discovers Google's, fetches it from a second origin, discovers the woff2,
 * fetches that from a third — each with its own DNS + TLS on a phone network.
 * PR #268's navigation baseline put it at about 250 ms of first paint on every
 * full load. It also sent every visitor's IP to Google, and asked for discrete
 * weights, so `font-[560]` could not render.
 *
 * Inter is now self-hosted through next/font (src/app/layout.tsx): downloaded
 * at build time, served from /_next/static/media, preloaded.
 *
 * The regression is one pasted line from a font specimen page, so this scans
 * every stylesheet and component under src/ for the two Google Fonts hosts.
 * Comments are blanked first — explaining WHY the import is gone is allowed.
 *
 * Scope is CSS and TSX, where a font gets loaded. `src/lib/security/csp.ts`
 * still lists the hosts in its (unwired) policy; allowing an origin is not
 * requesting from it, and it is tightened with the CSP rollout.
 */

const HOSTS = /fonts\.(?:googleapis|gstatic)\.com/;

/** Blank block comments and whole-line `//` comments — never `//` inside a URL. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FILES = [...globSync('src/**/*.css'), ...globSync('src/**/*.tsx')].map(String);

describe('fonts are self-hosted', () => {
  it('the scan found the stylesheets and components', () => {
    expect(FILES).toContain('src/app/globals.css');
    expect(FILES).toContain('src/app/layout.tsx');
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('no stylesheet or component requests fonts.googleapis.com or fonts.gstatic.com', () => {
    const offenders = FILES.filter((f) => HOSTS.test(codeOf(readFileSync(f, 'utf8'))));

    if (offenders.length > 0) {
      throw new Error(
        `Third-party font host in:\n\n${offenders.map((f) => `  ${f}`).join('\n')}\n\n` +
          `Load the font with next/font (see src/app/layout.tsx). A remote @import or\n` +
          `<link> is a render-blocking chain across two extra origins (#266).`,
      );
    }
  });

  it('the root layout loads Inter through next/font, with Cyrillic', () => {
    const layout = readFileSync('src/app/layout.tsx', 'utf8');

    expect(layout).toMatch(/from 'next\/font\/google'/);
    expect(layout).toMatch(/subsets:\s*\[[^\]]*'cyrillic'/);
    expect(readFileSync('src/app/globals.css', 'utf8')).toMatch(/var\(--font-inter\)/);
  });
});

// ── Negative controls ────────────────────────────────────────────────

describe('the rule fires on the code it forbids', () => {
  it('catches the old @import and a <link>', () => {
    expect(
      HOSTS.test(codeOf("@import url('https://fonts.googleapis.com/css2?family=Inter');")),
    ).toBe(true);
    expect(HOSTS.test(codeOf('<link href="https://fonts.gstatic.com" rel="preconnect" />'))).toBe(
      true,
    );
  });

  it('ignores a comment that names the host', () => {
    expect(HOSTS.test(codeOf('/* the fonts.googleapis.com chain is gone */'))).toBe(false);
    expect(HOSTS.test(codeOf('  // was fonts.gstatic.com'))).toBe(false);
  });
});
