-- P70 (#544, module 3): a COACH account also plays.
--
-- Owner decision, 2026-10-14 (#377, decision 3): "a coach account can do
-- everything a player can, plus teach. One sign-in for a coach who also plays."
--
-- P37 made the kinds strict: a COACH account holds COACH memberships only. But
-- playing somewhere IS a PLAYER membership: booking a court at a club joins
-- the club as a player (#229), and a place on somebody's booking does the same.
-- So with P37's rule a coach could never book anywhere they do not teach.
--
-- The rule becomes: a COACH account holds COACH memberships (where it
-- teaches) and PLAYER memberships (where it only plays). It still holds no
-- club role: running a club is a CLUB account's, as before.
--
-- Nothing else moves. PLAYER and CLUB accounts are held exactly as P37 holds
-- them, the function is still reachable only through its two triggers, and it
-- still takes the row lock that makes two concurrent joins see each other.
-- `CREATE OR REPLACE` swaps the body in place: the triggers keep pointing at it.
--
-- Rollback: the previous image refuses a coach's booking in code before it
-- reaches the database, so it never writes what this allows. A coach's PLAYER
-- memberships written by the newer image stay valid rows for it to read.
SET lock_timeout = '5s';

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

  -- P70: COACH where it teaches, PLAYER where it only plays. Never a club role.
  IF kind = 'COACH' AND EXISTS (
    SELECT 1 FROM "tenant_membership"
    WHERE "userId" = p_user_id AND "status" = 'ACTIVE'
      AND "role" NOT IN ('COACH', 'PLAYER')
  ) THEN
    RAISE EXCEPTION
      'account_kind_coach_roles: account % is a COACH account, which teaches (COACH) and plays (PLAYER). Running a club needs a separate account (#263, #377).',
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

-- As P37 left it: reachable only through the triggers, which run as its owner.
REVOKE ALL ON FUNCTION account_kind_assert(text) FROM PUBLIC;
