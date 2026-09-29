import { parseArgs } from 'node:util';

import { PrismaPg } from '@prisma/adapter-pg';
import { CourtSurface, PrismaClient, SportType } from '@prisma/client';

import { readAccountStanding } from '@/app-layer/repositories/account';
import { decideOwnerAssignment } from '@/lib/auth/account-kind';

/**
 * Create a real club, its venue and its courts. THE ONLY WRITER.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * There is no way to create a club. Not in the app, not over the API:
 * `/api/v1/platform/tenants` is GET-only and gated on TENANT_READ, and
 * `scripts/seed.ts` refuses outright to run against a database whose URL does
 * not look local — deliberately, because it plants demo clubs with a shared
 * dev password.
 *
 * So the first real club on a deployment could not be created by any means.
 * The production database had its schema, thirty applied migrations, and no
 * row a player could book.
 *
 * ═══ WHY A SCRIPT RATHER THAN A ROUTE ═══
 *
 * The same reasoning as `grant-platform-admin.ts`, and it is worth repeating
 * because the temptation to add an endpoint will return. Creating a tenant is
 * the act that brings a tenant boundary into existence, so it cannot be
 * authorised BY one. Anything in-app would therefore be gated on platform
 * authority — and a stolen platform session that can mint tenants is a much
 * larger blast radius than one that can read them.
 *
 * The cost is accepted and is the same one: onboarding a club needs somebody
 * with deploy-level database access.
 *
 * ═══ WHY IT NEEDS THE OWNER CONNECTION ═══
 *
 * After P24 the runtime role `playerz_app` owns no table and does not inherit
 * its memberships. It cannot insert a VenueOrg, and RLS has no tenant to bind
 * to before the tenant exists — which is the same reason sign-in runs as
 * superuser. `DIRECT_DATABASE_URL` is checked explicitly below rather than
 * left to fail as a permission error, because "permission denied for table
 * venue_org" does not tell you which of the two URLs was wrong.
 *
 * ═══ IT CREATES NO CREDENTIAL ═══
 *
 * Unlike the seed, the owner is created with NO passwordHash. Web sign-in is
 * Google or Microsoft only, so a password here would be an unusable secret
 * sitting in a real user row — and the seed's one is a known constant.
 *
 * The owner does not have to exist yet. They are matched by email, so the row
 * is waiting for them the first time they sign in with that address.
 *
 * ═══ THE OWNER IS A CLUB ACCOUNT, OF THIS CLUB ONLY (#263) ═══
 *
 * One account, one kind. The address must be new, belong to an account that
 * holds nothing yet, or already be this club's club account (re-running). A
 * player who plays anywhere, a coach, or another club's account is refused by
 * name — see the check below — and nothing is created.
 *
 * ═══ USAGE ═══
 *
 *   npm run create:venue-org -- \
 *     --slug sofia-tennis \
 *     --name "Sofia Tennis Club" \
 *     --city Sofia \
 *     --address "bul. Bulgaria 1" \
 *     --lat 42.6977 --lng 23.3219 \
 *     --email hello@sofiatennis.bg \
 *     --owner-email ivo@inflect.bg \
 *     --sport TENNIS --surface CLAY \
 *     --courts 4 --price 2400 \
 *     --open 08:00 --close 22:00
 *
 * Re-running with the same --slug is a no-op: the org and venue are upserted
 * and a court is skipped if one of that name already exists. Nothing is
 * overwritten, so an operator who mistypes a price cannot fix it by re-running
 * — that is a deliberate refusal to let a create script silently become an
 * edit script.
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A `@db.Time(0)` column. Prisma wants a Date; only the clock part is stored. */
function timeOfDay(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(1970, 0, 1, h!, m!, 0));
}

function die(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    city: { type: 'string' },
    address: { type: 'string' },
    lat: { type: 'string' },
    lng: { type: 'string' },
    email: { type: 'string' },
    phone: { type: 'string' },
    'owner-email': { type: 'string' },
    'owner-name': { type: 'string' },
    sport: { type: 'string' },
    surface: { type: 'string' },
    courts: { type: 'string' },
    price: { type: 'string' },
    open: { type: 'string' },
    close: { type: 'string' },
  },
});

// Nothing has a default. A default price becomes the price everybody ships
// with, and a default set of opening hours is a club that is open when the
// script's author guessed rather than when it is open.
const required = [
  'slug',
  'name',
  'city',
  'address',
  'lat',
  'lng',
  'email',
  'owner-email',
  'sport',
  'surface',
  'courts',
  'price',
  'open',
  'close',
] as const;

const missing = required.filter((k) => !values[k]);
if (missing.length > 0) {
  die(`Missing: ${missing.map((m) => `--${m}`).join(' ')}\n\nSee the usage block in this file.`);
}

const slug = values.slug!;
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
  die(`--slug must be lower-case kebab: got "${slug}". It appears in URLs.`);
}

const sport = values.sport! as SportType;
if (!Object.values(SportType).includes(sport)) {
  die(`--sport "${values.sport}" is not a SportType.\n\n  ${Object.values(SportType).join(' ')}`);
}

const surface = values.surface! as CourtSurface;
if (!Object.values(CourtSurface).includes(surface)) {
  die(
    `--surface "${values.surface}" is not a CourtSurface.\n\n  ${Object.values(CourtSurface).join(' ')}`,
  );
}

const lat = Number(values.lat);
const lng = Number(values.lng);
if (!Number.isFinite(lat) || lat < -90 || lat > 90)
  die(`--lat must be -90..90, got "${values.lat}"`);
if (!Number.isFinite(lng) || lng < -180 || lng > 180)
  die(`--lng must be -180..180, got "${values.lng}"`);

const courts = Number(values.courts);
if (!Number.isInteger(courts) || courts < 1) die(`--courts must be a positive integer`);

const price = Number(values.price);
// CENTS. `Booking.totalCents` and `Resource.basePriceCents` are integers
// throughout — there is a money-integer guardrail enforcing it — so a decimal
// here is somebody thinking in euros, and would silently become €0.24/hour.
if (!Number.isInteger(price) || price < 1) {
  die(`--price must be a whole number of CENTS per hour (2400 = €24.00), got "${values.price}"`);
}

const open = values.open!;
const close = values.close!;
if (!HHMM.test(open) || !HHMM.test(close)) die(`--open and --close must be HH:MM (24h)`);
if (timeOfDay(open) >= timeOfDay(close)) die(`--open must be before --close`);

const url = process.env.DIRECT_DATABASE_URL;
if (!url) {
  die(
    'DIRECT_DATABASE_URL is not set.\n\n' +
      'This needs the OWNER connection. The runtime role `playerz_app` owns no\n' +
      'table (P24) and there is no tenant to bind RLS to before the tenant\n' +
      'exists, so DATABASE_URL cannot do this — it would fail with "permission\n' +
      'denied for table venue_org", which does not tell you which URL was wrong.',
  );
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

async function main(): Promise<void> {
  const [{ current_user: role, rolsuper }] = await prisma.$queryRawUnsafe<
    { current_user: string; rolsuper: boolean }[]
  >(`SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)`);

  if (!rolsuper) {
    die(
      `Connected as "${role}", which is not the owner.\n\n` +
        'DIRECT_DATABASE_URL is pointing at the runtime role. Point it at the\n' +
        'role that owns the tables.',
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const org = await tx.venueOrg.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        name: values.name!,
        contactEmail: values.email!,
        contactPhone: values.phone ?? null,
        addressLine: values.address!,
        city: values.city!,
      },
      select: { id: true, name: true },
    });

    const ownerEmail = values['owner-email']!.trim().toLowerCase();

    // ═══ THE OWNER MUST BE A CLUB ACCOUNT WITH NO OTHER CLUB (#263) ═══
    //
    // One account, one kind, and a club account belongs to one club. An
    // address that already belongs to somebody who plays, or who runs another
    // club, is refused rather than quietly converted: making a player an owner
    // would end their player memberships, and the operator typing this command
    // is not the person who should decide that. Refused BEFORE anything is
    // written — the transaction rolls back, so the club is not created either.
    //
    // A brand-new address, or an account that holds nothing yet, becomes a
    // CLUB account here.
    const existing = await tx.user.findUnique({
      where: { email: ownerEmail },
      select: { id: true },
    });
    const standing = existing
      ? await readAccountStanding(tx as unknown as PrismaClient, existing.id)
      : null;
    const assignment = standing
      ? decideOwnerAssignment(standing, org.id)
      : { ok: true as const, becomes: 'CLUB' as const };

    if (!assignment.ok) {
      throw new Error(
        {
          PLAYER_ACCOUNT:
            `${ownerEmail} is a PLAYER account that already plays at a club. One account is one ` +
            'kind (#263): the club needs a separate account for its owner — use another address.',
          COACH_ACCOUNT: `${ownerEmail} is a COACH account. A club's owner needs a club account of its own — use another address.`,
          CLUB_ACCOUNT_TAKEN:
            `${ownerEmail} is the club account of another club, and a club account belongs to one ` +
            'club. Use another address for this one.',
          UNDECIDED:
            `${ownerEmail} is an account the #263 migration could not decide — it held roles at ` +
            'more than one club, or a coach role. Settle it first: npm run report:undecided-accounts',
        }[assignment.refusal],
      );
    }

    const owner = await tx.user.upsert({
      where: { email: ownerEmail },
      update: assignment.becomes ? { accountKind: assignment.becomes } : {},
      create: {
        email: ownerEmail,
        name: values['owner-name'] ?? null,
        // No passwordHash, on purpose — see the header.
        accountKind: 'CLUB',
      },
      select: { id: true },
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

    const venue = await tx.venue.upsert({
      where: { tenantId_slug: { tenantId: org.id, slug } },
      update: {},
      create: {
        tenantId: org.id,
        slug,
        name: values.name!,
        addressLine: values.address!,
        city: values.city!,
        lat,
        lng,
        email: values.email!,
        phone: values.phone ?? null,
      },
      select: { id: true },
    });

    let created = 0;
    for (let i = 1; i <= courts; i++) {
      const name = `Корт ${i}`;
      const existing = await tx.resource.findFirst({
        where: { tenantId: org.id, venueId: venue.id, name },
        select: { id: true },
      });
      if (existing) continue;

      const court = await tx.resource.create({
        data: {
          tenantId: org.id,
          venueId: venue.id,
          name,
          sport,
          surface,
          basePriceCents: price,
        },
        select: { id: true },
      });

      // Without availability rows the court is open zero hours a week and
      // `/venues/[id]/availability` returns an empty grid — a court nobody can
      // book, which looks exactly like a bug in the booking flow.
      await tx.resourceAvailability.createMany({
        data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          tenantId: org.id,
          resourceId: court.id,
          dayOfWeek,
          openTime: timeOfDay(open),
          closeTime: timeOfDay(close),
        })),
      });

      created++;
    }

    return { org, venueId: venue.id, created, ownerEmail };
  });

  console.log(`\n✓ ${result.org.name}`);
  console.log(`  tenant      ${result.org.id}  (${slug})`);
  console.log(`  venue       ${result.venueId}`);
  console.log(`  owner       ${result.ownerEmail}`);
  console.log(
    `  courts      ${result.created} created${result.created < courts ? `, ${courts - result.created} already existed` : ''}`,
  );
  console.log(`  open        ${open}–${close}, every day`);
  console.log(`  price       ${(price / 100).toFixed(2)} EUR/hour`);
  // Eyeball the pin. A swapped lat/lng is still two valid numbers, and no
  // range check can catch it — Sofia reversed is a field in Iraq.
  console.log(
    `  map         https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}\n`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
