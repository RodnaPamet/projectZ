import bcrypt from 'bcryptjs';

import { E2E_PASSWORD, prisma } from './create-isolated-tenant';

/**
 * A PLAYER account for E2E (T20): the player chrome is about what a player
 * sees, and `isolatedTenant`'s account is a CLUB one (#263), which gets a
 * different tab bar and a link to its club.
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

export async function createPlayer(): Promise<E2EPlayer> {
  const id = `e2e-player-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${id}@playerz.test`;
  const name = 'E2E Player';
  // Cost 4, not the app's 12: this account lives for one spec.
  const passwordHash = await bcrypt.hash(E2E_PASSWORD, 4);

  const user = await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return tx.user.create({ data: { email, name, accountKind: 'PLAYER', passwordHash } });
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
      await tx.user.deleteMany({ where: { id: userId } });
    });
  } catch (err) {
    console.warn(`e2e: could not delete player ${userId}: ${(err as Error).message}`);
  }
}
