import { readFileSync } from 'node:fs';

/**
 * THE NATIVE-FEEL LAYER, AND THE WAYS IT QUIETLY BREAKS.
 *
 * Everything in P4 is motion or device chrome. Both are the kind of thing that
 * looks fine in review, works on the reviewer's laptop, and is wrong on a phone
 * — or wrong for somebody whose vestibular system cannot tolerate it.
 */

const LAYOUT = readFileSync('src/app/layout.tsx', 'utf8');
const CSS = readFileSync('src/app/globals.css', 'utf8');
const VT = readFileSync('src/lib/view-transition.ts', 'utf8');

describe('device chrome', () => {
  it('themeColor is a light/dark PAIR, not one colour', () => {
    // We ship a PWA (P22) and two themes (P23). A single colour is right in one
    // theme and wrong in the other — and a chrome colour that is NEARLY the page
    // background is more obviously wrong than one that is completely different,
    // because the seam is visible.
    expect(LAYOUT).toMatch(/themeColor:\s*\[/);
    expect(LAYOUT).toMatch(/prefers-color-scheme:\s*dark/);
    expect(LAYOUT).toMatch(/prefers-color-scheme:\s*light/);
  });

  it('the chrome colours are the ACTUAL page tokens', () => {
    // Not approximations. If these drift from --bg-page the seam reappears.
    const tokens = readFileSync('src/styles/tokens.css', 'utf8');

    const dark = /--bg-page:\s*(#[0-9a-f]{6})/i.exec(tokens)?.[1];
    expect(dark).toBeTruthy();
    expect(LAYOUT.toLowerCase()).toContain(dark!.toLowerCase());
  });

  it('viewport-fit is `cover`, or the safe-area utilities are silent no-ops', () => {
    // env(safe-area-inset-*) returns 0 without it. The .safe-area-* classes would
    // still be applied, still look correct in the source, and do NOTHING — the
    // notch would go on eating the header.
    expect(LAYOUT).toMatch(/viewportFit:\s*['"]cover['"]/);
  });

  it('safe-area-top exists, not just -bottom', () => {
    // A sticky header without it sits UNDER the status bar.
    expect(CSS).toMatch(/\.safe-area-top\s*\{/);
    expect(CSS).toMatch(/env\(safe-area-inset-top\)/);
  });
});

describe('the theme never flashes', () => {
  // Before the pre-paint script, <html> shipped with no data-theme, so every
  // light-theme visitor saw the dark `:root` palette until ThemeProvider's
  // mount effect ran — and axe once sampled a button mid-transition (#115).

  it('the server renders data-theme from the theme cookie', () => {
    expect(LAYOUT).toMatch(/cookies\(\)\)\.get\(THEME_COOKIE\)/);
    expect(LAYOUT).toMatch(/data-theme=\{initialTheme\}/);
  });

  it('a pre-paint script covers the first visit, built from the constants', () => {
    // Literal key names would silently disagree with ThemeProvider the day the
    // keys are renamed, and the flash would return on every load.
    expect(LAYOUT).toMatch(/dangerouslySetInnerHTML=\{\{ __html: THEME_INIT_SCRIPT \}\}/);
    expect(LAYOUT).toMatch(/jsToken\(\s*THEME_COOKIE,?\s*\)/);
    expect(LAYOUT).toMatch(/jsToken\(\s*THEME_STORAGE_KEY,?\s*\)/);
    // Allow-listed, not JSON.stringify'd: CodeQL's js/bad-code-sanitization
    // (JSON does not escape `</script>`), alerts 88-90 on PR #283.
    expect(LAYOUT).not.toMatch(/JSON\.stringify\(\s*THEME_/);
    expect(LAYOUT).not.toMatch(/inflect_theme|inflect:theme/);
  });

  it('the script carries no backslash escapes', () => {
    // It is a template literal emitted into HTML: every escape passes through
    // two parsers, and getting one level wrong turned `\s` into `s` and `\b`
    // into a backspace, so the cookie never matched (see layout.tsx).
    const script = /const THEME_INIT_SCRIPT = `([\s\S]*?)`;/.exec(LAYOUT)?.[1];

    expect(script).toBeTruthy();
    expect(script).not.toMatch(/\\/);
  });

  it('the constants come from the server-safe module, not the client ThemeProvider', () => {
    // A server import of a 'use client' module's constant is a client-reference
    // proxy, so `cookies().get(THEME_COOKIE)` would always miss.
    expect(LAYOUT).toMatch(/from '@\/lib\/theme-constants'/);
    expect(LAYOUT).not.toMatch(/THEME_COOKIE[^;]*from '@\/components\/theme\/ThemeProvider'/);
  });

  it('the chrome colour follows the CHOSEN theme, not only the OS one', () => {
    expect(LAYOUT).toMatch(/meta\[name="theme-color"\]/);
    const providers = readFileSync('src/app/providers.tsx', 'utf8');
    expect(providers).toMatch(/attributeFilter:\s*\['data-theme'\]/);
    expect(providers).toMatch(/--bg-page/);
  });
});

describe('scroll chaining', () => {
  it('overscroll-behavior-y is contained, or the browser fights pull-to-refresh', () => {
    // Chrome for Android has its OWN pull-to-refresh. Without `contain` it
    // reloads the whole page while ours is running — two refreshes, one of which
    // throws the app away.
    expect(CSS).toMatch(/overscroll-behavior-y:\s*contain/);
  });

  it('…and the -x half is still there (P1)', () => {
    expect(CSS).toMatch(/overscroll-behavior-x:\s*none/);
  });
});

describe('view transitions', () => {
  it('are disabled under prefers-reduced-motion, in JAVASCRIPT', () => {
    // A view transition is a browser-level animation of a SNAPSHOT, not a CSS
    // transition on an element. The global reduced-motion override in globals.css
    // cannot reach it — it must be suppressed before it starts.
    expect(VT).toMatch(/prefers-reduced-motion/);
    expect(VT).toMatch(/prefersReducedMotion\(\)/);
  });

  it('ALWAYS run the update, even when the transition cannot', () => {
    // The contract. If the API is missing, the user opted out, or the browser
    // throws — the navigation still happens. A pretty transition that can swallow
    // a navigation is a broken app.
    const fn = VT.slice(VT.indexOf('export function withViewTransition'));

    // Two escape paths call it directly (unsupported / reduced-motion, and the
    // catch), and the happy path HANDS it to startViewTransition. All three reach
    // update(); none of them can drop it.
    expect((fn.match(/update\(\);/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(fn).toMatch(/startViewTransition!\(update\)/);
    expect(fn).toMatch(/catch\s*\{[\s\S]*?update\(\);/);
  });

  it('add ZERO new dependencies — the module imports nothing', () => {
    // The reflex here is framer-motion: 30+ KB to cross-fade a page, it needs the
    // tree wrapped in AnimatePresence, and it fights the App Router's streaming.
    // `document.startViewTransition` is in the browser.
    //
    // NOTE: `motion` IS already a dependency — it came with the ported component
    // library and is genuinely used by the table, the toggle group and the root
    // providers (5 import sites since T28 deleted the charts).
    // So the claim is not "no animation library exists"; it is that the ROUTE
    // TRANSITION layer added nothing and pulls in nothing.
    const imports = VT.match(/^import .*/gm) ?? [];

    expect(imports).toEqual([]);
  });

  it('framer-motion specifically was not reached for', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
    };

    expect(Object.keys(pkg.dependencies)).not.toContain('framer-motion');
  });

  it('are FAST — a transition you notice is one you resent by the tenth time', () => {
    const durations = [...CSS.matchAll(/::view-transition[^{]*\{[^}]*?(\d+)ms/gs)].map((m) =>
      Number(m[1]),
    );

    expect(durations.length).toBeGreaterThan(0);
    for (const d of durations) expect(d).toBeLessThanOrEqual(200);
  });
});

describe('the gestures cannot be stolen', () => {
  const SWIPE = readFileSync('src/lib/hooks/use-swipe-navigation.ts', 'utf8');
  const PTR = readFileSync('src/lib/hooks/use-pull-to-refresh.ts', 'utf8');

  it('a swipe starting on a horizontally-scrollable child is NOT a tab change', () => {
    // Otherwise the user cannot reach the columns of a table they can plainly
    // see, because every attempt to scroll it changes the tab.
    expect(SWIPE).toMatch(/startedOnScrollableChild/);
    expect(SWIPE).toMatch(/scrollWidth > el\.clientWidth/);
  });

  it('a mostly-vertical drag is a scroll, not a swipe', () => {
    // Every downward flick has some horizontal component.
    expect(SWIPE).toMatch(/HORIZONTAL_DOMINANCE/);
  });

  it('pull-to-refresh only arms AT THE TOP of the page', () => {
    // The single most infuriating way to get this wrong: it fires while the user
    // is halfway down a list dragging their thumb to scroll up, and the item they
    // were reaching for disappears.
    expect(PTR).toMatch(/atTop\(\)/);
    expect(PTR).toMatch(/armed\.current = atTop\(\)/);
  });

  it('every touch listener is passive — a non-passive one makes scrolling judder', () => {
    for (const [name, src] of [
      ['swipe', SWIPE],
      ['pull-to-refresh', PTR],
    ] as const) {
      const listeners = src.match(/addEventListener\([^)]*\)/gs) ?? [];
      const touchListeners = listeners.filter((l) => /touch/.test(l));

      expect(touchListeners.length).toBeGreaterThan(0);

      for (const l of touchListeners) {
        expect(`${name}: ${l}`).toMatch(/passive:\s*true/);
      }
    }
  });
});
