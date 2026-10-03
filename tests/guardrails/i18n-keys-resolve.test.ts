import { allKeyUses, catalogueKeys, keyUsesIn, SCANNED_SOURCE } from '../helpers/i18n-usage';
import { treeFiles } from '../helpers/scan-floor';

/**
 * EVERY KEY THE CODE ASKS FOR IS IN THE BULGARIAN CATALOGUE (T29).
 *
 * ═══ WHY ═══
 *
 * next-intl's answer to a missing key is the key: `admin.courts.title` on the
 * page where a heading belongs, in production, with nothing failing. The
 * catalogue guards (i18n-completeness, message-catalogue-parity) compare the
 * catalogues with EACH OTHER; none of them compared the catalogues with the
 * CODE, so a typo in a `t('...')` call, or a key deleted while a page still
 * asks for it, passed every check. bg is the reference (the default locale,
 * and parity holds en to it).
 *
 * ═══ WHAT IS CHECKED ═══
 *
 * tests/helpers/i18n-usage.ts finds every translator (`useTranslations`,
 * `getTranslations`, by lexical scope) and every call through one:
 *
 *   t('a.b')          ns.a.b must be a LEAF in bg (a subtree renders as a key too)
 *   t(`status.${s}`)  at least one bg key must match ns.status.<…>
 *   t(row.labelKey)   the namespace must exist; the key is data, and the
 *                     orphan guard's families say which keys it can be
 */

const BG = catalogueKeys('bg');
const LEAVES = new Set(BG);
const SUBTREES = new Set(
  BG.flatMap((k) => k.split('.').map((_, i, parts) => parts.slice(0, i).join('.'))).filter(Boolean),
);

describe('the scan is not vacuous', () => {
  const uses = allKeyUses();

  it('reads every non-test source file', () => {
    expect(SCANNED_SOURCE()).toEqual(
      treeFiles(['src'], /\.tsx?$/).filter(
        (f) => !/\.test\.tsx?$/.test(f) && !/(?:^|\/)__tests__\//.test(f),
      ),
    );
  });

  it('finds literal, pattern and dynamic lookups across the app', () => {
    // 371 lookups at T29. A broken translator binding would find a handful.
    expect(uses.filter((u) => u.kind === 'literal').length).toBeGreaterThan(250);
    expect(uses.some((u) => u.kind === 'pattern')).toBe(true);
    expect(uses.some((u) => u.kind === 'dynamic')).toBe(true);
    // Sentinels: a client hook, a server translator, a Promise.all binding.
    const files = new Set(uses.map((u) => u.file));
    for (const f of [
      'src/app/(public)/login/login-form.tsx',
      'src/components/layout/SiteHeader.tsx',
      'src/app/(app)/t/[slug]/admin/calendar/page.tsx',
    ])
      expect(files).toContain(f);
  });
});

describe('every key the code asks for exists in bg.json', () => {
  const uses = allKeyUses();

  it('every literal key is a leaf', () => {
    const missing = uses
      .filter((u) => u.kind === 'literal' && !LEAVES.has(u.key))
      .map((u) =>
        u.kind === 'literal'
          ? `  ${u.file}:${u.line}  ${u.key}${SUBTREES.has(u.key) ? '  (a subtree, not a message)' : ''}`
          : '',
      );
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} key(s) the code asks for and messages/bg.json lacks:\n\n` +
          `${missing.join('\n')}\n\n` +
          `next-intl renders the key itself in their place. Add the key to bg.json AND\n` +
          `en.json (parity), or fix the call.`,
      );
    }
  });

  it('every template key matches at least one key', () => {
    const dead = uses.filter((u) => u.kind === 'pattern' && !BG.some((k) => u.pattern.test(k)));
    expect(
      dead.map((u) => (u.kind === 'pattern' ? `${u.file}:${u.line} ${u.source}` : '')),
    ).toEqual([]);
  });

  it("every dynamic key's namespace exists", () => {
    const dead = uses.filter(
      (u) => u.kind === 'dynamic' && u.namespace !== '' && !SUBTREES.has(u.namespace),
    );
    expect(
      dead.map((u) => (u.kind === 'dynamic' ? `${u.file}:${u.line} ${u.namespace}` : '')),
    ).toEqual([]);
  });
});

// ── Negative controls ────────────────────────────────────────────────

describe('the scan resolves translators the way the code binds them', () => {
  const keys = (src: string) =>
    keyUsesIn('x.tsx', src).map((u) =>
      u.kind === 'literal' ? u.key : u.kind === 'pattern' ? `~${u.source}` : `?${u.namespace}`,
    );

  it.each([
    ['a client hook', "const t = useTranslations('a'); t('b');", ['a.b']],
    ['a server translator', "const t = await getTranslations('a'); t('b');", ['a.b']],
    [
      'the object form',
      "const t = await getTranslations({ locale, namespace: 'a' }); t('b');",
      ['a.b'],
    ],
    ['no namespace', "const t = useTranslations(); t('a.b');", ['a.b']],
    [
      'Promise.all',
      "const [x, t] = await Promise.all([getLocale(), getTranslations('a')]); t('b'); x('no');",
      ['a.b'],
    ],
    [
      't.rich and t.has',
      "const t = useTranslations('a'); t.rich('b'); t.has('c');",
      ['a.b', 'a.c'],
    ],
    [
      'a cast and a conditional',
      "const t = useTranslations('a'); t((ok ? 'b' : 'c') as never);",
      ['a.b', 'a.c'],
    ],
    ['a template', "const t = useTranslations('a'); t(`s.${x}`);", ['~a.s.${…}']],
    ['data as the key', "const t = useTranslations('a'); t(item.labelKey);", ['?a']],
    ['translateFor', "await translateFor(locale, 'a.b');", ['a.b']],
  ])('%s', (_l, src, want) => {
    expect(keys(src)).toEqual(want);
  });

  it('two components in one file keep their own namespaces', () => {
    const src = [
      "function A() { const t = useTranslations('one'); return t('x'); }",
      "function B() { const t = useTranslations('two'); return t('y'); }",
    ].join('\n');
    expect(keys(src)).toEqual(['one.x', 'two.y']);
  });

  it('a function that is not a translator is not read', () => {
    expect(keys("const t = (s: string) => s; t('not.a.key');")).toEqual([]);
  });

  it('a missing key is reported', () => {
    const [use] = keyUsesIn('x.tsx', "const t = useTranslations('common'); t('noSuchKey');");
    expect(use?.kind === 'literal' && LEAVES.has(use.key)).toBe(false);
  });
});
