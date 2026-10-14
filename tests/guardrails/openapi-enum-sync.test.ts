import { globSync, readFileSync } from 'node:fs';

/**
 * AN ENUM THE API SPEC LISTS IS THE DATABASE'S, VALUE FOR VALUE (#550).
 *
 * The spec's `Notification.kind` fell sixteen values behind the database
 * between #376 and #550: open play, the coach's profile, lessons. A client
 * generated from it calls those rows unknown, and a reader of the spec never
 * learns they exist. Nothing failed, which is how it fell behind.
 *
 * So each schema property below must list exactly the values of its Prisma
 * enum, in the same order. A new value lands in both, in the same change.
 */
const PAIRS: Array<{ schema: string; property: string; prismaEnum: string }> = [
  { schema: 'Notification', property: 'kind', prismaEnum: 'NotificationKind' },
];

function prismaEnum(name: string): string[] {
  const source = globSync('prisma/schema/*.prisma')
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const body = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(source)?.[1];
  if (!body) throw new Error(`No enum ${name} in prisma/schema`);
  return body
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l));
}

const spec = JSON.parse(readFileSync('openapi/playerz-v1.json', 'utf8')) as {
  components: {
    schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }>;
  };
};

describe('the API spec lists enums as the database has them', () => {
  it.each(PAIRS)('$schema.$property is $prismaEnum', ({ schema, property, prismaEnum: e }) => {
    const listed = spec.components.schemas[schema]?.properties?.[property]?.enum;
    expect(listed).toEqual(prismaEnum(e));
  });

  it('reads an enum, comments and all', () => {
    expect(prismaEnum('NotificationKind')).toContain('LESSON_BOOKED');
    expect(prismaEnum('NotificationKind')).not.toContain('///');
  });
});
