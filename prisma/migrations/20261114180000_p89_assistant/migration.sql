-- P89: «Асистент» for players (owner 2026-11-14, #704), ported from agri-saas.
--
-- Four tables, every one the PERSON's: owner-only on app.user_id, failing
-- closed when it is unset, like the favourite clubs (P87) and the calendar
-- connection (P88). There is no tenant: a player's questions span every club.
--
--   assistant_conversation  one conversation, continued by its id
--   assistant_turn          its questions and the answers that were sent
--   assistant_memory_fact   the short profile, learned from the person's words
--   assistant_spend         what the assistant cost them per day, for the cap
--
-- The one thing that is nobody in particular is the memory sweep, a timer that
-- finds the conversations due across people; it reads ids and times only, as
-- app_superuser, and then works as each person (superuser-call-sites).
--
-- Additive: new tables the previous image never names.

CREATE TABLE "assistant_conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTurnAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extractedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "assistant_conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assistant_turn" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_turn_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assistant_turn_role" CHECK ("role" IN ('user', 'assistant'))
);

CREATE TABLE "assistant_memory_fact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    -- Rule 3: the person's own sentence. A point without one cannot exist.
    "sourceQuote" TEXT NOT NULL,
    "sourceAt" TIMESTAMPTZ(3) NOT NULL,
    "editedByPerson" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMPTZ(3),
    "supersededAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_memory_fact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assistant_memory_fact_quote" CHECK (length("sourceQuote") > 0)
);

CREATE TABLE "assistant_spend" (
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_spend_pkey" PRIMARY KEY ("userId","day")
);

CREATE INDEX "assistant_conversation_userId_deletedAt_lastTurnAt_idx" ON "assistant_conversation"("userId", "deletedAt", "lastTurnAt");
CREATE INDEX "assistant_conversation_extractedAt_lastTurnAt_idx" ON "assistant_conversation"("extractedAt", "lastTurnAt");
CREATE INDEX "assistant_turn_conversationId_createdAt_idx" ON "assistant_turn"("conversationId", "createdAt");
CREATE INDEX "assistant_turn_userId_idx" ON "assistant_turn"("userId");
CREATE INDEX "assistant_memory_fact_userId_deletedAt_sourceAt_idx" ON "assistant_memory_fact"("userId", "deletedAt", "sourceAt");

ALTER TABLE "assistant_turn" ADD CONSTRAINT "assistant_turn_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "assistant_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Who may read and write them: the person, as themselves ──────────────

ALTER TABLE "assistant_conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_conversation" FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_conversation_owner_only ON "assistant_conversation"
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));
GRANT SELECT, INSERT, UPDATE ON "assistant_conversation" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_conversation" TO app_superuser;

ALTER TABLE "assistant_turn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_turn" FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_turn_owner_only ON "assistant_turn"
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));
GRANT SELECT, INSERT ON "assistant_turn" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_turn" TO app_superuser;

-- No DELETE for app_user: «Изтрий» tombstones a point (rule 5), it never
-- removes the row the sweep needs to refuse to learn it again.
ALTER TABLE "assistant_memory_fact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_memory_fact" FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_memory_fact_owner_only ON "assistant_memory_fact"
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));
GRANT SELECT, INSERT, UPDATE ON "assistant_memory_fact" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_memory_fact" TO app_superuser;

ALTER TABLE "assistant_spend" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_spend" FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_spend_owner_only ON "assistant_spend"
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));
GRANT SELECT, INSERT, UPDATE ON "assistant_spend" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_spend" TO app_superuser;

-- ─── A deleted account gains nothing new (P69, #465) ─────────────────────

DROP TRIGGER IF EXISTS assistant_conversation_account_not_deleted_trg ON "assistant_conversation";
CREATE TRIGGER assistant_conversation_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "assistant_conversation"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS assistant_turn_account_not_deleted_trg ON "assistant_turn";
CREATE TRIGGER assistant_turn_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "assistant_turn"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS assistant_memory_fact_account_not_deleted_trg ON "assistant_memory_fact";
CREATE TRIGGER assistant_memory_fact_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "assistant_memory_fact"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS assistant_spend_account_not_deleted_trg ON "assistant_spend";
CREATE TRIGGER assistant_spend_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "assistant_spend"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');
