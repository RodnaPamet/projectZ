/** @jest-environment node */
import { checkSource } from '../../../scripts/ui-sync/portable-rules.mjs';

/**
 * check-portable's rules. Upstream authors run them over inflect files before
 * opening a PR, so a false positive costs them a rewrite and a false negative
 * costs a second upstream round-trip once the copy fails a playerz guardrail.
 * Each rule is pinned both ways.
 */

interface Finding {
  path: string;
  line: number;
  rule: string;
  text: string;
}

const check = (src: string, path = 'src/components/ui/thing.tsx') =>
  (checkSource(path, src) as Finding[]).map((f) => `${f.rule}:${f.line}:${f.text}`);
const rules = (src: string, path?: string) => [
  ...new Set(check(src, path).map((f) => f.split(':')[0])),
];

describe('raw-palette (no-raw-tokens)', () => {
  it('flags a raw Tailwind scale in code', () => {
    expect(check(`const c = 'bg-slate-800 text-gray-500';`)).toEqual([
      'raw-palette:1:bg-slate-800',
      'raw-palette:1:text-gray-500',
    ]);
  });

  it('ignores semantic tokens, the brand fills, and comment lines', () => {
    expect(check(`const c = 'bg-bg-default text-content-muted bg-brand-600';`)).toEqual([]);
    expect(check(`// never bg-slate-800\n * text-gray-500 in prose\nconst x = 1;`)).toEqual([]);
  });
});

describe('brand-text (no-raw-brand-text, and #246)', () => {
  it.each([
    'text-brand-600',
    'hover:text-brand-500',
    'text-[var(--brand-default)]',
    'text-(--brand-emphasis)',
  ])('flags %s in a class string', (cls) => {
    expect(rules(`<p className="${cls} font-medium" />`)).toEqual(['brand-text']);
  });

  it('does not flag fills, the text token, or a class named in a comment', () => {
    expect(check(`<p className="bg-brand-600 text-content-brand border-brand-500" />`)).toEqual([]);
    expect(check(`// never text-brand-600\nconst x = 1;`)).toEqual([]);
  });

  it('reads @apply in CSS, and not CSS comments', () => {
    expect(check('.x { @apply text-brand-600; }', 'src/styles/x.css')).toEqual([
      'brand-text:1:text-brand-600',
    ]);
    expect(check('/* text-brand-600 */ .x { color: red; }', 'src/styles/x.css')).toEqual([]);
  });
});

describe('english-copy (i18n-no-hardcoded-copy)', () => {
  it('flags JSX text and copy attributes', () => {
    expect(check(`export const A = () => <h1>Book a court</h1>;`)).toEqual([
      'english-copy:1:Book a court',
    ]);
    expect(check(`export const A = () => <input placeholder="Search venues" />;`)).toEqual([
      'english-copy:1:placeholder="Search venues"',
    ]);
  });

  it('flags the fallbacks the guardrail cannot see: ??, ternaries, {"…"} children', () => {
    expect(rules(`<svg aria-label={label ?? 'Line chart'} />`)).toEqual(['english-copy']);
    expect(rules(`<b aria-label={open ? 'Hide password' : 'Show password'} />`)).toEqual([
      'english-copy',
    ]);
    expect(rules(`<span>{children ?? 'Filter'}</span>`)).toEqual(['english-copy']);
  });

  it('flags a copy parameter default, in a signature or a destructured prop', () => {
    expect(rules(`export function E({ retryLabel = 'Try again' }) { return null; }`)).toEqual([
      'english-copy',
    ]);
    expect(rules(`export const f = (title = 'No results') => title;`, 'src/lib/x.ts')).toEqual([
      'english-copy',
    ]);
  });

  it('does not flag keys, class names, single lowercase words or non-copy defaults', () => {
    expect(check(`<p className="flex gap-2">{t('venues.title')}</p>`)).toEqual([]);
    expect(check(`<Button variant="primary" size="md" />`)).toEqual([]);
    expect(check(`export function B({ variant = 'primary', format = 'dd MMM yyyy' }) {}`)).toEqual(
      [],
    );
    // A destructured default outside a parameter list is not a parameter default.
    expect(check(`const { label = 'Save changes' } = props;`)).toEqual([]);
  });
});

describe('vocabulary (the upstream portability rules)', () => {
  it('flags compliance nouns and the four brands in comments, JSDoc, strings and test names', () => {
    expect(check(`// renders the Evidence list\nconst x = 1;`)).toEqual(['vocabulary:1:Evidence']);
    expect(check(`/**\n * ISO 27001 — Clause 9.3\n */\nexport const a = 1;`)).toEqual([
      'vocabulary:2:ISO 27001',
      'vocabulary:2:Clause',
    ]);
    expect(check(`const key = 'inflect:theme';`)).toEqual(['vocabulary:1:inflect']);
    expect(check(`it('hides audited controls', () => {});`)).toEqual([
      'vocabulary:1:audited',
      'vocabulary:1:controls',
    ]);
    expect(check(`<p>{/* ported from Dub */}</p>`)).toEqual(['vocabulary:1:Dub']);
  });

  it('does not flag identifiers, import paths, aria-controls, or the singular UI words', () => {
    expect(check(`const controls = useAnimationControls();`)).toEqual([]);
    expect(check(`import { x } from '@dub/utils';`)).toEqual([]);
    expect(check(`<button aria-controls={id} {...{ 'aria-controls': id }} />`)).toEqual([]);
    expect(
      check(`// a form control, at your own risk, per the privacy policy\nconst a = 1;`),
    ).toEqual([]);
  });

  // #300: a test or automation hook is a widget name, not the compliance noun.
  it('does not flag data-* attribute values or test-id lookups', () => {
    expect(check(`<nav data-testid="pagination-controls" />`)).toEqual([]);
    expect(check(`<nav data-testid={\`row-\${id}-controls\`} data-section={'risks'} />`)).toEqual(
      [],
    );
    expect(check(`const p = { 'data-testid': 'pagination-controls' };`)).toEqual([]);
    expect(
      check(
        `expect(screen.getByTestId('pagination-controls')).toBeVisible();`,
        'tests/rendered/pagination.test.tsx',
      ),
    ).toEqual([]);
    expect(
      check(
        `await page.locator('[data-testid="pagination-controls"]').click();`,
        'tests/e2e/pagination.spec.ts',
      ),
    ).toEqual([]);
    expect(check('<div data-testid="pagination-controls"></div>', 'docs/fixture.html')).toEqual([]);
  });

  it('still flags the compliance nouns everywhere else (#300 negative controls)', () => {
    expect(check(`// lists the controls for this framework\nconst a = 1;`)).toEqual([
      'vocabulary:1:controls',
    ]);
    expect(check(`router.push('/controls');`)).toEqual(['vocabulary:1:controls']);
    expect(check(`const t = useTranslations('controls.list');`)).toEqual(['vocabulary:1:controls']);
    expect(rules(`export const H = () => <h2>Risks</h2>;`)).toContain('vocabulary');
    expect(check(`<h2>{t('risks.title')}</h2>`)).toEqual(['vocabulary:1:risks']);
    expect(check('## Risks\n\nOpen risks by owner.', 'docs/x.md')).toEqual([
      'vocabulary:1:Risks',
      'vocabulary:3:risks',
    ]);
    // the exemption is the attribute VALUE, not any string near one
    expect(check(`<a data-testid="nav" href="/controls">x</a>`)).toEqual(['vocabulary:1:controls']);
    expect(check(`<div className="pagination-controls" />`)).toEqual(['vocabulary:1:controls']);
  });

  it('is not fooled by // inside JSX text or a URL', () => {
    expect(check(`<a href="https://example.com/evidence">docs</a>`)).toEqual([
      'vocabulary:1:evidence',
    ]);
    expect(check(`<p>see https://x.bg</p>`)).toEqual(['english-copy:1:see https://x.bg']);
  });
});

describe('hand-rolled-menu (no-hand-rolled-menus)', () => {
  it('flags a click-away layer and a trigger-anchored menu', () => {
    expect(rules(`<div className="fixed inset-0" onClick={close} />`)).toEqual([
      'hand-rolled-menu',
    ]);
    expect(rules(`<div className="absolute top-full right-0">menu</div>`)).toContain(
      'hand-rolled-menu',
    );
    expect(rules(`const [openMenuId, setOpenMenuId] = useState(null);`)).toEqual([
      'hand-rolled-menu',
    ]);
  });

  it('leaves the three overlay primitives, variants and prose alone', () => {
    const layer = `<div className="fixed inset-0" />`;
    for (const p of ['modal', 'sheet', 'popover']) {
      expect(check(layer, `src/components/ui/${p}.tsx`)).toEqual([]);
    }
    expect(check(`<div className="before:absolute before:bottom-full" />`)).toEqual([]);
    expect(check(`// never write fixed inset-0 by hand\nconst a = 1;`)).toEqual([]);
  });

  // #300: a ratchet that counts bespoke overlays has to quote the literal it counts.
  it('lets a test file quote fixed inset-0, and only that rule', () => {
    const ratchet = `const BESPOKE = /fixed inset-0 bg-black/g;\nexpect(count('fixed inset-0 bg-black')).toBe(0);`;
    expect(check(ratchet, 'tests/unit/modal-primitive.test.ts')).toEqual([]);
    expect(check(ratchet, 'src/components/ui/modal-primitive.test.ts')).toEqual([]);
    expect(
      rules(`<div className="absolute top-full">menu</div>`, 'tests/unit/x.test.tsx'),
    ).toContain('hand-rolled-menu');
  });

  it('still flags fixed inset-0 in a non-primitive src component', () => {
    expect(
      check(
        `<div className="fixed inset-0" onClick={close} />`,
        'src/components/venues/filters.tsx',
      ),
    ).toEqual(['hand-rolled-menu:1:fixed inset-0 click-away layer']);
    expect(
      check(`<div className="fixed inset-0" />`, 'src/components/ui/tests-banner.tsx'),
    ).toEqual(['hand-rolled-menu:1:fixed inset-0 click-away layer']);
  });
});

describe('native-select (no-native-select, and #253)', () => {
  it('flags the element, including `<select` at the end of a line', () => {
    expect(check(`<select className="w-full">`)).toEqual(['native-select:1:<select']);
    expect(check(`return (\n  <select\n    value={v}\n  />\n);`)).toEqual([
      'native-select:2:<select',
    ]);
  });

  it('does not flag prose, strings or our own components', () => {
    expect(check(`// a drop-in replacement for native <select>\nconst x = '<select>';`)).toEqual(
      [],
    );
    expect(check(`<Select value={v} />`)).toEqual([]);
  });
});

describe('motion (motion-safety)', () => {
  it('flags inline durations and infinite animations', () => {
    expect(rules(`<div style={{ animationDuration: '2s' }} />`)).toEqual(['motion']);
    expect(rules(`const css = 'animation: spin 1s linear infinite;';`)).toEqual(['motion']);
  });

  it('does not flag Tailwind transitions or a finite animation', () => {
    expect(check(`<div className="transition-colors duration-200" />`)).toEqual([]);
    expect(check(`const css = 'animation: fade 200ms ease-out;';`)).toEqual([]);
  });
});

it('a portable file has no findings at all', () => {
  const src = [
    "'use client';",
    "import { cn } from '@/lib/cn';",
    '',
    '/** A labelled field. The label comes from the caller, already translated. */',
    'export function Field({ label, className }: { label: string; className?: string }) {',
    "  return <label className={cn('text-content-default flex gap-2', className)}>{label}</label>;",
    '}',
  ].join('\n');
  expect(check(src)).toEqual([]);
});
