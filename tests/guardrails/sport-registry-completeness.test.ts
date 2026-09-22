import { readFileSync } from 'node:fs';

import { sportSchema } from '@/app-layer/schemas/common';
import { SPORTS } from '@/lib/sports/registry';

/**
 * FIVE-WAY CROSS-WALK RATCHET.
 *
 * A sport exists in five places: the Prisma enum, the registry, the two
 * message catalogues, and the Zod enum that validates it on the wire. They
 * drift silently.
 *
 * Add PICKLEBALL to the enum and forget the Bulgarian label, and nothing
 * fails — a Bulgarian user just sees the raw string "PICKLEBALL" where a
 * sport name should be. Add it to the registry and forget the enum, and the
 * database rejects the write at runtime, in production, on the first person
 * who tries to book one.
 *
 * So all four must agree, and the build says so.
 */

function prismaEnumMembers(): string[] {
  const schema = readFileSync('prisma/schema/enums.prisma', 'utf8');
  const block = schema.match(/enum SportType \{([\s\S]*?)\}/)?.[1] ?? '';
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'));
}

function messageKeys(locale: 'bg' | 'en'): string[] {
  const json = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'));
  return Object.keys(json.sports ?? {});
}

describe('sport registry completeness (five-way cross-walk)', () => {
  const enumMembers = prismaEnumMembers();
  const registryKeys = Object.keys(SPORTS);

  it('the schema parser actually found the enum', () => {
    // A broken regex here would make every assertion below vacuous.
    expect(enumMembers.length).toBeGreaterThanOrEqual(14);
    expect(enumMembers).toContain('CHESS');
  });

  it('Prisma enum ⟷ registry', () => {
    expect([...registryKeys].sort()).toEqual([...enumMembers].sort());
  });

  it.each(['bg', 'en'] as const)('registry ⟷ messages/%s.json', (locale) => {
    const keys = messageKeys(locale);

    const missing = registryKeys.filter((k) => !keys.includes(k));
    const orphan = keys.filter((k) => !registryKeys.includes(k));

    if (missing.length || orphan.length) {
      throw new Error(
        `messages/${locale}.json is out of sync with the sport registry.\n` +
          (missing.length
            ? `  MISSING (a user sees the raw enum key): ${missing.join(', ')}\n`
            : '') +
          (orphan.length ? `  ORPHANED (no such sport): ${orphan.join(', ')}\n` : ''),
      );
    }

    expect(missing).toEqual([]);
    expect(orphan).toEqual([]);
  });

  it('Prisma enum ⟷ zod sportSchema', () => {
    // THE LEG THAT WAS MISSING, and it had already drifted: the wire enum
    // hand-listed seven sports while the database had sixteen. Nothing
    // failed. CHESS, PICKLEBALL, RUNNING, CYCLING, HANDBALL, FOOTBALL,
    // BEACH_TENNIS, BEACH_VOLLEYBALL and ESPORTS were stored happily by
    // Postgres, offered by the UI, and rejected as invalid input by every
    // filter that validated a sport.
    //
    // Compared against the PRISMA SCHEMA FILE rather than the registry on
    // purpose. `sportSchema` derives from the registry, so asserting the two
    // agree would be a tautology that passes no matter what breaks. Parsing
    // enums.prisma independently is what makes this a real check of the
    // whole derivation chain.
    expect([...sportSchema.options].sort()).toEqual([...enumMembers].sort());
  });

  it('the zod enum is DERIVED, not a hand-written copy', () => {
    // The cross-walk above only proves the two agree TODAY. Someone can
    // satisfy it by pasting the sixteen names into the literal array — which
    // passes, and is silently wrong again at the next migration.
    //
    // So this pins the mechanism, not just the outcome.
    const src = readFileSync('src/app-layer/schemas/common.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const handListed = [...src.matchAll(/'([A-Z][A-Z_0-9]{2,})'/g)].map((m) => m[1]!);
    const sportNames = handListed.filter((n) => (SPORTS as Record<string, unknown>)[n]);

    if (sportNames.length > 0) {
      throw new Error(
        `src/app-layer/schemas/common.ts names sports as string literals: ` +
          `${sportNames.join(', ')}.\n\n` +
          `Derive the enum from the registry instead:\n` +
          `  z.enum(Object.keys(SPORTS) as [SportType, ...SportType[]])\n\n` +
          `A hand-written copy is correct on the day it is written and ` +
          `silently wrong from the next migration onward — it has no way to ` +
          `fail loudly, which is how this drifted to 7 of 16 in the first place.`,
      );
    }
  });

  it('no message label is just the enum key echoed back', () => {
    // The laziest way to "fix" this ratchet is to paste the key in as the
    // label. That passes the cross-walk and still shows PICKLEBALL to a
    // Bulgarian user.
    const bg = JSON.parse(readFileSync('messages/bg.json', 'utf8')).sports;
    for (const [key, label] of Object.entries(bg as Record<string, string>)) {
      expect(label).not.toBe(key);
    }
  });
});
