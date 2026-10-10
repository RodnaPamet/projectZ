-- P54: messaging, module 1 (#375), ported from Agrent's exchange messaging.
--
-- P15 created the tables in 2026-07 and nothing has written to them since:
-- the use case had no caller. This migration makes them what the owner's
-- decisions on #375 need, and changes who may read them.
--
--   conversation              CLUB, a new kind (player ↔ club); one per pair
--                             (`pairKey`); the request state of a stranger's
--                             first message; a CLUB conversation's block
--   conversation_participant  `lastReadAt`, the monotonic read pointer
--   chat_message              `senderTenantId` (a staff reply is the club's),
--                             `clientMutationId` (an idempotent send), and the
--                             body as ciphertext only
--   app_user                  `searchable` — "Показвай ме в търсенето"
--
-- ═══ ADDITIVE ═══
--
-- New nullable columns, a column with a default, a new enum value, new
-- indexes, a CHECK, and policies replaced. The previous image never reads a
-- conversation (nothing called the use case), so it runs against this
-- unchanged; rolling back past P54 still parks the new enum value first,
-- because Prisma refuses to read a value its client does not know:
-- deploy/rollback/p54-park.sql.
--
-- Every statement takes a lock on a table the app uses (app_user above all),
-- so it waits five seconds at most and then fails. The file is one
-- transaction, so a failure changes nothing and the deploy is run again.
SET lock_timeout = '5s';

-- ── 1. Columns ──────────────────────────────────────────────────────────

-- Not referenced below this line as an enum literal: a value added in this
-- transaction cannot be used in it ("unsafe use of new value"). The policies
-- compare `"type"::text`, which needs no enum input.
ALTER TYPE "ConversationType" ADD VALUE 'CLUB';

ALTER TABLE "app_user" ADD COLUMN "searchable" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "chat_message" ADD COLUMN "clientMutationId" TEXT,
ADD COLUMN "senderTenantId" TEXT;

ALTER TABLE "conversation" ADD COLUMN "acceptedAt" TIMESTAMP(3),
ADD COLUMN "blockedAt" TIMESTAMP(3),
ADD COLUMN "blockedByUserId" TEXT,
ADD COLUMN "blockedSide" TEXT,
ADD COLUMN "declinedAt" TIMESTAMP(3),
ADD COLUMN "pairKey" TEXT,
ADD COLUMN "playerUserId" TEXT;

ALTER TABLE "conversation_participant" ADD COLUMN "lastReadAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "chat_message_senderId_clientMutationId_key" ON "chat_message"("senderId", "clientMutationId");
CREATE UNIQUE INDEX "conversation_pairKey_key" ON "conversation"("pairKey");
CREATE INDEX "conversation_tenantId_lastMessageAt_id_idx" ON "conversation"("tenantId", "lastMessageAt" DESC, "id" DESC);
CREATE INDEX "conversation_playerUserId_idx" ON "conversation"("playerUserId");

-- A blocked CLUB conversation names its side, and only these two.
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_blocked_side_valid"
  CHECK ("blockedSide" IS NULL OR "blockedSide" IN ('CLUB', 'PLAYER'));

-- ── 2. The body is ciphertext ───────────────────────────────────────────
--
-- `encryptField`'s `v1:` envelope (AES-256-GCM under the key derived from
-- DATA_ENCRYPTION_KEY), or '' — the tombstone a retraction or an account
-- deletion leaves. A plaintext write is an error at write time, whichever
-- code path it comes from.
--
-- Nothing has ever written a message (the use case had no caller), so there
-- should be no row to fail this. If one exists anyway — a hand-made test row —
-- it is plaintext nobody has ever been shown: it becomes a tombstone rather
-- than failing the deploy.
UPDATE "chat_message"
   SET "body" = '', "deletedAt" = COALESCE("deletedAt", CURRENT_TIMESTAMP)
 WHERE "body" <> '' AND "body" NOT LIKE 'v1:%';

ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_body_is_envelope"
  CHECK ("body" = '' OR "body" LIKE 'v1:%');

-- ── 3. Who may read a conversation: PEOPLE, not a club ──────────────────
--
-- P15's policy keyed a conversation on its tenant and read a NULL tenant as
-- "anyone": every DM was readable by every session, and its own comment said
-- the real check lived in the app layer. Agrent learned the same lesson the
-- hard way (agri-saas #1323): a conversation is private to the PEOPLE in it.
--
-- A conversation is readable by
--   - a person-participant: either player of a DM, the player of a CLUB
--     conversation (role MEMBER or PLAYER, keyed on `app.user_id`); and
--   - for a CLUB conversation, an ACTIVE OWNER, MANAGER or STAFF of its club,
--     acting FOR that club: `app.tenant_id` bound to it AND a staff membership
--     there. Both, because a player's own booking runs bound to the club's
--     tenant, and a tenant binding alone would hand that player the inbox.
--
-- A STAFF participant row is only that person's read pointer. It grants
-- nothing: somebody who leaves the club loses the inbox with the membership.
--
-- ═══ SECURITY DEFINER, AND WHY THAT IS SAFE ═══
--
-- The conversation policy reads `conversation_participant`, whose own policy
-- reads `conversation`: written directly, Postgres refuses the pair as
-- infinite recursion. And `tenant_membership` is FORCE row security keyed on
-- the tenant. So the questions are asked by functions that run as the table
-- owner. Each takes one id and answers about the CALLER only (`app.user_id`,
-- `app.tenant_id`), `search_path` is pinned, and none returns a row.

CREATE OR REPLACE FUNCTION messaging_is_person_participant(p_conversation_id text)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "conversation_participant" p
     WHERE p."conversationId" = p_conversation_id
       AND p."userId" = current_setting('app.user_id', true)
       AND p."role" IN ('MEMBER', 'PLAYER')
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION messaging_is_club_staff(p_tenant_id text)
RETURNS boolean AS $$
  SELECT p_tenant_id IS NOT NULL
     AND p_tenant_id = current_setting('app.tenant_id', true)
     AND EXISTS (
       SELECT 1 FROM "tenant_membership" m
        WHERE m."tenantId" = p_tenant_id
          AND m."userId" = current_setting('app.user_id', true)
          AND m."status" = 'ACTIVE'
          AND m."role" IN ('OWNER', 'MANAGER', 'STAFF')
     )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION messaging_can_read(p_conversation_id text)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "conversation" c
     WHERE c."id" = p_conversation_id
       AND (messaging_is_person_participant(c."id")
            OR (c."type"::text = 'CLUB' AND messaging_is_club_staff(c."tenantId")))
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- Whether the caller may write this participant row as the conversation's
-- CREATOR: before its rows exist, nothing makes the conversation readable to
-- them. Only the shape the conversation has: a DM's two MEMBERs (and no third),
-- a CLUB conversation's one PLAYER, who is its `playerUserId`. A staff member
-- who opened a club conversation can therefore never seed themselves into it
-- as a person, and keep it after leaving the club.
CREATE OR REPLACE FUNCTION messaging_may_seed(p_conversation_id text, p_user_id text, p_role text)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "conversation" c
     WHERE c."id" = p_conversation_id
       AND c."createdById" = current_setting('app.user_id', true)
       AND (
         (c."type"::text = 'DM' AND p_role = 'MEMBER'
           AND (SELECT count(*) FROM "conversation_participant" p
                 WHERE p."conversationId" = c."id") < 2)
         OR (c."type"::text = 'CLUB' AND p_role = 'PLAYER' AND p_user_id = c."playerUserId")
       )
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION messaging_is_person_participant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION messaging_is_club_staff(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION messaging_can_read(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION messaging_may_seed(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging_is_person_participant(text) TO app_user, app_superuser;
GRANT EXECUTE ON FUNCTION messaging_is_club_staff(text) TO app_user, app_superuser;
GRANT EXECUTE ON FUNCTION messaging_can_read(text) TO app_user, app_superuser;
GRANT EXECUTE ON FUNCTION messaging_may_seed(text, text, text) TO app_user, app_superuser;

-- conversation: per command, so that DELETE has no policy at all (only the
-- superuser path deletes, and nothing does).
DROP POLICY IF EXISTS tenant_isolation ON "conversation";

CREATE POLICY conversation_audience_select ON "conversation" FOR SELECT
  USING (
    messaging_is_person_participant("id")
    OR ("type"::text = 'CLUB' AND messaging_is_club_staff("tenantId"))
  );

-- A DM belongs to no club, and is started by one of its players. A CLUB
-- conversation is started by its player, or by the club's staff acting for it.
-- `tenantId IS NULL` here is not the laundering `rls-policy-shape` hunts: the
-- row is readable by participation, never by tenancy, and its identity —
-- type, tenant, pair, player, creator — is immutable (the trigger below), so it
-- cannot be re-parented into a club afterwards.
CREATE POLICY conversation_audience_insert ON "conversation" FOR INSERT
  WITH CHECK (
    "createdById" = current_setting('app.user_id', true)
    AND (
      ("type"::text = 'DM' AND "tenantId" IS NULL AND "playerUserId" IS NULL)
      OR (
        "type"::text = 'CLUB'
        AND "tenantId" IS NOT NULL
        AND "playerUserId" IS NOT NULL
        AND (
          "playerUserId" = current_setting('app.user_id', true)
          OR messaging_is_club_staff("tenantId")
        )
      )
    )
  );

CREATE POLICY conversation_audience_update ON "conversation" FOR UPDATE
  USING (
    messaging_is_person_participant("id")
    OR ("type"::text = 'CLUB' AND messaging_is_club_staff("tenantId"))
  )
  WITH CHECK (
    messaging_is_person_participant("id")
    OR ("type"::text = 'CLUB' AND messaging_is_club_staff("tenantId"))
  );

CREATE OR REPLACE FUNCTION conversation_identity_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."pairKey" IS DISTINCT FROM OLD."pairKey"
     OR NEW."playerUserId" IS DISTINCT FROM OLD."playerUserId"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById" THEN
    RAISE EXCEPTION 'a conversation''s kind, club, pair, player and creator never change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conversation_identity_immutable_trg ON "conversation";
CREATE TRIGGER conversation_identity_immutable_trg
  BEFORE UPDATE ON "conversation"
  FOR EACH ROW EXECUTE FUNCTION conversation_identity_immutable();

-- conversation_participant: everyone in a conversation may see who else is in
-- it; a person writes only their OWN pointer, except that the creator seeds
-- the rows of the conversation they started.
DROP POLICY IF EXISTS conv_isolation ON "conversation_participant";

CREATE POLICY conversation_participant_select ON "conversation_participant" FOR SELECT
  USING (
    "userId" = current_setting('app.user_id', true)
    OR messaging_can_read("conversationId")
  );

CREATE POLICY conversation_participant_insert ON "conversation_participant" FOR INSERT
  WITH CHECK (
    messaging_may_seed("conversationId", "userId", "role")
    OR (
      "userId" = current_setting('app.user_id', true)
      AND "role" = 'STAFF'
      AND messaging_can_read("conversationId")
    )
  );

CREATE POLICY conversation_participant_update ON "conversation_participant" FOR UPDATE
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));

-- chat_message: readable with its conversation; written only as yourself,
-- into a conversation you can read, and "for a club" only by its staff.
DROP POLICY IF EXISTS conv_isolation ON "chat_message";

CREATE POLICY chat_message_audience_select ON "chat_message" FOR SELECT
  USING (messaging_can_read("conversationId"));

CREATE POLICY chat_message_audience_insert ON "chat_message" FOR INSERT
  WITH CHECK (
    "senderId" = current_setting('app.user_id', true)
    AND messaging_can_read("conversationId")
    AND ("senderTenantId" IS NULL OR messaging_is_club_staff("senderTenantId"))
  );

-- A retraction: only your own message.
CREATE POLICY chat_message_audience_update ON "chat_message" FOR UPDATE
  USING (
    "senderId" = current_setting('app.user_id', true)
    AND messaging_can_read("conversationId")
  )
  WITH CHECK (
    "senderId" = current_setting('app.user_id', true)
    AND messaging_can_read("conversationId")
  );

-- ── 4. user_block: the two people it names, and only the blocker writes ──
--
-- P15 left it without row security ("blocking is GLOBAL"): global it stays,
-- since a block follows the person to every club, but who blocked whom is
-- nobody else's business. The blocked person must still SEE the row, because
-- the check that refuses them runs inside THEIR request (agri-saas's
-- ExchangeBlock lesson: a row they cannot see cannot refuse them).
ALTER TABLE "user_block" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_block" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_block_select ON "user_block";
CREATE POLICY user_block_select ON "user_block" FOR SELECT
  USING (
    "blockerId" = current_setting('app.user_id', true)
    OR "blockedId" = current_setting('app.user_id', true)
  );

DROP POLICY IF EXISTS user_block_insert ON "user_block";
CREATE POLICY user_block_insert ON "user_block" FOR INSERT
  WITH CHECK ("blockerId" = current_setting('app.user_id', true));

DROP POLICY IF EXISTS user_block_delete ON "user_block";
CREATE POLICY user_block_delete ON "user_block" FOR DELETE
  USING ("blockerId" = current_setting('app.user_id', true));

DROP POLICY IF EXISTS superuser_bypass ON "user_block";
CREATE POLICY superuser_bypass ON "user_block" TO app_superuser USING (true) WITH CHECK (true);
