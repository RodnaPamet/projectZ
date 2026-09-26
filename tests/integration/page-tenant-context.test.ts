import { randomUUID } from 'node:crypto';

import { membershipContext } from '@/lib/auth/page-context';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE TENANT RESOLVER A PAGE USES, AGAINST A REAL DATABASE.
 *
 * ═══ WHY IT EXISTS AT ALL ═══
 *
 * `contextFromRequest` takes a `NextRequest`, which a server component does not
 * have. Before this, NO page in the repo resolved a tenant — the only
 * data-bound page is the public venue index, which is deliberately tenant-less.
 * Every admin screen rests on this function being right.
 *
 * ═══ WHAT WOULD GO WRONG, SPECIFICALLY ═══
 *
 * Reading the role from the token instead of the matched membership is the
 * cross-tenant escalation `context.ts` documents: `auth.ts` freezes
 * `token.role` to `memberships[0]`, the club joined FIRST, so an OWNER at one
 * club would carry owner permissions into every club they merely joined.
 *
 * Accepting any membership row rather than an ACTIVE one would let an INVITED
 * user — asked but never accepted — administer a club.
 *
 * Both are one careless `where` clause away, and neither fails visibly: the
 * screen renders, with the wrong authority.
 */

describe('membershipContext', () => {
  const db = prismaTestClient();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('THE POINT: resolves the club and the role held AT THAT CLUB', async () => {
    const t = await seedTenant({ name: 'Sofia Padel' }, db);

    const res = await membershipContext(t.userId, t.tenantSlug);

    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') throw new Error('unreachable');
    expect(res.ctx).toMatchObject({
      userId: t.userId,
      tenantId: t.tenantId,
      tenantSlug: t.tenantSlug,
      role: 'OWNER',
    });
    // OWNER holds the admin permissions the five screens gate on.
    expect(res.ctx.permissions).toContain('courts.manage');
    expect(res.ctx.permissions).toContain('admin.pricing_manage');
  });

  it('reports the role for THIS club, not the first one joined', async () => {
    // ═══ THE ESCALATION THIS PREVENTS ═══
    //
    // auth.ts mints token.role from memberships[0]. A resolver that trusted it
    // would report OWNER at the club where this person is only a PLAYER, and
    // hand them every admin permission on a screen that gates on exactly that.
    const a = await seedTenant({ name: 'Club A' }, db);
    const b = await seedTenant({ name: 'Club B' }, db);

    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { userId: a.userId, tenantId: b.tenantId, role: 'PLAYER', status: 'ACTIVE' },
      }),
    );

    const atA = await membershipContext(a.userId, a.tenantSlug);
    const atB = await membershipContext(a.userId, b.tenantSlug);

    expect(atA.kind === 'ok' && atA.ctx.role).toBe('OWNER');
    expect(atB.kind === 'ok' && atB.ctx.role).toBe('PLAYER');

    // And the permissions follow the role, not the person.
    if (atB.kind !== 'ok') throw new Error('unreachable');
    expect(atB.ctx.permissions).not.toContain('courts.manage');
    expect(atB.ctx.permissions).not.toContain('admin.staff_manage');
  });

  it.each(['INVITED', 'SUSPENDED', 'EXPIRED'] as const)(
    'refuses a %s membership — a row existing is not membership',
    async (status) => {
      const t = await seedTenant({}, db);
      await asAppSuperuser(db, (tx) =>
        tx.tenantMembership.updateMany({
          where: { userId: t.userId, tenantId: t.tenantId },
          data: { status },
        }),
      );

      expect((await membershipContext(t.userId, t.tenantSlug)).kind).toBe('not-a-member');
    },
  );

  it('does not distinguish "no such club" from "not a member of it"', async () => {
    // Different answers would make any admin URL a tenant-enumeration oracle —
    // the same reason checkTenantAccess refuses to separate them.
    const mine = await seedTenant({}, db);
    const theirs = await seedTenant({}, db);

    const foreign = await membershipContext(mine.userId, theirs.tenantSlug);
    const nonexistent = await membershipContext(mine.userId, 'no-such-club-anywhere');

    expect(foreign).toEqual(nonexistent);
    expect(foreign.kind).toBe('not-a-member');
  });

  it('a slug that merely PREFIXES a real one is not a match', async () => {
    const t = await seedTenant({}, db);
    const prefix = t.tenantSlug.slice(0, Math.max(3, t.tenantSlug.length - 2));

    expect((await membershipContext(t.userId, prefix)).kind).toBe('not-a-member');
  });

  it('reads tenant_membership despite its FORCE row security', async () => {
    // The chicken-and-egg this function exists inside: the table is RLS-keyed
    // on app.tenant_id, and the whole point of the call is to discover which
    // tenant to bind to. Bound as app_user with nothing set it returns zero
    // rows, and every caller reads that as "not a member".
    //
    // Asserted rather than assumed, because the failure is silent and looks
    // exactly like a legitimate refusal.
    const t = await seedTenant({}, db);
    expect((await membershipContext(t.userId, t.tenantSlug)).kind).toBe('ok');

    const unbound = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
      return tx.tenantMembership.findMany({ where: { userId: t.userId } });
    });
    expect(unbound).toHaveLength(0);
  });
});
