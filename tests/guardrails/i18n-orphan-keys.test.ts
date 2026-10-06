import { readFileSync } from 'node:fs';

import { allKeyUses, catalogueKeys, type KeyUse } from '../helpers/i18n-usage';

/**
 * EVERY CATALOGUE KEY IS ASKED FOR BY SOME CODE (T29).
 *
 * ═══ WHY ═══
 *
 * A key nothing renders still gets translated, reviewed and kept in parity,
 * and it reads like a feature playerz has. The port brought inflect's whole
 * catalogue shape with it; T28 (#225) deleted 128 dead keys per locale
 * (570 → 442), and this guard found 21 more (common.yes/no/none/submit/…,
 * the old login form's email/password/submit, myBookings.price), deleted with
 * it (442 → 421). From here a key goes when its last caller goes.
 *
 * ═══ HOW A KEY COUNTS AS USED ═══
 *
 * A literal lookup names it (tests/helpers/i18n-usage.ts), a template lookup
 * matches it (`status.${s}` uses every status.*), or it sits under a FAMILY
 * below: a namespace whose keys are chosen by data the scan cannot read (a
 * sport enum, a nav item's labelKey). Each family names the file that reads
 * it, and fails if that file stops doing so.
 */

interface Family {
  prefix: string;
  /** The file whose data-driven lookup reads the family. */
  via: string;
  why: string;
}

const FAMILIES: Family[] = [
  {
    prefix: 'sports.',
    via: 'src/app/(public)/venues/VenueList.tsx',
    why: 'one label per Sport enum value, looked up as t(sport)',
  },
  {
    prefix: 'cities.',
    via: 'src/lib/geo/cities.ts',
    why: 'one name per known city (#357), looked up as t(key) from the city a venue row stores',
  },
  {
    prefix: 'common.nav.',
    via: 'src/components/layout/nav-items.ts',
    why: "nav items carry labelKey/titleKey as data; the shells call t(item.labelKey) in 'common.nav'",
  },
  {
    prefix: 'common.calendar.weekdayShort.',
    via: 'src/app/(app)/t/[slug]/admin/pricing/WeekdayToggles.tsx',
    why: 'weekday labels by ISO day number, t(String(d))',
  },
  {
    prefix: 'ui.combobox.',
    via: 'src/components/ui/combobox/messages.ts',
    why: "the vendored Combobox takes a 'ui.combobox' translator and calls t(key) by message id",
  },
  {
    prefix: 'admin.photos.errors.',
    via: 'src/app/(app)/t/[slug]/admin/photos/PhotosBoard.tsx',
    why: "one sentence per VenuePhotoError code (#366), looked up as t(code) from the server's answer",
  },
];

const BG = catalogueKeys('bg');

const usedBy = (uses: KeyUse[]) => {
  const literal = new Set(uses.flatMap((u) => (u.kind === 'literal' ? [u.key] : [])));
  const patterns = uses.flatMap((u) => (u.kind === 'pattern' ? [u.pattern] : []));
  return (key: string) =>
    literal.has(key) ||
    patterns.some((p) => p.test(key)) ||
    FAMILIES.some((f) => key.startsWith(f.prefix));
};

describe('no orphan catalogue keys', () => {
  const uses = allKeyUses();

  it('the catalogue is the size the guard expects to read', () => {
    expect(BG.length).toBeGreaterThan(300);
    expect(catalogueKeys('en')).toEqual(BG);
  });

  it('every bg key is used, or belongs to a data-driven family', () => {
    const used = usedBy(uses);
    const orphans = BG.filter((k) => !used(k));
    if (orphans.length > 0) {
      throw new Error(
        `${orphans.length} catalogue key(s) nothing asks for:\n\n  ${orphans.join('\n  ')}\n\n` +
          `Delete each from messages/bg.json AND messages/en.json. If the code builds the\n` +
          `key from data the scan cannot read, add a FAMILY here naming the file that\n` +
          `reads it.`,
      );
    }
  });

  it('every family is real: it has keys, and its file still reads it from data', () => {
    for (const f of FAMILIES) {
      expect(BG.some((k) => k.startsWith(f.prefix))).toBe(true);
      expect(f.why.length).toBeGreaterThan(20);
      const src = readFileSync(f.via, 'utf8');
      // The reader either looks the key up from data, or (the combobox, the nav
      // builder) is handed a translator and calls it with a variable.
      const dynamicHere = uses.some((u) => u.kind === 'dynamic' && u.file === f.via);
      expect(dynamicHere || /\bt\((?:key|i\.labelKey|s\.titleKey)\b/.test(src)).toBe(true);
    }
  });
});

// ── Negative control ─────────────────────────────────────────────────

describe('the rule fires on an unused key', () => {
  it('a key no lookup names is an orphan; a template or a family covers its own', () => {
    const uses: KeyUse[] = [
      { kind: 'literal', file: 'x', line: 1, key: 'a.used' },
      { kind: 'pattern', file: 'x', line: 2, source: 'a.s.${…}', pattern: /^a\.s\.[^.]+$/ },
    ];
    const used = usedBy(uses);
    expect(
      ['a.used', 'a.s.ok', 'sports.TENNIS', 'a.unused', 'a.s.deep.er'].filter((k) => !used(k)),
    ).toEqual(['a.unused', 'a.s.deep.er']);
  });
});
