import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

/**
 * Development seed.
 *
 * Runs as app_superuser: it creates tenants, and there is no tenant context
 * to bind to before they exist.
 *
 * Idempotent — `upsert` on the natural keys, so re-running does not
 * duplicate. Courts land in P05, once the schema has them.
 */

/**
 * DIRECT_DATABASE_URL first, exactly as prisma.config.ts prefers it.
 *
 * Seeding WRITES tables, so it is an owner operation like a migration, not a
 * runtime one. Once `DATABASE_URL` names `playerz_app` — a role that owns no
 * table and does not inherit its memberships, which is the whole point of P24 —
 * reading `DATABASE_URL` here would make the seed fail with "permission denied
 * for table …", and the fix somebody reaches for under time pressure is to
 * point runtime back at the owner.
 *
 * The fallback keeps local dev working unchanged, where both URLs are the owner.
 */
const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error('Neither DIRECT_DATABASE_URL nor DATABASE_URL is set — refusing to seed.');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

// Dev-only credential. Never used outside a local stack, and the seed
// refuses to run against a database whose URL does not look local.
const DEV_PASSWORD = 'Passw0rd!'; // pragma: allowlist secret

const VENUES = [
  {
    slug: 'sofia-padel-club',
    name: 'Sofia Padel Club',
    city: 'Sofia',
    lat: 42.6977,
    lng: 23.3219,
    contactEmail: 'hello@sofia-padel.bg',
    owner: { email: 'owner@sofia.bg', name: 'Ivan Petrov' },
    sport: 'PADEL',
    surface: 'ARTIFICIAL_GRASS',
    courtCount: 4,
    basePriceCents: 2400,
  },
  {
    slug: 'plovdiv-tennis-center',
    name: 'Plovdiv Tennis Center',
    city: 'Plovdiv',
    lat: 42.1354,
    lng: 24.7453,
    contactEmail: 'hello@plovdiv-tennis.bg',
    owner: { email: 'owner@plovdiv.bg', name: 'Maria Dimitrova' },
    sport: 'TENNIS',
    surface: 'CLAY',
    courtCount: 6,
    basePriceCents: 3000,
  },
] as const;

/** 09:00–22:00, Monday to Sunday. */
const OPEN_HOUR = 9;
const CLOSE_HOUR = 22;

/** Postgres `time` columns — only the clock part is stored. */
function timeOfDay(hour: number): Date {
  return new Date(Date.UTC(1970, 0, 1, hour, 0, 0));
}

async function main() {
  if (!/localhost|127\.0\.0\.1|postgres-test|@postgres/.test(url!)) {
    throw new Error(
      `Refusing to seed a non-local database.\n  ${url!.replace(/:[^:@]*@/, ':***@')}`,
    );
  }

  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);

    for (const v of VENUES) {
      const org = await tx.venueOrg.upsert({
        where: { slug: v.slug },
        update: {},
        create: {
          slug: v.slug,
          name: v.name,
          city: v.city,
          country: 'BG',
          contactEmail: v.contactEmail,
          timezone: 'Europe/Sofia',
          currency: 'EUR',
        },
      });

      // A CLUB account (#263): one club, and it does not play. The player
      // profile these owners used to carry belongs to the demo PLAYER below —
      // one account, one kind, and the seed is the first place a developer
      // copies the shape of the data from.
      //
      // `update` sets the kind too, so re-seeding a database seeded before the
      // kinds existed leaves it conforming rather than depending on the
      // migration having run first.
      const owner = await tx.user.upsert({
        where: { email: v.owner.email },
        update: { accountKind: 'CLUB' },
        create: {
          email: v.owner.email,
          name: v.owner.name,
          passwordHash,
          emailVerified: new Date(),
          accountKind: 'CLUB',
        },
      });

      await tx.tenantMembership.upsert({
        where: { userId_tenantId: { userId: owner.id, tenantId: org.id } },
        update: { role: 'OWNER', status: 'ACTIVE' },
        create: {
          userId: owner.id,
          tenantId: org.id,
          role: 'OWNER',
          status: 'ACTIVE',
          acceptedAt: new Date(),
        },
      });

      // ── Venue + courts + availability + one pricing rule ──────────
      const venue = await tx.venue.upsert({
        where: { tenantId_slug: { tenantId: org.id, slug: v.slug } },
        update: {},
        create: {
          tenantId: org.id,
          slug: v.slug,
          name: v.name,
          addressLine: `${v.city} Center 1`,
          city: v.city,
          country: 'BG',
          lat: v.lat,
          lng: v.lng,
          email: v.contactEmail,
        },
      });

      for (let i = 1; i <= v.courtCount; i++) {
        const existing = await tx.resource.findFirst({
          where: { tenantId: org.id, venueId: venue.id, name: `Court ${i}` },
        });
        if (existing) continue;

        const court = await tx.resource.create({
          data: {
            tenantId: org.id,
            venueId: venue.id,
            name: `Court ${i}`,
            sport: v.sport,
            surface: v.surface,
            isIndoor: i % 2 === 0,
            basePriceCents: v.basePriceCents,
          },
        });

        // Open every day, 09:00–22:00.
        await tx.resourceAvailability.createMany({
          data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
            tenantId: org.id,
            resourceId: court.id,
            dayOfWeek,
            openTime: timeOfDay(OPEN_HOUR),
            closeTime: timeOfDay(CLOSE_HOUR),
          })),
        });

        // Weekend evenings cost 50% more — the rule the pricing engine in
        // P08 is built to resolve.
        await tx.pricingRule.create({
          data: {
            tenantId: org.id,
            resourceId: court.id,
            name: 'Weekend peak',
            priority: 200,
            conditionsJson: { dayOfWeek: [0, 6], timeRange: { from: '18:00', to: '22:00' } },
            multiplier: 1.5,
          },
        });
      }

      console.log(
        `  ✓ ${v.name} — owner ${v.owner.email}, ${v.courtCount} ${v.sport.toLowerCase()} courts`,
      );
    }

    // A player (#263): the account that books. No membership yet — booking a
    // court is how a player joins a club (#229) — and the player profile the
    // owners used to carry, because a rating belongs to somebody who plays.
    await tx.user.upsert({
      where: { email: 'player@playerz.bg' },
      update: {},
      create: {
        email: 'player@playerz.bg',
        name: 'Georgi Ivanov',
        passwordHash,
        emailVerified: new Date(),
        accountKind: 'PLAYER',
        profile: { create: { displayName: 'Georgi Ivanov', sports: ['PADEL', 'TENNIS'] } },
      },
    });
    console.log('  ✓ player@playerz.bg (player)');

    // Platform admin. Global identity, no membership — access comes from
    // appPermissions, not from belonging to a tenant. A PLAYER account by kind,
    // because it holds nothing: platform authority is a grant, not a kind.
    await tx.user.upsert({
      where: { email: 'admin@playerz.bg' },
      update: {},
      create: {
        email: 'admin@playerz.bg',
        name: 'Platform Admin',
        passwordHash,
        emailVerified: new Date(),
        accountKind: 'PLAYER',
      },
    });
    console.log('  ✓ admin@playerz.bg (platform)');
  });

  // Passwords are for test runs only (#361): a server answers them only with
  // TEST_PASSWORD_SIGN_IN=1 and DEPLOY_ENV=test (src/lib/auth/password-sign-in.ts).
  console.log(
    `\nSeeded. Password for every account: ${DEV_PASSWORD}` +
      `\n(Password sign-in needs TEST_PASSWORD_SIGN_IN=1 and DEPLOY_ENV=test on the server.)`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
