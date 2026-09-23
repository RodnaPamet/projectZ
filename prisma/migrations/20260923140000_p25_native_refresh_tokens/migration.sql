-- P25 — refresh tokens for native clients.
--
-- ═══ WHY A SEPARATE SLOT FROM tokenHash ═══
--
-- `tokenHash` binds the ACCESS token to its session: the JWE carries a secret
-- and the row stores its keyed hash. Reusing that column for refresh rotation
-- would invalidate every access token already in flight on every refresh —
-- which is exactly the failure this design exists to avoid.
--
-- Rotating only `refreshTokenHash` leaves in-flight access tokens alone.
--
-- ═══ WHY A GRACE WINDOW ═══
--
-- An iOS app resumed from the app switcher fires several requests at once. All
-- of them 401 on an expired access token, and all of them call /auth/refresh
-- with the SAME refresh token within milliseconds.
--
-- Strict rotation reads the second and third as replay and revokes the session.
-- The user is logged out for using their phone normally, and it is not
-- reproducible on a developer's desk because a developer makes one request at
-- a time.
--
-- So the previous token stays acceptable briefly after rotation. Inside the
-- window a caller gets a fresh access token and the CURRENT refresh token, so
-- concurrent callers converge instead of racing. Outside it, presenting an
-- already-rotated token is the genuine replay signal.

ALTER TABLE "user_session"
  ADD COLUMN "refreshTokenHash"         TEXT,
  ADD COLUMN "previousRefreshTokenHash" TEXT,
  ADD COLUMN "previousRefreshExpiresAt" TIMESTAMP(3);

-- Unique: a refresh token identifies exactly one session. A collision would be
-- an HMAC collision, so this is an invariant rather than a real constraint —
-- but it means a bug that tried to write a duplicate fails loudly instead of
-- creating two sessions a single token can open.
CREATE UNIQUE INDEX "user_session_refreshTokenHash_key"
  ON "user_session"("refreshTokenHash");

-- Plain index, deliberately NOT unique. This is the grace-window lookup path;
-- a unique constraint here would turn an unexpected duplicate into a write
-- failure during rotation rather than a lookup that simply finds nothing.
CREATE INDEX "user_session_previousRefreshTokenHash_idx"
  ON "user_session"("previousRefreshTokenHash");
