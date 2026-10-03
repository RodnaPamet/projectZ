import { readFileSync, globSync } from 'node:fs';

import { treeFiles } from '../helpers/scan-floor';

/**
 * NO NATIVE <select> ON A PHONE.
 *
 * A native `<select>` is not a dropdown on mobile. It is an OS-rendered wheel or
 * full-screen list that we cannot style, cannot search, cannot make match the
 * app, and — the part that actually breaks things — cannot control the dismissal
 * of. It looks like a different application briefly took over.
 *
 * Worse, it is the ONE control that silently ignores the whole design system: no
 * tokens, no dark mode, no focus ring, no 44px target. It is a hole straight
 * through everything the component library guarantees.
 *
 * The replacement already exists: `<Combobox>` (searchable, `forceDropdown` when
 * inside a sheet), `<RadioGroup>`, `<ToggleGroup>`.
 *
 * ─── This ratchet has an EMPTY ALLOWLIST ─────────────────────────────
 *
 * That is deliberate, and it is the strongest form a ratchet can take.
 *
 * The usual shape is: remediate the violations, then baseline whatever survives.
 * A baseline is a debt, and it is the thing people add to when they are in a
 * hurry. Here there is nothing to remediate — the codebase already has zero
 * native selects — so the ratchet starts at zero and the FIRST one ever written
 * fails the build.
 *
 * If you are about to add an entry to an allowlist that does not exist, you are
 * about to be the first person to break this. Use a Combobox.
 *
 * ─── Scope ───────────────────────────────────────────────────────────
 *
 * ALL of src/**. Not just src/app/** — scoping a select-ratchet to routes is how
 * a native select ends up in a shared component and reaches every page at once.
 */

const SOURCE = globSync('src/**/*.tsx').map((f) => f.toString());

/**
 * Strip comments AND strings.
 *
 * Both of the codebase's two `<select>` mentions live in PROSE — the primitives
 * describing themselves as its replacement:
 *
 *   combobox/index.tsx:  "…a drop-in replacement for native `<select>` inside…"
 *   status-badge.tsx:    "…can't be a <StatusBadge> element (e.g. interactive <select>…"
 *
 * A ratchet that flagged those would be a ratchet that punished the
 * documentation for describing the rule. It would be deleted within a week.
 */
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

    // A `<select>` inside a JSX string/template literal is prose too.
    line = line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');

    if (line.trim()) out.push(line);
  }

  return out.join('\n');
}

/** A rendered native select. Not the word; the element. */
const NATIVE_SELECT = /<select[\s/>]/;

describe('the scan is not vacuous', () => {
  it('found the component tree', () => {
    // The floor is the tree itself, counted a second way
    // (tests/helpers/scan-floor.ts), and the two primitives that replace
    // <select> (they are pinned again below).
    expect([...SOURCE].sort()).toEqual(treeFiles(['src'], /\.tsx$/));
    for (const sentinel of [
      'src/components/ui/combobox/index.tsx',
      'src/components/ui/radio-group.tsx',
    ]) {
      expect(SOURCE).toContain(sentinel);
    }
  });

  it('the comment stripper does not swallow real code', () => {
    // If `code()` were over-eager it would return nothing, and every assertion
    // below would pass by scanning an empty string.
    const stripped = SOURCE.map((f) => code(readFileSync(f, 'utf8'))).join('\n');

    expect(stripped.length).toBeGreaterThan(50_000);
    expect(stripped).toContain('export');
  });
});

describe('no native <select> anywhere in src/', () => {
  it('has none — and the allowlist is empty on purpose', () => {
    const violations: string[] = [];

    for (const file of SOURCE) {
      const source = code(readFileSync(file, 'utf8'));

      source.split('\n').forEach((line, i) => {
        if (NATIVE_SELECT.test(line)) {
          violations.push(`${file}:${i + 1}\n      ${line.trim()}`);
        }
      });
    }

    if (violations.length > 0) {
      throw new Error(
        `Native <select> element(s):\n\n` +
          violations.map((v) => `  ${v}`).join('\n\n') +
          `\n\nOn a phone a native <select> is an OS-rendered wheel we cannot style, cannot\n` +
          `search, and cannot control the dismissal of. It is the one control that ignores\n` +
          `the entire design system — no tokens, no dark mode, no focus ring, no 44px\n` +
          `target.\n\n` +
          `Use <Combobox> (add forceDropdown when it sits inside a sheet or modal),\n` +
          `<RadioGroup>, or <ToggleGroup>.\n\n` +
          `There is NO allowlist in this file, deliberately. The codebase has zero native\n` +
          `selects today, so this ratchet starts at zero and you are the first person to\n` +
          `break it.`,
      );
    }
  });

  it('the replacement primitives exist, so the rule is actionable', () => {
    // A ratchet that forbids something without offering a replacement is a
    // ratchet people route around.
    expect(globSync('src/components/ui/combobox/index.tsx').length).toBe(1);
    expect(globSync('src/components/ui/radio-group.tsx').length).toBe(1);
  });
});

// ── Negative controls ────────────────────────────────────────────────

describe('the rule fires on the code it forbids', () => {
  it.each([
    '<select className="w-full">',
    '<select>',
    '<select />',
    '  <select onChange={handle}>',
  ])('catches %s', (bad) => {
    expect(NATIVE_SELECT.test(bad)).toBe(true);
  });

  it.each([
    '<Select value={v} />', // our own capital-S component, if one ever exists
    '<Combobox options={o} />',
    'const selected = useSelection();',
    'onSelect={handleSelect}',
  ])('does NOT flag %s', (good) => {
    expect(NATIVE_SELECT.test(good)).toBe(false);
  });

  it('a <select> mentioned in PROSE is not a violation', () => {
    // Both real occurrences in this codebase are exactly this: the primitives
    // documenting themselves as the replacement.
    const commented = code('// this is a drop-in replacement for native <select>\nconst x = 1;');
    expect(NATIVE_SELECT.test(commented)).toBe(false);

    // …but a real one on the next line still is.
    const real = code('// replaces <select>\n<select className="x">');
    expect(NATIVE_SELECT.test(real)).toBe(true);
  });
});
