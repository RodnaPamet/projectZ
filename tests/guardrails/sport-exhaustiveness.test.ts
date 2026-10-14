import { readFileSync } from 'node:fs';

import { PROFILE_SPORTS } from '@/lib/profile/limits';
import { SPORTS } from '@/lib/sports/registry';
import {
  combineNouns,
  NOUN_ORDER,
  RESOURCE_KINDS,
  RESOURCE_NOUNS,
  RESOURCE_TYPES,
  type ResourceNoun,
} from '@/lib/sports/resource-kinds';

/**
 * THE NEXT SPORT FAILS LOUDLY WHERE IT IS UNHANDLED (P51).
 *
 * Adding squash and karting touched every place a sport is listed, and the
 * ones the compiler cannot see are the ones that drift:
 *
 *   - the iOS client is GENERATED from openapi/playerz-v1.json, whose enums are
 *     hand-written. A sport missing there is one a shipped app cannot decode;
 *   - a resource type gets a noun ("корт", "игрище", "писта") in `RESOURCE_KINDS`, and
 *     every message that names a resource needs that noun's wording. A
 *     missing one does not throw: the new kind silently reads as a court.
 *
 * The rest is a compile error already — `SPORTS` is a `Record<SportType, …>`
 * and `RESOURCE_KINDS` a `Record<ResourceType, …>` — or derived from them
 * (`sportSchema`, `PROFILE_SPORTS`, the courts form, the onboarding spec);
 * sport-registry-completeness cross-walks the labels. This covers the gaps.
 *
 * ═══ HOW NOUN WORDING IS LAID OUT ═══
 *
 * A key's plain path is the court wording. The same path with a noun after
 * the namespace the component binds is that noun's wording (`admin.courts.title`
 * → `admin.courts.track.title`, `admin.courts.table.title`), and with `several`
 * the one wording for any list of two or more nouns (`admin.courts.several.title`),
 * whose slot (`{Nouns}`, `{anyNoun}`, …) `nounList` fills from each noun's forms
 * in `nouns.<noun>.*`, in the owner's order (#454, #477): кортове, игрища,
 * писти, маси, места.
 */

function prismaEnum(name: string): string[] {
  const schema = readFileSync('prisma/schema/enums.prisma', 'utf8');
  const block = schema.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`))?.[1] ?? '';
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'));
}

const spec = JSON.parse(readFileSync('openapi/playerz-v1.json', 'utf8')) as {
  components: { schemas: Record<string, { enum?: string[] }> };
};
const openapiEnum = (name: string) => spec.components.schemas[name]?.enum ?? [];

type Tree = { [k: string]: string | Tree };
function leaves(tree: Tree, prefix = ''): Array<[string, string]> {
  return Object.entries(tree).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'string' ? [[path, v] as [string, string]] : leaves(v, path);
  });
}
const catalogue = (locale: 'bg' | 'en') =>
  new Map(leaves(JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as Tree));

const BG = catalogue('bg');
const EN = catalogue('en');

/** Every noun other than the court, which is a key's plain path. */
const NOUNS = [...new Set(Object.values(RESOURCE_KINDS).map((k) => k.noun))].filter(
  (n) => n !== 'court',
);
/** The one wording of a message for a list of several nouns (#477). */
const SEVERAL = 'several';
const VARIANTS = [...NOUNS, SEVERAL];
/** The slots a `several.` wording fills its list into (noun-list.ts). */
const LIST_SLOTS = ['Nouns', 'nouns', 'AnyNoun', 'anyNoun', 'countedNouns', 'NounSlash'];
const NOUN_FORMS = ['one', 'many', 'counted'];

/** `courtPitchTrack` → `['court', 'pitch', 'track']`. */
const nounsOf = (list: string) => list.split(/(?=[A-Z])/).map((n) => n.toLowerCase());

/**
 * How each catalogue spells a noun, to find it in a sentence. Bulgarian has no
 * `\b` for Cyrillic, so the table's and the seat's words are bounded by hand:
 * "маса" must not be found in "масаж", nor "места" in a word around it.
 */
const STEMS: Record<ResourceNoun, { bg: RegExp; en: RegExp }> = {
  court: { bg: /корт/i, en: /court/i },
  pitch: { bg: /игрищ/i, en: /pitch/i },
  track: { bg: /пист/i, en: /track/i },
  table: { bg: /(?<![а-я])мас(?:а|и|ата|ите)(?![а-я])/i, en: /\btables?\b/i },
  seat: { bg: /(?<![а-я])(?:място|мястото|места|местата)(?![а-я])/i, en: /\bseats?\b/i },
};

/**
 * The namespaces that hold noun wording: every one has the track's
 * (`admin.courts.track.*`). A noun's word met anywhere else is something else:
 * `common.table.*` is the data table's own copy, not a table tennis table.
 */
function nounParents(keys: Iterable<string>): Set<string> {
  const parents = new Set<string>();
  for (const k of keys) {
    const parts = k.split('.');
    const at = parts.indexOf('track');
    if (at >= 0 && at < parts.length - 1) parents.add(parts.slice(0, at).join('.'));
  }
  return parents;
}
const PARENTS = nounParents(BG.keys());

/**
 * `a.b.track.c` → `{ variant: 'track', twin: 'a.b.c', at: 2 }`. Never the last
 * segment: `admin.pricing.preview.mixed` is a mixed PRICE, not a noun. Only
 * under a namespace that holds noun wording (`nounParents`).
 */
function variantOf(key: string, parents: ReadonlySet<string> = PARENTS) {
  const parts = key.split('.');
  const at = parts.findIndex(
    (p, i) =>
      VARIANTS.includes(p) && i < parts.length - 1 && parents.has(parts.slice(0, i).join('.')),
  );
  if (at < 0) return null;
  return {
    variant: parts[at]!,
    at,
    twin: [...parts.slice(0, at), ...parts.slice(at + 1)].join('.'),
  };
}

/** For every message with a noun variant, the keys a noun in `nouns` is missing. */
function missingNounKeys(keys: ReadonlySet<string>, nouns: readonly string[]): string[] {
  const families = new Map<string, number>();
  const parents = nounParents(keys);
  for (const k of keys) {
    const v = variantOf(k, parents);
    if (v && v.variant !== SEVERAL) families.set(v.twin, v.at);
  }
  const missing: string[] = [];
  for (const [twin, at] of families) {
    const parts = twin.split('.');
    for (const noun of nouns) {
      const key = [...parts.slice(0, at), noun, ...parts.slice(at)].join('.');
      if (!keys.has(key)) missing.push(key);
    }
  }
  return missing;
}

/**
 * What is wrong with a `several.` wording: it fills no list slot, or it names a
 * noun itself, which the list it is given may not hold.
 */
function severalWordingErrors(text: string, locale: 'bg' | 'en'): string[] {
  const errors: string[] = [];
  if (!LIST_SLOTS.some((s) => text.includes(`{${s}}`))) errors.push('fills no list slot');
  for (const noun of NOUN_ORDER) {
    if (STEMS[noun][locale].test(text)) errors.push(`names a ${noun} itself`);
  }
  return errors;
}

describe('every place a sport or a resource type is listed', () => {
  it('the parsers found what they read', () => {
    // A broken regex or path would make every comparison below vacuous.
    expect(prismaEnum('SportType')).toContain('KARTING');
    expect(prismaEnum('ResourceType')).toContain('TRACK');
    expect(openapiEnum('SportType').length).toBeGreaterThanOrEqual(18);
    expect(BG.size).toBeGreaterThan(300);
    expect(NOUNS).toContain('track');
  });

  it('Prisma ResourceType ⟷ RESOURCE_KINDS', () => {
    expect([...RESOURCE_TYPES].sort()).toEqual(prismaEnum('ResourceType').sort());
  });

  it('OpenAPI SportType ⟷ Prisma SportType', () => {
    expect([...openapiEnum('SportType')].sort()).toEqual(prismaEnum('SportType').sort());
  });

  it('OpenAPI ResourceType ⟷ Prisma ResourceType', () => {
    expect([...openapiEnum('ResourceType')].sort()).toEqual(prismaEnum('ResourceType').sort());
  });

  it('OpenAPI ProfileSport ⟷ the sports the profile offers', () => {
    // `PATCH /me` validates against PROFILE_SPORTS; a client generated from a
    // list that differs either cannot send a sport the web offers or sends one
    // the server refuses.
    expect([...openapiEnum('ProfileSport')].sort()).toEqual([...PROFILE_SPORTS].sort());
  });

  it('OpenAPI ClubStatement.courtNouns ⟷ every list of nouns (#477)', () => {
    const listed =
      (
        spec.components.schemas.ClubStatement as {
          properties?: Record<string, { enum?: string[] }>;
        }
      ).properties?.courtNouns?.enum ?? [];
    expect([...listed].sort()).toEqual([...RESOURCE_NOUNS].sort());
  });

  it("every sport's resource type has a kind", () => {
    for (const s of Object.values(SPORTS)) expect(RESOURCE_KINDS[s.resourceType]).toBeDefined();
  });
});

describe('every noun has its wording wherever a message names a resource', () => {
  // `nouns.*` holds the words themselves, not messages about resources.
  const variantKeys = [...BG.keys()].filter((k) => !k.startsWith('nouns.') && variantOf(k));

  it('found the noun wording', () => {
    expect(variantKeys.length).toBeGreaterThan(20);
    expect(NOUNS).toEqual(expect.arrayContaining(['pitch', 'track', 'table', 'seat']));
    expect(variantKeys.filter((k) => variantOf(k)!.variant === SEVERAL).length).toBeGreaterThan(5);
  });

  it('every noun has every form, in both languages, and each form is that noun', () => {
    const wrong: string[] = [];
    for (const noun of NOUN_ORDER) {
      for (const form of NOUN_FORMS) {
        for (const [locale, cat] of [
          ['bg', BG],
          ['en', EN],
        ] as const) {
          const word = cat.get(`nouns.${noun}.${form}`);
          if (!word) wrong.push(`${locale} nouns.${noun}.${form} is missing`);
          else if (!STEMS[noun][locale].test(word))
            wrong.push(`${locale} ${word} is not a ${noun}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('every list of nouns has a name, and the name holds its nouns in order', () => {
    // Every set of nouns a club can have, as `combineNouns` names it.
    const subsets = NOUN_ORDER.reduce<ResourceNoun[][]>(
      (all, n) => [...all, ...all.map((s) => [...s, n])],
      [[]],
    ).filter((s) => s.length > 0);
    const named = subsets.map((s) => combineNouns([...s].reverse()));
    expect([...named].sort()).toEqual([...RESOURCE_NOUNS].sort());
    for (const s of subsets) expect(nounsOf(combineNouns(s))).toEqual(s);
    expect(combineNouns([])).toBe('court');
  });

  it('every noun or list key mirrors a court key', () => {
    const orphans = variantKeys.filter((k) => !BG.has(variantOf(k)!.twin));
    expect(orphans).toEqual([]);
  });

  it('every court key with a noun variant has one for EVERY noun', () => {
    // A resource type that brings a new noun fails here, once per message,
    // until each has its wording.
    expect(missingNounKeys(new Set(BG.keys()), NOUNS)).toEqual([]);
  });

  it('negative control: a new noun is reported once per message that lacks it', () => {
    const keys = new Set(['ns.title', 'ns.track.title', 'ns.label', 'ns.track.label']);
    expect(missingNounKeys(keys, ['track'])).toEqual([]);
    expect(missingNounKeys(keys, ['track', 'lane'])).toEqual(['ns.lane.title', 'ns.lane.label']);
  });

  it('a message worded for several nouns has every noun alone too', () => {
    const missing = variantKeys
      .filter((k) => variantOf(k)!.variant === SEVERAL)
      .flatMap((k) => {
        const { at } = variantOf(k)!;
        const parts = k.split('.');
        return NOUNS.map((v) => [...parts.slice(0, at), v, ...parts.slice(at + 1)].join('.'));
      })
      .filter((k) => !BG.has(k));
    expect([...new Set(missing)]).toEqual([]);
  });

  it('a noun never reads as another; a list names its nouns, in order', () => {
    // Not every noun's value names it: "Активна" only agrees with "писта". So
    // the rule for one noun is the absence of the others, and a Bulgarian
    // difference from the court wording (English "Active" is the same word).
    const wrong: string[] = [];
    for (const k of variantKeys) {
      const { variant, twin } = variantOf(k)!;
      const bg = BG.get(k)!;
      const en = EN.get(k) ?? '';
      if (variant === SEVERAL) {
        for (const e of severalWordingErrors(bg, 'bg')) wrong.push(`bg ${k}: ${e}: ${bg}`);
        for (const e of severalWordingErrors(en, 'en')) wrong.push(`en ${k}: ${e}: ${en}`);
        continue;
      }
      for (const other of NOUN_ORDER.filter((n) => n !== variant)) {
        if (STEMS[other].bg.test(bg)) wrong.push(`bg ${k} names a ${other}: ${bg}`);
        if (STEMS[other].en.test(en)) wrong.push(`en ${k} names a ${other}: ${en}`);
      }
      if (bg === BG.get(twin)) wrong.push(`bg ${k} reads as the court's: ${bg}`);
    }
    // And the court wording of the same messages names no other noun.
    for (const twin of new Set(variantKeys.map((k) => variantOf(k)!.twin))) {
      for (const other of NOUNS as ResourceNoun[]) {
        if (STEMS[other].bg.test(BG.get(twin) ?? '')) wrong.push(`bg ${twin} names a ${other}`);
        if (STEMS[other].en.test(EN.get(twin) ?? '')) wrong.push(`en ${twin} names a ${other}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('negative control: a several wording with no slot, or naming a noun itself, is caught', () => {
    expect(severalWordingErrors('Добавяне на {anyNoun}', 'bg')).toEqual([]);
    expect(severalWordingErrors('Кортове и {nouns}', 'bg')).toEqual(['names a court itself']);
    expect(severalWordingErrors('Всички маси', 'bg')).toEqual([
      'fills no list slot',
      'names a table itself',
    ]);
    // The bounded stems: "масаж" is not a table, "местност" not a seat.
    expect(STEMS.table.bg.test('масаж')).toBe(false);
    expect(STEMS.seat.bg.test('местност')).toBe(false);
    expect(STEMS.seat.bg.test('Мястото е заето.')).toBe(true);
  });
});
