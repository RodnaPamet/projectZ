import { readFileSync, globSync } from 'node:fs';

import { treeFiles } from '../helpers/scan-floor';

/**
 * HORIZONTAL DRIFT — THE #1 MOBILE BUG CLASS, CAUGHT AT AUTHORING TIME.
 *
 * "Drift" is when a page scrolls sideways on a phone. The user swipes down the
 * list, the whole page slides left, the layout tears, and nothing looks broken
 * to whoever built it on a 27-inch monitor.
 *
 * ─── Why a STATIC guard and not just an e2e check ────────────────────
 *
 * The e2e drift spec renders real pages at 390px and measures
 * `scrollWidth > clientWidth`. That is the ground truth, and it is the right
 * final check.
 *
 * But it can only test the pages that EXIST. Every page not yet written is one
 * PR away from reintroducing the bug, and the e2e suite will not know until
 * somebody adds it to the list. A sampled ratchet is not a guarantee.
 *
 * So this guard bans the ROOT-CAUSE PATTERNS in source, regardless of whether
 * any page renders them yet. It is the half of the promise that scales.
 *
 * ─── The two patterns ────────────────────────────────────────────────
 *
 *   (a) An UNCOMPENSATED NEGATIVE MARGIN. `-mx-4` pulls content wider than its
 *       parent; if any ancestor scrolls, that extra width becomes horizontal
 *       scroll.
 *
 *       Note the rule is NOT "…inside a scroll container". I wrote it that way
 *       first, gating on whether the same FILE contained `overflow-y-auto`. It
 *       found nothing — because the scroll container is almost never in the same
 *       file as the margin. It lives in a parent component, or inside cmdk. The
 *       guard skipped every file and passed in silence, and its baseline was
 *       decorative.
 *
 *       You CANNOT know from a source file whether an element's parent scrolls.
 *       So the safe rule is the unconditional one: an uncompensated negative
 *       x-margin is a drift risk wherever it appears. Compensate it, or justify
 *       it here.
 *
 *   (b) A RAW <table> with no horizontal scroll context. A table is the one
 *       element that will not wrap: eight columns of content at 390px simply
 *       do not fit, and without an `overflow-x-auto` ancestor the whole PAGE
 *       carries the overflow instead of the table.
 *
 * Every rule is NEGATIVE-CONTROLLED at the bottom of the file: we prove the
 * pattern fires on the code it forbids, so nobody is protected by a regex that
 * silently stopped matching.
 */

const SOURCE = [...globSync('src/components/**/*.tsx'), ...globSync('src/app/**/*.tsx')].map((f) =>
  f.toString(),
);

interface Baseline {
  file: string;
  /**
   * A distinctive fragment of the offending line — NOT a line number.
   *
   * The first version of this baseline pinned line numbers. It broke the moment
   * an unrelated PR (P3, keyboard avoidance) added imports to popover.tsx: the
   * separator moved from 265 to 293 and the guard declared its own baseline
   * stale.
   *
   * A line-number baseline is invalidated by ANY edit above it, which means it
   * fails on PRs that have nothing to do with it. That is the fastest way to
   * teach people that this guard is noise.
   *
   * The content is stable; the line number is not.
   */
  match: string;
  reason: string;
}

/**
 * KNOWN, REVIEWED, COMPENSATED SITES.
 *
 * Every one of these is a menu separator using `-mx-1` to bleed a divider to
 * the edges of a menu whose CONTAINER carries `p-1`. The compensation is real —
 * it is just on the parent rather than the element itself, which is exactly what
 * the rule cannot see and why these need a written reason rather than a code
 * change.
 *
 * A new entry here is a claim that somebody looked. Do not add one to make a
 * build green.
 */
const BASELINE: Baseline[] = [
  {
    file: 'src/components/ui/popover.tsx',
    match: "cn('bg-border-subtle -mx-1 my-1 h-px', className)",
    reason:
      'Popover.Separator. The -mx-1 bleeds the divider to the edges of Popover.Menu, which carries p-1 (popover.tsx:186). Compensated by the parent, not the element.',
  },
  {
    file: 'src/components/ui/combobox/index.tsx',
    match: 'bg-border-subtle -mx-1 my-1 h-px',
    reason: 'Command.Separator in a p-1 menu list. Same bleed-to-edge pattern.',
  },
  {
    file: 'src/components/ui/table/table.tsx',
    match: "'-mr-px',",
    reason:
      "The column-resize handle: a 1px hairline that is `absolute right-0`, so it is OUT OF FLOW and cannot widen its parent. It also sits inside the table's own overflow-x-auto context, so the 1px cannot reach the page. Baselined rather than exempting `absolute` wholesale — a blanket escape hatch would let a genuinely drifting absolute element through.",
  },
];

/** Utilities that pull an element WIDER than its parent. */
const NEGATIVE_X_MARGIN = /(?:^|[\s"'`])-m[xlr]?-(?:\d+(?:\.\d+)?|px|\[[^\]]+\])(?=[\s"'`]|$)/;

/** Compensation ON THE SAME ELEMENT. */
const COMPENSATING = /(?:^|[\s"'`])(?:p[xlr]?-\d|overflow-x-hidden|overflow-hidden)(?=[\s"'`]|$)/;

/**
 * An icon nudge inside a button.
 *
 * `-ml-1` on a chevron to optically align it is not a drift risk: the icon is a
 * fixed 16-20px and the button has its own padding. Flagging these would make
 * the guard fire on dozens of harmless sites, and a guard that cries wolf is a
 * guard people switch off.
 */
const ICON_NUDGE = /size-[0-9]|h-[0-9]\s|w-[0-9]\s|shrink-0/;

describe('the scan is not vacuous', () => {
  it('found the component tree', () => {
    // A broken glob makes every assertion below trivially true. The floor is the
    // tree itself, counted a second way (tests/helpers/scan-floor.ts), plus the
    // files whose drift this guard has baselined.
    expect([...SOURCE].sort()).toEqual(treeFiles(['src/components', 'src/app'], /\.tsx$/));
    for (const sentinel of ['src/components/ui/popover.tsx', 'src/components/ui/table/table.tsx']) {
      expect(SOURCE).toContain(sentinel);
    }
  });

  it('the baselined files still exist', () => {
    // A stale baseline is a hole nobody can see: the file was deleted or moved,
    // the exemption stayed, and it now silently excuses a line somewhere else.
    for (const entry of BASELINE) {
      expect(SOURCE).toContain(entry.file);
    }
  });
});

// ── (a) Uncompensated negative margin in a scroll container ──────────

describe('no uncompensated negative margin', () => {
  it('finds no unbaselined violation', () => {
    const violations: string[] = [];

    for (const file of SOURCE) {
      const source = readFileSync(file, 'utf8');

      source.split('\n').forEach((line, i) => {
        const lineNo = i + 1;

        if (!NEGATIVE_X_MARGIN.test(line)) return;
        if (COMPENSATING.test(line)) return;
        if (ICON_NUDGE.test(line)) return;

        const baselined = BASELINE.some((b) => b.file === file && line.includes(b.match));
        if (baselined) return;

        violations.push(`${file}:${lineNo}\n      ${line.trim()}`);
      });
    }

    if (violations.length > 0) {
      throw new Error(
        `Uncompensated negative margin:\n\n` +
          violations.map((v) => `  ${v}`).join('\n\n') +
          `\n\nA negative margin pulls content WIDER than its parent. Inside a scrolling\n` +
          `container that extra width becomes HORIZONTAL SCROLL — the page slides sideways\n` +
          `on a phone, the layout tears, and it looks perfectly fine on the monitor of\n` +
          `whoever wrote it.\n\n` +
          `Fix it by adding a compensating px-*/pl-*/pr-* on the SAME element, or\n` +
          `overflow-x-hidden.\n\n` +
          `If the compensation is genuinely on the PARENT (a menu separator bleeding into\n` +
          `a p-1 list, say), add it to BASELINE in this file WITH A REASON — a reason that\n` +
          `says you looked, not one that makes the build green.`,
      );
    }
  });

  it('every baseline entry still matches a real negative margin', () => {
    // If the code was fixed but the exemption stayed, the exemption excuses
    // nothing — and is waiting to excuse whatever lands there next.
    for (const entry of BASELINE) {
      const lines = readFileSync(entry.file, 'utf8').split('\n');
      const hit = lines.find((l) => l.includes(entry.match));

      if (!hit) {
        throw new Error(
          `Stale baseline: ${entry.file} no longer contains \`${entry.match}\`.\n\n` +
            `  reason on file: ${entry.reason}\n\n` +
            `The code was changed but the exemption stayed. Remove it — a stale exemption\n` +
            `is a hole waiting for something new to fall through.`,
        );
      }

      if (!NEGATIVE_X_MARGIN.test(hit)) {
        throw new Error(
          `Stale baseline: ${entry.file} — \`${entry.match}\` no longer has a negative margin.`,
        );
      }
    }
  });

  it('every baseline entry gives a real reason', () => {
    for (const entry of BASELINE) {
      expect(entry.reason.length).toBeGreaterThan(30);
    }
  });
});

// ── (b) Raw <table> with no horizontal scroll context ────────────────

describe('no raw <table> without a horizontal scroll context', () => {
  /**
   * The primitives that OWN a table are allowed to render one — they are the
   * thing that provides the scroll context (or, after P5, the card fallback).
   * Anything else rendering a bare <table> is a page that will overflow.
   */
  const TABLE_PRIMITIVES = [
    'src/components/ui/table/table.tsx',
    'src/components/ui/table/data-table.tsx',
    'src/components/ui/table/virtual-table-body.tsx',
    'src/components/ui/skeleton.tsx',
  ];

  it('the primitives that own a table are the only ones rendering one', () => {
    const offenders: string[] = [];

    for (const file of SOURCE) {
      const source = readFileSync(file, 'utf8');
      if (!/<table[\s>]/.test(source)) continue;

      if (TABLE_PRIMITIVES.includes(file)) continue;

      // Anyone else must provide their own horizontal scroll context.
      if (/overflow-x-auto|overflow-auto/.test(source)) continue;

      offenders.push(file);
    }

    if (offenders.length > 0) {
      throw new Error(
        `Raw <table> with no overflow-x context:\n\n` +
          offenders.map((f) => `  ${f}`).join('\n') +
          `\n\nA table is the one element that will NOT wrap. Eight columns of content do\n` +
          `not fit in 390px, and without an overflow-x-auto ancestor the overflow lands on\n` +
          `the PAGE — the whole app scrolls sideways.\n\n` +
          `Use <DataTable> (which owns its scroll context, and after P5 collapses to cards\n` +
          `on a phone), or wrap it in overflow-x-auto and say why a raw table was needed.`,
      );
    }
  });

  it('each declared table primitive really does contain a table', () => {
    // An allowlist entry for a file that no longer has a table is an exemption
    // doing nothing, waiting to excuse something else.
    for (const file of TABLE_PRIMITIVES) {
      const source = readFileSync(file, 'utf8');
      expect(/<table[\s>]/.test(source)).toBe(true);
    }
  });
});

// ── (c) The CSS backstop stays ───────────────────────────────────────

describe('overscroll-behavior-x is locked on', () => {
  const CSS = readFileSync('src/app/globals.css', 'utf8');

  it('the app shell sets overscroll-behavior-x: none', () => {
    // The last line of defence. Even if something DOES overflow, this stops the
    // horizontal rubber-band / navigation-gesture chaining that makes drift feel
    // like the app is broken rather than merely wide.
    //
    // It is one line and it is trivially deleted by somebody "cleaning up CSS".
    expect(CSS).toMatch(/overscroll-behavior-x:\s*none/);
  });
});

// ── Negative controls ────────────────────────────────────────────────

describe('the rules fire on the code they forbid', () => {
  it('detects an uncompensated negative margin', () => {
    expect(NEGATIVE_X_MARGIN.test('<div className="-mx-4 flex">')).toBe(true);
    expect(NEGATIVE_X_MARGIN.test('<div className="-ml-6">')).toBe(true);
    expect(NEGATIVE_X_MARGIN.test('<div className="-mr-px">')).toBe(true);

    // …and does NOT fire on ordinary positive margins, or on a word that merely
    // ends in something margin-shaped.
    expect(NEGATIVE_X_MARGIN.test('<div className="mx-4">')).toBe(false);
    expect(NEGATIVE_X_MARGIN.test('<div className="-mt-4">')).toBe(false); // vertical: harmless
  });

  it('recognises compensation on the same element', () => {
    expect(COMPENSATING.test('-mx-4 px-4')).toBe(true);
    expect(COMPENSATING.test('-mx-4 overflow-x-hidden')).toBe(true);
    expect(COMPENSATING.test('-mx-4')).toBe(false);
  });

  it('exempts an icon nudge', () => {
    expect(ICON_NUDGE.test('className="-ml-1 size-5 shrink-0"')).toBe(true);
    expect(ICON_NUDGE.test('className="-mx-4 flex flex-col"')).toBe(false);
  });

  it('a compensated negative margin is NOT a violation', () => {
    // The whole point: `-mx-4 px-4` is the standard full-bleed idiom and is safe.
    const line = '<div className="-mx-4 px-4 overflow-y-auto">';

    const flagged = NEGATIVE_X_MARGIN.test(line) && !COMPENSATING.test(line);
    expect(flagged).toBe(false);
  });
});
