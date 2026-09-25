import { randomUUID } from 'node:crypto';

import { redis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';

/**
 * Rate limiter — a SHARED sliding window, with a per-instance fallback.
 *
 * ═══ WHY IT IS NOT A Map ANY MORE ═══
 *
 * It was, and the docblock said "In-memory is appropriate for single-instance
 * deployments. For multi-instance, swap to Redis-backed limiter." Two problems
 * with leaving it there:
 *
 *   PER INSTANCE. With N instances behind a load balancer the effective limit
 *   is N× what it says. The sign-in throttle — 10 attempts per 15 minutes —
 *   becomes 10×N, and nothing anywhere reports that. It is the defence against
 *   credential stuffing on /auth/token and the web login, which draw on the
 *   same bucket.
 *
 *   CLEARED ON DEPLOY. A lockout evaporates when the process restarts. An
 *   attacker who notices a deploy cadence gets a fresh budget every release.
 *
 * `REDIS_URL` has been a REQUIRED, authenticated production variable all along,
 * and src/env.ts refuses a password-less `redis://` in production with a
 * comment saying rate-limit counters live there. The intended design was
 * already written down; only the implementation was missing.
 *
 * ═══ WHY A LUA SCRIPT AND NOT INCR ═══
 *
 * The check and the record have to be ONE atomic step. Read-then-write over
 * the network is the same check-then-act race `createBooking` refuses: two
 * concurrent requests both read `count = max - 1`, both decide they are
 * allowed, and both insert. At the sign-in throttle that is an attacker
 * getting 2N attempts out of a budget of N by firing in pairs.
 *
 * So the window lives in a sorted set and the whole decision runs inside
 * Redis, in one round trip. The Lua reproduces the previous in-memory
 * semantics exactly — sliding window, then the lockout branch, then the
 * budget branch — so this commit changes WHERE the state lives and not what
 * the limits mean.
 *
 * ═══ WHAT HAPPENS WHEN REDIS IS DOWN ═══
 *
 * It falls back to the in-memory Map, which is exactly today's behaviour: a
 * per-instance limit. Deliberately not the two alternatives —
 *
 *   fail open  — no limiting at all, which is the vulnerability this fixes
 *   fail closed — nobody can sign in, an outage caused by the limiter
 *
 * so degrading to "the limit we had yesterday" is the only option that is
 * never worse than the status quo. The client is configured with
 * `commandTimeout: 2_000`, so a dead Redis costs one 2-second wait and then a
 * short circuit-break rather than 2 seconds on every subsequent request.
 */

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

// Clean up stale entries every 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(windowMs: number) {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
      if (entry.timestamps.length === 0) {
        store.delete(key);
      }
    }
  }, CLEANUP_INTERVAL);
  // Allow Node.js to exit even if timer is running
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }
}

export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  maxAttempts: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Optional: lockout duration in ms after max attempts exceeded */
  lockoutMs?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * Check if a request is within rate limits.
 *
 * @param key - Unique identifier (e.g., `mfa:${userId}`, `login:${ip}`)
 * @param config - Rate limit configuration
 * @returns Whether the request is allowed and how many attempts remain
 */
/**
 * The previous implementation, kept verbatim as the FALLBACK.
 *
 * Unchanged on purpose: when Redis is unavailable this is the behaviour the
 * product had yesterday, so the degraded mode is a known quantity rather than
 * a second implementation to reason about.
 */
export function checkRateLimitInMemory(key: string, config: RateLimitConfig): RateLimitResult {
  startCleanup(config.windowMs);

  const now = Date.now();
  const entry = store.get(key) || { timestamps: [] };

  // Remove timestamps outside the window
  const windowStart = now - config.windowMs;
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  // Check lockout: if last attempt was within lockout period and at max
  if (config.lockoutMs && entry.timestamps.length >= config.maxAttempts) {
    const lastAttempt = entry.timestamps[entry.timestamps.length - 1];
    const lockoutEnd = lastAttempt + config.lockoutMs;
    if (now < lockoutEnd) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: lockoutEnd - now,
      };
    }
    // Lockout expired, reset
    entry.timestamps = [];
  }

  if (entry.timestamps.length >= config.maxAttempts) {
    store.set(key, entry);
    const oldestInWindow = entry.timestamps[0];
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: oldestInWindow + config.windowMs - now,
    };
  }

  // Record this attempt
  entry.timestamps.push(now);
  store.set(key, entry);

  return {
    allowed: true,
    remaining: config.maxAttempts - entry.timestamps.length,
    retryAfterMs: 0,
  };
}

/**
 * Reset rate limit for a key (e.g., after successful auth).
 */
export async function resetRateLimit(key: string): Promise<void> {
  store.delete(key);

  if (redisUsable()) {
    try {
      await redis().del(redisKey(key));
    } catch (err) {
      noteRedisFailure(err);
    }
  }
}

/**
 * For testing: clear all rate limit state.
 */
export async function clearAllRateLimits(): Promise<void> {
  store.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  redisDownUntil = 0;

  // Only the keys this module owns. A FLUSHDB in a shared database would take
  // the leaderboard and every cache with it.
  if (redisUsable()) {
    try {
      const keys = await redis().keys(`${KEY_PREFIX}*`);
      if (keys.length > 0) await redis().del(...keys);
    } catch (err) {
      noteRedisFailure(err);
    }
  }
}

// ─── The shared store ───────────────────────────────────────────────

const KEY_PREFIX = 'ratelimit:';

const redisKey = (key: string) => `${KEY_PREFIX}${key}`;

/**
 * How long to stop asking Redis after it fails.
 *
 * Without this, a dead Redis costs `commandTimeout` (2s) on EVERY request —
 * turning a limiter outage into a site-wide latency outage, which is worse
 * than the problem being fixed.
 */
const REDIS_COOLDOWN_MS = 10_000;
let redisDownUntil = 0;

function redisUsable(): boolean {
  if (!process.env.REDIS_URL) return false;
  return Date.now() >= redisDownUntil;
}

function noteRedisFailure(err: unknown): void {
  const firstFailure = redisDownUntil === 0 || Date.now() >= redisDownUntil;
  redisDownUntil = Date.now() + REDIS_COOLDOWN_MS;

  // Logged once per cooldown, not per request. A limiter that floods the log
  // when Redis blinks is a limiter nobody reads the log of.
  if (firstFailure) {
    logger.warn('rate limiter fell back to the in-memory store', {
      component: 'rate-limit',
      cooldownMs: REDIS_COOLDOWN_MS,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The whole decision, in one atomic step, inside Redis.
 *
 * Reproduces `checkRateLimitInMemory` branch for branch:
 *
 *   1. drop entries older than the window
 *   2. LOCKOUT branch — at or over budget and a lockout is configured: denied
 *      until `last attempt + lockoutMs`, then the window is wiped and the
 *      caller starts fresh
 *   3. BUDGET branch — at or over budget: denied until the OLDEST entry in the
 *      window falls out of it
 *   4. otherwise record the attempt and allow
 *
 * Returns `{allowed, remaining, retryAfterMs}` as three integers, in that
 * order, because a Lua table of mixed types is not worth the parsing.
 *
 * The member is a UUID passed in from Node rather than the timestamp: two
 * attempts in the same millisecond would otherwise be one ZADD overwriting the
 * other, and the second request would be free.
 */
const SCRIPT = `
local key        = KEYS[1]
local now        = tonumber(ARGV[1])
local windowMs   = tonumber(ARGV[2])
local maxAttempts= tonumber(ARGV[3])
local lockoutMs  = tonumber(ARGV[4])
local member     = ARGV[5]

redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)

if lockoutMs > 0 and count >= maxAttempts then
  local newest = redis.call('ZRANGE', key, -1, -1, 'WITHSCORES')
  local lockoutEnd = tonumber(newest[2]) + lockoutMs
  if now < lockoutEnd then
    return {0, 0, lockoutEnd - now}
  end
  redis.call('DEL', key)
  count = 0
end

if count >= maxAttempts then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, 0, tonumber(oldest[2]) + windowMs - now}
end

redis.call('ZADD', key, now, member)
-- Expire covers the window AND any lockout that could still be pending, so a
-- key never outlives the decision it can still influence.
redis.call('PEXPIRE', key, windowMs + lockoutMs)

return {1, maxAttempts - (count + 1), 0}
`;

/**
 * Check a rate limit against the SHARED store.
 *
 * Async, which it was not before. That ripples to every caller and is
 * unavoidable: a shared counter lives over a network. The alternative — a
 * synchronous local guess — is the bug.
 */
export async function checkRateLimit(
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  if (!redisUsable()) return checkRateLimitInMemory(key, config);

  try {
    const raw = (await redis().eval(
      SCRIPT,
      1,
      redisKey(key),
      String(Date.now()),
      String(config.windowMs),
      String(config.maxAttempts),
      String(config.lockoutMs ?? 0),
      randomUUID(),
    )) as [number, number, number];

    return {
      allowed: raw[0] === 1,
      remaining: raw[1],
      retryAfterMs: raw[2],
    };
  } catch (err) {
    noteRedisFailure(err);
    return checkRateLimitInMemory(key, config);
  }
}

// ─── Preset Configurations ──────────────────────────────────────────
//
// Each preset encodes a policy choice. The numbers are not arbitrary —
// they balance user ergonomics against abuse resistance. Sizing rule
// of thumb:
//
//   sensitive auth flow   → small window, small budget, lockout
//   normal mutation       → per-minute window, moderate budget
//   highly privileged op  → hour window, tiny budget
//
// When you add a new preset, document the threat model in the JSDoc
// and prefer tighter-than-you-think limits — the middleware returns
// a clean 429 + Retry-After, not an opaque error.

/** MFA verify: 5 attempts per 15 minutes, 5 min lockout after exhaustion */
export const MFA_VERIFY_LIMIT: RateLimitConfig = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000, // 15 minutes
  lockoutMs: 5 * 60 * 1000, // 5 minute lockout
};

/** MFA enrollment verify: 10 attempts per 15 minutes */
export const MFA_ENROLL_VERIFY_LIMIT: RateLimitConfig = {
  maxAttempts: 10,
  windowMs: 15 * 60 * 1000,
};

/**
 * Login (credentials / SSO callback / password reset):
 *   10 attempts per 15 minutes, 15 min lockout after exhaustion.
 *
 * Threat model: online password brute-force. The lockout doubles as
 * a back-pressure signal — an attacker spraying credentials across
 * thousands of accounts gets degraded throughput per IP even when
 * they rotate usernames, because the middleware keys by IP+userId
 * when available but falls back to IP alone for pre-authentication.
 */
export const LOGIN_LIMIT: RateLimitConfig = {
  maxAttempts: 10,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
};

/**
 * General mutation API: 60 requests per minute per (IP, userId).
 *
 * Threat model: a compromised credential or a runaway client making
 * thousands of writes per second. The limit is intentionally
 * generous — normal interactive use doesn't come close (a user
 * filling a detail form might submit 2-3 writes per minute). Scripts
 * and tests that need higher throughput should use an API key with
 * a dedicated rate plan (future work), not share the interactive
 * budget.
 */
export const API_MUTATION_LIMIT: RateLimitConfig = {
  maxAttempts: 60,
  windowMs: 60 * 1000,
};

/**
 * General read API: 120 requests per minute per (IP, userId, tenantSlug).
 *
 * GAP-17. Applied at the Edge middleware to GET requests on
 * `/api/t/<slug>/...`, excluding health probes (`/api/health`,
 * `/api/livez`, `/api/readyz`) and `/api/docs`.
 *
 * Threat model: scraping / accidental overload — a runaway frontend
 * that fans out many list calls per page load, an abusive script
 * iterating filter combinations, or a compromised credential
 * scraping data. The limit is roughly 2× the mutation budget because
 * reads are cheaper, idempotent, and a normal page load can fan
 * out to 5-10 list endpoints (controls + risks + evidence + counts
 * + traceability + …); 120/min comfortably covers that for a single
 * actor while still tripping a real scraper within seconds.
 *
 * Bucketing: per (IP, userId, tenantSlug) so a single user with a
 * runaway tab in tenant A doesn't burn the budget for the same user
 * in tenant B. The tenantSlug appears as a scope namespace in the
 * key, not as part of the identifier — meaning N users in one
 * tenant each get their own bucket, not a shared tenant pool.
 *
 * The actual enforcement lives in `src/lib/rate-limit/apiReadRateLimit.ts`
 * (Upstash + memory-fallback, mirrors `authRateLimit.ts`). This
 * preset is the single source of truth for the numbers; the
 * enforcement module re-uses them.
 */
export const API_READ_LIMIT: RateLimitConfig = {
  maxAttempts: 120,
  windowMs: 60 * 1000,
};

/**
 * API key creation: 5 per hour per (tenant, creator user).
 *
 * Threat model: post-compromise lateral movement. A user with a
 * stolen session could mint persistent API keys; tight limits slow
 * that chain and leave a denser audit trail. Legitimate churn (a
 * user rotating a handful of keys) is comfortably under 5/hr.
 */
export const API_KEY_CREATE_LIMIT: RateLimitConfig = {
  maxAttempts: 5,
  windowMs: 60 * 60 * 1000,
  lockoutMs: 60 * 60 * 1000,
};

/**
 * Passwordless / magic-link email dispatch: 5 per hour per IP.
 *
 * Threat model: email bomb abuse (attacker pointing the "send link"
 * endpoint at a victim email). This preset is explicitly IP-only
 * even when the endpoint receives a target email — the rate applies
 * to senders, not recipients.
 */
export const EMAIL_DISPATCH_LIMIT: RateLimitConfig = {
  maxAttempts: 5,
  windowMs: 60 * 60 * 1000,
};

/**
 * Platform-admin tenant creation: 5 per hour per calling IP.
 *
 * ⚠️ UNUSED, and describing a threat model that no longer exists. Kept only so
 * removing it is a decision somebody makes on purpose rather than a side effect
 * of P31.
 *
 * Its original threat model was "a leaked PLATFORM_ADMIN_API_KEY used to spin up
 * many tenants in rapid succession", guarding `POST /api/admin/tenants`. Neither
 * exists: the endpoint was never built, and P31 deleted the shared secret in
 * favour of `platform_admin_grant` — a named person, a granter, a reason, a
 * capability list, an expiry, and an append-only audit row per use.
 *
 * If tenant creation ever does get a platform endpoint, it will be authorised by
 * a capability rather than a shared key, so this bucket's IP keying (chosen
 * because "the platform key is a single shared secret, so per-key bucketing adds
 * no isolation") no longer follows either.
 */
export const TENANT_CREATE_LIMIT: RateLimitConfig = {
  maxAttempts: 5,
  windowMs: 60 * 60 * 1000,
  lockoutMs: 60 * 60 * 1000,
};

/**
 * Tenant invite creation: 20 per hour per tenant.
 *
 * Threat model: a compromised ADMIN account flooding the TenantInvite
 * table (storage abuse) or sending phishing invites at scale. 20/hr is
 * comfortable for legitimate batch onboarding while creating a tight
 * audit trail for abuse. Keyed by (tenant, IP) so a multi-browser
 * attacker with one session still burns the same budget.
 */
export const TENANT_INVITE_CREATE_LIMIT: RateLimitConfig = {
  maxAttempts: 20,
  windowMs: 60 * 60 * 1000,
};

/**
 * Invite preview / redemption: 10 per minute per IP.
 *
 * Threat model: token brute-force on the preview/redeem endpoints.
 * The 32-byte base64url token space is 2^256, so enumeration is
 * impossible in practice — this limit adds a defence-in-depth layer
 * and rate-stamps the audit trail so anomalous redemption patterns
 * are visible in logs. 10/min is comfortable for a user tabbing
 * between invite emails.
 */
export const INVITE_REDEEM_LIMIT: RateLimitConfig = {
  maxAttempts: 10,
  windowMs: 60 * 1000,
};

// ═══════════════════════════════════════════════════════════════════
// Progressive rate limit — Epic A.3 auth brute-force protection
// ═══════════════════════════════════════════════════════════════════
//
// The simple `RateLimitConfig` above is "N attempts per window,
// optional lockout" — a single threshold. Epic A.3 needs graduated
// *punishment*: each failed attempt past a threshold costs the
// attacker more wall-clock time, culminating in a hard lockout.
//
// The primitive is shared (not login-specific) so future flows
// (second-factor, recovery codes) can reuse it with their own policy.

export interface ProgressiveRateLimitTier {
  /** Apply this delay when cumulative failures >= this count. */
  atFailures: number;
  /** Milliseconds to delay the CURRENT attempt before verifying. */
  delayMs: number;
}

export interface ProgressiveRateLimitPolicy {
  /**
   * Tiers sorted ascending by `atFailures`. The highest-matching
   * tier's `delayMs` is applied; tiers do not sum. Failures below
   * the first tier's threshold incur no delay.
   */
  tiers: readonly ProgressiveRateLimitTier[];
  /** Failure count that flips the account into lockout. */
  lockoutAtFailures: number;
  /** Duration of the lockout once triggered. */
  lockoutMs: number;
  /**
   * Rolling window over which failures accumulate. A single entry
   * older than `windowMs` stops contributing to the count. Sized
   * generously — lockouts are meant to feel real, not rotate out.
   */
  windowMs: number;
}

/**
 * Epic A.3 login policy.
 *
 *   attempts 1-2  → no delay (typo allowance)
 *   attempts 3-4  → 5s delay (mild friction)
 *   attempts 5-9  → 30s delay (significant friction)
 *   attempt 10+   → 15 min lockout (attack territory)
 *
 * Window is 1 hour: a legitimate user who typed their password
 * wrong ten times in a day isn't locked out in perpetuity; an
 * attacker who managed to sustain 10 failures/hour stays locked
 * for the full window.
 */
export const LOGIN_PROGRESSIVE_POLICY: ProgressiveRateLimitPolicy = {
  tiers: [
    { atFailures: 3, delayMs: 5_000 },
    { atFailures: 5, delayMs: 30_000 },
  ],
  lockoutAtFailures: 10,
  lockoutMs: 15 * 60 * 1000,
  windowMs: 60 * 60 * 1000,
};

export interface ProgressiveRateLimitDecision {
  /**
   * `false` when the identifier is in lockout and no further
   * verify should be attempted. The caller returns 429/"too many
   * requests" to the client.
   */
  allowed: boolean;
  /**
   * Delay (ms) the caller SHOULD sleep before proceeding with the
   * expensive verify. `0` when under the first tier. The caller
   * is responsible for actually sleeping — this function returns
   * synchronously so it can be used inside timing-sensitive
   * branches (e.g. a dummyVerify needs to happen even on lockout).
   */
  delayMs: number;
  /**
   * Only populated when `allowed === false`. Seconds until the
   * lockout expires (always ≥ 1).
   */
  retryAfterSeconds: number;
  /** Failures currently counted against this identifier. */
  failureCount: number;
}

function pickDelayMs(count: number, tiers: readonly ProgressiveRateLimitTier[]): number {
  let delay = 0;
  for (const tier of tiers) {
    if (count >= tier.atFailures) delay = tier.delayMs;
  }
  return delay;
}

/**
 * Evaluate the current state WITHOUT recording a new attempt. Call
 * this BEFORE verifying the password so the caller knows how long
 * to delay (and whether to short-circuit with a lockout response).
 *
 * Reuses the same sliding-window store the other rate-limit functions
 * in this file already use — one process-wide Map, cleanup timer
 * already running.
 */
export function evaluateProgressiveRateLimit(
  key: string,
  policy: ProgressiveRateLimitPolicy,
): ProgressiveRateLimitDecision {
  startCleanup(policy.windowMs);

  const now = Date.now();
  const entry = store.get(key) || { timestamps: [] };

  // Expire stale failures out of the count but keep the entry
  // stored; caller may be about to write a new failure.
  const windowStart = now - policy.windowMs;
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
  store.set(key, entry);

  const failureCount = entry.timestamps.length;

  if (failureCount >= policy.lockoutAtFailures) {
    const lastFailure = entry.timestamps[entry.timestamps.length - 1];
    const lockoutEnd = lastFailure + policy.lockoutMs;
    if (now < lockoutEnd) {
      return {
        allowed: false,
        delayMs: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((lockoutEnd - now) / 1000)),
        failureCount,
      };
    }
    // Lockout expired — counter resets. The attempt proceeds
    // with zero delay; a legitimate user who came back after
    // the lockout should not immediately eat another 30s.
    entry.timestamps = [];
    store.set(key, entry);
    return {
      allowed: true,
      delayMs: 0,
      retryAfterSeconds: 0,
      failureCount: 0,
    };
  }

  return {
    allowed: true,
    delayMs: pickDelayMs(failureCount, policy.tiers),
    retryAfterSeconds: 0,
    failureCount,
  };
}

/**
 * Record a failure for this identifier. Call AFTER a verify has
 * returned `false`. Returns the post-increment decision so the
 * caller can surface the new lockout state to logging / audit.
 */
export function recordProgressiveFailure(
  key: string,
  policy: ProgressiveRateLimitPolicy,
): ProgressiveRateLimitDecision {
  startCleanup(policy.windowMs);
  const now = Date.now();
  const entry = store.get(key) || { timestamps: [] };
  // Trim the window before writing so the count we return is
  // current.
  const windowStart = now - policy.windowMs;
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
  entry.timestamps.push(now);
  store.set(key, entry);

  return evaluateProgressiveRateLimit(key, policy);
}

/**
 * Clear the failure list. Call after a SUCCESSFUL verify so a
 * legitimate user who typo'd a few times isn't still throttled on
 * the next login.
 */
export function resetProgressiveFailures(key: string): void {
  store.delete(key);
}
