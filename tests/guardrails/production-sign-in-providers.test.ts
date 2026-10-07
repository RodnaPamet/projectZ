import { globSync, readFileSync, statSync } from 'node:fs';

import type { NextAuthOptions } from 'next-auth';

/**
 * IN PRODUCTION, THE WAYS IN ARE GOOGLE AND FACEBOOK. NOTHING ELSE (#361).
 *
 * Owner decisions Q15/Q21: everyone signs in with Google or Facebook;
 * Microsoft/Entra is gone; email and password stay for the test suites only
 * and are never enabled in production.
 *
 * Before #361 the credentials provider was registered unconditionally, so
 * password sign-in was live in production for any account with a
 * `passwordHash` — nobody had one, which is the only reason it was harmless.
 * This pins the provider list a production process actually builds, with the
 * environment set as WRONG as it can plausibly be: the test flag copied into
 * the .env, the retired MICROSOFT_* variables still there.
 *
 * The flag in a deployment also stops the server from starting
 * (`assertPasswordSignInNotDeployed`, password-sign-in.test.ts); this proves
 * that even past that, it would turn nothing on.
 */

jest.mock('@/lib/db/prisma', () => ({ prisma: {} }));
jest.mock('@/lib/db/rls-middleware', () => ({ runAsSuperuser: jest.fn() }));
jest.mock('@/lib/auth/sessions', () => ({
  SESSION_MAX_AGE_SECONDS: 604800,
  createUserSession: jest.fn(),
  newSessionSecret: jest.fn(() => 'secret'),
}));

const PRODUCTION_AT_ITS_WORST: Record<string, string> = {
  GOOGLE_CLIENT_ID: 'google-id',
  GOOGLE_CLIENT_SECRET: 'google-secret', // pragma: allowlist secret
  FACEBOOK_CLIENT_ID: 'facebook-id',
  FACEBOOK_CLIENT_SECRET: 'facebook-secret', // pragma: allowlist secret
  TEST_PASSWORD_SIGN_IN: '1',
  MICROSOFT_CLIENT_ID: 'ms-id',
  MICROSOFT_CLIENT_SECRET: 'ms-secret', // pragma: allowlist secret
  MICROSOFT_TENANT_ID: 'common',
};

function providersIn(env: Record<string, string>): string[] {
  const keys = [...Object.keys(PRODUCTION_AT_ITS_WORST), 'DEPLOY_ENV'];
  const saved = new Map(keys.map((k) => [k, process.env[k]] as const));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try {
    let options: NextAuthOptions | undefined;
    jest.isolateModules(() => {
      options = (require('@/auth') as typeof import('@/auth')).authOptions;
    });
    return options!.providers.map((p) => p.id).sort();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('a production process registers Google and Facebook, and nothing else', () => {
  it.each([
    ['DEPLOY_ENV unset, which is how production runs', {}],
    ['DEPLOY_ENV=production', { DEPLOY_ENV: 'production' }],
  ])('%s', (_label, deploy) => {
    const ids = providersIn({ ...PRODUCTION_AT_ITS_WORST, ...deploy });

    expect(ids).toEqual(['facebook', 'google']);
    expect(ids).not.toContain('credentials');
    expect(ids).not.toContain('azure-ad');
  });

  it('and each only when configured: never a provider with no credentials', () => {
    expect(providersIn({ TEST_PASSWORD_SIGN_IN: '1', DEPLOY_ENV: 'production' })).toEqual([]);
  });

  it('staging, which runs every merge before production, is held to the same', () => {
    expect(providersIn({ ...PRODUCTION_AT_ITS_WORST, DEPLOY_ENV: 'staging' })).toEqual([
      'facebook',
      'google',
    ]);
  });
});

describe('no other way in can be added without this file saying so', () => {
  const SOURCE = globSync('src/**/*.{ts,tsx}');
  const code = (file: string) =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');

  it('the scan is not vacuous', () => {
    expect(SOURCE.length).toBeGreaterThan(200);
    expect(SOURCE).toContain('src/auth.ts');
  });

  it('next-auth providers are imported in src/auth.ts only, and they are these three', () => {
    const imports = SOURCE.flatMap((file) =>
      [...code(file).matchAll(/['"]next-auth\/providers\/([\w-]+)['"]/g)].map(
        (m) => `${file}: ${m[1]}`,
      ),
    ).sort();

    expect(imports).toEqual([
      'src/auth.ts: credentials',
      'src/auth.ts: facebook',
      'src/auth.ts: google',
    ]);
  });

  it('the credentials provider sits behind passwordSignInEnabled()', () => {
    const auth = code('src/auth.ts');
    const gate = auth.indexOf('...(passwordSignInEnabled()');
    const provider = auth.indexOf('CredentialsProvider({');

    expect(gate).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(gate);
    // Exactly one registration, so a second, ungated one cannot hide.
    expect(auth.split('CredentialsProvider({').length - 1).toBe(1);
  });

  it('nothing in src still speaks Microsoft Entra', () => {
    const offenders = SOURCE.filter((file) =>
      /azure-ad|AzureADProvider|MICROSOFT_[A-Z_]+|microsoft-entra-id/.test(code(file)),
    );

    expect(offenders).toEqual([]);
  });

  it('no deployment configuration carries the test-only password flag', () => {
    // Files only: `deploy/` has subdirectories (deploy/rollback, P51).
    const deployFiles = [
      ...globSync('deploy/**/*'),
      ...globSync('ops/**/*.{yml,yaml}'),
      'Dockerfile',
      '.env.example',
    ].filter((file) => statSync(file).isFile());
    // `.env.example` documents the flag, commented out; nothing may set it.
    const setting = deployFiles.filter((file) =>
      /^\s*(?:ENV\s+)?TEST_PASSWORD_SIGN_IN\s*[=:]/m.test(readFileSync(file, 'utf8')),
    );

    expect(deployFiles.length).toBeGreaterThan(3);
    expect(setting).toEqual([]);
  });
});
