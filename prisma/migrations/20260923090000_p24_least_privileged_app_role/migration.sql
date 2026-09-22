-- P24 — a login role that cannot bypass RLS.
--
-- ═══ THE PROBLEM THIS EXISTS TO FIX ═══
--
-- Every policy in this database is bypassed today, unconditionally, because of
-- one line of configuration: the application connects as `playerz`, which
-- initdb created as a cluster SUPERUSER and which owns all 57 tables.
--
-- A superuser is exempt from row security entirely. FORCE ROW LEVEL SECURITY
-- constrains the table OWNER; it does nothing about a superuser. So measured on
-- this database:
--
--   connection role     binding             rows visible
--   ---------------     ----------------    ------------
--   playerz (today)     none                1   <-- every row, every tenant
--   playerz (today)     app_user, tenant A  1
--
-- The wrappers in src/lib/db/rls-middleware.ts save us: they `SET LOCAL ROLE
-- app_user` before touching anything. But that makes RLS a CONVENTION enforced
-- by remembering to call a function, not a property of the connection. One
-- repository that reaches for the raw Prisma singleton — and one already does,
-- `listVenues` via /api/venues — runs with no row security at all and nothing
-- says a word.
--
-- ═══ WHY THE GRANT OPTION, NOT JUST NOINHERIT ═══
--
-- `playerz_app` is granted membership in app_user and app_superuser but
-- INHERITS NEITHER. It therefore holds no table privileges of its own, and a
-- query issued before `SET LOCAL ROLE` does not return the wrong rows — it
-- fails outright:
--
--   ERROR:  permission denied for table venue
--
-- That is the entire point. The failure mode of forgetting the wrapper changes
-- from "silently reads every tenant's data" to "crashes immediately, in
-- development, on the first request". A loud failure is worth far more here
-- than a safe-looking empty list: this codebase already has two places where
-- fail-closed behaviour produced an empty result that looked like real data.
--
-- With the wrapper, everything behaves exactly as before:
--
--   playerz_app        none                 permission denied
--   playerz_app        app_user, no tenant  0
--   playerz_app        app_user, tenant A   1
--   playerz_app        app_superuser        1
--
-- ═══ NO PASSWORD HERE, DELIBERATELY ═══
--
-- The role is created able to log in but with no password set. A credential
-- committed to a migration is a credential in every clone, every CI log and
-- every fork, and this repo runs a secret scanner precisely to stop that.
--
-- The operator sets it out of band:
--
--   ALTER ROLE playerz_app PASSWORD '<from the secret store>';
--
-- ═══ THIS MIGRATION ALONE CHANGES NOTHING ═══
--
-- Creating the role does not make anything use it. The application still
-- connects as whatever DATABASE_URL names. The switch is a configuration
-- change, and it is deliberately NOT made here because it needs the two-URL
-- split that prisma.config.ts already anticipates:
--
--   DIRECT_DATABASE_URL  owner (playerz)      migrations, which must own tables
--   DATABASE_URL         playerz_app          runtime, which must not
--
-- Pointing runtime at this role before that split is in place would break
-- `prisma migrate deploy`, because playerz_app cannot create a table.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'playerz_app') THEN
    -- NOINHERIT: membership grants the ABILITY to SET ROLE, never the
    -- privileges themselves. Dropping NOINHERIT silently re-opens the hole
    -- this migration closes, which is why p24-least-privileged-role asserts it.
    CREATE ROLE playerz_app LOGIN NOINHERIT;
  ELSE
    ALTER ROLE playerz_app LOGIN NOINHERIT;
  END IF;
END $$;

-- The two roles the wrappers switch to. Nothing else.
-- ─── WITH INHERIT FALSE is not decoration ───────────────────────────
--
-- PostgreSQL 16 records the inherit option PER GRANT, in
-- pg_auth_members.inherit_option — it is not read from pg_roles.rolinherit at
-- use time. The role's own NOINHERIT only supplies the DEFAULT at the moment
-- the grant is written.
--
-- Measured on this database: after `ALTER ROLE playerz_app INHERIT`, a query
-- with no SET ROLE was still denied, because the two existing grants kept
-- inherit_option = false. The role flag had stopped being the thing that
-- governs.
--
-- The trap is the other way round. Someone re-runs `GRANT app_user TO
-- playerz_app` while the role happens to be INHERIT — a routine-looking line
-- in a later migration — and the grant is re-recorded as inheriting. The role
-- then holds app_user's privileges at all times, every unwrapped query starts
-- working, and no test that looks only at rolinherit notices.
--
-- Stating it explicitly makes the grant independent of the role's state when
-- it runs. `p24-least-privileged-role` asserts inherit_option directly for the
-- same reason.
--
-- SET is left TRUE: it is what permits `SET LOCAL ROLE app_user` at all, and
-- without it the wrappers cannot work.
GRANT app_user TO playerz_app WITH INHERIT FALSE, SET TRUE;
GRANT app_superuser TO playerz_app WITH INHERIT FALSE, SET TRUE;

-- No table, sequence or schema grants. `playerz_app` is a doorway, not a role
-- that does work: everything it can do, it does as app_user or app_superuser.
-- Schema USAGE comes from PUBLIC and is not sufficient to read any table.
