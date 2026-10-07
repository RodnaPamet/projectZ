import { readFileSync } from 'node:fs';

import { PROFILE_SPORTS } from '@/lib/profile/limits';
import { SPORTS } from '@/lib/sports/registry';
import { RESOURCE_KINDS, RESOURCE_TYPES } from '@/lib/sports/resource-kinds';

/**
 * THE NEXT SPORT FAILS LOUDLY WHERE IT IS UNHANDLED (P51).
 *
 * Adding squash and karting touched every place a sport is listed, and the
 * ones the compiler cannot see are the ones that drift:
 *
 *   - the iOS client is GENERATED from openapi/playerz-v1.json, whose enums are
 *     hand-written. A sport missing there is one a shipped app cannot decode;
 *   - a resource type gets a noun ("корт", "писта") in `RESOURCE_KINDS`, and
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
 * A key's plain path is the court wording. The same path with `track.` after
 * the namespace the component binds is the track wording, and with `mixed.`
 * the wording for a list holding both (`admin.courts.title` →
 * `admin.courts.track.title`, `admin.courts.mixed.title`).
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
const VARIANTS = [...NOUNS, 'mixed'];

/**
 * `a.b.track.c` → `{ variant: 'track', twin: 'a.b.c', at: 2 }`. Never the last
 * segment: `admin.pricing.preview.mixed` is a mixed PRICE, not a noun.
 */
function variantOf(key: string) {
  const parts = key.split('.');
  const at = parts.findIndex((p, i) => VARIANTS.includes(p) && i < parts.length - 1);
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
  for (const k of keys) {
    const v = variantOf(k);
    if (v && v.variant !== 'mixed') families.set(v.twin, v.at);
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

  it("every sport's resource type has a kind", () => {
    for (const s of Object.values(SPORTS)) expect(RESOURCE_KINDS[s.resourceType]).toBeDefined();
  });
});

describe('every noun has its wording wherever a message names a resource', () => {
  const variantKeys = [...BG.keys()].filter((k) => variantOf(k));

  it('found the noun wording', () => {
    expect(variantKeys.length).toBeGreaterThan(20);
  });

  it('every track or mixed key mirrors a court key', () => {
    const orphans = variantKeys.filter((k) => !BG.has(variantOf(k)!.twin));
    expect(orphans).toEqual([]);
  });

  it('every court key with a noun variant has one for EVERY noun', () => {
    // Today the nouns are court and track. A resource type that brings a new
    // noun fails here, once per message, until each has its wording.
    expect(missingNounKeys(new Set(BG.keys()), NOUNS)).toEqual([]);
  });

  it('negative control: a new noun is reported once per message that lacks it', () => {
    const keys = new Set(['ns.title', 'ns.track.title', 'ns.label', 'ns.track.label']);
    expect(missingNounKeys(keys, ['track'])).toEqual([]);
    expect(missingNounKeys(keys, ['track', 'lane'])).toEqual(['ns.lane.title', 'ns.lane.label']);
  });

  it('a list holding both nouns has wording for a list of one, too', () => {
    const missing = variantKeys
      .filter((k) => variantOf(k)!.variant === 'mixed')
      .flatMap((k) => {
        const { at } = variantOf(k)!;
        const parts = k.split('.');
        return NOUNS.map((noun) => [...parts.slice(0, at), noun, ...parts.slice(at + 1)].join('.'));
      })
      .filter((k) => !BG.has(k));
    expect(missing).toEqual([]);
  });

  it('a track never reads "корт"; a list of both names both', () => {
    // Not every track value names the noun: "Активна" only agrees with it. So
    // the rule is the absence of the court, and a Bulgarian difference from
    // the court wording (English "Active" is the same word for both).
    const wrong: string[] = [];
    for (const k of variantKeys) {
      const { variant, twin } = variantOf(k)!;
      const bg = BG.get(k)!;
      const en = EN.get(k) ?? '';
      if (variant !== 'mixed') {
        if (/корт/i.test(bg) || bg === BG.get(twin)) wrong.push(`bg ${k}: ${bg}`);
        if (/court/i.test(en)) wrong.push(`en ${k}: ${en}`);
      } else if (!(/корт/i.test(bg) && /пист/i.test(bg))) {
        wrong.push(`bg ${k}: ${bg}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
