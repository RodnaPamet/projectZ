import type { PrismaClient } from '@prisma/client';
import { encode } from 'next-auth/jwt';

import { createUserSession, newSessionSecret } from '@/lib/auth/sessions';

/**
 * A real bearer token for a real session.
 *
 * ═══ WHY NOT JUST MOCK getToken ═══
 *
 * Mocking it would skip the two things most likely to be wrong. `getToken`
 * has to find the token on the `Authorization` header rather than a cookie —
 * that header fallback is the ONLY reason a native client can reuse the web
 * pipeline — and `contextFromRequest` then calls `checkSession`, which needs a
 * `user_session` row whose `tokenHash` matches the secret in the token.
 *
 * A mocked token satisfies neither, so a test built on one would pass against
 * a build where native auth is completely broken.
 */
export interface TestIdentity {
  userId: string;
  bearer: string;
}

export async function signInAs(
  db: PrismaClient,
  input: {
    userId: string;
    memberships: Array<{ tenantId: string; tenantSlug: string; role: string }>;
  },
): Promise<TestIdentity> {
  const sessionSecret = newSessionSecret();

  const { userSessionId, sessionVersion } = await createUserSession({
    userId: input.userId,
    tenantId: null,
    sessionSecret,
    expiresAt: new Date(Date.now() + 3_600_000),
  });

  const bearer = await encode({
    token: {
      sub: input.userId,
      userSessionId,
      sessionVersion,
      sessionSecret,
      memberships: input.memberships,
    },
    secret: process.env.NEXTAUTH_SECRET!,
    // next-auth v4 defaults `salt` from the cookie name; encode/decode must
    // agree, and getToken uses the default, so it is left alone here.
  });

  return { userId: input.userId, bearer };
}

/** A second player at the same club — the one who must NOT see the first's data. */
export async function seedPlayer(
  db: PrismaClient,
  tenantId: string,
  label = 'player',
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);

  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);

    const user = await tx.user.create({
      data: { email: `${label}-${suffix}@playerz.test`, name: 'Test Player', passwordHash: null },
    });

    await tx.tenantMembership.create({
      data: { tenantId, userId: user.id, role: 'PLAYER', status: 'ACTIVE' },
    });

    return user.id;
  });
}
