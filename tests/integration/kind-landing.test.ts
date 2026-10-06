import type { AccountKind, MembershipStatus, Role, TenantStatus } from '@prisma/client';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';

import { resolveLanding } from '@/app-layer/usecases/landing';
import { GET as start } from '@/app/(app)/start/route';
import ClubIndexPage from '@/app/(app)/t/[slug]/page';
import { kindForRole } from '@/lib/auth/account-kind';
import { HOME, KIND_CHOOSER_PATH, PLAYER_HOME } from '@/lib/auth/landing';

import { signInAs } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * LANDING BY ACCOUNT KIND, AGAINST A REAL DATABASE, THROUGH THE REAL SESSION
 * CHECK (#263, replacing #227's role landing and its switcher).
 *
 * `tests/unit/auth/landing.test.ts` pins the rule. This pins what feeds it and
 * what acts on it, because both fail QUIETLY:
 *
 *   - A club account's one club can be any club, and `tenant_membership`
 *     carries FORCE row security keyed on one tenant. The wrong binding does
 *     not raise — it returns zero rows, and an owner lands on the home page as
 *     though their club had gone.
 *   - The read runs as superuser, so the `userId` scope is the only fence left.
 *   - `/start` and the `/t/[slug]` index read the session through
 *     `requireSignedIn` / `resolveTenantPageContext`, which call
 *     `checkSession`. The session here is a real `user_session` row and a real
 *     encrypted token in the cookie next-auth would set.
 *
 * The switcher's own tests went with it: one kind has nothing to switch
 * between, and its `lastContext` column is gone — asserted at the end.
 */

// The request's cookie jar, as `next/headers` would hand it to a route. Holds
// the same encrypted JWT next-auth sets on a real sign-in — under both names,
// because which one `getToken` reads depends on whether NEXTAUTH_URL is https.
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

const db = prismaTestClient();

/** Where the call sent the browser: a redirect target, or '404'. */
async function destination(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (isRedirectError(error)) return getURLFromRedirectError(error);
    if (String((error as { digest?: unknown }).digest).startsWith('NEXT_HTTP_ERROR_FALLBACK;404')) {
      return '404';
    }
    throw error;
  }
  throw new Error('expected a redirect or a 404, and the call returned normally');
}

async function newUser(label: string, accountKind: AccountKind | null = 'PLAYER'): Promise<string> {
  const user = await asAppSuperuser(db, (tx) =>
    tx.user.create({
      data: {
        email: `${label}-${Math.random().toString(36).slice(2, 10)}@playerz.test`,
        accountKind,
      },
      select: { id: true },
    }),
  );
  return user.id;
}

async function join(
  userId: string,
  tenantId: string,
  role: Role,
  status: MembershipStatus = 'ACTIVE',
  createdAt?: Date,
) {
  await asAppSuperuser(db, (tx) =>
    tx.tenantMembership.create({ data: { userId, tenantId, role, status, createdAt } }),
  );
}

async function setClubStatus(tenantId: string, status: TenantStatus) {
  await asAppSuperuser(db, (tx) =>
    tx.venueOrg.update({ where: { id: tenantId }, data: { status } }),
  );
}

async function setMemberStatus(userId: string, tenantId: string, status: MembershipStatus) {
  await asAppSuperuser(db, (tx) =>
    tx.tenantMembership.update({
      where: { userId_tenantId: { userId, tenantId } },
      data: { status },
    }),
  );
}

async function signIn(userId: string) {
  sessionCookie = (await signInAs(db, { userId, memberships: [] })).bearer;
}

const diary = (t: SeededTenant) => `/t/${t.tenantSlug}/admin/calendar`;

beforeEach(() => {
  sessionCookie = null;
});

describe('resolveLanding — by the kind of account', () => {
  it('a brand-new account is a PLAYER, and lands on the player UI', async () => {
    const userId = await newUser('new');

    const d = await resolveLanding(userId);

    expect(d).toEqual({ href: PLAYER_HOME, reason: 'player', club: null });
  });

  it('a PLAYER at two clubs lands on the player UI', async () => {
    const a = await seedTenant({ name: 'Club A' });
    const b = await seedTenant({ name: 'Club B' });
    const userId = await newUser('player');
    await join(userId, a.tenantId, 'PLAYER');
    await join(userId, b.tenantId, 'PLAYER');

    expect((await resolveLanding(userId)).href).toBe(PLAYER_HOME);
  });

  it('THE POINT: a club account lands on its club, read through FORCE row security', async () => {
    const t = await seedTenant({ name: 'Sofia Padel' });

    const d = await resolveLanding(t.userId);

    expect(d).toEqual({
      href: diary(t),
      reason: 'club',
      club: { tenantId: t.tenantId, tenantSlug: t.tenantSlug, tenantName: 'Sofia Padel' },
    });
  });

  it.each(['MANAGER', 'STAFF'] as const)('…and a %s lands on it too', async (role) => {
    const t = await seedTenant({});
    const userId = await newUser(role.toLowerCase(), 'CLUB');
    await join(userId, t.tenantId, role);

    expect((await resolveLanding(userId)).href).toBe(diary(t));
  });

  it.each(['SUSPENDED', 'EXPIRED'] as const)(
    'a club account whose membership is %s lands on the home page, not the player UI',
    async (status) => {
      const t = await seedTenant({});
      await setMemberStatus(t.userId, t.tenantId, status);

      expect(await resolveLanding(t.userId)).toEqual({
        href: HOME,
        reason: 'club-unavailable',
        club: null,
      });
    },
  );

  it.each(['SUSPENDED', 'CLOSED'] as const)(
    'a club account whose club is %s lands on the home page',
    async (status) => {
      const t = await seedTenant({});
      await setClubStatus(t.tenantId, status);

      expect((await resolveLanding(t.userId)).href).toBe(HOME);
    },
  );

  it('a COACH account lands on the player UI while no coach UI exists', async () => {
    const t = await seedTenant({});
    const userId = await newUser('coach', 'COACH');
    await join(userId, t.tenantId, 'COACH');

    expect(await resolveLanding(userId)).toEqual({
      href: PLAYER_HOME,
      reason: 'coach',
      club: null,
    });
  });

  it('an UNDECIDED account lands where #227 landed it: its highest club role', async () => {
    // Club roles at two clubs when #263 arrived — the migration left it NULL
    // and its memberships alone, and so does landing.
    const staffed = await seedTenant({ name: 'Staffed' });
    const owned = await seedTenant({ name: 'Owned' });
    const userId = await newUser('mixed', null);
    await join(userId, staffed.tenantId, 'STAFF', 'ACTIVE', new Date('2020-01-01'));
    await join(userId, owned.tenantId, 'OWNER', 'ACTIVE', new Date('2026-01-01'));

    const d = await resolveLanding(userId);

    expect(d).toMatchObject({ href: diary(owned), reason: 'undecided' });
  });

  it('describes only the person asked about, although it bypasses row security', async () => {
    const mine = await seedTenant({ name: 'Mine' });
    await seedTenant({ name: 'Theirs' });

    const d = await resolveLanding(mine.userId);

    expect(d.club?.tenantId).toBe(mine.tenantId);
  });
});

describe('GET /start — the post-sign-in router', () => {
  it('sends somebody with no session to sign in', async () => {
    expect(await destination(() => start())).toBe('/login');
  });

  it('sends a club account to its club’s diary', async () => {
    const t = await seedTenant({});
    await signIn(t.userId);

    expect(await destination(() => start())).toBe(diary(t));
  });

  it('sends a player to the player UI', async () => {
    const t = await seedTenant({});
    const userId = await newUser('player');
    await join(userId, t.tenantId, 'PLAYER');
    await signIn(userId);

    expect(await destination(() => start())).toBe(PLAYER_HOME);
  });

  it('sends a new account that has not chosen player or coach to the chooser (#360, U01)', async () => {
    const userId = await newUser('fresh', null);
    await signIn(userId);

    expect(await destination(() => start())).toBe(KIND_CHOOSER_PATH);
  });

  it('…and, once it chose PLAYER, to the player UI', async () => {
    const userId = await newUser('chose', 'PLAYER');
    await signIn(userId);

    expect(await destination(() => start())).toBe(PLAYER_HOME);
  });

  it('treats a REVOKED session as no session', async () => {
    // The token still decrypts. `checkSession` is what says no — the
    // password-change lever, bumped here as "sign out everywhere" would.
    const t = await seedTenant({});
    await signIn(t.userId);
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: t.userId }, data: { sessionVersion: { increment: 1 } } }),
    );

    expect(await destination(() => start())).toBe('/login');
  });
});

describe('/t/[slug] — a club’s front door, by the role held there', () => {
  const visit = (slug: string) =>
    destination(() => ClubIndexPage({ params: Promise.resolve({ slug }) }));

  it.each(['OWNER', 'MANAGER', 'STAFF'] as const)('a %s goes to the diary', async (role) => {
    const t = await seedTenant({});
    const userId = await newUser(role.toLowerCase(), kindForRole(role));
    await join(userId, t.tenantId, role);
    await signIn(userId);

    expect(await visit(t.tenantSlug)).toBe(diary(t));
  });

  it.each(['PLAYER', 'COACH'] as const)('a %s goes to the player UI', async (role) => {
    const t = await seedTenant({});
    const userId = await newUser(role.toLowerCase(), kindForRole(role));
    await join(userId, t.tenantId, role);
    await signIn(userId);

    expect(await visit(t.tenantSlug)).toBe(PLAYER_HOME);
  });

  it('is a 404 for a club you are not in — the same as for a club that does not exist', async () => {
    const mine = await seedTenant({});
    const theirs = await seedTenant({});
    await signIn(mine.userId);

    expect(await visit(theirs.tenantSlug)).toBe('404');
    expect(await visit('no-such-club-anywhere')).toBe('404');
  });

  it('sends a signed-out visitor to sign in, and back here afterwards', async () => {
    const t = await seedTenant({});

    expect(await visit(t.tenantSlug)).toBe(
      `/login?next=${encodeURIComponent(`/t/${t.tenantSlug}`)}`,
    );
  });
});

describe('the role switcher is gone (#263)', () => {
  it('and so is the column it wrote', async () => {
    // One kind has nothing to switch between. `lastContext` was dropped by the
    // p37 migration, not merely left unused — a column nothing reads is one
    // somebody starts reading again.
    const columns = await asAppSuperuser(db, (tx) =>
      tx.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'app_user' AND column_name IN ('lastContext', 'accountKind')`,
      ),
    );

    expect(columns.map((c) => c.column_name)).toEqual(['accountKind']);
  });
});
