import { readFileSync } from 'node:fs';

import { AA_NON_TEXT, AA_NORMAL, ratioOf } from '@/lib/design/contrast';

/**
 * WCAG CONTRAST, MEASURED — not asserted in a comment.
 *
 * `tokens.css` carries hand-written claims like:
 *
 *     --content-muted: #b9bcb2;  /* (AA, 9.0:1 on bg-default) *␘/
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

const TOKENS_CSS = readFileSync('src/styles/tokens.css', 'utf8');

/**
 * Read a theme's token block.
 *
 * Dark lives under `:root`, light under `[data-theme="light"]`. Reading the file
 * as one blob would let a light-theme value satisfy a dark-theme assertion, and
 * the ratchet would pass while the dark theme was unreadable.
 */
function tokensFor(theme: 'dark' | 'light'): Map<string, string> {
  const startMarker = theme === 'dark' ? ':root {' : "[data-theme='light'] {";
  const altMarker = theme === 'light' ? '[data-theme="light"] {' : null;

  let start = TOKENS_CSS.indexOf(startMarker);
  if (start === -1 && altMarker) start = TOKENS_CSS.indexOf(altMarker);

  if (start === -1) {
    throw new Error(
      `Could not find the ${theme} token block in tokens.css. The ratchet is reading ` +
        `nothing, which means it is protecting nothing.`,
    );
  }

  // Take everything from the marker to the end of the file, then stop at the
  // FIRST token of the other theme by simply reading declarations in order and
  // letting later ones win — which is exactly what the cascade does.
  const block =
    theme === 'dark'
      ? TOKENS_CSS.slice(start, TOKENS_CSS.indexOf('[data-theme', start) + 1 || undefined)
      : TOKENS_CSS.slice(start);

  const map = new Map<string, string>();
  const declaration = /(--[\w-]+)\s*:\s*([^;]+);/g;

  let match: RegExpExecArray | null;
  while ((match = declaration.exec(block)) !== null) {
    const value = match[2]!.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    // Only the first definition wins within a block, matching the cascade for a
    // single selector.
    if (!map.has(match[1]!)) map.set(match[1]!, value);
  }

  return map;
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
  /** For a translucent bg, what is behind it. */
  backdrop?: string;
  /** Text is AA_NORMAL. Icons, borders and focus rings are AA_NON_TEXT. */
  kind?: 'text' | 'non-text';
  why: string;
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

  // ── The inverted surface: text on the primary button ──────────────
  {
    fg: '--content-inverted',
    bg: '--bg-inverted',
    why: 'the label on the PRIMARY BUTTON — the single most-clicked thing in the product',
  },

  // ── The translucent glass button fill ─────────────────────────────
  //
  // `<Button variant="secondary">` paints
  // `bg-[var(--btn-glass-fill-secondary)]` with a `text-content-emphasis`
  // label (button-variants.ts). The fill is TRANSLUCENT, so it has no ratio of
  // its own — it depends on the surface behind it, which is why it needs the
  // backdrop treatment rather than a naive measurement.
  //
  // This pairing was missing when issue #115 reported the secondary button at
  // 2.99:1 from an E2E axe run. That reading turned out to be a sample taken
  // mid-theme-flip, not the settled colour — but nothing here could say so,
  // because nothing here measured this button. Now it does, on every run,
  // without a browser.
  {
    fg: '--content-emphasis',
    bg: '--btn-glass-fill-secondary',
    backdrop: '--bg-page',
    why: 'the label on the SECONDARY button — the second-most-clicked thing in the product',
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
  // `--border-default` (a card divider, 1.39:1) is absent from this list and
  // `--border-strong` is in it. Demanding 3:1 of every hairline divider would
  // make the UI shout, and a ratchet that forces a bad design is a ratchet people
  // learn to silence.
  {
    fg: '--border-strong',
    bg: '--bg-default',
    kind: 'non-text',
    why: 'the edge of an input, a checkbox, a radio — an invisible border is an invisible control',
  },
  {
    fg: '--focus-ring',
    bg: '--bg-page',
    kind: 'non-text',
    why: 'the FOCUS RING. A keyboard user who cannot see where they are cannot use the app.',
  },
  {
    fg: '--focus-ring',
    bg: '--bg-default',
    kind: 'non-text',
    why: 'the focus ring on a control inside a card',
  },
];

describe.each(['dark', 'light'] as const)('%s theme contrast', (theme) => {
  const tokens = tokensFor(theme);

  it('the token block was actually read', () => {
    // A broken parser makes every assertion below vacuous — it would find no
    // pairings and pass in silence.
    expect(tokens.size).toBeGreaterThan(15);
    expect(tokens.get('--bg-page')).toBeTruthy();
    expect(tokens.get('--content-default')).toBeTruthy();
  });

  it.each(PAIRINGS.map((p) => [`${p.fg} on ${p.bg}`, p] as const))(
    '%s meets WCAG AA',
    (_label, pairing) => {
      const fg = tokens.get(pairing.fg);
      const bg = tokens.get(pairing.bg);

      // A pairing naming a token that does not exist is a BROKEN RATCHET, not a
      // pass. Fail loudly rather than skip.
      if (!fg) throw new Error(`${pairing.fg} is not defined in the ${theme} theme.`);
      if (!bg) throw new Error(`${pairing.bg} is not defined in the ${theme} theme.`);

      const backdrop = pairing.backdrop ? tokens.get(pairing.backdrop) : tokens.get('--bg-page');

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

  // ── Negative control ──────────────────────────────────────────────
  it('actually FAILS a pairing that is too low', () => {
    // The destructive button that really shipped: white on a translucent red.
    const bad = ratioOf('#ffffff', '#ef4444')!;

    expect(bad).toBeLessThan(AA_NORMAL);
  });
});
