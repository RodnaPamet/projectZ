-- P37: one account, one kind (#263).
--
-- Owner's decision, 2026-09-29: "it's either or - player or club
-- owner/manager/staff - using both requires two separate accounts … club
-- accounts only relate to one club … coach … a third type of account
-- altogether". Enforced everywhere; for an existing mixed account, the club
-- side wins.
--
--   PLAYER  PLAYER memberships at any number of clubs
--   CLUB    at most one ACTIVE membership, OWNER / MANAGER / STAFF, one club
--   COACH   COACH memberships only — nothing sets it yet (the coach flow)
--
-- ═══ WHY HAND-WRITTEN ═══
--
-- `prisma migrate diff` against a live database also proposes
-- `ALTER TABLE "venue" DROP COLUMN "geog"` and dropping `venue_geog_idx`,
-- which Prisma cannot model (see the migration-safety guardrail). Nothing
-- below touches `venue`. The two schema statements are exactly what Prisma
-- generates for `accountKind AccountKind? @default(PLAYER)` and for removing
-- `lastContext`; everything else is data and a trigger, which Prisma cannot
-- express at all.
--
-- ═══ IDEMPOTENT, BECAUSE A DEPLOY CAN FAIL HALF-WAY ═══
--
-- Every statement can run a second time over its own result and change
-- nothing: the type and column are created only if absent, each UPDATE
-- recomputes from memberships (which it does not change, except to expire rows
-- it would then not select again), the column drop is IF EXISTS, and the
-- functions and triggers are replaced. So a deploy that died part-way is
-- retried by resolving it rolled-back and deploying again, and
-- tests/integration/account-kind-migration.test.ts runs the whole file twice
-- over fixture data to prove it.

-- ── 1. The kind ─────────────────────────────────────────────────────────
DO $$
BEGIN
  CREATE TYPE "AccountKind" AS ENUM ('PLAYER', 'CLUB', 'COACH');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Nullable, DEFAULT 'PLAYER'. Every existing row takes the default, which on
-- Postgres 11+ is a catalogue change, not a table rewrite. NULL is written
-- below, deliberately, for the accounts nobody may decide on their behalf.
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "accountKind" "AccountKind" DEFAULT 'PLAYER';

-- ── 2. Hold membership writes while the accounts are decided ────────────
--
-- The app still running during a deploy could join a club account to a club
-- as a PLAYER between the UPDATEs below and the trigger that would refuse it,
-- and nothing would ever look again. SHARE ROW EXCLUSIVE blocks every writer
-- of the table — INSERT, UPDATE, DELETE — and no reader, until this migration
-- commits. It takes as long as the UPDATEs below, which are the whole of it.
LOCK TABLE "tenant_membership" IN SHARE ROW EXCLUSIVE MODE;

-- ── 3. Decide every account from what it holds ──────────────────────────
--
-- ACTIVE memberships only. A suspended or expired row is somebody's history,
-- not a role they hold: a player who was on a club's staff five years ago is
-- a player.

-- (a) NOT DECIDED, and left exactly as they are — memberships untouched — with
--     the kind NULL so that nothing treats them as decided:
--
--       - club roles at TWO OR MORE clubs: "club accounts only relate to one
--         club", and which club this account is, is a question for a person;
--       - any COACH role: with a club role beside it the owner said not to
--         decide, and on its own it would make a COACH account, which only the
--         coach flow may do.
--
--     `scripts/report-undecided-accounts.ts` lists them, and why.
UPDATE "app_user" AS u
SET "accountKind" = NULL
FROM (
  SELECT "userId"
  FROM "tenant_membership"
  WHERE "status" = 'ACTIVE'
  GROUP BY "userId"
  HAVING count(DISTINCT "tenantId") FILTER (WHERE "role" IN ('OWNER', 'MANAGER', 'STAFF')) >= 2
      OR bool_or("role" = 'COACH')
) AS held
WHERE u."id" = held."userId"
  AND u."accountKind" IS NOT NULL;

-- (b) CLUB SIDE WINS: one club role, no coach role → a CLUB account, which
--     plays nowhere. So its ACTIVE PLAYER memberships end…
--
--     EXPIRED, not SUSPENDED: SUSPENDED is a club's deliberate act, and each of
--     these clubs would then show a player it never suspended. EXPIRED says the
--     membership lapsed. The rows are kept, and nothing touches `booking`, so
--     every booking made on them still has its player, its receipt and its
--     club — "keep their bookings".
--
--     …FIRST, and only then does the kind change. The other order makes the
--     account, for one statement, a CLUB account that still plays — and on a
--     re-run the trigger at the bottom of this file already exists and refuses
--     exactly that (measured: tests/integration/account-kind-migration.test.ts
--     failed on it). In this order a re-run is safe with or without it.
UPDATE "tenant_membership" AS m
SET "status" = 'EXPIRED',
    "deactivatedAt" = now(),
    "updatedAt" = now()
FROM (
  SELECT "userId"
  FROM "tenant_membership"
  WHERE "status" = 'ACTIVE'
  GROUP BY "userId"
  HAVING count(DISTINCT "tenantId") FILTER (WHERE "role" IN ('OWNER', 'MANAGER', 'STAFF')) = 1
     AND NOT bool_or("role" = 'COACH')
) AS wins
WHERE m."userId" = wins."userId"
  AND m."role" = 'PLAYER'
  AND m."status" = 'ACTIVE';

UPDATE "app_user" AS u
SET "accountKind" = 'CLUB'
FROM (
  SELECT "userId"
  FROM "tenant_membership"
  WHERE "status" = 'ACTIVE'
  GROUP BY "userId"
  HAVING count(DISTINCT "tenantId") FILTER (WHERE "role" IN ('OWNER', 'MANAGER', 'STAFF')) = 1
     AND NOT bool_or("role" = 'COACH')
) AS wins
WHERE u."id" = wins."userId"
  AND u."accountKind" IS DISTINCT FROM 'CLUB';

-- Everybody else keeps the default, PLAYER: PLAYER memberships only, or none.

-- ── 4. The switcher's column goes with the switcher ─────────────────────
--
-- `lastContext` (#227) remembered which of several contexts somebody chose.
-- One kind is one context.
ALTER TABLE "app_user" DROP COLUMN IF EXISTS "lastContext";

-- ── 5. The guarantee ────────────────────────────────────────────────────
--
-- The application refuses the mixes with a message. This refuses them WITHOUT
-- one, for every writer the application does not know about: a script, a
-- console, a future use case, a race between two of its own.
--
-- ═══ A TRIGGER, NOT A UNIQUE INDEX ═══
--
-- "At most one ACTIVE club-role membership per CLUB account" looks like a
-- partial unique index on "userId". It cannot be one. An index covers every
-- row or none of the rows its predicate selects, its predicate cannot read
-- `app_user`, and the accounts in (a) above already hold club roles at two
-- clubs — so building it would fail on exactly the data the owner said to
-- leave alone, and the deploy with it. A trigger holds every DECIDED account
-- and skips the undecided until a person decides them.
--
-- ═══ SECURITY DEFINER, AND WHY THAT IS SAFE ═══
--
-- `tenant_membership` carries FORCE row security keyed on one tenant, and the
-- question — "what else does this person hold?" — spans every tenant. A staff
-- action bound to club A would otherwise see only club A and pass a second
-- club. So the checks run as the table owner. They take nothing from the
-- caller but the row the caller wrote, `search_path` is pinned, and the shared
-- helper is not executable by anybody else.
--
-- ═══ RACE-FREE UNDER READ COMMITTED ═══
--
-- Two invitations accepted at once, at two clubs, would each count one club and
-- both commit. So the check first locks the person's `app_user` row: the second
-- waits for the first to commit, and its count — a new statement, so a new
-- snapshot — then includes the first. Every writer of memberships runs at READ
-- COMMITTED; a SERIALIZABLE one would abort instead, which is also safe.

CREATE OR REPLACE FUNCTION account_kind_assert(p_user_id text) RETURNS void AS $$
DECLARE
  kind "AccountKind";
  clubs integer;
BEGIN
  SELECT u."accountKind" INTO kind
  FROM "app_user" AS u
  WHERE u."id" = p_user_id
  FOR NO KEY UPDATE;

  -- A deleted account holds nothing, and an undecided one is left for a person.
  IF NOT FOUND OR kind IS NULL THEN
    RETURN;
  END IF;

  IF kind = 'PLAYER' AND EXISTS (
    SELECT 1 FROM "tenant_membership"
    WHERE "userId" = p_user_id AND "status" = 'ACTIVE' AND "role" <> 'PLAYER'
  ) THEN
    RAISE EXCEPTION
      'account_kind_player_roles: account % is a PLAYER account, which holds PLAYER memberships only. A club or coach role needs a separate account (#263).',
      p_user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_kind_player_roles';
  END IF;

  IF kind = 'COACH' AND EXISTS (
    SELECT 1 FROM "tenant_membership"
    WHERE "userId" = p_user_id AND "status" = 'ACTIVE' AND "role" <> 'COACH'
  ) THEN
    RAISE EXCEPTION
      'account_kind_coach_roles: account % is a COACH account, which holds COACH memberships only (#263).',
      p_user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_kind_coach_roles';
  END IF;

  IF kind = 'CLUB' THEN
    IF EXISTS (
      SELECT 1 FROM "tenant_membership"
      WHERE "userId" = p_user_id AND "status" = 'ACTIVE'
        AND "role" NOT IN ('OWNER', 'MANAGER', 'STAFF')
    ) THEN
      RAISE EXCEPTION
        'account_kind_club_roles: account % is a CLUB account, which holds OWNER, MANAGER or STAFF only. Playing or coaching needs a separate account (#263).',
        p_user_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'account_kind_club_roles';
    END IF;

    SELECT count(DISTINCT "tenantId") INTO clubs
    FROM "tenant_membership"
    WHERE "userId" = p_user_id AND "status" = 'ACTIVE'
      AND "role" IN ('OWNER', 'MANAGER', 'STAFF');

    IF clubs > 1 THEN
      RAISE EXCEPTION
        'account_kind_one_club: account % is a CLUB account, which belongs to one club; this would make it % (#263).',
        p_user_id, clubs
        USING ERRCODE = 'check_violation', CONSTRAINT = 'account_kind_one_club';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- Reachable only through the triggers below, which run as its owner.
REVOKE ALL ON FUNCTION account_kind_assert(text) FROM PUBLIC;

-- A membership that is ACTIVE afterwards is the only kind that can break a
-- rule. Suspending, expiring or deleting one only ever brings an account
-- closer to its kind, so those are not checked.
CREATE OR REPLACE FUNCTION account_kind_membership_check() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'ACTIVE' THEN
    PERFORM account_kind_assert(NEW."userId");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS account_kind_membership_trg ON "tenant_membership";
CREATE TRIGGER account_kind_membership_trg
  AFTER INSERT OR UPDATE OF "userId", "role", "status" ON "tenant_membership"
  FOR EACH ROW EXECUTE FUNCTION account_kind_membership_check();

-- Changing what an account IS must fit what it already holds: a CLUB account
-- cannot be turned into a PLAYER while it still runs a club.
CREATE OR REPLACE FUNCTION account_kind_user_check() RETURNS trigger AS $$
BEGIN
  PERFORM account_kind_assert(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS account_kind_user_trg ON "app_user";
CREATE TRIGGER account_kind_user_trg
  AFTER UPDATE OF "accountKind" ON "app_user"
  FOR EACH ROW EXECUTE FUNCTION account_kind_user_check();
