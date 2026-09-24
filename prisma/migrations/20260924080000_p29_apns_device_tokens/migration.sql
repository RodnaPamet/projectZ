-- ════════════════════════════════════════════════════════════════════
--  P29 — APNs DEVICE TOKENS
--
--  A separate table from `push_subscription`, deliberately.
--
--  Web Push and APNs share intent and nothing else. `push_subscription`
--  stores an `endpoint` URL that is unique because it IS the address,
--  plus `p256dh` and `auth` — the browser's keys, used so the push
--  service cannot read the payload it relays.
--
--  APNs has no endpoint, no per-device keys (the connection is
--  authenticated to Apple with a JWT signed by a .p8), and different
--  failure semantics: Apple's BadDeviceToken/Unregistered is permanent
--  in a way a Web Push 500 is not.
--
--  One table would mean a discriminator, half the columns inapplicable
--  per row, and `endpoint UNIQUE` — what stops a browser accumulating
--  duplicate rows — no longer being the right key for either.
--
--  ── ENVIRONMENT IS PART OF THE KEY ──────────────────────────────────
--
--  SANDBOX and PRODUCTION are different APNs hosts with different token
--  namespaces. The same hex string can legitimately exist in both. Keying
--  uniqueness on the token alone would let a developer's debug build
--  evict their own production registration — and produce the classic
--  "works in TestFlight, not in the App Store", which looks like a
--  certificate problem and is not.
--
--  ── OWNER-ONLY RLS, NOT TENANT ──────────────────────────────────────
--
--  A device belongs to a PERSON, not a club. Your phone receives your
--  notifications at every club you belong to — the same reasoning
--  push_subscription and notification already encode.
--
--  So the policy is keyed on app.user_id, mirroring
--  push_subscription_owner_only from P22. Handing a device token to
--  another user is handing them a megaphone aimed at somebody else's
--  lock screen.
-- ════════════════════════════════════════════════════════════════════

CREATE TYPE "ApnsEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

CREATE TABLE "device_token" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceToken" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "environment" "ApnsEnvironment" NOT NULL DEFAULT 'PRODUCTION',
    "deviceName" TEXT,
    "osVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "device_token_pkey" PRIMARY KEY ("id")
);

-- Environment is part of the key. See above.
CREATE UNIQUE INDEX "device_token_deviceToken_environment_key"
  ON "device_token"("deviceToken", "environment");

CREATE INDEX "device_token_userId_idx" ON "device_token"("userId");

ALTER TABLE "device_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "device_token" FORCE ROW LEVEL SECURITY;

CREATE POLICY device_token_owner_only ON "device_token"
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, app_superuser;
