/**
 * WCAG contrast, computed rather than asserted in a comment.
 *
 * ─── Why this exists ─────────────────────────────────────────────────
 *
 * `tokens.css` is full of hand-written claims:
 *
 *     --content-muted: #b6b3c8;  // (AA, 9.00:1 on bg-default)
 *
 * Those were true when somebody measured them. They are not re-measured when a
 * designer nudges a hex by two points, and nothing tells you the comment has
 * become a lie. The colour still looks fine on the reviewer's good monitor in a
 * bright room; it fails for the person it was written for.
 *
 * So the ratios are COMPUTED, from the actual token values, and a ratchet
 * (tests/guardrails/contrast.test.ts) fails the build when a real pairing drops
 * below AA. The comments stay, but they are now checked.
 *
 * This already caught a real bug once, before it existed: the destructive button
 * shipped white-on-red at 3.13:1, and even solid #DC2626 only reaches 4.48:1.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0..1. Present for rgba() tokens. */
  a: number;
}

/** Parse `#rrggbb`, `#rgb`, or `rgba(r, g, b, a)`. Returns null for anything else. */
export function parseColor(input: string): Rgb | null {
  const value = input.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) {
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }

  const rgba = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(
    value.replace(/\s+/g, ' '),
  );
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }

  return null;
}

/**
 * Flatten a translucent colour onto its backdrop.
 *
 * A token like `rgba(167, 139, 250, 0.08)` has NO contrast ratio on its own — the
 * ratio depends entirely on what is behind it. Measuring it as if it were opaque
 * produces a number that is confidently wrong, which is worse than no number.
 */
export function composite(foreground: Rgb, backdrop: Rgb): Rgb {
  if (foreground.a >= 1) return foreground;

  const a = foreground.a;
  return {
    r: foreground.r * a + backdrop.r * (1 - a),
    g: foreground.g * a + backdrop.g * (1 - a),
    b: foreground.b * a + backdrop.b * (1 - a),
    a: 1,
  };
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(color: Rgb): number {
  const channel = (value: number): number => {
    const c = value / 255;
    // The sRGB transfer curve. Using c/12.92 everywhere (or the power law
    // everywhere) is a common shortcut and it shifts the ratio enough to move a
    // colour across the AA line.
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * The contrast ratio between two colours, 1..21.
 *
 * Order does not matter — the lighter one is always the numerator.
 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);

  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The WCAG thresholds.
 *
 * `LARGE` (3:1) applies only to text at 24px, or 18.66px bold. Almost nothing in
 * this product qualifies — captions and table cells are 12–14px — so the default
 * everywhere is AA_NORMAL, and a caller has to say so explicitly to get the
 * lower bar. Defaulting the other way is how a 3.1:1 caption ships.
 */
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;
/** Icons, focus rings, input borders — anything that is not text but must be seen. */
export const AA_NON_TEXT = 3;
export const AAA_NORMAL = 7;

export function meetsAA(ratio: number, size: 'normal' | 'large' = 'normal'): boolean {
  return ratio >= (size === 'large' ? AA_LARGE : AA_NORMAL);
}

/** Contrast between two CSS colour strings, compositing onto a backdrop if needed. */
export function ratioOf(
  foreground: string,
  background: string,
  opts: { backdrop?: string } = {},
): number | null {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return null;

  const backdrop = opts.backdrop ? parseColor(opts.backdrop) : null;

  // A translucent background must be flattened onto the page beneath it, or the
  // ratio is computed against a colour that never appears on screen.
  const solidBg = bg.a < 1 && backdrop ? composite(bg, backdrop) : bg;
  const solidFg = fg.a < 1 ? composite(fg, solidBg) : fg;

  return contrastRatio(solidFg, solidBg);
}
