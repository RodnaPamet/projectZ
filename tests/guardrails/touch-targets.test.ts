import { readFileSync } from 'node:fs';

/**
 * A FINGER CAN HIT A CHECKBOX.
 *
 * Radix Checkbox, RadioGroup and Switch draw a 16-20 px control. That is the
 * right VISUAL size and the wrong hit size: Apple's HIG and WCAG 2.5.5 ask for
 * 44 px, and on a phone a 16 px box is a box you miss, then miss again, then
 * zoom the page to hit. globals.css fixes it once for every control on a
 * coarse pointer: a transparent 44 px ::before, centred on the control, which
 * catches the tap without changing the design.
 *
 * Those rules sat for months inside the process-canvas section inherited from
 * inflect, between the xyflow handle rules and a legacy `.input` floor. T28
 * (#225) deleted that section as compliance CSS, and the rules came within one
 * selection of going with it. They live in their own section now; this guard
 * is what keeps the next cleanup from taking them.
 *
 * Text, not a rendered test: jsdom has no pointer media and no layout, so the
 * only thing it could check is the stylesheet anyway.
 */

const GLOBALS_CSS = readFileSync('src/app/globals.css', 'utf8');

/** Every `@media (pointer: coarse) { … }` block, by brace depth. */
function coarseBlocks(css: string): string[] {
  const out: string[] = [];
  const re = /@media\s*\(\s*pointer:\s*coarse\s*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.push(css.slice(m.index, i));
  }
  return out;
}

/** The declarations of the first rule in `block` whose selector list includes `selector`. */
function ruleFor(block: string, selector: string): string | null {
  const rules = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rules.exec(block))) {
    const selectors = m[1]!.split(',').map((s) => s.replace(/\s+/g, ' ').trim());
    if (selectors.some((s) => s.endsWith(selector))) return m[2]!;
  }
  return null;
}

const ROLES = ['checkbox', 'radio', 'switch'] as const;

describe('the scan is not vacuous', () => {
  it('finds a coarse-pointer block in globals.css', () => {
    // A renamed file or a reworded media query makes every check below vacuous.
    expect(GLOBALS_CSS.length).toBeGreaterThan(1000);
    expect(coarseBlocks(GLOBALS_CSS).length).toBeGreaterThan(0);
  });

  it('the rule finder sees a rule it is given', () => {
    // A sentinel: if the parser broke, `ruleFor` would return null for every
    // role and the failure would read as "the rule was deleted".
    const sentinel = "@media (pointer: coarse) { [role='x']::before { width: 44px; } }";
    expect(ruleFor(coarseBlocks(sentinel)[0]!, "[role='x']::before")).toMatch(/width:\s*44px/);
  });
});

describe('toggle controls get a 44 px hit-target on a coarse pointer', () => {
  const block = coarseBlocks(GLOBALS_CSS).join('\n');

  it.each(ROLES)('role=%s is the positioning parent', (role) => {
    // Without position: relative the ::before positions against some ancestor
    // and the hit-target lands somewhere else on the page.
    expect(ruleFor(block, `[role='${role}']`)).toMatch(/position:\s*relative/);
  });

  it.each(ROLES)('role=%s::before is 44 px square, centred and invisible', (role) => {
    const rule = ruleFor(block, `[role='${role}']::before`);
    expect(rule).not.toBeNull();
    expect(rule).toMatch(/content:\s*''/);
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/width:\s*44px/);
    expect(rule).toMatch(/height:\s*44px/);
    expect(rule).toMatch(/transform:\s*translate\(-50%,\s*-50%\)/);
    // Transparent, so the control looks the same; a visible ::before would be
    // a 44 px box drawn around every checkbox on every phone.
    expect(rule).toMatch(/background:\s*transparent/);
  });

  it('is not scoped to a canvas, a page or a data attribute', () => {
    // The rules apply to every control. Nested under [data-process-canvas]
    // they would have covered one compliance screen playerz does not have.
    for (const role of ROLES) {
      const scoped = new RegExp(`\\[data-[^\\]]+\\][^,{]*\\[role='${role}'\\]`);
      expect(block).not.toMatch(scoped);
    }
  });
});
