import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { dummyVerify, verifyPassword } from './passwords';

/**
 * Email + password, verified once, for every entry point.
 *
 * ═══ WHY THIS IS NOT JUST `authorize()` ═══
 *
 * You cannot call next-auth's authorize from outside next-auth, and the type
 * system says you can. `CredentialsProvider` returns
 *
 *     { id, name, type, credentials: {}, authorize: () => null, options }
 *
 * — the real function is nested under `.options`, while the top-level
 * `authorize` is a STUB that returns null SYNCHRONOUSLY. The declared type is
 * `(credentials, req) => Awaitable<User | null>`, so
 * `authOptions.providers[1].authorize(creds, req)` compiles, type-checks, and
 * rejects every correct password in silence.
 *
 * A native login built that way would look like "the password is wrong" for
 * every user, forever, with nothing in any log.
 *
 * So the credential check lives here and BOTH paths call it: the web provider
 * in src/auth.ts and the native token endpoint.
 *
 * ═══ WHY ONE COPY AND NOT TWO ═══
 *
 * `dummyVerify` is what stops response TIMING revealing whether an address has
 * an account: every failure path burns the same bcrypt time. passwords.ts says
 * it must be called on every such path, and "skipping it on any one of them
 * reopens the oracle for that case".
 *
 * Two hand-copied implementations is precisely how one of them loses it — and
 * it would be the newer one, on the endpoint nobody has been staring at.
 */
export interface VerifiedUser {
  id: string;
  email: string;
  name?: string;
}

export async function verifyCredentials(
  email: string | undefined,
  password: string | undefined,
): Promise<VerifiedUser | null> {
  const normalised = email?.toLowerCase().trim();
  if (!normalised || !password) return null;

  // Superuser: at sign-in no tenant is selected, so there is no app.tenant_id
  // to bind, and an RLS-scoped read of User would return zero rows and look
  // exactly like "wrong password".
  const user = await runAsSuperuser((db) => db.user.findUnique({ where: { email: normalised } }));

  // Burn the same time whether or not the account exists. Returning early here
  // (~1ms) versus a real compare (~100ms) is a user-enumeration oracle that
  // needs no error message to read.
  if (!user?.passwordHash) {
    await dummyVerify(password);
    return null;
  }

  if (!(await verifyPassword(password, user.passwordHash))) return null;

  return { id: user.id, email: user.email, name: user.name ?? undefined };
}
