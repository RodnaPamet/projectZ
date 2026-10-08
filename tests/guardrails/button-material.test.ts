import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { buttonVariants } from '@/components/ui/button-variants';
import { ratioOf } from '@/lib/design/contrast';

/**
 * STILL SURFACE — the button material, locked (T18).
 *
 * Ported from inflect's `tests/guards/still-surface-button-material.test.ts`
 * (at 542ef7966; the literal-base check follows its #3101 rewrite), the guard
 * that sits beside the two files playerz vendors byte-identical: `button.tsx`
 * and `button-variants.ts`. Those files can only
 * change by a copy from inflect (ui-sync-manifest fails any local edit), so
 * this is less about a playerz contributor drifting the recipe than about a
 * future re-sync bringing a different material back without anyone deciding
 * it. A re-sync that moves any of the lines below fails here, and the owner
 * gets to say whether playerz wants it.
 *
 * What it guards, in inflect's words: motionless by construction, exactly
 * four variants, one 28 px rung, and the 44 px touch floor on coarse
 * pointers, including while `loading` (inflect T05 fixed that branch).
 *
 * Left out of the port, because playerz does not have the files: inflect's
 * `control-variants.ts` lockstep, its FilterToolbar trigger, and the topbar
 * notifications bell, which inflect lists as a hit-area consumer.
 */

const root = process.cwd();
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

/**
 * Source with comments blanked, so prose can never satisfy a ratchet: both
 * vendored files are mostly comments, and they name every banned class in
 * order to explain why it is banned. A `//` after `:` or a quote is kept,
 * which is how a URL inside a string survives.
 */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');

const VARIANTS = 'src/components/ui/button-variants.ts';
const BUTTON = 'src/components/ui/button.tsx';
const HIT_AREA = 'src/components/ui/hit-area.ts';
const TOKENS = 'src/styles/tokens.css';

describe('Still Surface — motionless by construction', () => {
  const src = code(VARIANTS);

  it('declares the three motion kill-switches in the cva base', () => {
    expect(src).toMatch(/['"]transition-none['"]/);
    expect(src).toMatch(/\[animation:none\]/);
    expect(src).toMatch(/\[transform:none\]/);
  });

  // Each entry is a mechanism the R19 → R24 material used to build depth out
  // of movement. playerz shipped all of them until T18.
  const BANNED: ReadonlyArray<{ rx: RegExp; what: string; why: string }> = [
    { rx: /transition-all/, what: 'transition-all', why: 'the base transition' },
    { rx: /\btransition-(?!none)/, what: 'transition-*', why: 'any transition at all' },
    { rx: /\banimate-/, what: 'animate-*', why: 'a keyframe animation' },
    { rx: /active:scale-/, what: 'active:scale-*', why: 'the 3% press shrink' },
    { rx: /active:translate-/, what: 'active:translate-*', why: 'the 1px press travel' },
    {
      rx: /\b(?:hover:|active:)?(?:scale|rotate|translate|skew)-/,
      what: 'transform utilities',
      why: 'any transform',
    },
    {
      rx: /before:transition|after:transition/,
      what: '::before/::after transitions',
      why: 'the hover fade and the aura',
    },
    { rx: /hover:after:shadow-/, what: 'hover:after:shadow-*', why: 'the aura bloom on hover' },
    { rx: /backdrop-blur/, what: 'backdrop-blur-*', why: 'the R24 glass' },
    { rx: /motion-reduce:/, what: 'motion-reduce:*', why: 'nothing moves, so nothing to strip' },
  ];

  it.each(BANNED.map((b) => [b.what, b] as const))('never reintroduces %s', (_label, entry) => {
    if (entry.rx.test(src)) {
      throw new Error(
        `${entry.what} is back in ${VARIANTS}: that was ${entry.why}. Still Surface builds ` +
          `depth from static light and a hue trade; motion breaks the material contract.`,
      );
    }
  });

  it('has no pseudo-element MATERIAL; the one ::before is the hit area, which paints nothing', () => {
    for (const rx of [
      /before:bg-/,
      /after:bg-/,
      /before:shadow/,
      /after:shadow/,
      /before:opacity/,
      /after:opacity/,
      /before:backdrop/,
      /after:backdrop/,
      /before:blur/,
      /after:blur/,
      /before:border-\[/,
      /after:border-\[/,
    ]) {
      expect({ rx: String(rx), hit: rx.test(src) }).toEqual({ rx: String(rx), hit: false });
    }
    expect(src).not.toMatch(/\bafter:/);
  });

  it('keeps the hit area square, on the border box, so a pill has no dead corners', () => {
    const recipe = code(HIT_AREA);
    expect(recipe).toMatch(/before:absolute/);
    expect(recipe).toMatch(/before:-inset-px/);
    expect(recipe).not.toMatch(/before:inset-0/);
    expect(recipe).toMatch(/before:rounded-none/);
    expect(src).toMatch(/HIT_AREA_CLASS/);
    expect(src).toMatch(/['"]relative['"]/);
  });
});

describe('Still Surface — the reciprocal hover edge', () => {
  const src = code(VARIANTS);

  it('primary trades its edge for the complementary hue on hover and press', () => {
    expect(src).toMatch(/hover:border-\[var\(--brand-secondary-default\)\]/);
    expect(src).toMatch(/active:border-\[var\(--brand-secondary-default\)\]/);
  });

  it('secondary takes the BRAND edge, the mirror of primary', () => {
    expect(src).toMatch(/hover:border-\[var\(--brand-default\)\]/);
  });

  it('destructive keeps its own danger stops and never borrows the reciprocity', () => {
    const start = src.indexOf('destructive: [');
    const block = src.slice(start, src.indexOf('],', start));
    expect(block).toMatch(/--btn-still-danger/);
    expect(block).not.toMatch(/--brand-secondary-default/);
  });

  it('declares every Still Surface token exactly once per theme', () => {
    const css = read(TOKENS).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const t of [
      '--btn-still-top',
      '--btn-still-bot',
      '--btn-still-lift',
      '--btn-still-press',
      '--btn-still-danger',
      '--btn-still-danger-deep',
      '--btn-still-danger-lift',
      '--brand-secondary-default',
    ]) {
      const hits = css.match(new RegExp(`${t}:`, 'g')) ?? [];
      expect({ token: t, count: hits.length }).toEqual({ token: t, count: 2 });
    }
  });

  it('the retired R19 / R20 / R24 button tokens stay gone', () => {
    // T18 deleted them once nothing read them. A token with no consumer is a
    // second, silent material a reader can mistake for the live one.
    const css = read(TOKENS).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.match(/--btn-(?:carbon|ambient|aura|glass|iridescent|gradient)[\w-]*:/g)).toBeNull();
  });

  it('the complementary hue is a real complement: at least 150° from the brand, in both themes', () => {
    // The vendored material requires --brand-secondary-default to be the
    // complement of --brand-default (button-variants.ts header). playerz's
    // teal was 31° away and the hover read as the same edge.
    const css = read(TOKENS).replace(/\/\*[\s\S]*?\*\//g, '');
    const values = (name: string) =>
      [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((m) => m[1]!);
    const brand = values('--brand-default');
    const secondary = values('--brand-secondary-default');
    expect(brand).toHaveLength(2);
    expect(secondary).toHaveLength(2);
    for (const i of [0, 1]) {
      const d = Math.abs(hueOf(brand[i]!) - hueOf(secondary[i]!));
      expect({ theme: i, apart: Math.min(d, 360 - d) >= 150 }).toEqual({ theme: i, apart: true });
    }
  });
});

describe('Still Surface — contrast floors', () => {
  const src = code(VARIANTS);

  it('secondary declares a solid background-color under its gradient', () => {
    // A tile painted only with background-image gives axe nothing to resolve,
    // so it measures the label against the page instead.
    const block = src.slice(src.indexOf('secondary: ['), src.indexOf('ghost: ['));
    expect(block).toMatch(/bg-\[image:/);
    expect(block).toMatch(/['"]bg-\[var\(--bg-muted\)\]['"]/);
  });

  // This asserted that `stillTile(from, to, lift, base)` took the base as a
  // parameter and interpolated it. Inflect #3101 (#3084) wrote the tile
  // classes out, because Tailwind never evaluates a function and so never
  // emitted the interpolated ones, so it asserts the property instead, as
  // inflect's own guard does: each tile writes its worst-case base literally,
  // and the base is one of the stops its rest gradient paints.
  it.each([
    // variant, where its block ends, the base it must declare
    ['primary', 'secondary: [', 'var(--brand-emphasis)'],
    ['destructive', null, 'var(--btn-still-danger)'],
  ] as const)('%s declares its worst-case base colour as a literal class', (key, next, base) => {
    const from = src.indexOf(`${key}: [`);
    expect(from).toBeGreaterThanOrEqual(0);
    const block = src.slice(from, next ? src.indexOf(next) : src.indexOf('size:', from));
    // A collapsed window would pass every check below for free.
    expect(block.length).toBeGreaterThan(400);
    expect({ key, base: block.includes(`'bg-[${base}]'`) }).toEqual({ key, base: true });
    const rest = block.split('\n').find((l) => l.includes("'bg-[image:"));
    expect({ key, stop: (rest ?? '').includes(base) }).toEqual({ key, stop: true });
  });

  it('primary and destructive keep their fill on press (inflect #3160)', () => {
    // The owner reported the flat fill flip on click as the buttons being
    // "animated" again, so upstream removed it: press feedback is the seat
    // shadow and the reciprocal edge. A re-sync that brings a press fill back
    // fails here, and the owner gets to decide.
    for (const [key, next] of [
      ['primary', 'secondary: ['],
      ['destructive', 'size:'],
    ] as const) {
      const from = src.indexOf(`${key}: [`);
      const block = src.slice(from, src.indexOf(next, from));
      expect(block.length).toBeGreaterThan(400);
      expect({ key, pressFill: /active:bg-/.test(block) }).toEqual({ key, pressFill: false });
      expect(block).toMatch(/active:shadow-\[var\(--btn-still-press\)\]/);
    }
  });

  it('every danger stop clears 4.5:1 under the white label, in both themes', () => {
    // contrast.test.ts pins the exact numbers; this keeps the floor beside the
    // material, so a re-sync that brings back red-400 fills fails here too.
    const css = read(TOKENS).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const name of [
      '--btn-still-danger',
      '--btn-still-danger-deep',
      '--btn-still-danger-lift',
    ]) {
      const hexes = [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map(
        (m) => m[1]!,
      );
      expect(hexes).toHaveLength(2);
      for (const hex of hexes) {
        expect({ name, hex, passes: ratioOf('#ffffff', hex)! >= 4.5 }).toEqual({
          name,
          hex,
          passes: true,
        });
      }
    }
  });
});

describe('Still Surface — the canonical four variants', () => {
  it('declares exactly primary | secondary | ghost | destructive', () => {
    const src = code(VARIANTS);
    const block = src.match(/variant:\s*\{([\s\S]*?)\},\s*size:/)?.[1] ?? '';
    const declared = [...block.matchAll(/^\s*['"]?([a-z][a-z-]*)['"]?\s*:\s*\[/gm)].map(
      (m) => m[1],
    );
    expect(declared.sort()).toEqual(['destructive', 'ghost', 'primary', 'secondary']);
  });

  it('no destructive-outline survives anywhere in src', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name)) {
          const body = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
          if (/destructive-outline/.test(body)) offenders.push(relative(root, full));
        }
      }
    };
    walk(join(root, 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('Still Surface — the single 28 px rung and the 44 px touch floor', () => {
  const src = code(VARIANTS);
  const RUNG = /h-7 px-\[0\.7rem\] text-\[0\.76rem\]/;

  it.each(['xs', 'sm', 'md', 'lg'])('size "%s" resolves to the same 28px geometry', (key) => {
    const line = src.match(new RegExp(`^\\s*${key}:\\s*['"]([^'"]+)['"]`, 'm'))?.[1] ?? '';
    expect({ key, line }).toEqual({ key, line: expect.stringMatching(RUNG) });
  });

  it('the icon rung is square at the same height, and 44px wide on touch', () => {
    expect(src).toMatch(/icon:\s*['"]h-7 w-7/);
    expect(src).toMatch(/pointer-coarse:min-w-11/);
  });

  it('every enabled button is at least 44px tall on a coarse pointer', () => {
    expect(src).toMatch(/['"]pointer-coarse:min-h-11['"]/);
  });

  it('the disabled and LOADING branches keep the 44px floor and mirror the rung', () => {
    // Both branches bypass cva. Before inflect T05 the loading branch dropped
    // `pointer-coarse:min-h-11`, so a 44px phone button shrank to 28px the
    // moment it started loading, exactly when a second tap is most likely.
    const btn = code(BUTTON);
    const shell = btn.match(/const INERT_BUTTON_SHELL = cn\(([\s\S]*?)\);/)?.[1] ?? '';
    expect(shell).toMatch(/['"]pointer-coarse:min-h-11['"]/);
    expect(shell).toMatch(/HIT_AREA_CLASS/);

    const loadingBranch = btn.slice(btn.indexOf('props.disabled || loading'));
    expect(loadingBranch.slice(0, 600)).toMatch(/INERT_BUTTON_SHELL/);
    expect(btn.match(/INERT_BUTTON_SHELL,/g) ?? []).toHaveLength(2);
    expect(btn.match(RUNG_GLOBAL) ?? []).toHaveLength(2);
  });
});

describe('Still Surface — every class the recipe returns reaches the CSS', () => {
  // Tailwind generates a class only if its full text appears in a scanned
  // file. stillTile() in the vendored button-variants.ts used to build its
  // classes from template literals, which Tailwind cannot see, and on the
  // first T18 build the destructive button had no fill; playerz kept a
  // safelist in tailwind.config.ts until inflect #3101 wrote the classes out.
  // This evaluates the real recipe and fails on any class that is not
  // literal in the vendored files themselves: there is no safelist to hide in.
  const sources = read(VARIANTS) + read(HIT_AREA);
  // Tailwind splits source text on whitespace and quotes; a class counts as
  // written when it sits between two such delimiters.
  const DELIM = `[\\s'"\`]`;
  const written = (c: string) =>
    new RegExp(`(^|${DELIM})${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=${DELIM}|$)`).test(
      sources,
    );

  it.each(['primary', 'secondary', 'ghost', 'destructive'] as const)(
    'the %s variant has no class Tailwind cannot find',
    (variant) => {
      const classes = buttonVariants({ variant }).split(/\s+/).filter(Boolean);
      const unseen = classes.filter((c) => !written(c));
      expect({ variant, unseen }).toEqual({ variant, unseen: [] });
    },
  );
});

describe('Still Surface — durable invariants', () => {
  const src = code(VARIANTS);

  it('keeps the pill radius', () => expect(src).toMatch(/rounded-full/));

  it('keeps the two-channel disabled mute', () => {
    expect(src).toMatch(/disabled:opacity-45/);
    expect(src).toMatch(/disabled:saturate-50/);
  });

  it('keeps a visible focus indicator on --accent-default', () => {
    // Inflect's accent seam (#362): the halo points in the accent, which
    // playerz sets to yellow (dark) and the signature orange (light).
    // contrast.test.ts measures --accent-default on the page, in a card and
    // in a dropdown.
    expect(src).toMatch(/focus-visible:outline-none/);
    expect(src).toMatch(
      /focus-visible:shadow-\[0_0_0_2px_var\(--bg-default\),0_0_0_4px_var\(--accent-default\)\]/,
    );
  });

  it('keeps icon shrink-0', () => expect(src).toMatch(/\[&_svg\]:shrink-0/));

  it('keeps the primary label on the inverted contrast token', () => {
    expect(src).toMatch(/text-content-inverted/);
  });
});

const RUNG_GLOBAL = /h-7 px-\[0\.7rem\] text-\[0\.76rem\]/g;

function hueOf(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
