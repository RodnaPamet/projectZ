import { readFileSync } from 'node:fs';

import { CLIENT_NAMESPACES, type ClientSection } from '@/lib/i18n/client-messages';

import { clientNamespacesOf, minimalCover, ROUTE_FILES } from '../helpers/client-namespaces';
import { catalogueKeys, SCANNED_SOURCE } from '../helpers/i18n-usage';

/**
 * THE BROWSER GETS EVERY TRANSLATION ITS CODE ASKS FOR, AND NO MORE (#599).
 *
 * ═══ WHY ═══
 *
 * Each section's layout sends its client components only the namespaces in
 * its list (src/lib/i18n/client-messages.tsx). A namespace the list lacks is
 * not an error anywhere: next-intl renders the key (`admin.calendar.title`)
 * where the words belong, in production. A namespace the list keeps that no
 * browser code uses is weight on every full page load, which is how the
 * catalogue reached 241 KB in each one (#402's quiet baseline).
 *
 * ═══ WHAT IS CHECKED ═══
 *
 * tests/helpers/client-namespaces.ts follows each route file's imports to the
 * browser code it renders and collects the namespaces that code binds with
 * `useTranslations('ns')`. A route file belongs to the nearest section
 * directory below; its section's list must be exactly the cover of what its
 * route files bind. Each section's layout must put every tree it returns
 * under `<ClientMessages section>`, and nothing else in src/ may mount a
 * provider of its own (it would send whatever it was given, the whole
 * catalogue included).
 */

const SECTIONS: Record<ClientSection, { dir: string; layout: string }> = {
  root: { dir: 'src/app', layout: 'src/app/layout.tsx' },
  home: { dir: 'src/app/(home)', layout: 'src/app/(home)/layout.tsx' },
  public: { dir: 'src/app/(public)', layout: 'src/app/(public)/layout.tsx' },
  clubAdmin: {
    dir: 'src/app/(app)/t/[slug]/admin',
    layout: 'src/app/(app)/t/[slug]/admin/layout.tsx',
  },
  platform: { dir: 'src/app/(app)/platform', layout: 'src/app/(app)/platform/layout.tsx' },
};
const NAMES = Object.keys(SECTIONS) as ClientSection[];

/** The section a route file is rendered under: the deepest section directory it sits in. */
const sectionOf = (file: string): ClientSection =>
  NAMES.filter((s) => file.startsWith(`${SECTIONS[s].dir}/`)).sort(
    (a, b) => SECTIONS[b].dir.length - SECTIONS[a].dir.length,
  )[0]!;

/** For each section: every namespace its browser code binds, and a module that binds it. */
const bound = (() => {
  const out = new Map<ClientSection, Map<string, string>>(NAMES.map((s) => [s, new Map()]));
  for (const file of ROUTE_FILES()) {
    const into = out.get(sectionOf(file))!;
    for (const [ns, by] of clientNamespacesOf(file)) if (!into.has(ns)) into.set(ns, by);
  }
  return out;
})();

describe('the scan is not vacuous', () => {
  it('reads the route files of every section', () => {
    const files = ROUTE_FILES();
    expect(files.length).toBeGreaterThan(80);
    for (const s of NAMES) expect(files.some((f) => sectionOf(f) === s)).toBe(true);
  });

  it('finds what each section is known to use', () => {
    // Sentinels: the diary's sheet, the sign-in form, the platform's fees board.
    expect(bound.get('clubAdmin')!.has('admin.calendar')).toBe(true);
    expect(bound.get('public')!.has('login')).toBe(true);
    expect(bound.get('platform')!.has('platform.fees')).toBe(true);
    expect(bound.get('root')!.has('common')).toBe(true);
    // And a server component's useTranslations is not browser code: the venue
    // page's back link renders on the server only (VenueBackLink.tsx).
    expect(bound.get('public')!.get('venue')).not.toBe(
      'src/app/(public)/venues/[slug]/VenueBackLink.tsx',
    );
  });
});

describe('browser code names its namespace', () => {
  it('no client module binds the whole catalogue or a computed namespace', () => {
    const offenders = NAMES.flatMap((s) =>
      [...bound.get(s)!]
        .filter(([ns]) => ns === '' || ns === '<dynamic>')
        .map(([ns, by]) => `  ${by}: useTranslations(${ns === '' ? '' : 'a variable'})`),
    );
    if (offenders.length > 0) {
      throw new Error(
        `Browser code must bind a literal namespace, so its section can send it alone:\n\n` +
          `${[...new Set(offenders)].join('\n')}\n\n` +
          `Pass the namespace: useTranslations('admin.calendar'), not useTranslations().`,
      );
    }
  });
});

describe("each section's list is what its browser code binds", () => {
  it.each(NAMES)('%s', (s) => {
    const uses = bound.get(s)!;
    const want = minimalCover([...uses.keys()].filter((ns) => ns !== '' && ns !== '<dynamic>'));
    const have = [...CLIENT_NAMESPACES[s]].sort();
    if (JSON.stringify(want) === JSON.stringify(have)) return;

    const missing = want
      .filter((ns) => !have.some((h) => ns === h || ns.startsWith(`${h}.`)))
      .map((ns) => {
        const by = [...uses].find(([u]) => u === ns || u.startsWith(`${ns}.`))?.[1];
        return `  + ${ns}   (${by})`;
      });
    const unused = have.filter((h) => !want.includes(h)).map((h) => `  - ${h}`);
    throw new Error(
      `CLIENT_NAMESPACES.${s} in src/lib/i18n/client-messages.tsx is out of date.\n\n` +
        (missing.length
          ? `Missing (the browser would show these keys):\n${missing.join('\n')}\n\n`
          : '') +
        (unused.length
          ? `Kept, but no browser code under ${SECTIONS[s].dir} binds it:\n${unused.join('\n')}\n\n`
          : '') +
        `The list should be:\n\n  ${s}: ${JSON.stringify(want)},`,
    );
  });

  it('every listed namespace is in both catalogues', () => {
    for (const locale of ['bg', 'en'] as const) {
      const keys = catalogueKeys(locale);
      const absent = NAMES.flatMap((s) =>
        CLIENT_NAMESPACES[s]
          .filter((ns) => !keys.some((k) => k === ns || k.startsWith(`${ns}.`)))
          .map((ns) => `${s}: ${ns}`),
      );
      expect({ locale, absent }).toEqual({ locale, absent: [] });
    }
  });
});

describe('every section mounts its own provider, and nothing else does', () => {
  it('the root layout puts the whole app under <ClientMessages section="root">', () => {
    // Inside <body>, around the providers: the Toaster and the primitives they
    // render call useTranslations() too.
    expect(readFileSync(SECTIONS.root.layout, 'utf8')).toMatch(
      /<ClientMessages section="root">\s*<Providers>\{children\}<\/Providers>\s*<\/ClientMessages>/,
    );
  });

  it.each(NAMES.filter((s) => s !== 'root'))(
    "%s's layout puts every tree it returns under <ClientMessages>",
    (s) => {
      const src = readFileSync(SECTIONS[s].layout, 'utf8');
      const returns = [...src.matchAll(/\breturn\s*\(?\s*</g)].map((m) =>
        src.slice(m.index + m[0].length - 1),
      );
      expect(returns.length).toBeGreaterThan(0);
      for (const tree of returns)
        expect(tree.startsWith(`<ClientMessages section="${s}">`)).toBe(true);
    },
  );

  it('only src/lib/i18n/client-messages.tsx mounts NextIntlClientProvider', () => {
    const mounts = SCANNED_SOURCE().filter((f) =>
      /<NextIntlClientProvider\b|import\s*\{[^}]*\bNextIntlClientProvider\b[^}]*\}\s*from\s*'next-intl'/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(mounts).toEqual(['src/lib/i18n/client-messages.tsx']);
  });
});
