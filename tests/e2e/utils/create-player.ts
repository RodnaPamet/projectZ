import bcrypt from 'bcryptjs';

import { E2E_PASSWORD, prisma } from './create-isolated-tenant';

/**
 * A PLAYER account for E2E (T20), or a COACH one (#362): the player shell is
 * about what they see, and `isolatedTenant`'s account is a CLUB one (#263),
 * which wears its club admin's frame instead.
 *
 * Straight to Prisma, as `createIsolatedTenant` does and for its reason: a
 * fixture that provisions through the app under test cannot tell "the app is
 * broken" from "the fixture is broken". It holds no membership: a player
 * account's PLAYER rows decide nothing about the chrome (`resolveLanding`
 * answers from the account row alone).
 */
export interface E2EPlayer {
  userId: string;
  email: string;
  password: string;
  name: string;
}

export async function createPlayer(kind: 'PLAYER' | 'COACH' = 'PLAYER'): Promise<E2EPlayer> {
  const id = `e2e-${kind.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${id}@playerz.test`;
  const name = kind === 'COACH' ? 'E2E Coach' : 'E2E Player';
  // Cost 4, not the app's 12: this account lives for one spec.
  const passwordHash = await bcrypt.hash(E2E_PASSWORD, 4);

  const user = await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return tx.user.create({ data: { email, name, accountKind: kind, passwordHash } });
  });

  return { userId: user.id, email, password: E2E_PASSWORD, name };
}

/**
 * Remove the player. Its sessions cascade. Best effort: a row that refuses to
 * go (an append-only log naming the user, say) leaves one inert account in a
 * test database, which is not worth failing a passing spec over.
 */
export async function destroyPlayer(userId: string): Promise<void> {
  try {
    await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      // The bell's rows name a person, not a foreign key (#367): clear them too.
      await tx.notification.deleteMany({ where: { userId } });
      await tx.user.deleteMany({ where: { id: userId } });
    });
  } catch (err) {
    console.warn(`e2e: could not delete player ${userId}: ${(err as Error).message}`);
  }
}

/**
 * A CLUB account holding STAFF at `tenantId` (#362): the front desk. It opens
 * the diary and the players, and the admin's own filter hides the rest.
 */
export async function createStaff(tenantId: string): Promise<E2EPlayer> {
  const id = `e2e-staff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${id}@playerz.test`;
  const name = 'E2E Staff';
  const passwordHash = await bcrypt.hash(E2E_PASSWORD, 4);

  const user = await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    const u = await tx.user.create({ data: { email, name, accountKind: 'CLUB', passwordHash } });
    await tx.tenantMembership.create({
      data: { tenantId, userId: u.id, role: 'STAFF', status: 'ACTIVE' },
    });
    return u;
  });

  return { userId: user.id, email, password: E2E_PASSWORD, name };
}

/**
 * A live platform grant for `userId` (#345), issued by `grantedBy`: the
 * database refuses a self-grant. `REVIEW_MODERATE` makes a moderator.
 */
export async function grantModerator(userId: string, grantedBy: string): Promise<void> {
  const id = `cg${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.$executeRawUnsafe(
      `INSERT INTO platform_admin_grant
         (id,"userId","grantedByUserId",reason,capabilities,"expiresAt")
       VALUES ($1,$2,$3,'e2e #362 navigation check',
               '{REVIEW_MODERATE}'::"PlatformCapability"[], now() + interval '1 day')`,
      id,
      userId,
      grantedBy,
    );
  });
}
