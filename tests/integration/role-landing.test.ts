import type { MembershipStatus, Role, TenantStatus } from '@prisma/client';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';

import {
  listLandingContexts,
  rememberLandingContext,
  resolveLanding,
} from '@/app-layer/usecases/landing';
import { switchContextAction } from '@/app/(app)/start/actions';
import { GET as start } from '@/app/(app)/start/route';
import ClubIndexPage from '@/app/(app)/t/[slug]/page';
import { PLAYER_HOME } from '@/lib/auth/landing';

import { signInAs } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * ROLE LANDING AGAINST A REAL DATABASE, THROUGH THE REAL SESSION CHECK (#227).
 *
 * `tests/unit/auth/landing.test.ts` pins the rule. This pins what feeds it and
 * what acts on it, because both fail QUIETLY:
 *
 *   - The memberships are read across every club, and `tenant_membership`
 *     carries FORCE row security keyed on one tenant. The wrong binding does
 *     not raise — it returns zero rows, and an owner lands on the player UI as
 *     though they ran nothing. Only a real database shows the difference.
 *   - The read runs as superuser, so the `userId` scope is the only fence left.
 *     A mistake there shows up as somebody else's club in your switcher.
 *   - `/start`, the switcher action and the `/t/[slug]` index each read the
 *     session through `requireSignedIn` / `resolveTenantPageContext`, which
 *     call `checkSession`. The session here is a real `user_session` row and a
 *     real encrypted token in the cookie next-auth would set, so a revoked
 *     session is revoked for real.
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

async function newUser(label: string): Promise<string> {
  const user = await asAppSuperuser(db, (tx) =>
    tx.user.create({
      data: { email: `${label}-${Math.random().toString(36).slice(2, 10)}@playerz.test` },
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

async function lastContextOf(userId: string): Promise<string | null> {
  const row = await asAppSuperuser(db, (tx) =>
    tx.user.findUniqueOrThrow({ where: { id: userId }, select: { lastContext: true } }),
  );
  return row.lastContext;
}

async function signIn(userId: string) {
  sessionCookie = (await signInAs(db, { userId, memberships: [] })).bearer;
}

const diary = (t: SeededTenant) => `/t/${t.tenantSlug}/admin/calendar`;

beforeEach(() => {
  sessionCookie = null;
});

describe('resolveLanding', () => {
  it('somebody with no memberships lands on the player UI', async () => {
    const userId = await newUser('nobody');

    const d = await resolveLanding(userId);

    expect(d.context.href).toBe(PLAYER_HOME);
    expect(d.reason).toBe('only-context');
  });

  it('a PLAYER at two clubs lands on the player UI, with nothing to switch between', async () => {
    const a = await seedTenant({ name: 'Club A' });
    const b = await seedTenant({ name: 'Club B' });
    const userId = await newUser('player');
    await join(userId, a.tenantId, 'PLAYER');
    await join(userId, b.tenantId, 'PLAYER');

    const d = await resolveLanding(userId);

    expect(d.context.href).toBe(PLAYER_HOME);
    expect(d.contexts).toHaveLength(1);
  });

  it('THE POINT: an owner lands on their club, read through FORCE row security', async () => {
    // Bound as app_user with no tenant this read returns zero rows, and the
    // owner would land on the player UI with nothing to say anything was
    // wrong. seedTenant makes an OWNER, and nothing else.
    const t = await seedTenant({ name: 'Sofia Padel' });

    const d = await resolveLanding(t.userId);

    expect(d.context).toMatchObject({ kind: 'club', tenantId: t.tenantId, role: 'OWNER' });
    expect(d.context.href).toBe(diary(t));
  });

  it('STAFF at one club and PLAYER at another → the club they work at', async () => {
    const work = await seedTenant({ name: 'Front Desk' });
    const play = await seedTenant({ name: 'Weekend Courts' });
    const userId = await newUser('staff');
    await join(userId, play.tenantId, 'PLAYER');
    await join(userId, work.tenantId, 'STAFF');

    expect((await resolveLanding(userId)).context.href).toBe(diary(work));
  });

  it('a COACH lands on the player UI while no coach UI exists', async () => {
    const t = await seedTenant({});
    const userId = await newUser('coach');
    await join(userId, t.tenantId, 'COACH');

    const d = await resolveLanding(userId);

    expect(d.context.href).toBe(PLAYER_HOME);
    expect(d.contexts).toHaveLength(1);
  });

  it.each(['INVITED', 'SUSPENDED', 'EXPIRED'] as const)(
    'a %s MANAGER gets no club landing',
    async (status) => {
      const t = await seedTenant({});
      const userId = await newUser('manager');
      await join(userId, t.tenantId, 'MANAGER', status);

      const d = await resolveLanding(userId);

      expect(d.context.href).toBe(PLAYER_HOME);
      expect(d.contexts).toHaveLength(1);
    },
  );

  it.each(['SUSPENDED', 'CLOSED'] as const)(
    'the owner of a %s club gets no club landing',
    async (status) => {
      const t = await seedTenant({});
      await setClubStatus(t.tenantId, status);

      expect((await resolveLanding(t.userId)).context.href).toBe(PLAYER_HOME);
    },
  );

  it('several clubs: the highest role by default, and every club in the switcher by name', async () => {
    const staffAt = await seedTenant({ name: 'Varna Tennis' });
    const ownerAt = await seedTenant({ name: 'Ask Padel' });
    const userId = await newUser('multi');
    await join(userId, staffAt.tenantId, 'STAFF', 'ACTIVE', new Date('2024-01-01'));
    await join(userId, ownerAt.tenantId, 'OWNER', 'ACTIVE', new Date('2026-01-01'));

    const d = await resolveLanding(userId);

    expect(d.reason).toBe('default');
    expect(d.context.href).toBe(diary(ownerAt));
    expect(d.contexts.map((c) => (c.kind === 'club' ? c.tenantName : c.kind))).toEqual([
      'player',
      'Ask Padel',
      'Varna Tennis',
    ]);
  });

  it('honours the last-used context, and ignores it once it has gone stale', async () => {
    const a = await seedTenant({ name: 'A' });
    const b = await seedTenant({ name: 'B' });
    await join(a.userId, b.tenantId, 'MANAGER');

    await rememberLandingContext(a.userId, `club:${b.tenantId}`);
    expect(await resolveLanding(a.userId)).toMatchObject({
      reason: 'last-used',
      context: { href: diary(b) },
    });

    // Suspended at B since. The stored value is still there — and ignored:
    // they land on the club they still run, not the one they were removed from.
    await setMemberStatus(a.userId, b.tenantId, 'SUSPENDED');
    expect(await lastContextOf(a.userId)).toBe(`club:${b.tenantId}`);
    expect(await resolveLanding(a.userId)).toMatchObject({
      reason: 'default',
      context: { href: diary(a) },
    });
  });

  it('describes only the person asked about, although it bypasses row security', async () => {
    // Superuser removes the tenant fence, so the userId filter is all that is
    // left. Two people at one club; each sees exactly their own standing.
    const t = await seedTenant({});
    const playerAtSameClub = await newUser('neighbour');
    await join(playerAtSameClub, t.tenantId, 'PLAYER');

    expect((await resolveLanding(playerAtSameClub)).contexts).toHaveLength(1);
    expect(await listLandingContexts(playerAtSameClub)).toHaveLength(1);
    expect((await resolveLanding(t.userId)).context.href).toBe(diary(t));
  });
});

describe('rememberLandingContext', () => {
  it('records a context the person holds', async () => {
    const t = await seedTenant({});

    const chosen = await rememberLandingContext(t.userId, 'player');

    expect(chosen).toMatchObject({ kind: 'player', href: PLAYER_HOME });
    expect(await lastContextOf(t.userId)).toBe('player');
    // And the owner now lands on the player UI, because they chose it.
    expect((await resolveLanding(t.userId)).context.href).toBe(PLAYER_HOME);
  });

  it('refuses a club the person does not run, and stores nothing', async () => {
    // A forged key must be refused, not merely ignored on the way back out.
    const mine = await seedTenant({});
    const theirs = await seedTenant({});

    await expect(
      rememberLandingContext(mine.userId, `club:${theirs.tenantId}`),
    ).resolves.toBeNull();
    expect(await lastContextOf(mine.userId)).toBeNull();
  });

  it('refuses a club where they are only a PLAYER', async () => {
    const mine = await seedTenant({});
    const playsAt = await seedTenant({});
    await join(mine.userId, playsAt.tenantId, 'PLAYER');

    await expect(
      rememberLandingContext(mine.userId, `club:${playsAt.tenantId}`),
    ).resolves.toBeNull();
  });

  it('refuses a club where their membership is suspended', async () => {
    const a = await seedTenant({});
    const b = await seedTenant({});
    await join(a.userId, b.tenantId, 'OWNER', 'SUSPENDED');

    await expect(rememberLandingContext(a.userId, `club:${b.tenantId}`)).resolves.toBeNull();
  });

  it('writes only the caller’s own row', async () => {
    const a = await seedTenant({});
    const b = await seedTenant({});

    await rememberLandingContext(a.userId, 'player');

    expect(await lastContextOf(a.userId)).toBe('player');
    expect(await lastContextOf(b.userId)).toBeNull();
  });
});

describe('GET /start — the post-sign-in router', () => {
  it('sends somebody with no session to sign in', async () => {
    expect(await destination(() => start())).toBe('/login');
  });

  it('sends an owner to their club’s diary', async () => {
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

describe('the switcher action', () => {
  it('records the choice and goes there — and the next sign-in lands there too', async () => {
    const a = await seedTenant({ name: 'A' });
    const b = await seedTenant({ name: 'B' });
    await join(a.userId, b.tenantId, 'STAFF');
    await signIn(a.userId);

    // Default: the club they OWN.
    expect(await destination(() => start())).toBe(diary(a));

    expect(await destination(() => switchContextAction(`club:${b.tenantId}`))).toBe(diary(b));
    expect(await lastContextOf(a.userId)).toBe(`club:${b.tenantId}`);
    expect(await destination(() => start())).toBe(diary(b));

    expect(await destination(() => switchContextAction('player'))).toBe(PLAYER_HOME);
    expect(await destination(() => start())).toBe(PLAYER_HOME);
  });

  it('refuses a club the caller does not hold, without storing it', async () => {
    const mine = await seedTenant({});
    const theirs = await seedTenant({});
    await signIn(mine.userId);

    await expect(switchContextAction(`club:${theirs.tenantId}`)).resolves.toEqual({
      error: 'NOT_AVAILABLE',
    });
    expect(await lastContextOf(mine.userId)).toBeNull();
  });

  it.each([42, null, '', 'x'.repeat(65), { key: 'player' }])(
    'refuses a malformed key (%j) before it reaches the database',
    async (key) => {
      const t = await seedTenant({});
      await signIn(t.userId);

      await expect(switchContextAction(key)).resolves.toEqual({ error: 'NOT_AVAILABLE' });
      expect(await lastContextOf(t.userId)).toBeNull();
    },
  );

  it('does nothing for somebody who is not signed in', async () => {
    await expect(switchContextAction('player')).resolves.toEqual({ error: 'SIGN_IN_REQUIRED' });
  });
});

describe('/t/[slug] — a club’s front door, by role', () => {
  const visit = (slug: string) =>
    destination(() => ClubIndexPage({ params: Promise.resolve({ slug }) }));

  it.each(['OWNER', 'MANAGER', 'STAFF'] as const)('a %s goes to the diary', async (role) => {
    const t = await seedTenant({});
    const userId = await newUser(role.toLowerCase());
    await join(userId, t.tenantId, role);
    await signIn(userId);

    expect(await visit(t.tenantSlug)).toBe(diary(t));
  });

  it.each(['PLAYER', 'COACH'] as const)('a %s goes to the player UI', async (role) => {
    const t = await seedTenant({});
    const userId = await newUser(role.toLowerCase());
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
