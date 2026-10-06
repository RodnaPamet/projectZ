import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { AccountKind, PrismaClient, Role } from '@prisma/client';
import { NextRequest } from 'next/server';

import { changeRoleAction, setSuspendedAction } from '@/app/(app)/t/[slug]/admin/staff/actions';
import { acceptInviteAction } from '@/app/(public)/invite/[token]/actions';
import { POST as createBooking } from '@/app/api/v1/t/[slug]/bookings/route';
import { createInvite, inviteAcceptanceFor, previewInvite } from '@/app-layer/usecases/invites';
import { accountKindViolation } from '@/lib/db/pg-errors';
import { runAsSuperuser, runInTenantContext } from '@/lib/db/rls-middleware';
import { middleware } from '@/middleware';

import bg from '../../messages/bg.json';
import en from '../../messages/en.json';
import { signInAs } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * ONE ACCOUNT, ONE KIND (#263) — EVERY PLACE IT IS ENFORCED.
 *
 * The owner: "it's either or - player or club owner/manager/staff - using both
 * requires two separate accounts … club accounts only relate to one club".
 * Enforced everywhere, which here means two layers:
 *
 *   the application   refuses with a message somebody can act on
 *   the database      refuses without one, for every writer the application
 *                     does not know about (`account_kind_membership_trg`)
 *
 * Both are driven for real: the trigger by writing rows past the application,
 * the application through its actual entry points — the booking route behind
 * the middleware, the invite and staff Server Actions with a real session
 * cookie, and `create-venue-org` spawned as the command line it is.
 */

// The request's cookie jar for the Server Actions, as `next/headers` would
// hand it over — the encrypted JWT next-auth sets, under both names.
let sessionCookie: string | null = null;

jest.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () =>
      sessionCookie
        ? [
            { name: 'next-auth.session-token', value: sessionCookie },
            { name: '__Secure-next-auth.session-token', value: sessionCookie },
          ]
        : [],
  }),
  headers: async () => new Headers(),
}));

// `revalidatePath` needs a Next request store the actions do not have here.
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));

const db = prismaTestClient();

async function account(
  kind: AccountKind | null,
  opts: { locale?: 'bg' | 'en' } = {},
): Promise<{ id: string; email: string }> {
  const email = `${String(kind).toLowerCase()}-${randomUUID().slice(0, 8)}@playerz.test`;
  const u = await asAppSuperuser(db, (tx) =>
    tx.user.create({
      data: { email, accountKind: kind, locale: opts.locale ?? 'bg' },
      select: { id: true },
    }),
  );
  return { id: u.id, email };
}

const hold = (
  userId: string,
  tenantId: string,
  role: Role,
  status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
  handle: PrismaClient = db,
) =>
  asAppSuperuser(handle, (tx) =>
    tx.tenantMembership.create({
      data: { userId, tenantId, role, status },
      select: { id: true },
    }),
  );

const kindOf = async (userId: string) =>
  (
    await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId }, select: { accountKind: true } }),
    )
  ).accountKind;

const membershipsOf = (userId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.tenantMembership.findMany({
      where: { userId },
      select: { tenantId: true, role: true, status: true },
    }),
  );

async function signIn(userId: string) {
  sessionCookie = (await signInAs(db, { userId, memberships: [] })).bearer;
}

beforeEach(() => {
  sessionCookie = null;
});

// ══ The database guarantee ═══════════════════════════════════════════

describe('the database refuses a membership the account kind does not allow', () => {
  let a: SeededTenant;
  let b: SeededTenant;

  beforeEach(async () => {
    a = await seedTenant({ name: 'Club A' });
    b = await seedTenant({ name: 'Club B' });
  });

  it('a PLAYER account may not hold a club role', async () => {
    const player = await account('PLAYER');

    const refused = hold(player.id, a.tenantId, 'STAFF');

    await expect(refused).rejects.toThrow(/account_kind_player_roles/);
    await expect(refused.catch(accountKindViolation)).resolves.toBe('player_roles');
    expect(await membershipsOf(player.id)).toEqual([]);
  });

  it('a CLUB account may not play', async () => {
    const club = await account('CLUB');
    await expect(hold(club.id, a.tenantId, 'PLAYER')).rejects.toThrow(/account_kind_club_roles/);
  });

  it('a CLUB account belongs to ONE club', async () => {
    const club = await account('CLUB');
    await hold(club.id, a.tenantId, 'OWNER');

    const refused = hold(club.id, b.tenantId, 'STAFF');

    await expect(refused).rejects.toThrow(/account_kind_one_club/);
    await expect(refused.catch(accountKindViolation)).resolves.toBe('one_club');
  });

  it('…and that holds from inside ANOTHER club’s transaction, where the first is invisible', async () => {
    // Bound to club B, row security hides club A's rows from the writer. The
    // trigger runs as the table owner — SECURITY DEFINER — so it still sees
    // that this club account already runs A. Without it, this passes.
    const club = await account('CLUB');
    await hold(club.id, a.tenantId, 'OWNER');

    const fromB = runInTenantContext(b.tenantId, (tx) =>
      tx.tenantMembership.create({
        data: { userId: club.id, tenantId: b.tenantId, role: 'MANAGER', status: 'ACTIVE' },
      }),
    );

    await expect(fromB).rejects.toThrow(/account_kind_one_club/);
  });

  it('a COACH account holds COACH roles only — at as many clubs as it likes', async () => {
    const coach = await account('COACH');
    await hold(coach.id, a.tenantId, 'COACH');
    await hold(coach.id, b.tenantId, 'COACH');

    const c = await seedTenant({ name: 'Club C' });
    await expect(hold(coach.id, c.tenantId, 'PLAYER')).rejects.toThrow(/account_kind_coach_roles/);
  });

  it('a row that is not ACTIVE is history, and is not held to anything', async () => {
    const player = await account('PLAYER');
    await expect(hold(player.id, a.tenantId, 'STAFF', 'SUSPENDED')).resolves.toBeDefined();

    // …until somebody reinstates it.
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.tenantMembership.updateMany({
          where: { userId: player.id, tenantId: a.tenantId },
          data: { status: 'ACTIVE' },
        }),
      ),
    ).rejects.toThrow(/account_kind_player_roles/);
  });

  it('an account the migration left UNDECIDED is left alone — a person decides it', async () => {
    const undecided = await account(null);
    await hold(undecided.id, a.tenantId, 'OWNER');
    await hold(undecided.id, b.tenantId, 'STAFF');

    expect(await membershipsOf(undecided.id)).toHaveLength(2);
  });

  it('what an account IS may not change under what it holds', async () => {
    // Relabelling a club account a player while it still runs its club.
    const refused = asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: a.userId }, data: { accountKind: 'PLAYER' } }),
    );

    await expect(refused).rejects.toThrow(/account_kind_player_roles/);
    expect(await kindOf(a.userId)).toBe('CLUB');
  });

  it('two clubs added to one club account AT ONCE: exactly one commits', async () => {
    // The race a count-then-insert loses: each transaction counts one club and
    // both commit. The trigger locks the account's row first, so the second
    // waits for the first, then counts two.
    const club = await account('CLUB');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let firstWrote!: () => void;
    const wrote = new Promise<void>((r) => (firstWrote = r));

    const first = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE app_superuser');
        await tx.tenantMembership.create({
          data: { userId: club.id, tenantId: a.tenantId, role: 'STAFF', status: 'ACTIVE' },
        });
        firstWrote();
        await held;
      },
      { timeout: 20_000 },
    );

    await wrote;
    const second = hold(club.id, b.tenantId, 'STAFF');
    // Give the second a moment to reach the lock, then let the first commit.
    await new Promise((r) => setTimeout(r, 300));
    release();

    const [one, two] = await Promise.allSettled([first, second]);
    expect(one.status).toBe('fulfilled');
    expect(two.status).toBe('rejected');
    expect(String((two as PromiseRejectedResult).reason)).toMatch(/account_kind_one_club/);
    expect((await membershipsOf(club.id)).filter((m) => m.status === 'ACTIVE')).toHaveLength(1);
  });
});

// ══ Join-on-booking, through the middleware ══════════════════════════

describe('booking a court needs a PLAYER account', () => {
  let club: SeededTenant;
  let courtId: string;

  beforeEach(async () => {
    club = await seedTenant({ name: 'Booking Club' });
    courtId = await asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: club.tenantId,
          slug: `kind-${randomUUID().slice(0, 8)}`,
          name: 'Kind Club',
          addressLine: '1 St',
          city: 'Sofia',
          email: 'k@club.test',
          lat: 42.69,
          lng: 23.32,
          timezone: 'Europe/Sofia',
        },
      });
      const resource = await tx.resource.create({
        data: {
          tenantId: club.tenantId,
          venueId: venue.id,
          name: 'Court 1',
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 2400,
          minBookingMinutes: 60,
          maxBookingMinutes: 120,
          slotStepMinutes: 60,
        },
      });
      await tx.resourceAvailability.create({
        data: {
          tenantId: club.tenantId,
          resourceId: resource.id,
          dayOfWeek: 3,
          openTime: new Date('1970-01-01T09:00:00Z'),
          closeTime: new Date('1970-01-01T17:00:00Z'),
        },
      });
      return resource.id;
    });
  });

  /** The middleware, then the route — as Next serves it. */
  async function book(userId: string, slug: string) {
    const { bearer } = await signInAs(db, { userId, memberships: [] });
    const init = () => ({
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': `k-${randomUUID()}`,
      },
      body: JSON.stringify({
        resourceId: courtId,
        startTs: '2036-07-16T06:00:00Z',
        endTs: '2036-07-16T07:00:00Z',
      }),
    });
    const url = `http://localhost:3000/api/v1/t/${slug}/bookings`;

    const edge = await middleware(new NextRequest(url, init()));
    expect(edge.headers.get('x-middleware-next')).toBe('1');

    const res = await createBooking(new NextRequest(url, init()), {
      params: Promise.resolve({ slug }),
    });
    return {
      status: res.status,
      body: (await res.json()) as { error?: { code: string; message: string } },
    };
  }

  it('a PLAYER account books, and joins the club by doing so', async () => {
    const player = await account('PLAYER');

    const { status } = await book(player.id, club.tenantSlug);

    expect(status).toBe(201);
    expect(await membershipsOf(player.id)).toEqual([
      { tenantId: club.tenantId, role: 'PLAYER', status: 'ACTIVE' },
    ]);
  });

  it('a CLUB account is refused — in its own language — and joins nothing', async () => {
    const other = await seedTenant({ name: 'Other' });
    const clubAccount = other.userId; // OWNER of Other, a CLUB account

    const { status, body } = await book(clubAccount, club.tenantSlug);

    expect(status).toBe(403);
    expect(body.error?.code).toBe('PLAYER_ACCOUNT_REQUIRED');
    // Bulgarian by default: `User.locale` is `bg` unless somebody chose.
    expect(body.error?.message).toBe(bg.accountKind.booking.playerAccountRequired);
    expect(await membershipsOf(clubAccount)).toEqual([
      { tenantId: other.tenantId, role: 'OWNER', status: 'ACTIVE' },
    ]);
  });

  it('…in English for somebody who chose English', async () => {
    const clubAccount = await account('CLUB', { locale: 'en' });

    const { body } = await book(clubAccount.id, club.tenantSlug);

    expect(body.error?.message).toBe(en.accountKind.booking.playerAccountRequired);
  });

  it('…at its OWN club too, where it would not even have to join', async () => {
    const { status, body } = await book(club.userId, club.tenantSlug);

    expect(status).toBe(403);
    expect(body.error?.code).toBe('PLAYER_ACCOUNT_REQUIRED');
  });

  it('…and with the SAME answer at a club that does not exist — it is about the caller', async () => {
    const clubAccount = await account('CLUB');

    const real = await book(clubAccount.id, club.tenantSlug);
    const invented = await book(clubAccount.id, 'no-such-club-anywhere');

    expect(invented.status).toBe(real.status);
    expect(invented.body.error?.code).toBe(real.body.error?.code);
    expect(invented.body.error?.message).toBe(real.body.error?.message);
  });

  it.each([
    ['a COACH account', 'COACH'],
    ['an account the migration left undecided', null],
  ] as const)('%s is refused too', async (_label, kind) => {
    const who = await account(kind);

    const { status, body } = await book(who.id, club.tenantSlug);

    expect(status).toBe(403);
    expect(body.error?.code).toBe('PLAYER_ACCOUNT_REQUIRED');
    expect(await membershipsOf(who.id)).toEqual([]);
  });
});

// ══ Invites ═════════════════════════════════════════════════════════

describe('an invitation is accepted only by an account of the right kind', () => {
  let club: SeededTenant;

  beforeEach(async () => {
    club = await seedTenant({ name: 'Inviting Club' });
  });

  const invite = async (email: string, role: Role) =>
    (
      await runInTenantContext(club.tenantId, (c) =>
        createInvite(c, club.tenantId, club.userId, { email, role }),
      )
    ).token;

  /** Accepted as a person would: signed in, through the Server Action. */
  async function acceptAs(userId: string, token: string): Promise<string> {
    await signIn(userId);
    try {
      const result = await acceptInviteAction(token);
      return result.error;
    } catch (err) {
      // Success redirects, which Next implements by throwing.
      if (String((err as { digest?: unknown }).digest).startsWith('NEXT_REDIRECT')) {
        return 'ACCEPTED';
      }
      throw err;
    }
  }

  const stillOpen = async (token: string) =>
    (await runAsSuperuser((c) => previewInvite(c, token))) !== null;

  it('THE POINT: a brand-new account accepts a staff invite, and becomes a CLUB account', async () => {
    const fresh = await account('PLAYER');
    const token = await invite(fresh.email, 'STAFF');

    expect(await acceptAs(fresh.id, token)).toBe('ACCEPTED');
    expect(await kindOf(fresh.id)).toBe('CLUB');
    expect(await membershipsOf(fresh.id)).toEqual([
      { tenantId: club.tenantId, role: 'STAFF', status: 'ACTIVE' },
    ]);
  });

  it('a club account with no club yet accepts it as it is', async () => {
    const empty = await account('CLUB');
    const token = await invite(empty.email, 'MANAGER');

    expect(await acceptAs(empty.id, token)).toBe('ACCEPTED');
    expect(await kindOf(empty.id)).toBe('CLUB');
  });

  it('a player who plays anywhere is told to use a SEPARATE account — and nothing changes', async () => {
    const elsewhere = await seedTenant({ name: 'Elsewhere' });
    const player = await account('PLAYER');
    await hold(player.id, elsewhere.tenantId, 'PLAYER');
    const token = await invite(player.email, 'STAFF');

    expect(await acceptAs(player.id, token)).toBe('SEPARATE_ACCOUNT_REQUIRED');

    expect(await kindOf(player.id)).toBe('PLAYER');
    expect(await membershipsOf(player.id)).toEqual([
      { tenantId: elsewhere.tenantId, role: 'PLAYER', status: 'ACTIVE' },
    ]);
    // Not spent: the right account can still use it.
    expect(await stillOpen(token)).toBe(true);
  });

  it('another club’s account is told it already belongs to a club', async () => {
    const other = await seedTenant({ name: 'Other' });
    const token = await invite(other.ownerEmail, 'STAFF');

    expect(await acceptAs(other.userId, token)).toBe('CLUB_ACCOUNT_TAKEN');
  });

  it('a club account is refused a PLAYER invitation — accept it with your player account', async () => {
    const other = await seedTenant({ name: 'Other' });
    const token = await invite(other.ownerEmail, 'PLAYER');

    expect(await acceptAs(other.userId, token)).toBe('PLAYER_ACCOUNT_REQUIRED');
  });

  it('a COACH invitation converts nobody: that is the coach flow, which does not exist yet', async () => {
    const fresh = await account('PLAYER');
    const token = await invite(fresh.email, 'COACH');

    expect(await acceptAs(fresh.id, token)).toBe('COACH_ACCOUNT_REQUIRED');
    expect(await kindOf(fresh.id)).toBe('PLAYER');
  });

  it('an undecided account that holds something accepts nothing until a person decides it', async () => {
    const undecided = await account(null);
    const academy = await seedTenant({ name: 'Academy' });
    await hold(undecided.id, academy.tenantId, 'COACH');
    const token = await invite(undecided.email, 'STAFF');

    expect(await acceptAs(undecided.id, token)).toBe('ACCOUNT_KIND_UNDECIDED');
  });

  it('a brand-new account that has not chosen yet (#360) becomes a CLUB account by a staff invite', async () => {
    const fresh = await account(null);
    const token = await invite(fresh.email, 'STAFF');

    expect(await acceptAs(fresh.id, token)).toBe('ACCEPTED');
    expect(await kindOf(fresh.id)).toBe('CLUB');
  });

  it('the page asks the same question BEFORE offering the button', async () => {
    const elsewhere = await seedTenant({ name: 'Elsewhere' });
    const player = await account('PLAYER');
    await hold(player.id, elsewhere.tenantId, 'PLAYER');
    const token = await invite(player.email, 'STAFF');
    const preview = (await runAsSuperuser((c) => previewInvite(c, token)))!;

    await expect(
      runAsSuperuser((c) => inviteAcceptanceFor(c, preview, player.id)),
    ).resolves.toEqual({ ok: false, refusal: 'SEPARATE_ACCOUNT_REQUIRED' });
  });

  it('two staff invites at two clubs, accepted at once by one new account: it joins ONE', async () => {
    // Both see a brand-new account. The database decides which commits first;
    // the other is told the account now belongs to a club.
    const second = await seedTenant({ name: 'Second' });
    const fresh = await account('PLAYER');
    const one = await invite(fresh.email, 'STAFF');
    const two = (
      await runInTenantContext(second.tenantId, (c) =>
        createInvite(c, second.tenantId, second.userId, { email: fresh.email, role: 'STAFF' }),
      )
    ).token;
    await signIn(fresh.id);

    const outcomes = await Promise.all(
      [one, two].map((token) =>
        acceptInviteAction(token)
          .then((r) => r.error)
          .catch((err: unknown) =>
            String((err as { digest?: unknown }).digest).startsWith('NEXT_REDIRECT')
              ? 'ACCEPTED'
              : Promise.reject(err),
          ),
      ),
    );

    expect(outcomes.sort()).toEqual(['ACCEPTED', 'CLUB_ACCOUNT_TAKEN']);
    expect((await membershipsOf(fresh.id)).filter((m) => m.status === 'ACTIVE')).toHaveLength(1);
  });
});

// ══ The staff screen ════════════════════════════════════════════════

describe('the staff screen says why, instead of failing', () => {
  it('turning a player into staff is refused as ACCOUNT_KIND', async () => {
    const club = await seedTenant({ name: 'Staffing' });
    const player = await account('PLAYER');
    const { id } = await hold(player.id, club.tenantId, 'PLAYER');
    await signIn(club.userId);

    const form = new FormData();
    form.set('role', 'STAFF');

    await expect(changeRoleAction(club.tenantSlug, id, null, form)).resolves.toEqual({
      ok: false,
      error: 'ACCOUNT_KIND',
    });
    expect(bg.admin.staff.error.ACCOUNT_KIND).toBeTruthy();
  });

  it('reinstating a club account that now works elsewhere is ACCOUNT_IN_ANOTHER_CLUB', async () => {
    const club = await seedTenant({ name: 'Former' });
    const now = await seedTenant({ name: 'Current' });
    const staff = await account('CLUB');
    const { id } = await hold(staff.id, club.tenantId, 'STAFF', 'SUSPENDED');
    await hold(staff.id, now.tenantId, 'STAFF');
    await signIn(club.userId);

    await expect(setSuspendedAction(club.tenantSlug, id, false)).resolves.toEqual({
      ok: false,
      error: 'ACCOUNT_IN_ANOTHER_CLUB',
    });
    expect(bg.admin.staff.error.ACCOUNT_IN_ANOTHER_CLUB).toBeTruthy();
  });

  it('reinstating the old club role of an account that now plays is ACCOUNT_KIND', async () => {
    // The shape the migration leaves behind on purpose: a SUSPENDED club role
    // is history, so an account that also played stayed a PLAYER. The club
    // still lists that suspended row, and reinstating it would mix the kinds.
    // The database refuses; the screen has to say why rather than fail.
    const club = await seedTenant({ name: 'Old staff' });
    const elsewhere = await seedTenant({ name: 'Plays here' });
    const player = await account('PLAYER');
    const { id } = await hold(player.id, club.tenantId, 'STAFF', 'SUSPENDED');
    await hold(player.id, elsewhere.tenantId, 'PLAYER');
    await signIn(club.userId);

    await expect(setSuspendedAction(club.tenantSlug, id, false)).resolves.toEqual({
      ok: false,
      error: 'ACCOUNT_KIND',
    });
    expect(await membershipsOf(player.id)).toEqual(
      expect.arrayContaining([
        { tenantId: club.tenantId, role: 'STAFF', status: 'SUSPENDED' },
        { tenantId: elsewhere.tenantId, role: 'PLAYER', status: 'ACTIVE' },
      ]),
    );
    expect(await kindOf(player.id)).toBe('PLAYER');
  });
});

// ══ create-venue-org, as the command line it is ═════════════════════

describe('create-venue-org makes the owner a CLUB account of that club only', () => {
  const cli = (args: string[]): { code: number; out: string } => {
    try {
      const out = execFileSync('npx', ['tsx', 'scripts/create-venue-org.ts', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
        },
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  const create = (slug: string, ownerEmail: string) =>
    cli([
      '--slug', slug, '--name', 'Kind Club', '--city', 'Sofia', '--address', '1 St',
      '--lat', '42.69', '--lng', '23.32', '--email', 'club@kind.test',
      '--owner-email', ownerEmail, '--sport', 'PADEL', '--surface', 'HARD',
      '--courts', '1', '--price', '2400', '--open', '09:00', '--close', '17:00',
    ]); // prettier-ignore

  const clubExists = async (slug: string) =>
    (await asAppSuperuser(db, (tx) => tx.venueOrg.findUnique({ where: { slug } }))) !== null;

  const userByEmail = (email: string) =>
    asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { email }, select: { id: true, accountKind: true } }),
    );

  it('a new address becomes a CLUB account and the owner — and re-running is a no-op', async () => {
    const email = `new-owner-${randomUUID().slice(0, 8)}@kind.test`;

    const first = create('kind-new', email);
    expect(first.code).toBe(0);
    const owner = await userByEmail(email);
    expect(owner.accountKind).toBe('CLUB');
    expect(await membershipsOf(owner.id)).toEqual([
      expect.objectContaining({ role: 'OWNER', status: 'ACTIVE' }),
    ]);

    expect(create('kind-new', email).code).toBe(0);
  });

  it('an existing account that holds nothing yet becomes CLUB', async () => {
    const fresh = await account('PLAYER');

    expect(create('kind-fresh', fresh.email).code).toBe(0);
    expect(await kindOf(fresh.id)).toBe('CLUB');
  });

  it('refuses a PLAYER who plays somewhere, by name — and creates nothing', async () => {
    const elsewhere = await seedTenant({ name: 'Elsewhere' });
    const player = await account('PLAYER');
    await hold(player.id, elsewhere.tenantId, 'PLAYER');

    const run = create('kind-player', player.email);

    expect(run.code).toBe(1);
    expect(run.out).toMatch(/is a PLAYER account/);
    expect(await clubExists('kind-player')).toBe(false);
    expect(await kindOf(player.id)).toBe('PLAYER');
  });

  it('refuses the club account of another club', async () => {
    const other = await seedTenant({ name: 'Other' });

    const run = create('kind-second', other.ownerEmail);

    expect(run.code).toBe(1);
    expect(run.out).toMatch(/club account of another club/);
    expect(await clubExists('kind-second')).toBe(false);
  });

  it('refuses an account the migration left undecided', async () => {
    const undecided = await account(null);
    // What the migration left undecided holds something (here a coach role);
    // an EMPTY undecided account is a new sign-in (#360), below.
    const academy = await seedTenant({ name: 'Academy' });
    await hold(undecided.id, academy.tenantId, 'COACH');

    const run = create('kind-undecided', undecided.email);

    expect(run.code).toBe(1);
    expect(run.out).toMatch(/could not decide/);
  });

  it('makes a new sign-in that has not chosen player or coach yet (#360) a CLUB account', async () => {
    const fresh = await account(null);

    expect(create('kind-unchosen', fresh.email).code).toBe(0);
    expect(await kindOf(fresh.id)).toBe('CLUB');
  });
});
