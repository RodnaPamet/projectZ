-- P66 (#511): drop the P05 open-play tables, which nothing ever wired.
--
-- #376 built open play on the booking (`open_game`, `open_game_request`, P61)
-- and its chat on messaging (P63). These three described a second, different
-- open play: its own participants and count, enum skill levels, an
-- unencrypted chat. No route ever read or wrote them.
--
-- Two steps, as P60 did for Entra. The code and the models went first
-- (release train 3, 3e636c2, 2026-10-13), so every image since runs without
-- these tables and rolling back to one needs nothing. The image before that
-- still deleted from two of them when an account was deleted, and is not a
-- rollback target any more.
--
-- All three were empty on production and on staging when counted on
-- 2026-10-13. The check below is the same count, made at the moment of the
-- drop: with a single row anywhere, nothing is dropped and the migration
-- fails, rather than deleting somebody's data on an assumption.
--
-- DROP TABLE takes each table's indexes, constraints and RLS policies with it.
SET lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "session_chat_message")
     OR EXISTS (SELECT 1 FROM "session_participant")
     OR EXISTS (SELECT 1 FROM "open_play_session") THEN
    RAISE EXCEPTION 'p66: a P05 open-play table holds rows; nothing was dropped (#511)';
  END IF;
END $$;

-- Children first: both reference open_play_session.
DROP TABLE "session_chat_message";
DROP TABLE "session_participant";
DROP TABLE "open_play_session";
