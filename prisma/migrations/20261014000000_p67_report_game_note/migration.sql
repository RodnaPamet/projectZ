-- P67 (#526): a player can report the public note on a game.
--
-- A booker who opens a game may write a note on it (#376), shown on Игри and
-- on the venue page to everyone. Owner decision 2026-10-13: it can be
-- reported, and a report joins the platform's moderation queue as a reported
-- message does; removing it clears the note and the game stays.
--
--   ModerationSubject  OPEN_GAME_NOTE: the subject id is the open_game's id.
--
-- Additive: one new enum value. Rolling back past P67 parks the
-- OPEN_GAME_NOTE reports and cases first (deploy/rollback/p67-park.sql),
-- because Prisma refuses to read a value its client does not know.
SET lock_timeout = '5s';

ALTER TYPE "ModerationSubject" ADD VALUE 'OPEN_GAME_NOTE';
