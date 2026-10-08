import { readFileSync } from 'node:fs';

import { AA_NON_TEXT, AA_NORMAL, composite, parseColor, ratioOf } from '@/lib/design/contrast';

/**
 * WCAG CONTRAST, MEASURED — not asserted in a comment.
 *
 * `tokens.css` carries hand-written claims like:
 *
 *     --content-muted: #b6b3c8;  /* (AA, 9.00:1 on bg-default) *␘/
 *
 * Those were true when somebody measured them. They are NOT re-measured when a
 * designer nudges a hex by two points, and nothing tells you the comment has
 * become a lie. The colour still looks fine on a good monitor in a bright room —
 * it fails for the person it was written for.
 *
 * So every pairing we actually ship is computed from the real token values, in
 * BOTH themes, and the build fails when one drops below AA.
 *
 * This class of bug has already bitten once: the destructive button shipped
 * white-on-red at 3.13:1, and even a solid #DC2626 only reaches 4.48:1.
 */

/**
 * Comments are stripped BEFORE anything is parsed.
 *
 * The prose in tokens.css names tokens and selectors, and a scanner that reads a
 * comment as code takes it at its word. Both of these were measured on the real
 * file:
 *
 *   - A light-block comment quoting "`--bg-default: #FAF7F2`" parsed as a
 *     declaration whose value ran on to the next `;` — which swallowed the real
 *     `--nav-row-liquid-tint` below it. That token was simply absent from the
 *     light map.
 *   - Naming the theme attribute in bracket form inside the dark block ends the
 *     dark block there: 12 tokens read instead of 121, most pairings "not
 *     defined". The `--content-brand` comment (#233) wants to say exactly that.
 *
 * Stripping changes no measured pairing — the maps are identical apart from the
 * token that was being swallowed.
 */
const TOKENS_CSS = readFileSync('src/styles/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Read a theme's token block.
 *
 * Dark lives under `:root`, light under `[data-theme="light"]`. Reading the file
 * as one blob would let a light-theme value satisfy a dark-theme assertion, and
 * the ratchet would pass while the dark theme was unreadable.
 *
 * A block runs from its selector to the first `}` at the start of a line, which
 * is how prettier closes a top-level rule. The light block used to run on to the
 * end of the file, so the reduced-motion `:root` override below it was read as
 * light tokens.
 *
 * In one rule the LAST declaration wins, and that is what the browser renders,
 * so the map keeps the last. It used to keep the first, and measured a focus
 * ring nobody saw: light --focus-ring was #15803d (4.48:1) and then, 70 lines
 * further down, rgba(22, 163, 74, 0.4), which is what rendered, at 1.53:1 on the
 * page (#244). Keeping the last is not enough on its own: the first value is the
 * one a reader finds, with its measured comment beside it. So every second
 * declaration is reported in `duplicates`, and the suite fails on it.
 */
function tokensFor(
  theme: 'dark' | 'light',
  css: string = TOKENS_CSS,
): { tokens: Map<string, string>; duplicates: string[] } {
  const markers =
    theme === 'dark' ? [':root {'] : ["[data-theme='light'] {", '[data-theme="light"] {'];
  const start = markers.map((marker) => css.indexOf(marker)).find((i) => i !== -1) ?? -1;

  if (start === -1) {
    throw new Error(
      `Could not find the ${theme} token block in tokens.css. The ratchet is reading ` +
        `nothing, which means it is protecting nothing.`,
    );
  }

  const close = css.indexOf('\n}', start);
  const block = css.slice(start, close === -1 ? undefined : close);

  const tokens = new Map<string, string>();
  const duplicates: string[] = [];
  const declaration = /(--[\w-]+)\s*:\s*([^;]+);/g;

  let match: RegExpExecArray | null;
  while ((match = declaration.exec(block)) !== null) {
    const name = match[1]!;
    if (tokens.has(name)) duplicates.push(name);
    tokens.set(name, match[2]!.trim());
  }

  return { tokens, duplicates };
}

/**
 * The pairings we ACTUALLY SHIP.
 *
 * Not every possible combination — most of those never appear on screen, and a
 * ratchet that fails on a pairing nobody renders is a ratchet people learn to
 * silence. These are the ones that are really rendered.
 */
interface Pairing {
  fg: string;
  bg: string;
  /**
   * For a translucent bg, what is behind it. A list is a stack of layers,
   * bottom first, each composited onto the one under it: the bell's count sits
   * on the header's brand wash, which is itself translucent over the page. A
   * layer written `--token@10%` is that token at 10%, which is what a
   * `color-mix(in srgb, <below>, var(--token) 10%)` paints.
   */
  backdrop?: string | string[];
  /** Text is AA_NORMAL. Icons, borders and focus rings are AA_NON_TEXT. */
  kind?: 'text' | 'non-text';
  why: string;
  /**
   * The ratio itself, pinned to two places, per theme.
   *
   * Clearing the bar is not the whole claim when a number is written down
   * somewhere. `--brand-emphasis` carried "5.1:1 on white" for as long as it
   * cleared this ratchet's bar, because the bar was all anyone checked; the
   * number described a background the product does not have (#233). A pinned
   * number is checked, so a hex nudge has to come back here, and to the comment
   * in tokens.css that says the same thing.
   */
  measured?: Record<'dark' | 'light', number>;
}

const PAIRINGS: Pairing[] = [
  // ── Body text on every surface it lands on ────────────────────────
  { fg: '--content-emphasis', bg: '--bg-page', why: 'headings on the page background' },
  { fg: '--content-emphasis', bg: '--bg-default', why: 'headings on a card' },
  { fg: '--content-default', bg: '--bg-page', why: 'body text on the page' },
  { fg: '--content-default', bg: '--bg-default', why: 'body text in a card' },
  { fg: '--content-default', bg: '--bg-elevated', why: 'body text in a dropdown' },

  // The tier that fails first, and the reason those comments exist.
  { fg: '--content-muted', bg: '--bg-page', why: 'captions and secondary text on the page' },
  { fg: '--content-muted', bg: '--bg-default', why: 'captions in a card — 12px, so AA_NORMAL' },
  { fg: '--content-muted', bg: '--bg-elevated', why: 'secondary text in a dropdown' },

  { fg: '--content-subtle', bg: '--bg-page', why: 'hints and tertiary info' },
  { fg: '--content-subtle', bg: '--bg-default', why: 'hints in a card' },

  // ── Brand-coloured text (#233) ────────────────────────────────────
  //
  // Brand-coloured WORDS have their own token, because no brand fill is body
  // text in both themes: --brand-default is 4.00:1 on the dark page, under AA
  // (#362). `--content-brand` carries its own shade per theme instead
  // (violet-400 dark; #9a3412 light, one step past inflect's #b83d00).
  // tests/guardrails/no-raw-brand-text.test.ts bans the fills as text, so this
  // token is the only way brand-coloured text gets written, and it is measured
  // here.
  {
    fg: '--content-brand',
    bg: '--bg-page',
    kind: 'text',
    why: 'brand-coloured words on the page: the homepage wordmark, the link on the 404',
    measured: { light: 6.53, dark: 7.21 },
  },
  {
    fg: '--content-brand',
    bg: '--bg-default',
    kind: 'text',
    why: 'brand-coloured words in a card',
    measured: { light: 6.77, dark: 6.77 },
  },
  {
    fg: '--content-brand',
    bg: '--brand-secondary-subtle',
    backdrop: '--bg-default',
    kind: 'text',
    why: "the sidebar's ACTIVE label on its wash (NAV_ITEM_ACTIVE), over the sidebar",
    // The wash is purple in dark on purpose (#362), and inflect's navy in light.
    measured: { light: 5.81, dark: 5.56 },
  },
  //
  // The same row in the PHONE nav drawer: a Sheet, whose `.surface-popup-texture`
  // (globals.css) mixes --brand-default into --bg-default, 10% at the sheet's
  // top. With inflect's light #b83d00 this measured 4.39:1 on real pixels and
  // 3.92:1 at the top, and axe, which cannot resolve a gradient, said nothing.
  // Light --content-brand is #9a3412 because of this pairing (tokens.css).
  {
    fg: '--content-brand',
    bg: '--brand-secondary-subtle',
    backdrop: ['--bg-default', '--brand-default@10%'],
    kind: 'text',
    why: "the ACTIVE label on its wash in the phone nav drawer, over the sheet's texture",
    measured: { light: 5.05, dark: 5.03 },
  },

  // ── The inverted surface: text on the primary button ──────────────
  {
    fg: '--content-inverted',
    bg: '--bg-inverted',
    why: 'the label on the PRIMARY BUTTON — the single most-clicked thing in the product',
  },

  // ── The Still Surface secondary tile (T18) ────────────────────────
  //
  // `<Button variant="secondary">` (vendored button-variants.ts) paints a
  // gradient from --bg-default to --bg-muted, with a solid --bg-muted under
  // it, and a `text-content-emphasis` label. Both stops are measured. On hover
  // the label turns `text-content-brand`, and the edge takes --brand-default.
  //
  // This used to measure the R24 glass fill, `--btn-glass-fill-secondary`. A
  // pairing like this was missing when #115 reported the secondary button at
  // 2.99:1 from an E2E axe run (a sample taken mid-theme-flip, it turned out),
  // and nothing here could say so. The glass token is gone, so the pairing
  // moved to the stops that replaced it.
  {
    fg: '--content-emphasis',
    bg: '--bg-default',
    kind: 'text',
    why: 'the SECONDARY button label on its top stop',
  },
  {
    fg: '--content-emphasis',
    bg: '--bg-muted',
    kind: 'text',
    why: 'the SECONDARY button label on its bottom stop and solid base',
  },
  {
    fg: '--content-brand',
    bg: '--bg-muted',
    kind: 'text',
    why: 'the SECONDARY button label on hover, on its darkest stop',
    measured: { light: 6.25, dark: 6.22 },
  },

  // ── The Still Surface primary tile (T18) ──────────────────────────
  //
  // The primary paints --brand-default → --brand-emphasis at rest and
  // --brand-muted → --brand-default on hover, under `text-content-inverted`.
  // The label crosses every stop, so every stop is text and pinned. In light,
  // inflect's own ramp (#d04a02 / #b83d00 / #e06520) measures 4.28 / 5.39 /
  // 3.30:1 here: the top stop and the whole hover fail. #362 takes it one step
  // darker (#b83d00 / #9a3412 / #c2410c), as T18 did the ramp before it, and
  // these are the numbers. Dark is a white label on purple.
  {
    fg: '--content-inverted',
    bg: '--brand-default',
    kind: 'text',
    why: 'the PRIMARY button label on its top stop, and on the bottom stop of its hover',
    measured: { light: 5.39, dark: 4.91 },
  },
  {
    fg: '--content-inverted',
    bg: '--brand-muted',
    kind: 'text',
    why: 'the PRIMARY button label on the top stop of its hover',
    measured: { light: 4.92, dark: 4.6 },
  },

  // ── The Still Surface destructive tile (T18) ──────────────────────
  //
  // White label (`text-white`, a literal, so the pairing names it) on three
  // red stops: rest top, rest bottom, hover top. In dark, inflect's red-700 /
  // 800 / 600; in light, its red-800 family.
  {
    fg: '#ffffff',
    bg: '--btn-still-danger',
    kind: 'text',
    why: 'the DESTRUCTIVE button label on its top stop, the floor',
    measured: { light: 8.46, dark: 6.47 },
  },
  {
    fg: '#ffffff',
    bg: '--btn-still-danger-deep',
    kind: 'text',
    why: 'the DESTRUCTIVE button label on its bottom stop',
    measured: { light: 10.83, dark: 8.31 },
  },
  {
    fg: '#ffffff',
    bg: '--btn-still-danger-lift',
    kind: 'text',
    why: 'the DESTRUCTIVE button label on hover',
    measured: { light: 6.96, dark: 4.83 },
  },

  // ── The inert button: disabled, loading, disabledTooltip (T18) ────
  //
  // The vendored Button's cn-only branches paint `text-content-subtle` on
  // `bg-bg-subtle`, a translucent fill. A disabled control is exempt from
  // 1.4.3, but a disabledTooltip button is focusable and announces its reason,
  // and axe measures both. On the light page it measured 4.44:1 and failed CI,
  // so light --content-subtle moved from #6b6b6b to #686868.
  {
    fg: '--content-subtle',
    bg: '--bg-subtle',
    backdrop: '--bg-page',
    kind: 'text',
    why: 'the label on a disabled or disabledTooltip button, on the page',
    measured: { light: 4.64, dark: 5.51 },
  },
  {
    fg: '--content-subtle',
    bg: '--bg-subtle',
    backdrop: '--bg-default',
    kind: 'text',
    why: 'the label on a disabled or disabledTooltip button, in a card',
    measured: { light: 4.81, dark: 5.08 },
  },

  // ── Status colours, which carry MEANING and must be readable ──────
  { fg: '--content-success', bg: '--bg-default', why: 'a confirmed booking' },
  { fg: '--content-warning', bg: '--bg-default', why: 'a pending payment' },
  {
    fg: '--content-error',
    bg: '--bg-default',
    why: 'a failed payment — the one you must not miss',
  },

  // ── Non-text: control boundaries and focus rings must be VISIBLE ──
  //
  // WCAG 1.4.11 requires 3:1 for the visual boundary that IDENTIFIES a control —
  // the edge of a checkbox is the only thing telling you a checkbox is there.
  //
  // It does NOT require it for purely decorative borders, which is why
  // `--border-default` (a card divider, 1.24:1) is absent from this list and
  // `--border-strong` is in it. Demanding 3:1 of every hairline divider would
  // make the UI shout, and a ratchet that forces a bad design is a ratchet people
  // learn to silence.
  {
    fg: '--border-strong',
    bg: '--bg-default',
    kind: 'non-text',
    why: 'the edge of an input, a checkbox, a radio — an invisible border is an invisible control',
  },
  //
  // The ring is pinned because the number was wrong for as long as it was only
  // checked against a bar: this file read 4.48:1 for the light ring while the
  // browser painted a second, translucent declaration at 1.53:1 (#244). --ring
  // is what `ring-ring` and `ring-[var(--ring)]` paint; it is the same literal
  // per theme and is measured on its own so the two cannot drift apart.
  {
    fg: '--focus-ring',
    bg: '--bg-page',
    kind: 'non-text',
    why: 'the FOCUS RING. A keyboard user who cannot see where they are cannot use the app.',
    measured: { light: 4.03, dark: 12.81 },
  },
  {
    fg: '--focus-ring',
    bg: '--bg-default',
    kind: 'non-text',
    why: 'the focus ring on a control inside a card',
    measured: { light: 4.18, dark: 12.02 },
  },
  {
    fg: '--ring',
    bg: '--bg-page',
    kind: 'non-text',
    why: 'the shadcn-named ring: the calendar day, the table selection toolbar',
    measured: { light: 4.03, dark: 12.81 },
  },
  {
    fg: '--ring',
    bg: '--bg-default',
    kind: 'non-text',
    why: 'the shadcn-named ring on a control inside a card',
    measured: { light: 4.18, dark: 12.02 },
  },
  //
  // The vendored Button does not use --focus-ring. Its halo is a two-stop
  // shadow, a --bg-default spacer then --accent-default (inflect's seam,
  // #362), so the outer stop is measured against every surface a button sits
  // on: the page, a card, and a dropdown or popover. The table's focus rings
  // read the same token, and the bottom tab bar's active bar is painted in it
  // on the page.
  {
    fg: '--accent-default',
    bg: '--bg-page',
    kind: 'non-text',
    why: "the BUTTON's focus halo, and the tab bar's active bar, on the page",
    measured: { light: 4.03, dark: 12.81 },
  },
  {
    fg: '--accent-default',
    bg: '--bg-default',
    kind: 'non-text',
    why: "the BUTTON's focus halo in a card",
    measured: { light: 4.18, dark: 12.02 },
  },
  {
    fg: '--accent-default',
    bg: '--bg-elevated',
    kind: 'non-text',
    why: "the BUTTON's focus halo in a dropdown or popover",
    measured: { light: 4.39, dark: 10.66 },
  },
  {
    fg: '--accent-emphasis',
    bg: '--bg-elevated',
    kind: 'non-text',
    why: "the undo toast's focus ring, on its elevated surface",
    measured: { light: 5.53, dark: 8.51 },
  },
  //
  // The SECONDARY button's hover edge is --brand-default, the mirror of
  // primary's. It was also the button's halo until #362 moved that to the
  // accent; as an edge it identifies the control's boundary, so 1.4.11's 3:1
  // still applies on both surfaces.
  {
    fg: '--brand-default',
    bg: '--bg-page',
    kind: 'non-text',
    why: "the secondary button's hover edge, on the page",
    measured: { light: 5.07, dark: 4.0 },
  },
  {
    fg: '--brand-default',
    bg: '--bg-default',
    kind: 'non-text',
    why: "the secondary button's hover edge, in a card",
    measured: { light: 5.25, dark: 3.75 },
  },
  //
  // The PRIMARY button's hover edge is the complementary hue: yellow in dark,
  // inflect's navy in light (#362). An edge identifies the control's boundary,
  // so 1.4.11's 3:1 applies on both surfaces.
  {
    fg: '--brand-secondary-default',
    bg: '--bg-page',
    kind: 'non-text',
    why: 'the PRIMARY button hover edge, the complementary hue, on the page',
    measured: { light: 9.26, dark: 12.81 },
  },
  {
    fg: '--brand-secondary-default',
    bg: '--bg-default',
    kind: 'non-text',
    why: 'the PRIMARY button hover edge in a card',
    measured: { light: 9.6, dark: 12.02 },
  },

  // ── The bell's count, in the accent (#362) ────────────────────────
  //
  // notification-bell.tsx paints the unread count as text-content-accent on
  // bg-bg-accent (a status badge may not take a brand tone upstream). The bell
  // sits at the right of the header, where nav-bar.tsx pools its radial
  // --brand-subtle wash, so the tint is measured over that wash at full
  // strength as well as over the bare page and a card. The light value is one
  // step past --accent-emphasis because of the wash: #b83d00 is 4.04:1 there.
  {
    fg: '--content-accent',
    bg: '--accent-subtle',
    backdrop: '--bg-page',
    kind: 'text',
    why: "the bell's unread count, over the page",
    measured: { light: 5.81, dark: 9.58 },
  },
  {
    fg: '--content-accent',
    bg: '--accent-subtle',
    backdrop: '--bg-default',
    kind: 'text',
    why: "the bell's unread count, over a card",
    measured: { light: 6.01, dark: 8.7 },
  },
  {
    fg: '--content-accent',
    bg: '--accent-subtle',
    backdrop: ['--bg-page', '--brand-subtle'],
    kind: 'text',
    why: "the bell's unread count, over the header's brand wash",
    measured: { light: 5.21, dark: 7.69 },
  },

  // ── The raised Card: text on translucent glass ────────────────────
  //
  // `.glass-card` is the default <Card>, so it is behind most text in the app.
  // Its fill is translucent and has no ratio of its own; it is composited over
  // the page. Dark was inflect navy until #246 (12.11:1 body, 7.54:1 muted).
  {
    fg: '--content-default',
    bg: '--glass-bg',
    backdrop: '--bg-page',
    kind: 'text',
    why: 'body text in the default raised card',
    measured: { light: 10.02, dark: 14.54 },
  },
  {
    fg: '--content-muted',
    bg: '--glass-bg',
    backdrop: '--bg-page',
    kind: 'text',
    why: 'captions in the default raised card',
    measured: { light: 7.2, dark: 9.1 },
  },

  // ── The label on the brand fill (#245) ────────────────────────────
  //
  // --content-inverted on --brand-emphasis. #245 drew the primary links (home,
  // the empty bookings list, the invite page) with `bg-bg-brand
  // text-content-on-brand` aliases for this pair; T22 and T27 moved them to
  // buttonVariants and T28 deleted the aliases. The pair stays: it is the
  // PRIMARY button's label on its bottom stop.
  {
    fg: '--content-inverted',
    bg: '--brand-emphasis',
    kind: 'text',
    why: 'the label on a primary link, and the PRIMARY button label on its bottom stop',
    // Light is inflect's #b83d00 label stop moved one step to #9a3412 (#362).
    measured: { light: 6.94, dark: 5.95 },
  },

  // ── The brand FILL, pinned at the bar a fill needs ────────────────
  //
  // `--brand-emphasis` is what #233 tripped on. It fills the primary button, a
  // checked checkbox or switch, and the selected day, and then it was used as a
  // 16px header colour. As TEXT on the light page it measured 4.48:1, 0.02 short
  // of AA, and this ratchet would have failed it as it should. Since #362 it is
  // 3.29:1 on the dark page, so as text it would fail outright; brand-coloured
  // text is --content-brand.
  //
  // So it is pinned as what it is: a fill, whose job is to stand out against
  // the surface around it (WCAG 1.4.11, 3:1). Large text has the same 3:1 bar.
  // Pinning it as `text` would fail on a use the product does not make. Pinning
  // it at the non-text bar with no number would bury the 3.29, and a buried
  // number is how "5.1:1 on white" survived. The number is pinned instead.
  {
    fg: '--brand-emphasis',
    bg: '--bg-page',
    kind: 'non-text',
    why: 'a primary-button fill or a checked control on the page — a FILL, not body text',
    measured: { light: 6.53, dark: 3.29 },
  },
  {
    fg: '--brand-emphasis',
    bg: '--bg-default',
    kind: 'non-text',
    why: 'the same fill on a control inside a card',
    measured: { light: 6.77, dark: 3.09 },
  },
];

/**
 * A pairing's backdrop as one opaque colour. A list is composited bottom-up,
 * each layer over the one under it; a missing token is a broken ratchet.
 */
function backdropOf(
  layers: string | string[],
  tokens: Map<string, string>,
  theme: string,
): string | undefined {
  const names = Array.isArray(layers) ? layers : [layers];
  if (names.length === 1 && !names[0]!.includes('@')) return tokens.get(names[0]!);

  let flat = null as ReturnType<typeof parseColor>;
  for (const layer of names) {
    // `--token@10%`: the token at that share, as color-mix() paints it.
    const [, name = layer, share] = /^(--[\w-]+)@(\d+(?:\.\d+)?)%$/.exec(layer) ?? [];
    const value = tokens.get(name);
    const color = value ? parseColor(value) : null;
    if (!color) throw new Error(`Backdrop layer ${layer} (${value}) is not a colour in ${theme}.`);
    if (share !== undefined) color.a *= Number(share) / 100;
    flat = flat ? composite(color, flat) : color;
  }
  return `rgba(${flat!.r}, ${flat!.g}, ${flat!.b}, 1)`;
}

describe.each(['dark', 'light'] as const)('%s theme contrast', (theme) => {
  const { tokens, duplicates } = tokensFor(theme);

  it('declares every custom property once', () => {
    // The second declaration silently replaces the first, and the first is the
    // one with the measured comment beside it. That is how #244 shipped.
    if (duplicates.length > 0) {
      throw new Error(
        `DUPLICATE TOKEN (${theme} theme): ${[...new Set(duplicates)].join(', ')}\n\n` +
          `Declared more than once in the same block. The browser renders the LAST\n` +
          `declaration, which is rarely the one a reader looks at. Delete one.`,
      );
    }
  });

  it('the token block was actually read', () => {
    // A broken parser makes every assertion below vacuous — it would find no
    // pairings and pass in silence.
    expect(tokens.size).toBeGreaterThan(15);
    expect(tokens.get('--bg-page')).toBeTruthy();
    expect(tokens.get('--content-default')).toBeTruthy();
  });

  const over = (p: Pairing) => (p.backdrop ? ` over ${[p.backdrop].flat().join(' + ')}` : '');

  it.each(PAIRINGS.map((p) => [`${p.fg} on ${p.bg}${over(p)}`, p] as const))(
    '%s meets WCAG AA',
    (_label, pairing) => {
      // A literal (`#ffffff`, for a `text-white` label) is its own value.
      const fg = pairing.fg.startsWith('#') ? pairing.fg : tokens.get(pairing.fg);
      const bg = tokens.get(pairing.bg);

      // A pairing naming a token that does not exist is a BROKEN RATCHET, not a
      // pass. Fail loudly rather than skip.
      if (!fg) throw new Error(`${pairing.fg} is not defined in the ${theme} theme.`);
      if (!bg) throw new Error(`${pairing.bg} is not defined in the ${theme} theme.`);

      const backdrop = backdropOf(pairing.backdrop ?? '--bg-page', tokens, theme);

      const ratio = ratioOf(fg, bg, { backdrop });

      // A token we cannot parse (a var() alias, a gradient) is ALSO a broken
      // ratchet, not a pass. Say so rather than skip it.
      if (ratio === null) {
        throw new Error(
          `Could not compute a ratio for ${pairing.fg} (${fg}) on ${pairing.bg} (${bg}).\n` +
            `If one of these is a var() alias, point the pairing at the underlying token.`,
        );
      }

      const required = pairing.kind === 'non-text' ? AA_NON_TEXT : AA_NORMAL;

      if (ratio < required) {
        throw new Error(
          `CONTRAST FAILURE (${theme} theme)\n\n` +
            `  ${pairing.fg} (${fg})\n` +
            `  on ${pairing.bg} (${bg})\n\n` +
            `  ratio:    ${ratio.toFixed(2)}:1\n` +
            `  required: ${required}:1  (WCAG AA, ${pairing.kind === 'non-text' ? 'non-text' : 'normal text'})\n\n` +
            `  This pairing is: ${pairing.why}\n\n` +
            `It looks fine on a good monitor in a bright room. It is not fine for the\n` +
            `person it was written for. Darken the background or lighten the text — do\n` +
            `not weaken this threshold.`,
        );
      }

      // Checked AFTER the threshold, so a real AA failure reports as one.
      const pinned = pairing.measured?.[theme];
      if (pinned !== undefined && ratio.toFixed(2) !== pinned.toFixed(2)) {
        throw new Error(
          `PINNED RATIO MOVED (${theme} theme)\n\n` +
            `  ${pairing.fg} (${fg})\n` +
            `  on ${pairing.bg} (${bg})\n\n` +
            `  measured: ${ratio.toFixed(2)}:1\n` +
            `  pinned:   ${pinned.toFixed(2)}:1\n\n` +
            `  This pairing is: ${pairing.why}\n\n` +
            `It still clears its bar. The number moved, and a written number is a claim\n` +
            `that somebody reads. Update the pin here AND the note beside the token in\n` +
            `src/styles/tokens.css, which states the same ratio.`,
        );
      }
    },
  );
});

// ── The maths itself ─────────────────────────────────────────────────

describe('the contrast calculation is correct', () => {
  it('black on white is 21:1 — the maximum', () => {
    expect(ratioOf('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('a colour against itself is 1:1', () => {
    expect(ratioOf('#22c55e', '#22c55e')).toBeCloseTo(1, 5);
  });

  it('is symmetric — the lighter colour is always the numerator', () => {
    expect(ratioOf('#000000', '#ffffff')).toBeCloseTo(ratioOf('#ffffff', '#000000')!, 5);
  });

  it('agrees with a known published value', () => {
    // #767676 on white is the canonical "exactly AA" grey — 4.54:1.
    expect(ratioOf('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
  });

  it('COMPOSITES a translucent colour onto its backdrop', () => {
    // A token like rgba(255,255,255,0.1) has NO ratio of its own — it depends
    // entirely on what is behind it. Measuring it as opaque white produces a
    // number that is confidently wrong.
    const onBlack = ratioOf('#ffffff', 'rgba(255, 255, 255, 0.1)', { backdrop: '#000000' });
    const onWhite = ratioOf('#ffffff', 'rgba(255, 255, 255, 0.1)', { backdrop: '#ffffff' });

    expect(onBlack).not.toBeCloseTo(onWhite!, 1);
    // White text on a 10%-white veil over black is still nearly white-on-black.
    expect(onBlack!).toBeGreaterThan(10);
  });

  it('uses the sRGB transfer curve, not a linear shortcut', () => {
    // The common shortcut (c/12.92 everywhere) shifts the ratio enough to move a
    // colour across the AA line. Mid-grey on white is the case where it shows.
    const ratio = ratioOf('#808080', '#ffffff')!;

    // Correct value is ~3.95. A linear approximation gives ~5.5.
    expect(ratio).toBeGreaterThan(3.8);
    expect(ratio).toBeLessThan(4.1);
  });

  // ── Negative controls ─────────────────────────────────────────────
  it('reads the LAST declaration and reports the duplicate (#244)', () => {
    const css = [
      ':root {',
      '  --focus-ring: #22c55e;',
      '}',
      "[data-theme='light'] {",
      '  --focus-ring: #15803d;',
      '  --ring: #15803d;',
      '  --focus-ring: rgba(22, 163, 74, 0.4);',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  :root {',
      '    --ring: #ffffff;',
      '  }',
      '}',
    ].join('\n');

    const light = tokensFor('light', css);
    expect(light.tokens.get('--focus-ring')).toBe('rgba(22, 163, 74, 0.4)');
    expect(light.duplicates).toEqual(['--focus-ring']);
    // The block stops at its own closing brace, not at the end of the file.
    expect(light.tokens.get('--ring')).toBe('#15803d');

    const dark = tokensFor('dark', css);
    expect(dark.duplicates).toEqual([]);
    expect([...dark.tokens.keys()]).toEqual(['--focus-ring']);
  });

  it('flattens a layered backdrop bottom-up, and a missing layer is an error', () => {
    // The bell's count sits on the header's translucent wash over the page.
    const tokens = new Map([
      ['--page', '#ffffff'],
      ['--wash', 'rgba(0, 0, 0, 0.5)'],
    ]);
    expect(backdropOf(['--page', '--wash'], tokens, 'test')).toBe('rgba(127.5, 127.5, 127.5, 1)');
    expect(backdropOf('--page', tokens, 'test')).toBe('#ffffff');
    expect(() => backdropOf(['--page', '--missing'], tokens, 'test')).toThrow(/--missing/);
  });

  it('reads `--token@NN%` as color-mix() does: the token at that share', () => {
    // .surface-popup-texture's top stop: color-mix(in srgb, page, brand 10%).
    const tokens = new Map([
      ['--page', '#ffffff'],
      ['--brand', '#000000'],
    ]);
    expect(backdropOf(['--page', '--brand@10%'], tokens, 'test')).toBe(
      'rgba(229.5, 229.5, 229.5, 1)',
    );
    expect(backdropOf(['--page', '--brand@50%'], tokens, 'test')).toBe(
      'rgba(127.5, 127.5, 127.5, 1)',
    );
    expect(() => backdropOf(['--page', '--nope@10%'], tokens, 'test')).toThrow(/--nope@10%/);
  });

  it('actually FAILS a pairing that is too low', () => {
    // The destructive button that really shipped: white on a translucent red.
    const bad = ratioOf('#ffffff', '#ef4444')!;

    expect(bad).toBeLessThan(AA_NORMAL);
  });
});
