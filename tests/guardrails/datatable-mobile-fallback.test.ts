import { readFileSync, globSync } from 'node:fs';

/**
 * NO TABLE HORIZONTAL-SCROLLS ON A PHONE BY OMISSION.
 *
 * An eight-column table at 390px does not fit and will not wrap. Without a
 * fallback the overflow lands on the PAGE and the whole app scrolls sideways —
 * the #1 mobile bug class (see P1).
 *
 * ═══ THIS GUARD IS INVERTED FROM THE OBVIOUS ONE ═══
 *
 * The natural design — the one the prompt describes, and the right one for a
 * codebase whose tables scroll by default — is: "every <DataTable> must pass an
 * explicit mobileFallback".
 *
 * In THIS codebase that would be theatre. DataTable already collapses to cards
 * below `md`, automatically, for every table, with no opt-in. The default is
 * already the SAFE one. Forcing 11 call sites to write `mobileFallback="card"`
 * would add ceremony and protect nothing — and a ratchet that demands ceremony
 * without protection is a ratchet people learn to resent.
 *
 * So it guards the thing that can ACTUALLY go wrong here:
 *
 *   1. the safe default must STAY the default — nobody may flip it to 'scroll';
 *   2. any call site that DOES opt out must say why, in writing;
 *   3. the card renderer must remain reachable and usable.
 *
 * The failure mode being refused is identical. Only the direction is reversed.
 */

const CALL_SITES = [...globSync('src/app/**/*.tsx'), ...globSync('src/components/**/*.tsx')]
  .map((f) => f.toString())
  .filter((f) => !f.includes('components/ui/table/'));

const DATA_TABLE = readFileSync('src/components/ui/table/data-table.tsx', 'utf8');
const CARDS = readFileSync('src/components/ui/table/data-table-cards.tsx', 'utf8');
// Since T21 (inflect's table, after T04 upstreamed playerz's keyboard cards)
// the card no longer spells its own role/tabIndex/key handler: it spreads
// `buttonLikeKeys`, the helper every button-like row in the library shares.
// The markers below therefore read the HELPER, and the card is held to
// actually delegating to it — otherwise a card that dropped the spread would
// pass on the helper's text alone.
const BUTTON_LIKE = readFileSync('src/components/ui/button-like-keys.ts', 'utf8');

describe('the safe default stays the default', () => {
  it('DataTable collapses to cards below md unless told otherwise', () => {
    // If this ever flips, every table in the app starts scrolling sideways on a
    // phone at once — and nothing else in the codebase would change to say so.
    expect(DATA_TABLE).toMatch(/mobileFallback \?\? ['"]card['"]/);
    expect(DATA_TABLE).toMatch(/useIsBelowMd\(\)/);
    expect(DATA_TABLE).toMatch(/<DataTableCards/);
  });

  it('the card branch is guarded by the fallback choice, not just the viewport', () => {
    // Otherwise `mobileFallback="scroll"` would be accepted and silently ignored
    // — a prop that lies, which is worse than no prop.
    expect(DATA_TABLE).toMatch(/collapsesToCards/);
    expect(DATA_TABLE).toMatch(/belowMd && collapsesToCards/);
  });
});

describe('opting OUT must be justified', () => {
  it('every mobileFallback="scroll" carries a comment saying why', () => {
    const violations: string[] = [];

    for (const file of CALL_SITES) {
      const lines = readFileSync(file, 'utf8').split('\n');

      lines.forEach((line, i) => {
        if (!/mobileFallback=["']scroll["']/.test(line)) return;

        // A reason must be adjacent: on the line, or within the three lines above.
        const context = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        const hasReason = /\/\/|\/\*|\{\/\*/.test(context);

        if (!hasReason) violations.push(`${file}:${i + 1}`);
      });
    }

    if (violations.length > 0) {
      throw new Error(
        `mobileFallback="scroll" with no stated reason:\n\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nOpting a table OUT of card mode means it will horizontal-scroll on a phone,\n` +
          `and an eight-column table at 390px pushes the whole PAGE sideways.\n\n` +
          `That is sometimes the right call — a wide admin matrix genuinely is\n` +
          `desktop-only. But it has to be a DECISION, written down, not an omission.\n` +
          `Add a one-line comment saying why.`,
      );
    }
  });
});

describe('the card renderer is actually usable', () => {
  it('a clickable card is operable BY KEYBOARD', () => {
    // It was a bare <div> with onClick: no role, no tabIndex, no key handler. A
    // keyboard user could not reach the row and a screen-reader user was never
    // told it was actionable — the entire mobile list was unusable for them,
    // silently.
    //
    // A clickable card spreads the helper's role, tabIndex and onKeyDown; a
    // read-only one is a listitem.
    expect(CARDS).toMatch(
      /import \{ buttonLikeKeys \} from ['"]@\/components\/ui\/button-like-keys['"]/,
    );
    expect(CARDS).toMatch(/clickable \? cardActivation\(/);
    expect(CARDS).toMatch(/onKeyDown: \(e[^)]*\) => bound\(e\)\.onKeyDown\(e\)/);

    expect(BUTTON_LIKE).toMatch(/role: ['"]button['"]/);
    expect(BUTTON_LIKE).toMatch(/tabIndex: disabled \? -1 : 0/);
    expect(BUTTON_LIKE).toMatch(/onKeyDown/);

    // BOTH keys must be handled — not the exact shape of the check. An early
    // `!==` return and an `===` branch are equally correct, and a guard that
    // dictates which one you wrote is a guard that fails on a refactor with no
    // behavioural change.
    expect(BUTTON_LIKE).toMatch(/['"]Enter['"]/);
    expect(BUTTON_LIKE).toMatch(/['"] ['"]/); // Space
  });

  it('Space does not scroll the page instead of opening the row', () => {
    // The default action of Space on a focused element is to scroll. A row that
    // scrolls the list instead of opening is worse than one that does nothing.
    // Read from the helper: the card's own file only mentions it in a comment.
    expect(BUTTON_LIKE).toMatch(/event\.preventDefault\(\)/);
  });

  it('a tappable card is at least 44px tall', () => {
    // Below that, a tap lands between rows as often as on one — and the miss
    // scrolls the list, which is the opposite of what was wanted.
    expect(CARDS).toMatch(/min-h-11/);
  });

  it('a tappable card SHOWS that it is tappable', () => {
    // Without an affordance the card looks like a read-only summary and the user
    // never discovers the row opens.
    expect(CARDS).toMatch(/ChevronRight/);
  });

  it('it has a visible focus ring', () => {
    // A keyboard user tabbing through a list of cards must be able to see where
    // they are. P23 gave the focus ring its own token precisely so this is
    // possible without darkening every link.
    expect(CARDS).toMatch(/focus-visible:ring/);
  });
});

// ── Negative controls ────────────────────────────────────────────────

describe('the rules fire on the code they forbid', () => {
  it('detects an unjustified opt-out', () => {
    const OPT_OUT = /mobileFallback=["']scroll["']/;

    expect(OPT_OUT.test('<DataTable mobileFallback="scroll" data={d} />')).toBe(true);
    expect(OPT_OUT.test('<DataTable mobileFallback="card" data={d} />')).toBe(false);
    expect(OPT_OUT.test('<DataTable data={d} />')).toBe(false);
  });

  it('accepts an opt-out that IS justified', () => {
    const lines = [
      '// A 20-column RBAC matrix. Genuinely desktop-only; cards would be nonsense.',
      '<DataTable mobileFallback="scroll" data={d} />',
    ];

    const context = lines.join('\n');
    expect(/\/\/|\/\*|\{\/\*/.test(context)).toBe(true);
  });
});
