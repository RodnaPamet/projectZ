// Side effect — set Zod's `jitless` flag (browser only) before this
// module's own client env-validation parse, which would otherwise be the
// first thing to trigger Zod's CSP-violating `new Function` probe. See
// src/lib/zod-jitless.ts.
import '@/lib/zod-jitless';
import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';
import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from '@/lib/security/encryption-constants';

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url(),
    // Direct connection to Postgres (bypasses PgBouncer).
    // Used by Prisma for migrations, schema push, and introspection.
    // Falls back to DATABASE_URL if not set (non-pooled environments).
    DIRECT_DATABASE_URL: z.string().url().optional(),
    // Read-replica connection string (via the replica's PgBouncer).
    // When set, reads explicitly marked as replica-tolerant
    // (dashboards, aggregations, reporting) route to the replica via
    // `prismaRead` + `runInTenantReadContext`; writes + read-after-write
    // + auth/billing stay on DATABASE_URL. Unset = single-DB mode
    // (all traffic on DATABASE_URL). See docs/database-routing.md.
    DATABASE_READ_URL: z.string().url().optional(),

    // Redis (rate limits, BullMQ jobs, session/cache coordination)
    //
    // Schema layer carries the optional() shape so dev/test boots
    // without Redis (rate-limit middleware + audit-stream buffer
    // both fall back to in-memory). The production-required
    // contract is enforced by the per-field superRefine() below
    // (mirrors the GAP-03 DATA_ENCRYPTION_KEY pattern).
    //
    // GAP-13 — Redis is REQUIRED in production. Without it three
    // production-load-bearing controls collapse into no-ops:
    //   - login brute-force throttle (Epic A.3)
    //   - invite-redemption rate limit
    //   - email-dispatch rate limit
    // Refuse to boot rather than ship with the limits stripped.
    //
    // Production also requires the Redis URL to be AUTHENTICATED:
    // a bare `redis://host:6379` (no password) is rejected. An
    // unauthenticated Redis that is network-reachable is wide
    // open — anyone who can reach the port can read sessions,
    // dump rate-limit counters, and enqueue jobs. The URL must
    // parse and carry a non-empty password in its userinfo
    // (`redis://:PASSWORD@HOST:6379`, `redis://user:pw@host`, or
    // `rediss://:token@host` for TLS managed Redis). The
    // `rediss://` scheme is NOT required — a same-host compose
    // service on an internal docker network is acceptable with
    // password auth alone.
    REDIS_URL: z
      .string()
      .optional()
      .superRefine((val, ctx) => {
        if (process.env.NODE_ENV !== 'production') return;
        if (!val) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'REDIS_URL is REQUIRED in production. ' +
              'Rate limits, queues, and session coordination depend on it. ' +
              'Set REDIS_URL to your Redis / ElastiCache connection string ' +
              '(e.g. redis://:PASSWORD@HOST:6379) before deploying.',
          });
          return;
        }
        let url: URL;
        try {
          url = new URL(val);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'REDIS_URL is not a valid URL. ' +
              'Expected redis://:PASSWORD@HOST:6379 ' +
              '(or rediss:// for TLS).',
          });
          return;
        }
        if (!url.password) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'REDIS_URL must be AUTHENTICATED in production. ' +
              'A bare redis://HOST:6379 leaves Redis open to anyone ' +
              'who can reach the port — sessions, rate-limit counters, ' +
              'and the job queue all live there. Set a password: ' +
              'redis://:PASSWORD@HOST:6379 (or rediss:// for TLS).',
          });
        }
      }),

    // NextAuth
    NEXTAUTH_URL: z.preprocess(
      // This makes Vercel deployments not fail if you don't set NEXTAUTH_URL
      // Since NextAuth automatically uses the VERCEL_URL if present.
      (str) => (process.env.VERCEL_URL ? process.env.VERCEL_URL : str),
      process.env.VERCEL ? z.string().optional() : z.string().url(),
    ),
    AUTH_URL: z.preprocess(
      (str) => (process.env.VERCEL_URL ? process.env.VERCEL_URL : str),
      process.env.VERCEL ? z.string().optional() : z.string().url(),
    ),
    AUTH_SECRET: z.string().min(16, 'AUTH_SECRET must be at least 16 characters long'),
    JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters long'),

    // Providers
    GOOGLE_CLIENT_ID: z.string().min(1, 'Google Client ID is required'),
    GOOGLE_CLIENT_SECRET: z.string().min(1, 'Google Client Secret is required'),
    MICROSOFT_CLIENT_ID: z.string().min(1, 'Microsoft Client ID is required'),
    MICROSOFT_CLIENT_SECRET: z.string().min(1, 'Microsoft Client Secret is required'),
    MICROSOFT_TENANT_ID: z.string().default('common'),

    // Rate Limiting
    RATE_LIMIT_ENABLED: z.enum(['0', '1']).optional(),
    RATE_LIMIT_MODE: z.enum(['upstash', 'memory']).default('upstash'),
    AUTH_TEST_MODE: z.enum(['0', '1']).optional(),
    // When "1", the Credentials provider rejects sign-ins whose User row
    // has `emailVerified = null`. See src/lib/auth/credentials.ts. Default
    // is OFF so existing deployments behave unchanged until verification
    // flow ships.
    AUTH_REQUIRE_EMAIL_VERIFICATION: z.enum(['0', '1']).optional(),
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

    // File Storage
    UPLOAD_DIR: z.string().min(1, 'UPLOAD_DIR must be specified'),
    FILE_STORAGE_ROOT: z.string().optional(),
    FILE_MAX_SIZE_BYTES: z.coerce.number().optional(),
    FILE_ALLOWED_MIME: z.string().optional(),

    // Cloud Storage (S3/R2/MinIO)
    STORAGE_PROVIDER: z.enum(['local', 's3']).default('s3'),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    // AV Scanning
    AV_WEBHOOK_SECRET: z.string().optional(), // HMAC secret for webhook auth
    AV_SCAN_MODE: z.enum(['strict', 'permissive', 'disabled']).default('strict'),
    CLAMAV_HOST: z.string().optional(), // ClamAV daemon host (e.g. clamav:3310)

    // Agent-action receipts (pipelock mediator). The mediator's Ed25519
    // PUBLIC signing key — used to VERIFY ingested action receipts. NOT a
    // secret (public half of the keypair); the private half stays with the
    // pipelock daemon and is never stored here. Accepts base64 or hex; the
    // ingest usecase normalises it. Absent ⇒ every receipt is flagged
    // verified:false (fail-safe: unverifiable, never auto-trusted).
    PIPELOCK_PUBLIC_KEY: z.string().optional(),
    // Strict-mode hook (default OFF). When "1", the MCP guard seam may
    // reject agent tool actions that arrive without a valid verified
    // receipt. Off by default — balanced (detect+sign) is the norm.
    PIPELOCK_STRICT_MODE: z.enum(['0', '1']).default('0'),

    // Data Protection (Epic 8) — GAP-03 enforcement.
    //
    // Schema layer: optional() carries the *shape* (string ≥32 chars
    // when present). The production-required + dev-fallback-rejection
    // contract is enforced by the per-field superRefine() below,
    // which reads the same `process.env.NODE_ENV` the schema is
    // about to validate. Two-stage so the field-level error message
    // points at DATA_ENCRYPTION_KEY rather than a top-level object
    // refinement that prints the whole env shape.
    DATA_ENCRYPTION_KEY: z
      .string()
      .min(32, 'DATA_ENCRYPTION_KEY must be at least 32 characters')
      .optional()
      .superRefine((val, ctx) => {
        // GAP-03 — production cannot boot without an encryption
        // key. Read NODE_ENV from process.env directly because
        // the parsed `env.NODE_ENV` is not yet available at
        // refine time (zod parses fields independently).
        if (process.env.NODE_ENV !== 'production') return;
        if (!val) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'DATA_ENCRYPTION_KEY is REQUIRED in production. ' +
              'Generate with: openssl rand -base64 48',
          });
          return;
        }
        if (val === DEV_FALLBACK_DATA_ENCRYPTION_KEY) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'DATA_ENCRYPTION_KEY equals the documented dev ' +
              'fallback. Refusing to boot — generate a real ' +
              'key with: openssl rand -base64 48',
          });
        }
      }),
    // Epic B.3 — master KEK rotation. When set, the old key is used
    // as a decrypt fallback for any ciphertext the new primary KEK
    // can't read. Encryption always uses DATA_ENCRYPTION_KEY
    // (primary). Remove this var ONCE the rotation job reports zero
    // remaining v1 rows under the previous key.
    DATA_ENCRYPTION_KEY_PREVIOUS: z.string().min(32).optional(),

    // Security / CORS
    CORS_ALLOWED_ORIGINS: z.string().default(''),

    // SMTP / Email (all optional — when SMTP_HOST is absent, console sink is used)
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    // Was `noreply@inflect.app` — a leftover from the compliance product this
    // codebase started as, which would have put another company's domain in
    // the From header of every invite.
    SMTP_FROM: z.string().default('noreply@playerz.bg'),

    // Web Push (VAPID). Optional: without them push is simply not sent, and the
    // notification CENTRE still has the row — the user sees it when they open
    // the app. Push is an enhancement, never the source of truth.
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    VAPID_SUBJECT: z.string().optional(),

    // APNs (native iOS push). Optional for the same reason as VAPID above: the
    // notification CENTRE keeps the row either way, so push is an enhancement.
    //
    // ═══ WHY THESE ARE DECLARED EVEN THOUGH apns.ts READS process.env ═══
    //
    // `src/lib/push/apns.ts:85-87` reads all three straight from process.env
    // and returns null if any is missing, disabling the whole APNs path. That
    // guard is correct — push must not throw into whatever was trying to notify
    // somebody — but combined with NOT being declared here it meant APNs was
    // invisible to the config surface entirely. A deploy that intended to have
    // native push on had no way to discover it did not: no validation, no
    // warning, no health signal.
    //
    // `send.ts` reads VAPID from process.env too, so reading-at-use is the
    // house style. Being DECLARED is what makes a variable part of the
    // documented surface, and that is the asymmetry this fixes.
    //
    // The private key is the PKCS#8 PEM Apple issues. `\n` escapes are accepted
    // and restored by apns.ts, because newlines survive an env var badly.
    APNS_KEY_ID: z.string().optional(),
    APNS_TEAM_ID: z.string().optional(),
    APNS_PRIVATE_KEY: z.string().optional(),

    // The SANDBOX pair, because an APNs auth key can be scoped to ONE
    // environment and both of this account's are: each is refused by the other
    // with `BadEnvironmentKeyInToken`, measured against Apple.
    //
    // A debug build of the iOS client registers against SANDBOX; TestFlight and
    // the App Store register against PRODUCTION. One key reaches half the
    // devices. Two scoped keys is also the safer arrangement — a development
    // key that leaks cannot notify real users.
    //
    // Unset falls back to the pair above, so a deployment with a single
    // both-environment key needs no change.
    APNS_KEY_ID_SANDBOX: z.string().optional(),
    APNS_PRIVATE_KEY_SANDBOX: z.string().optional(),

    // The Prometheus scrape token. Optional — and when it is ABSENT the metrics
    // endpoint returns 404 rather than serving. A missing secret must never mean
    // "no security".
    METRICS_TOKEN: z.string().optional(),

    // Stripe Billing
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    // One per paid PlanTier. The names must match `enum PlanTier`
    // (FREE | CLUB | PRO) — this was STRIPE_PRICE_ID_ENTERPRISE, a tier that
    // does not exist in the schema or in the commission table, while CLUB (the
    // 3% middle tier) had no price id at all. Neither variable was read
    // anywhere, so nothing ever forced the two to agree.
    STRIPE_PRICE_ID_PRO: z.string().optional(),
    STRIPE_PRICE_ID_CLUB: z.string().optional(),
    APP_URL: z.string().url().optional(),

    // AI Risk Assessment
    AI_RISK_PROVIDER: z.string().default('stub'),
    AI_QUESTIONNAIRE_PROVIDER: z.string().default('stub'),
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_MODEL: z.string().optional(),
    // Local / self-hosted AI gateway (AI sovereignty). Base URL of an
    // OpenAI-compatible endpoint (Ollama / vLLM / …); model name; optional
    // bearer. Used when AI_RISK_PROVIDER=local or a tenant sets
    // aiResidency=LOCAL_ONLY (a per-tenant override wins over these).
    AI_LOCAL_BASE_URL: z.string().optional(),
    AI_LOCAL_MODEL: z.string().optional(),
    AI_LOCAL_API_KEY: z.string().optional(),
    AI_RISK_DAILY_QUOTA: z.string().optional(),
    AI_RISK_USER_RPM: z.string().optional(),
    // Global AI kill switch. 'false' disables EVERY AI feature
    // (risk suggestions, assistant, questionnaire autofill).
    AI_RISK_ENABLED: z.string().default('true'),
    AI_RISK_PLAN_REQUIRED: z.string().default(''),
    // Per-feature enable flags (GAP-2). Each defaults 'true' and is
    // ANDed with the global AI_RISK_ENABLED master switch, so an
    // operator can disable one feature without touching the others.
    AI_RISK_SUGGESTIONS_ENABLED: z.string().default('true'),
    AI_ASSISTANT_ENABLED: z.string().default('true'),
    AI_QUESTIONNAIRE_ENABLED: z.string().default('true'),

    // AI Compliance-Posture Summary (dashboard hero, daily cron).
    // 'stub' (default) is fully functional with zero config; 'anthropic'
    // / 'openrouter' opt in to a real LLM narrative (keys below).
    AI_POSTURE_PROVIDER: z.string().default('stub'),
    // Direct Claude API — used when AI_POSTURE_PROVIDER=anthropic.
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5'),

    // Audit stream delivery retry (Epic E.2)
    // '0' disables retry (single POST); anything else (or unset) keeps retry on.
    // Kill-switch for debugging a misbehaving SIEM without redeploy.
    AUDIT_STREAM_RETRY_ENABLED: z.string().optional(),

    // Continuous vendor monitoring (vendor-monitoring job).
    // VENDOR_MONITOR_ENABLED='0' disables the daily sweep. The provider
    // vars pick the signal source — default 'stub' is deterministic +
    // network-free (CI-safe); 'hibp-domain' / 'header-grade' hit the real
    // free public feeds. Anything else falls back to the stub.
    VENDOR_MONITOR_ENABLED: z.enum(['0', '1']).optional(),
    VENDOR_MONITOR_BREACH_PROVIDER: z.string().default('stub'),
    VENDOR_MONITOR_TLS_PROVIDER: z.string().default('stub'),

    // NVD CVE ingestion (vuln integration).
    // NVD_SYNC_ENABLED='0' disables the daily nvd-cve-sync job — for
    // air-gapped deployments that cannot reach services.nvd.nist.gov.
    // Anything else (or unset) keeps it on.
    NVD_SYNC_ENABLED: z.enum(['0', '1']).optional(),
    // Optional NVD API key. Without it NVD throttles to ~5 req / 30s;
    // with it, ~50 req / 30s. The sync paces itself to respect both.
    NVD_API_KEY: z.string().optional(),

    // PLATFORM_ADMIN_API_KEY and its _PREVIOUS rotation slot lived here and
    // were read by NOTHING. They described a shared bearer secret for a
    // tenant-creation endpoint (POST /api/admin/tenants) that does not exist.
    //
    // Removed with P31, which gives platform authority a real identity: a
    // `platform_admin_grant` row naming a person, a granter, a reason, a
    // capability list and an expiry, with every use written to an append-only
    // audit table by a database trigger. A shared secret has none of that — no
    // owner, no expiry, no audit trail, and no revocation short of a redeploy.
    //
    // Leaving it declared was the hazard: it invited someone to wire the shared
    // secret as the human admin's credential, which is how this capability came
    // to be half-built twice (`appPermissions` was the other half).

    // Local zone for task-due deadline notifications — sets BOTH the
    // cron firing time AND the calendar-day classification ("due
    // today / tomorrow / in a week"). Must be one zone so a task
    // due near local midnight is not mis-bucketed. IANA zone name,
    // DST-aware; defaults to Europe/London.
    NOTIFICATIONS_TZ: z
      .string()
      .default('Europe/London')
      .refine(
        (val) => {
          try {
            // A bad zone makes the formatter throw RangeError.
            new Intl.DateTimeFormat('en-US', { timeZone: val });
            return true;
          } catch {
            return false;
          }
        },
        { message: 'NOTIFICATIONS_TZ must be a valid IANA timezone' },
      ),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    // PR-C 2026-05-27 — opt-in flag for the SSE notification
    // bell. Off by default (the bell stays on REST polling)
    // until the client integration is verified end-to-end in
    // a real browser. Server-side stream is wired regardless;
    // flipping this to '1' is the only step to engage SSE.
    NEXT_PUBLIC_NOTIFICATIONS_SSE: z.enum(['0', '1']).optional(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL,
    DATABASE_READ_URL: process.env.DATABASE_READ_URL,
    REDIS_URL: process.env.REDIS_URL,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    AUTH_URL: process.env.AUTH_URL,
    AUTH_SECRET: process.env.AUTH_SECRET,
    JWT_SECRET: process.env.JWT_SECRET,

    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
    MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID,

    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
    RATE_LIMIT_MODE: process.env.RATE_LIMIT_MODE,
    AUTH_TEST_MODE: process.env.AUTH_TEST_MODE,
    AUTH_REQUIRE_EMAIL_VERIFICATION: process.env.AUTH_REQUIRE_EMAIL_VERIFICATION,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,

    UPLOAD_DIR: process.env.UPLOAD_DIR,
    FILE_STORAGE_ROOT: process.env.FILE_STORAGE_ROOT,
    FILE_MAX_SIZE_BYTES: process.env.FILE_MAX_SIZE_BYTES,
    FILE_ALLOWED_MIME: process.env.FILE_ALLOWED_MIME,

    STORAGE_PROVIDER: process.env.STORAGE_PROVIDER,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_REGION: process.env.S3_REGION,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,

    AV_WEBHOOK_SECRET: process.env.AV_WEBHOOK_SECRET,
    AV_SCAN_MODE: process.env.AV_SCAN_MODE,
    CLAMAV_HOST: process.env.CLAMAV_HOST,

    PIPELOCK_PUBLIC_KEY: process.env.PIPELOCK_PUBLIC_KEY,
    PIPELOCK_STRICT_MODE: process.env.PIPELOCK_STRICT_MODE,

    DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY,
    DATA_ENCRYPTION_KEY_PREVIOUS: process.env.DATA_ENCRYPTION_KEY_PREVIOUS,

    CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    SMTP_FROM: process.env.SMTP_FROM,

    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
    APNS_KEY_ID: process.env.APNS_KEY_ID,
    APNS_TEAM_ID: process.env.APNS_TEAM_ID,
    APNS_PRIVATE_KEY: process.env.APNS_PRIVATE_KEY,
    APNS_KEY_ID_SANDBOX: process.env.APNS_KEY_ID_SANDBOX,
    APNS_PRIVATE_KEY_SANDBOX: process.env.APNS_PRIVATE_KEY_SANDBOX,
    METRICS_TOKEN: process.env.METRICS_TOKEN,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRICE_ID_PRO: process.env.STRIPE_PRICE_ID_PRO,
    STRIPE_PRICE_ID_CLUB: process.env.STRIPE_PRICE_ID_CLUB,
    APP_URL: process.env.APP_URL,

    AI_RISK_PROVIDER: process.env.AI_RISK_PROVIDER,
    AI_QUESTIONNAIRE_PROVIDER: process.env.AI_QUESTIONNAIRE_PROVIDER,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
    AI_LOCAL_BASE_URL: process.env.AI_LOCAL_BASE_URL,
    AI_LOCAL_MODEL: process.env.AI_LOCAL_MODEL,
    AI_LOCAL_API_KEY: process.env.AI_LOCAL_API_KEY,
    AI_RISK_DAILY_QUOTA: process.env.AI_RISK_DAILY_QUOTA,
    AI_RISK_USER_RPM: process.env.AI_RISK_USER_RPM,
    AI_RISK_ENABLED: process.env.AI_RISK_ENABLED,
    AI_RISK_PLAN_REQUIRED: process.env.AI_RISK_PLAN_REQUIRED,
    AI_RISK_SUGGESTIONS_ENABLED: process.env.AI_RISK_SUGGESTIONS_ENABLED,
    AI_ASSISTANT_ENABLED: process.env.AI_ASSISTANT_ENABLED,
    AI_QUESTIONNAIRE_ENABLED: process.env.AI_QUESTIONNAIRE_ENABLED,
    AI_POSTURE_PROVIDER: process.env.AI_POSTURE_PROVIDER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,

    AUDIT_STREAM_RETRY_ENABLED: process.env.AUDIT_STREAM_RETRY_ENABLED,
    VENDOR_MONITOR_ENABLED: process.env.VENDOR_MONITOR_ENABLED,
    VENDOR_MONITOR_BREACH_PROVIDER: process.env.VENDOR_MONITOR_BREACH_PROVIDER,
    VENDOR_MONITOR_TLS_PROVIDER: process.env.VENDOR_MONITOR_TLS_PROVIDER,
    NVD_SYNC_ENABLED: process.env.NVD_SYNC_ENABLED,
    NVD_API_KEY: process.env.NVD_API_KEY,
    NOTIFICATIONS_TZ: process.env.NOTIFICATIONS_TZ,

    NEXT_PUBLIC_NOTIFICATIONS_SSE: process.env.NEXT_PUBLIC_NOTIFICATIONS_SSE,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation.
   * This is especially useful for Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Makes it so that empty strings are treated as undefined.
   * `SOME_VAR: z.string()` and `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
