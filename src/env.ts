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
    // The canonical public origin, e.g. `https://playerz.bg` (#396). Every
    // absolute URL a search engine sees is built from it: the sitemap, the
    // robots.txt `Sitemap:` line, `<link rel="canonical">`, Open Graph `url`
    // and the venue page's JSON-LD. One setting, read in one place
    // (src/lib/seo/site-url.ts), so the move from app.playerz.bg to
    // playerz.bg (Q47) changes one line of .env and no code.
    //
    // Optional: unset, it falls back to NEXTAUTH_URL, which deploy/add-domain.sh
    // already points at the canonical host — and which add-domain.sh now
    // writes SITE_URL alongside, so the two cannot drift.
    SITE_URL: z.string().url().optional(),
    // ═══ AUTH_URL, AUTH_SECRET, JWT_SECRET AND UPLOAD_DIR ARE GONE ═══
    //
    // All four were REQUIRED here and read by NOTHING — verified by grep over
    // src, scripts, tests and the workflows. Nothing pinned them: not a test,
    // not .env.example, not CI.
    //
    // `AUTH_URL` and `AUTH_SECRET` are the Auth.js **v5** names. This app is on
    // next-auth **v4**, which reads `NEXTAUTH_URL` and `NEXTAUTH_SECRET` — both
    // declared above and both actually used. They arrived with the port from
    // upstream, where they are correct.
    //
    // The cost was not cosmetic. Four required variables that nothing consumes
    // made `npm run dev` fail on EVERY route that imports this module, with
    // "Invalid environment variables" and no hint that the offending names are
    // never read. /api/health kept working because it imports nothing, which
    // made it look like a routing problem rather than a config one.

    // ═══ PROVIDERS ═══
    //
    // Optional, because `src/auth.ts` now registers each provider only when its
    // pair is present. Requiring them meant the app could not boot at all
    // without two OAuth app registrations — including for anyone running tests
    // or the seed, neither of which signs in through a provider.
    //
    // Absent credentials therefore mean "that button is not offered", not "the
    // app is broken". `/api/ready` reports which methods are live, the same way
    // it does for push.
    //
    // Google and Facebook are the only two (#361, Q15/Q21). Microsoft Entra
    // and its MICROSOFT_* variables were removed with its group sync.
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),

    // ═══ THE PHONE CHECK (#500) ═══
    //
    // A player or coach confirms a phone number by an SMS code. Infobip's 2FA
    // API sends and checks the code (src/lib/sms/phone-verifier.ts; owner
    // decision 2026-10-13): the account's own API host, an API key allowed to
    // send and verify 2FA PINs, the 2FA APPLICATION, and the MESSAGE TEMPLATE
    // in Bulgarian. All four or none. A second template in English is
    // optional; without it everybody gets the Bulgarian text.
    //
    // REQUIRE_PHONE=1 is what turns the rule on: booking, joining a game and
    // writing a message then need a confirmed number (`PHONE_REQUIRED`). Off
    // by default, so a deployment without the keys behaves as before; `1`
    // without them refuses the check loudly at use (503), never silently lets
    // it pass.
    INFOBIP_BASE_URL: z
      .string()
      .regex(/^https:\/\/[a-z0-9.-]+\.infobip\.com\/?$/i)
      .optional(),
    INFOBIP_API_KEY: z.string().min(16).optional(),
    INFOBIP_2FA_APPLICATION_ID: z
      .string()
      .regex(/^[0-9A-Za-z]{16,64}$/)
      .optional(),
    INFOBIP_2FA_MESSAGE_ID: z
      .string()
      .regex(/^[0-9A-Za-z]{16,64}$/)
      .optional(),
    INFOBIP_2FA_MESSAGE_ID_EN: z
      .string()
      .regex(/^[0-9A-Za-z]{16,64}$/)
      .optional(),
    REQUIRE_PHONE: z.enum(['0', '1']).default('0'),
    // The tests' stand-in for the SMS: with DEPLOY_ENV=test and no Infobip
    // keys, this code confirms any number. Ignored everywhere else.
    PHONE_VERIFY_TEST_CODE: z
      .string()
      .regex(/^\d{4,10}$/)
      .optional(),
    // The Meta app's App ID and App Secret (#361). Redirect URI to register:
    // <NEXTAUTH_URL>/api/auth/callback/facebook — docs/oauth-setup.md.
    FACEBOOK_CLIENT_ID: z.string().optional(),
    FACEBOOK_CLIENT_SECRET: z.string().optional(),

    // ═══ EMAIL + PASSWORD: THE TEST SUITES ONLY (#361) ═══
    //
    // `1` registers the credentials provider and opens the native password
    // grant — honoured only with DEPLOY_ENV=test. A deployment that carries it
    // refuses to start (src/lib/auth/password-sign-in.ts). Never set it in
    // production or staging.
    TEST_PASSWORD_SIGN_IN: z.enum(['0', '1']).optional(),

    // Rate Limiting
    RATE_LIMIT_ENABLED: z.enum(['0', '1']).optional(),
    AUTH_TEST_MODE: z.enum(['0', '1']).optional(),
    // When "1", the Credentials provider rejects sign-ins whose User row
    // has `emailVerified = null`. See src/lib/auth/credentials.ts. Default
    // is OFF so existing deployments behave unchanged until verification
    // flow ships.
    AUTH_REQUIRE_EMAIL_VERIFICATION: z.enum(['0', '1']).optional(),

    // Data Protection (Epic 8) — GAP-03 enforcement.
    //
    // Schema layer: optional() carries the *shape* (string ≥32 chars
    // when present). The production-required + dev-fallback-rejection
    // contract is enforced by the per-field superRefine() below,
    // which reads the same `process.env.NODE_ENV` the schema is
    // about to validate. Two-stage so the field-level error message
    // points at DATA_ENCRYPTION_KEY rather than a top-level object
    // refinement that prints the whole env shape.
    // ═══ NEXTAUTH_SECRET WAS READ SIX TIMES AND DECLARED NOWHERE ═══
    //
    // `getToken` in src/middleware.ts, the v1 request context, the native token
    // route, the logout route and page-context all pass
    // `process.env.NEXTAUTH_SECRET` to next-auth. Without it next-auth cannot
    // sign or verify a JWT, so EVERY authenticated request fails.
    //
    // Nothing said so. The app boots, serves public pages, and then rejects
    // every sign-in — which is the worst shape of failure to discover after a
    // deploy, because "it started successfully" is true.
    //
    // Required in production for the same reason DATA_ENCRYPTION_KEY is, and
    // by the same two-stage pattern: NODE_ENV is read from process.env because
    // the parsed `env.NODE_ENV` does not exist yet at refine time.
    NEXTAUTH_SECRET: z
      .string()
      .min(32, 'NEXTAUTH_SECRET must be at least 32 characters')
      .optional()
      .superRefine((val, ctx) => {
        if (process.env.NODE_ENV !== 'production') return;
        if (!val) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'NEXTAUTH_SECRET is REQUIRED in production — without it next-auth ' +
              'cannot verify any session and every signed-in request fails. ' +
              'Generate with: openssl rand -base64 48',
          });
        }
      }),

    // Also the base of the no-show fingerprint (P53, src/lib/account/
    // no-show-fingerprint.ts): rotating this key ends every carry-over of a
    // deleted account's no-show standing to a new account.
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
    // Was the upstream product's noreply address — a leftover from the compliance product this
    // codebase started as, which would have put another company's domain in
    // the From header of every invite.
    SMTP_FROM: z.string().default('noreply@playerz.bg'),

    // ═══ NOTIFICATION EMAIL (#367) ═══
    //
    // The outbox drain picks ONE adapter (src/lib/email/provider.ts): Resend
    // when RESEND_API_KEY is set, else SMTP when SMTP_HOST is, else a
    // log-only adapter that sends nothing. All optional: production runs with
    // none and the bell carries every notification until a key is added.
    RESEND_API_KEY: z.string().min(1).optional(),
    // The From header, e.g. `playerz.bg <noreply@playerz.bg>`. Falls back to
    // SMTP_FROM. The domain must be verified with the provider (SPF/DKIM).
    EMAIL_FROM: z.string().min(3).optional(),
    // Staging (DEPLOY_ENV=staging) never emails anyone unless this is '1'.
    EMAIL_ALLOW_ON_STAGING: z.enum(['0', '1']).optional(),
    // Where the landing page's club enquiries are emailed (#369), through the
    // same outbox. Unset: the enquiry is still stored and listed on /platform,
    // and no email is queued. Read at send time too, so a changed inbox is
    // honoured by rows already queued.
    CONTACT_INBOX_EMAIL: z.string().email().optional(),
    // The operator's alerts: the disk alert (deploy/ops/disk-alert.sh, #440)
    // and the daily report of emails that could not be delivered (#425).
    ALERT_EMAIL: z.string().email().optional(),

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

    // The moderation classifier's key (src/lib/moderation/classify.ts). Absent,
    // held content waits for a person instead of being scored.
    ANTHROPIC_API_KEY: z.string().optional(),

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

    // ═══ PRODUCT MODULES (#362, roadmap #379 phase 2) ═══
    //
    // Each module's entry in the player chrome stays HIDDEN until its module
    // ships, and is switched on here, without a code change. Read on the
    // server only (`src/lib/modules.ts`); the client is handed the result.
    //   MODULE_OPEN_PLAY  the Игри tab and top link (module 2, #376)
    //   MODULE_MESSAGING  the messages icon in the header (module 1, #375)
    // Off by default: neither route exists yet, and nav-hrefs-resolve fails
    // a default of '1' for a module whose page is missing.
    MODULE_OPEN_PLAY: z.enum(['0', '1']).default('0'),
    MODULE_MESSAGING: z.enum(['0', '1']).default('0'),

    // ═══ CHAT PUSH: CENTRIFUGO (#481) ═══
    //
    // The broker runs next to the app (deploy/docker-compose.*.yml) and the
    // browser reaches it at <NEXTAUTH_URL>/connection/websocket, through Caddy.
    // Push is ON when both secrets are set, and off otherwise: chat then falls
    // back to re-reading every few seconds, as it did before #481, so a missing
    // broker degrades delivery and never breaks a send.
    //   CENTRIFUGO_API_URL       the broker's server API, inside the network
    //   CENTRIFUGO_API_KEY       its `http_api.key`
    //   CENTRIFUGO_TOKEN_SECRET  signs connection tokens (`client.token.hmac_secret_key`)
    //   CENTRIFUGO_PROXY_SECRET  the header the broker sends to /api/v1/realtime/subscribe
    CENTRIFUGO_API_URL: z.string().url().optional(),
    CENTRIFUGO_API_KEY: z.string().min(16).optional(),
    CENTRIFUGO_TOKEN_SECRET: z.string().min(32).optional(),
    CENTRIFUGO_PROXY_SECRET: z.string().min(32).optional(),

    // ═══ WHICH DEPLOYMENT THIS IS (#373) ═══
    //
    // `staging` is the copy on the same VM that gets every merge before the
    // weekly production release (owner decision Q44). It must never be
    // indexed: robots.txt disallows everything and the sitemap is empty
    // (`src/lib/seo/robots.ts`, `src/app/sitemap.ts`). Defaults to
    // `production`, so the production .env needs no change.
    //
    // `test` is not a deployment: the E2E, perf and Jest harnesses (and a
    // local server run with test accounts). It behaves as production in every
    // respect but one — it is the only value under which TEST_PASSWORD_SIGN_IN
    // is honoured (#361). Unset means production, deliberately: a deployment
    // that forgot to say what it is gets the strict answer.
    DEPLOY_ENV: z.enum(['production', 'staging', 'test']).default('production'),

    // ═══ MEDIA: VENUE PHOTOS (#366, docs/media-storage.md) ═══
    //
    // Where uploaded venue photos go. ALL OPTIONAL: unset, uploads are off and
    // the admin says "Качването на снимки не е настроено" instead of failing
    // (src/lib/media/storage.ts). Read on the server only.
    //   MEDIA_STORAGE           `gcs` (production, staging) or `local` (dev,
    //                           tests, CI: files under MEDIA_LOCAL_DIR, served
    //                           by the `/media/...` route)
    //   GCS_BUCKET              the bucket, for `gcs`
    //   GCS_CREDENTIALS_BASE64  a service-account key, base64 JSON. Unset, the
    //                           client uses Application Default Credentials. On
    //                           the VM it must be set: the VM's own account has
    //                           the read-only storage scope (see the doc).
    //   MEDIA_PUBLIC_BASE_URL   where the objects are read from; defaults to
    //                           https://storage.googleapis.com/{GCS_BUCKET},
    //                           or `/media` for `local`
    //   MEDIA_LOCAL_DIR         the directory for `local`; default `.media`
    MEDIA_STORAGE: z.enum(['gcs', 'local']).optional(),
    GCS_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/, 'GCS_BUCKET must be a bucket name')
      .optional(),
    GCS_CREDENTIALS_BASE64: z.string().optional(),
    MEDIA_PUBLIC_BASE_URL: z
      .string()
      .refine((v) => v.startsWith('/') || /^https?:\/\//.test(v), {
        message: 'MEDIA_PUBLIC_BASE_URL must be an http(s) URL or a path starting with /',
      })
      .optional(),
    MEDIA_LOCAL_DIR: z.string().optional(),

    // ═══ THE LEGAL TEXTS (#370, docs/legal-pages.md) ═══
    //
    // Where /privacy, /terms and /cookies read their Markdown. Unset in every
    // deployment: the texts are content/legal under the working directory,
    // which the image carries. The tests point it at tests/fixtures/legal, the
    // only reason it exists. Read at use (src/lib/legal/texts.ts), so a test
    // can set it after the module loads.
    LEGAL_CONTENT_DIR: z.string().optional(),
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
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    SITE_URL: process.env.SITE_URL,

    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    INFOBIP_BASE_URL: process.env.INFOBIP_BASE_URL,
    INFOBIP_API_KEY: process.env.INFOBIP_API_KEY,
    INFOBIP_2FA_APPLICATION_ID: process.env.INFOBIP_2FA_APPLICATION_ID,
    INFOBIP_2FA_MESSAGE_ID: process.env.INFOBIP_2FA_MESSAGE_ID,
    INFOBIP_2FA_MESSAGE_ID_EN: process.env.INFOBIP_2FA_MESSAGE_ID_EN,
    REQUIRE_PHONE: process.env.REQUIRE_PHONE,
    PHONE_VERIFY_TEST_CODE: process.env.PHONE_VERIFY_TEST_CODE,
    FACEBOOK_CLIENT_ID: process.env.FACEBOOK_CLIENT_ID,
    FACEBOOK_CLIENT_SECRET: process.env.FACEBOOK_CLIENT_SECRET,
    TEST_PASSWORD_SIGN_IN: process.env.TEST_PASSWORD_SIGN_IN,

    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
    AUTH_TEST_MODE: process.env.AUTH_TEST_MODE,
    AUTH_REQUIRE_EMAIL_VERIFICATION: process.env.AUTH_REQUIRE_EMAIL_VERIFICATION,

    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY,
    DATA_ENCRYPTION_KEY_PREVIOUS: process.env.DATA_ENCRYPTION_KEY_PREVIOUS,

    CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    SMTP_FROM: process.env.SMTP_FROM,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    EMAIL_ALLOW_ON_STAGING: process.env.EMAIL_ALLOW_ON_STAGING,
    CONTACT_INBOX_EMAIL: process.env.CONTACT_INBOX_EMAIL,
    ALERT_EMAIL: process.env.ALERT_EMAIL,

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

    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,

    MODULE_OPEN_PLAY: process.env.MODULE_OPEN_PLAY,
    MODULE_MESSAGING: process.env.MODULE_MESSAGING,
    CENTRIFUGO_API_URL: process.env.CENTRIFUGO_API_URL,
    CENTRIFUGO_API_KEY: process.env.CENTRIFUGO_API_KEY,
    CENTRIFUGO_TOKEN_SECRET: process.env.CENTRIFUGO_TOKEN_SECRET,
    CENTRIFUGO_PROXY_SECRET: process.env.CENTRIFUGO_PROXY_SECRET,
    DEPLOY_ENV: process.env.DEPLOY_ENV,
    MEDIA_STORAGE: process.env.MEDIA_STORAGE,
    GCS_BUCKET: process.env.GCS_BUCKET,
    GCS_CREDENTIALS_BASE64: process.env.GCS_CREDENTIALS_BASE64,
    MEDIA_PUBLIC_BASE_URL: process.env.MEDIA_PUBLIC_BASE_URL,
    MEDIA_LOCAL_DIR: process.env.MEDIA_LOCAL_DIR,
    LEGAL_CONTENT_DIR: process.env.LEGAL_CONTENT_DIR,
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
