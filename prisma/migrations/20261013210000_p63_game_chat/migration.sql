SET lock_timeout = '5s';

-- P63: the game chat (#376, owner decision 2026-10-13, rule 3). A GROUP
-- conversation of the booker and every player accepted into their open game.
-- It stays open as an ordinary group chat after the game; somebody who leaves
-- the game before it is played leaves the chat (`leftAt`).
--
-- Rolling back past this needs nothing: GROUP is a P15 value the previous
-- image's client knows and never reads (its inbox asks for DM and CLUB only),
-- the column is new, and both changes below only narrow who reads or writes.

-- The game's chat, made when the booker accepts the first player.
ALTER TABLE "open_game" ADD COLUMN "conversationId" TEXT;
CREATE UNIQUE INDEX "open_game_conversationId_key" ON "open_game"("conversationId");

-- ── A member who left reads the conversation no more ────────────────────
--
-- P54's helper admitted any person-participant row. A row is KEPT on leave,
-- with `leftAt` set, so that the departed member does not vanish from the
-- others' history (messaging.prisma) — which made "has a row" the wrong
-- question as soon as anybody could leave. Until now nobody could, except a
-- deleted account (whose `leftAt` P52's deletion sets, and who never signs in
-- again). With the game chat somebody can: they left the game before it was
-- played. Every policy built on this helper — the conversation, its
-- participants and its messages, reading and writing — follows.
CREATE OR REPLACE FUNCTION messaging_is_person_participant(p_conversation_id text)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "conversation_participant" p
     WHERE p."conversationId" = p_conversation_id
       AND p."userId" = current_setting('app.user_id', true)
       AND p."role" IN ('MEMBER', 'PLAYER')
       AND p."leftAt" IS NULL
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- ── Membership is not the member's to change ────────────────────────────
--
-- `conversation_participant_update` lets a person update their OWN row, which
-- is how their read pointer moves. It cannot tell which columns changed, so a
-- member could otherwise clear their own `leftAt` and walk back into a game
-- chat they were taken out of. Who is in a conversation is written by the
-- server's own binding (the game's roster, `syncGameChat`), never by
-- app_user, so app_user may move its read pointer and its mute, and nothing
-- else.
CREATE OR REPLACE FUNCTION conversation_participant_membership_fixed() RETURNS trigger AS $$
BEGIN
  IF current_user = 'app_user' AND (
       NEW."conversationId" IS DISTINCT FROM OLD."conversationId"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."role" IS DISTINCT FROM OLD."role"
    OR NEW."leftAt" IS DISTINCT FROM OLD."leftAt"
    OR NEW."joinedAt" IS DISTINCT FROM OLD."joinedAt"
  ) THEN
    RAISE EXCEPTION 'who is in a conversation is not changed by its members'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conversation_participant_membership_fixed_trg ON "conversation_participant";
CREATE TRIGGER conversation_participant_membership_fixed_trg
  BEFORE UPDATE ON "conversation_participant"
  FOR EACH ROW EXECUTE FUNCTION conversation_participant_membership_fixed();
