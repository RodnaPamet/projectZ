import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';

import {
  appRoleUrl,
  BUILD_LOG,
  PERF_BASE_URL,
  PERF_DATA_ENCRYPTION_KEY,
  PERF_DIR,
  PERF_NEXTAUTH_SECRET,
  PERF_PORT,
  PERF_REDIS_URL,
  SERVER_LOG,
} from './config';
import { prepareDatabase } from './prepare-db';

/**
 * The perf webServer: reset and seed the database, build, then serve.
 *
 * ═══ A PRODUCTION BUILD, ALWAYS REBUILT ═══
 *
 * `next dev` compiles each route on first request and serves unminified React
 * with dev-only checks. A navigation there measures the compiler and the dev
 * bundle, so its timings say nothing about production. This builds with
 * `next build` and serves with `next start`, every run, for the reason the e2e
 * config gives: a server left over from an earlier build serves OLD code, and a
 * before/after comparison against a stale build proves nothing.
 *
 * ═══ ORDER ═══
 *
 * Playwright starts the webServer BEFORE globalSetup
 * (playwright/lib/runner: plugin setup, then global setup). So the database is
 * prepared here, before `next start` opens a single connection. That includes
 * the runtime role, which the boot-time least-privilege check queries. Sign-in
 * needs the running server, so it happens in global-setup.ts.
 */

const log = (msg: string) => process.stdout.write(`[perf:serve] ${msg}\n`);
const nextBin = 'node_modules/.bin/next';

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, logPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(logPath);
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on('error', reject);
    child.on('exit', (code) => {
      out.end();
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}; see ${logPath}`));
    });
  });
}

async function main() {
  mkdirSync(PERF_DIR, { recursive: true });
  const startedAt = new Date();

  const seed = await prepareDatabase(startedAt);
  writeFileSync(`${PERF_DIR}/seed.json`, JSON.stringify({ startedAt, ...seed }, null, 2));

  // SKIP_ENV_VALIDATION for the same reason CI's e2e job sets it: env.ts
  // refuses a Redis URL without a password in production, and the local test
  // Redis has none.
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    SKIP_ENV_VALIDATION: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  };

  if (process.env.PERF_SKIP_BUILD === '1') {
    // For iterating on the harness only. The run's JSON records it and the
    // reporter says so loudly: a number from an unbuilt tree is not a result.
    log('PERF_SKIP_BUILD=1: serving whatever .next already holds');
  } else {
    log(`next build (log: ${BUILD_LOG})`);
    const t = Date.now();
    await run(nextBin, ['build'], buildEnv, BUILD_LOG);
    log(`built in ${((Date.now() - t) / 1000).toFixed(0)}s`);
  }

  const runtimeEnv: NodeJS.ProcessEnv = {
    ...buildEnv,
    PORT: String(PERF_PORT),
    DATABASE_URL: appRoleUrl(),
    REDIS_URL: PERF_REDIS_URL,
    NEXTAUTH_URL: PERF_BASE_URL,
    NEXTAUTH_SECRET: PERF_NEXTAUTH_SECRET,
    DATA_ENCRYPTION_KEY: PERF_DATA_ENCRYPTION_KEY,
    // Sign-in is by the credentials provider (see global-setup.ts), which
    // exists for test runs only and says so with both of these (#361,
    // src/lib/auth/password-sign-in.ts).
    TEST_PASSWORD_SIGN_IN: '1',
    DEPLOY_ENV: 'test',
  };
  // The runtime never needs the owner, and must not be able to find it.
  delete runtimeEnv.DIRECT_DATABASE_URL;
  // No OAuth: a configured provider would only add buttons nobody presses.
  for (const k of [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'FACEBOOK_CLIENT_ID',
    'FACEBOOK_CLIENT_SECRET',
  ]) {
    delete runtimeEnv[k];
  }

  log(`next start -p ${PERF_PORT} (log: ${SERVER_LOG})`);
  const out = createWriteStream(SERVER_LOG);
  const server = spawn(nextBin, ['start', '-p', String(PERF_PORT)], {
    env: runtimeEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(out);
  server.stderr.pipe(out);

  const stop = (signal: NodeJS.Signals) => {
    server.kill(signal);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  server.on('exit', (code, signal) => {
    log(`next start exited (${code ?? signal})`);
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  process.stderr.write(`[perf:serve] ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
