import { prismaTestClient } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * `playerz_app` — the login role that cannot bypass RLS.
 *
 * Every policy in this database is bypassed today because the application
 * connects as a cluster SUPERUSER that also owns every table. FORCE ROW LEVEL
 * SECURITY constrains the owner; nothing constrains a superuser. RLS is
 * therefore a convention enforced by remembering to call a wrapper, rather
 * than a property of the connection.
 *
 * These assertions pin the shape of the role that fixes that. They are
 * deliberately about PRIVILEGES rather than about queries: the "permission
 * denied" behaviour follows from NOINHERIT plus the absence of grants, and
 * those are the two things a future edit would quietly undo.
 */
describe('least-privileged application role', () => {
  const db = prismaTestClient();

  type RoleRow = {
    rolcanlogin: boolean;
    rolinherit: boolean;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
  };

  const role = () =>
    asAppSuperuser(db, (tx) =>
      tx.$queryRawUnsafe<RoleRow[]>(
        `SELECT rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
           FROM pg_roles WHERE rolname = 'playerz_app'`,
      ),
    );

  it('exists and can log in', async () => {
    const [r] = await role();
    expect(r).toBeDefined();
    expect(r!.rolcanlogin).toBe(true);
  });

  it('is NOT a superuser and canNOT bypass RLS', async () => {
    // The whole reason it exists. A superuser is exempt from row security
    // entirely, so connecting as one makes every policy in the schema
    // decorative.
    const [r] = await role();
    expect(r!.rolsuper).toBe(false);
    expect(r!.rolbypassrls).toBe(false);
  });

  it('does NOT inherit, on the role itself', async () => {
    // The role flag supplies the DEFAULT when a grant is written. It is not
    // what governs at use time — see the next test, which is the real one.
    const [r] = await role();
    expect(r!.rolinherit).toBe(false);
  });

  it('every GRANT is non-inheriting — this is the property that governs', async () => {
    // ═══ THE ONE THAT ACTUALLY MATTERS ═══
    //
    // PostgreSQL 16 records the inherit option PER GRANT, in
    // pg_auth_members.inherit_option. rolinherit is consulted only when the
    // grant is created.
    //
    // Measured: after `ALTER ROLE playerz_app INHERIT`, a query with no SET
    // ROLE was STILL denied, because the existing grants kept
    // inherit_option = false. Asserting rolinherit alone would therefore pass
    // on a database where the real control had been removed, and fail on one
    // where it had not — exactly backwards.
    //
    // The realistic regression is a later migration re-running
    // `GRANT app_user TO playerz_app` while the role happens to be INHERIT.
    // The grant is silently re-recorded as inheriting, the role holds
    // app_user's privileges at all times, and every unwrapped query starts
    // returning rows again.
    //
    // set_option must stay TRUE: it is what permits `SET LOCAL ROLE` at all,
    // and without it every wrapper in rls-middleware.ts fails.
    const rows = await asAppSuperuser(db, (tx) =>
      tx.$queryRawUnsafe<{ member_of: string; inherit_option: boolean; set_option: boolean }[]>(
        `SELECT r.rolname AS member_of, m.inherit_option, m.set_option
           FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.roleid
           JOIN pg_roles g ON g.oid = m.member
          WHERE g.rolname = 'playerz_app'
          ORDER BY 1`,
      ),
    );

    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.inherit_option).toBe(false);
      expect(r.set_option).toBe(true);
    }
  });

  it('holds NO table privileges of its own', async () => {
    // has_table_privilege returns false for a NOINHERIT role precisely because
    // it cannot use its memberships without switching to them. That is the
    // property being asserted, not an accident of the function.
    const [p] = await asAppSuperuser(db, (tx) =>
      tx.$queryRawUnsafe<{ can_select: boolean; can_insert: boolean }[]>(
        `SELECT has_table_privilege('playerz_app','venue','SELECT') AS can_select,
                has_table_privilege('playerz_app','venue','INSERT') AS can_insert`,
      ),
    );

    expect(p!.can_select).toBe(false);
    expect(p!.can_insert).toBe(false);
  });

  it('has no DIRECT grants on any table', async () => {
    // A single `GRANT SELECT ON some_table TO playerz_app` added later would
    // carve a permanent hole around the wrappers for that table alone — the
    // kind of thing that gets added to fix one bug and is never removed.
    const [g] = await asAppSuperuser(db, (tx) =>
      tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM information_schema.role_table_grants
          WHERE grantee = 'playerz_app'`,
      ),
    );

    expect(Number(g!.n)).toBe(0);
  });

  it('is a member of app_user AND app_superuser, and nothing else', async () => {
    // Both are needed: app_user for tenant-bound work, app_superuser for the
    // public cross-tenant reads and the sign-in path. Membership in anything
    // else would be a way around the two the wrappers know about.
    const rows = await asAppSuperuser(db, (tx) =>
      tx.$queryRawUnsafe<{ member_of: string }[]>(
        `SELECT r.rolname AS member_of
           FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.roleid
           JOIN pg_roles g ON g.oid = m.member
          WHERE g.rolname = 'playerz_app'
          ORDER BY 1`,
      ),
    );

    expect(rows.map((r) => r.member_of)).toEqual(['app_superuser', 'app_user']);
  });

  it('cannot create databases or roles', async () => {
    const [r] = await role();
    expect(r!.rolcreatedb).toBe(false);
    expect(r!.rolcreaterole).toBe(false);
  });
});
