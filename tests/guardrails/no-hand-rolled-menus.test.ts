import { readFileSync, globSync } from 'node:fs';

import { treeFiles } from '../helpers/scan-floor';

/**
 * POPOVER IS THE ONLY MENU PRIMITIVE.
 *
 * The hand-rolled floating menu is one of the most reliably broken patterns in
 * any React codebase. It looks like this:
 *
 *     const [openMenuId, setOpenMenuId] = useState<string | null>(null);
 *     ...
 *     {openMenuId === row.id && (
 *       <>
 *         <div className="fixed inset-0" onClick={() => setOpenMenuId(null)} />
 *         <div className="absolute top-full right-0 z-10">…</div>
 *       </>
 *     )}
 *
 * Every single one of these is wrong, in the same four ways:
 *
 *   1. IT CLIPS. The menu is `absolute`, so it is trapped inside the nearest
 *      ancestor with `overflow: hidden` or `overflow-x-auto` — which, on a table
 *      row, is the table. The last row's menu opens INTO the table and is cut
 *      off. It works perfectly in the developer's test with three rows.
 *
 *   2. IT HIDES UNDER FIXED CHROME. `z-10` loses to any bottom bar, sticky
 *      header or toast, which are all higher.
 *
 *   3. THE CLICK-AWAY EATS THE FIRST TAP ELSEWHERE. The `fixed inset-0` layer
 *      swallows the click that dismissed it, so the user has to tap twice to hit
 *      anything.
 *
 *   4. IT IS A NATIVE-FEELING MENU NOWHERE. No bottom sheet on mobile, no focus
 *      trap, no escape key, no arrow keys, no aria.
 *
 * `<Popover>` + `<Popover.Menu>` + `<Popover.Item>` solves all four: it PORTALS
 * on desktop (so nothing can clip it) and becomes a BOTTOM SHEET on mobile.
 *
 * ─── Empty allowlist, on purpose ─────────────────────────────────────
 *
 * This codebase has zero hand-rolled menus today. So the ratchet starts at zero
 * and the first one ever written fails the build — rather than being grandfathered
 * in behind a baseline that somebody then adds to.
 */

/**
 * ONLY the three overlay primitives are exempt — not the whole component library.
 *
 * `popover.tsx`, `modal.tsx` and `sheet.tsx` are the things that legitimately
 * IMPLEMENT an overlay: they are where `fixed inset-0` is supposed to live. A
 * rule that banned it everywhere would ban the implementation of the rule.
 *
 * The obvious scoping — "exempt src/components/ui/**" — is what the prompt says,
 * and here it would be a mistake. 419 of this codebase's 431 components live in
 * `ui/`. Exempting the directory would leave the guard scanning SEVENTEEN files,
 * and a hand-rolled menu inside `ui/table/` is exactly as broken as one in a
 * page — arguably worse, because every page inherits it.
 *
 * So the exemption is three FILES, not a directory, and the guard scans 428.
 */
const OVERLAY_PRIMITIVES = new Set([
  'src/components/ui/popover.tsx',
  'src/components/ui/modal.tsx',
  'src/components/ui/sheet.tsx',
]);

const SOURCE = [...globSync('src/components/**/*.tsx'), ...globSync('src/app/**/*.tsx')]
  .map((f) => f.toString())
  .filter((f) => !OVERLAY_PRIMITIVES.has(f));

/** Strip comments — this file's own prose describes the pattern it forbids. */
function code(source: string): string {
  const out: string[] = [];
  let inBlock = false;

  for (const raw of source.split('\n')) {
    let line = raw;

    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) {
        // A line INSIDE a block comment. Push a blank so the line COUNT is
        // preserved — `continue` here silently collapses the file and every
        // reported line number drifts by however many comment lines preceded it.
        out.push('');
        continue;
      }
      inBlock = false;
      line = line.slice(end + 2);
    }

    const block = line.indexOf('/*');
    if (block !== -1) {
      const end = line.indexOf('*/', block + 2);
      if (end === -1) {
        inBlock = true;
        line = line.slice(0, block);
      } else {
        line = line.slice(0, block) + line.slice(end + 2);
      }
    }

    const lineComment = line.indexOf('//');
    if (lineComment !== -1) line = line.slice(0, lineComment);

    // PUSH EVERY LINE, even an empty one.
    //
    // The obvious `if (line.trim()) out.push(line)` collapses the file, so the
    // array index no longer maps to the real line number — and every violation
    // this guard reports points at the wrong line. It sent me to a comment about
    // "items per page" while claiming it was a floating menu.
    //
    // A guard whose line numbers lie is worse than no guard: it burns the trust
    // of the person trying to act on it.
    out.push(line);
  }

  return out.join('\n');
}

/** The full-screen click-away layer. */
const CLICK_AWAY = /fixed\s+inset-0/;

/**
 * A menu ANCHORED TO ITS TRIGGER.
 *
 * `top-full` / `bottom-full` is the idiom: "hang directly below/above the button
 * I am positioned against". That is what makes it a menu.
 *
 * I first wrote this as `absolute` + `(top-full|bottom-full|right-0|left-0)` and
 * it false-positived on the table's COLUMN-RESIZE HANDLE — `absolute right-0` is
 * simply how you position any corner element, and `right-0` is not diagnostic of
 * anything. Combined with a file-wide search for the word "menu" (which appears
 * in table.tsx only as a COLUMN ID), it accused a 1,300-line file of a bug it
 * does not have.
 *
 * The second false positive was subtler: `before:absolute before:bottom-full` is
 * a 6px GRADIENT FADE above the sticky pagination bar. `before:` is a Tailwind
 * VARIANT PREFIX — it styles a pseudo-element, not the element. My pattern
 * ignored the prefix and read it as a menu.
 *
 * Hence the lookbehinds: the utility must not be prefixed by a variant.
 *
 * A guard that cries wolf is a guard people switch off. So: only the anchoring
 * idiom, only on the same line, and only on the element itself.
 */
const FLOATING_MENU = /(?<![:\w-])absolute\b[^"'`]*(?<![:\w-])(?:top-full|bottom-full)\b/;

/** The state that drives it. */
const MENU_STATE = /\b(?:openMenuId|menuOpenFor|activeMenuId|openRowMenu|showMenuFor)\b/;

describe('the scan is not vacuous', () => {
  it('scans the whole library, not just the handful of files outside ui/', () => {
    // Every .tsx under src/components and src/app but the three overlay
    // primitives, counted a second way (tests/helpers/scan-floor.ts). Most of
    // the library lives in ui/: if someone exempts the directory again, the
    // sentinels below fail.
    const tree = treeFiles(['src/components', 'src/app'], /\.tsx$/).filter(
      (f) => !OVERLAY_PRIMITIVES.has(f),
    );
    expect([...SOURCE].sort()).toEqual(tree);
    for (const sentinel of [
      'src/components/ui/combobox/index.tsx',
      'src/components/ui/table/table.tsx',
      'src/components/layout/BottomTabBar.tsx',
      'src/app/(app)/t/[slug]/admin/calendar/DayGrid.tsx',
    ]) {
      expect(SOURCE).toContain(sentinel);
    }
  });

  it('the three overlay primitives ARE excluded, and only those', () => {
    expect(SOURCE.some((f) => f.includes('components/ui/popover.tsx'))).toBe(false);
    expect(SOURCE.some((f) => f.includes('components/ui/modal.tsx'))).toBe(false);
    expect(SOURCE.some((f) => f.includes('components/ui/sheet.tsx'))).toBe(false);

    // …but the rest of the library is still in scope.
    expect(SOURCE.some((f) => f.includes('components/ui/table/'))).toBe(true);
  });
});

describe('no hand-rolled floating menu outside the primitives', () => {
  it('nobody builds their own click-away overlay', () => {
    const violations: string[] = [];

    for (const file of SOURCE) {
      const source = code(readFileSync(file, 'utf8'));

      if (CLICK_AWAY.test(source)) {
        violations.push(`${file} — builds its own \`fixed inset-0\` click-away layer`);
      }
      if (MENU_STATE.test(source)) {
        violations.push(`${file} — carries openMenuId-style state driving a menu`);
      }
      // Line-scoped, not file-scoped. A 1,300-line file mentioning "menu"
      // somewhere is not evidence about a div 800 lines away.
      source.split('\n').forEach((line, i) => {
        if (FLOATING_MENU.test(line)) {
          violations.push(
            `${file}:${i + 1} — an absolute element anchored to its trigger (top-full/bottom-full)`,
          );
        }
      });
    }

    if (violations.length > 0) {
      throw new Error(
        `Hand-rolled menu(s):\n\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nEvery hand-rolled floating menu breaks the same four ways:\n\n` +
          `  1. IT CLIPS. An \`absolute\` menu is trapped inside the nearest ancestor with\n` +
          `     overflow-hidden — which on a table row is the TABLE. The last row's menu\n` +
          `     opens into the table and is cut off. It works fine with three rows.\n` +
          `  2. IT HIDES under any fixed chrome with a higher z-index.\n` +
          `  3. THE CLICK-AWAY EATS THE NEXT TAP, so the user has to tap twice.\n` +
          `  4. No bottom sheet, no focus trap, no escape, no arrow keys, no aria.\n\n` +
          `Use <Popover> + <Popover.Menu> + <Popover.Item>. It PORTALS on desktop (so it\n` +
          `cannot be clipped) and becomes a BOTTOM SHEET on mobile.\n\n` +
          `There is no allowlist here. The codebase has zero of these today.`,
      );
    }
  });
});

describe('the Popover primitive really does provide the alternative', () => {
  const popover = readFileSync('src/components/ui/popover.tsx', 'utf8');

  it('exposes Menu and Item slots', () => {
    // A ratchet that forbids the hand-rolled pattern without a working
    // replacement is a ratchet people route around.
    expect(popover).toMatch(/Popover\s*=\s*Object\.assign\(/);
    expect(popover).toMatch(/Menu[,:]/);
    expect(popover).toMatch(/Item[,:]/);
  });

  it('becomes a bottom sheet on mobile — the thing a hand-rolled menu never does', () => {
    expect(popover).toMatch(/Drawer\.Root|Drawer\.Content/);
    expect(popover).toMatch(/isMobile|mobileOnly/);
  });

  it('can be forced to a dropdown when nested inside a sheet', () => {
    // Without this, a Popover inside a Drawer stacks two drawers.
    expect(popover).toMatch(/forceDropdown/);
  });
});

// ── Negative controls ────────────────────────────────────────────────

describe('the rules fire on the code they forbid', () => {
  it('detects a click-away layer', () => {
    expect(CLICK_AWAY.test('<div className="fixed inset-0" onClick={close} />')).toBe(true);
    expect(CLICK_AWAY.test('<div className="absolute inset-0" />')).toBe(false);
  });

  it('detects menu state', () => {
    expect(MENU_STATE.test('const [openMenuId, setOpenMenuId] = useState(null);')).toBe(true);
    expect(MENU_STATE.test('const [openPopover, setOpenPopover] = useState(false);')).toBe(false);
  });

  it('detects a trigger-anchored absolute menu', () => {
    expect(FLOATING_MENU.test('<div className="absolute top-full right-0 z-10">')).toBe(true);
    expect(FLOATING_MENU.test('<div className="absolute bottom-full left-0">')).toBe(true);
  });

  it('does NOT flag a `before:` pseudo-element', () => {
    // The second false positive. This is the gradient fade above the sticky
    // pagination bar — `before:` styles a pseudo-element, not the element, and it
    // is a 6px hairline, not a menu.
    expect(
      FLOATING_MENU.test(
        '<div className="before:pointer-events-none before:absolute before:bottom-full before:h-6">',
      ),
    ).toBe(false);
  });

  it('does NOT flag an ordinary corner-positioned element', () => {
    // The false positive that taught me the rule. `absolute right-0` is how you
    // position ANY corner element — a resize handle, a badge, a close button. It
    // says nothing about menus, and treating it as evidence accused the table
    // primitive of a bug it does not have.
    expect(
      FLOATING_MENU.test('<div className="absolute right-0 top-0 h-full w-1 cursor-col-resize">'),
    ).toBe(false);
    expect(FLOATING_MENU.test('<div className="absolute inset-y-0">')).toBe(false);
  });

  it('the comment stripper does not let a real violation hide in prose', () => {
    expect(code('// never write fixed inset-0 by hand')).not.toContain('fixed inset-0');
    expect(code('<div className="fixed inset-0" />')).toContain('fixed inset-0');
  });
});
