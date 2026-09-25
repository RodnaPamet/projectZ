import { randomUUID } from 'node:crypto';

import { PlatformCapability } from '@prisma/client';

import { resolvePlatformAuthority } from '@/lib/auth/platform-admin';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * WHAT COMES BACK MUST BE AN ARRAY, AND THAT IS NOT A PEDANTIC ASSERTION.
 *
 * ═══ THE BUG THIS EXISTS FOR ═══
 *
 * The first version of `resolvePlatformAuthority` read the grant with
 * `$queryRawUnsafe`. Measured against a real Postgres: Prisma returns an enum
 * ARRAY from a raw query as the STRING `"{TENANT_READ,AUDIT_READ}"`, not as a
 * JS array.
 *
 * So `ctx.appPermissions` held a string while its declared type said
 * `readonly PlatformCapability[]`, and the authorisation check in `bind.ts` is:
 *
 *     ctx.appPermissions.includes(act.capability)
 *
 * On a string, `includes` is SUBSTRING matching. Nothing was wrongly granted,
 * because no current capability name is a substring of another — that is luck,
 * not design. Add `TENANT_READ_PII` beside `TENANT_READ` and each would satisfy
 * the other's check, silently, in the one code path that decides who may read
 * every club's data.
 *
 * It is also precisely the failure `app-layer/types.ts` narrowed this field's
 * type to prevent, reintroduced by a raw query that bypasses the type. A type
 * only helps where the value actually comes from somewhere typed.
 *
 * So the first assertion here is `Array.isArray`. It is the cheapest possible
 * check and it is the one that was missing.
 */

describe('resolvePlatformAuthority', () => {
  const db = prismaTestClient();
  let holder: string;
  let granter: string;

  beforeEach(async () => {
    await resetDatabase(db);
    holder = `cadmin${randomUUID().replace(/-/g, '').slice(0, 18)}`;
    granter = `cgrant${randomUUID().replace(/-/g, '').slice(0, 18)}`;
    await asAppSuperuser(db, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO app_user (id,email,"createdAt","updatedAt")
         VALUES ($1,$2,now(),now()), ($3,$4,now(),now())`,
        holder,
        `${holder}@test.invalid`,
        granter,
        `${granter}@test.invalid`,
      ),
    );
  });

  async function grant(opts: { caps: PlatformCapability[]; days: number; revoked?: boolean }) {
    const id = `cg${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await asAppSuperuser(db, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO platform_admin_grant
           (id,"userId","grantedByUserId",reason,capabilities,"expiresAt")
         VALUES ($1,$2,$3,'incident response rota',$4::"PlatformCapability"[], now() + ($5 || ' days')::interval)`,
        id,
        holder,
        granter,
        `{${opts.caps.join(',')}}`,
        String(opts.days),
      );
      if (opts.revoked) {
        await tx.$executeRawUnsafe(
          `UPDATE platform_admin_grant
              SET "revokedAt" = now(), "revokedByUserId" = $2, "revokeReason" = 'revoked for the test'
            WHERE id = $1`,
          id,
          granter,
        );
      }
    });
    return id;
  }

  it('returns a real ARRAY of capabilities, not a Postgres array literal', async () => {
    // THE regression test. `$queryRawUnsafe` returned "{TENANT_READ,AUDIT_READ}"
    // here, which is a string of length 24 that passes every `.length > 0`
    // check and then substring-matches in an authorisation decision.
    const id = await grant({
      caps: [PlatformCapability.TENANT_READ, PlatformCapability.AUDIT_READ],
      days: 30,
    });

    const resolved = await resolvePlatformAuthority(holder);

    expect(Array.isArray(resolved.capabilities)).toBe(true);
    expect(resolved.capabilities).toEqual([
      PlatformCapability.TENANT_READ,
      PlatformCapability.AUDIT_READ,
    ]);
    expect(resolved.grantId).toBe(id);
  });

  it('does not let one capability satisfy a check for a different one', async () => {
    // With a string, `"{AUDIT_READ}".includes('TENANT_READ')` happens to be
    // false — so this passes either way today. It is here for the day somebody
    // adds a capability whose name contains another, which is when the string
    // version starts granting the wrong thing and this starts failing.
    await grant({ caps: [PlatformCapability.AUDIT_READ], days: 30 });

    const { capabilities } = await resolvePlatformAuthority(holder);

    expect(capabilities.includes(PlatformCapability.AUDIT_READ)).toBe(true);
    expect(capabilities.includes(PlatformCapability.TENANT_READ)).toBe(false);
    expect(capabilities.includes(PlatformCapability.TENANT_SUSPEND)).toBe(false);
    // An array has one element; the string had 13 characters.
    expect(capabilities).toHaveLength(1);
  });

  it('returns nothing for a user with no grant', async () => {
    const resolved = await resolvePlatformAuthority(holder);
    expect(resolved).toEqual({ grantId: null, capabilities: [] });
  });

  it('returns nothing for an anonymous request', async () => {
    expect(await resolvePlatformAuthority(null)).toEqual({ grantId: null, capabilities: [] });
  });

  it('returns nothing once the grant is revoked', async () => {
    // Revocation is the fast path during an incident, and it must not wait for
    // expiry. Because this is read per request, it takes effect on the next one.
    await grant({ caps: [PlatformCapability.TENANT_READ], days: 30, revoked: true });

    expect(await resolvePlatformAuthority(holder)).toEqual({ grantId: null, capabilities: [] });
  });

  it('returns nothing once the grant has expired, and no grantId either', async () => {
    // A grantId with an empty capability list would let an audit row name a
    // grant that authorised nothing.
    await grant({ caps: [PlatformCapability.TENANT_READ], days: 30 });

    const future = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const resolved = await resolvePlatformAuthority(holder, future);

    expect(resolved.capabilities).toEqual([]);
    expect(resolved.grantId).toBeNull();
  });
});
