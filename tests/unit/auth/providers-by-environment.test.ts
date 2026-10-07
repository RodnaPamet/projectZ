/**
 * @jest-environment node
 */
import type { NextAuthOptions } from 'next-auth';

/**
 * WHICH WAYS IN A PROCESS REGISTERS, BY ENVIRONMENT (#361, Q15/Q21).
 *
 * Everyone signs in with Google or Facebook. Email and password exist for the
 * test suites only: `TEST_PASSWORD_SIGN_IN=1`, honoured only with
 * `DEPLOY_ENV=test`. In production and on staging the flag changes nothing —
 * and a deployment carrying it does not start at all (password-sign-in.test).
 *
 * `src/auth.ts` decides its providers when it loads, so each case evaluates it
 * afresh under the environment it describes.
 */

jest.mock('@/lib/db/prisma', () => ({ prisma: {} }));
jest.mock('@/lib/db/rls-middleware', () => ({ runAsSuperuser: jest.fn() }));
jest.mock('@/lib/auth/sessions', () => ({
  SESSION_MAX_AGE_SECONDS: 604800,
  createUserSession: jest.fn(),
  newSessionSecret: jest.fn(() => 'secret'),
}));

const KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'FACEBOOK_CLIENT_ID',
  'FACEBOOK_CLIENT_SECRET',
  'TEST_PASSWORD_SIGN_IN',
  'DEPLOY_ENV',
] as const;
type Env = Partial<Record<(typeof KEYS)[number], string>>;

function providerIds(env: Env): string[] {
  const saved = new Map(KEYS.map((k) => [k, process.env[k]] as const));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    let options: NextAuthOptions | undefined;
    jest.isolateModules(() => {
      options = (require('@/auth') as typeof import('@/auth')).authOptions;
    });
    return options!.providers.map((p) => p.id);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const BOTH: Env = {
  GOOGLE_CLIENT_ID: 'google-id',
  GOOGLE_CLIENT_SECRET: 'google-secret', // pragma: allowlist secret
  FACEBOOK_CLIENT_ID: 'facebook-id',
  FACEBOOK_CLIENT_SECRET: 'facebook-secret', // pragma: allowlist secret
};

describe('the providers a process registers', () => {
  describe.each([
    ['production, DEPLOY_ENV unset (how production runs)', {}],
    ['production', { DEPLOY_ENV: 'production' }],
    ['staging', { DEPLOY_ENV: 'staging' }],
  ] as const)('%s', (_label, deploy: Env) => {
    it('is Google and Facebook when both are configured', () => {
      expect(providerIds({ ...BOTH, ...deploy })).toEqual(['google', 'facebook']);
    });

    it('never adds credentials, even with the test flag set', () => {
      expect(providerIds({ ...BOTH, ...deploy, TEST_PASSWORD_SIGN_IN: '1' })).toEqual([
        'google',
        'facebook',
      ]);
    });

    it('is only what is configured', () => {
      expect(providerIds({ ...deploy, GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's' })).toEqual([
        'google',
      ]);
      expect(
        providerIds({ ...deploy, FACEBOOK_CLIENT_ID: 'f', FACEBOOK_CLIENT_SECRET: 's' }),
      ).toEqual(['facebook']);
      expect(providerIds({ ...deploy })).toEqual([]);
    });
  });

  describe('a test run (DEPLOY_ENV=test)', () => {
    it('adds credentials when the flag asks for it', () => {
      expect(providerIds({ ...BOTH, DEPLOY_ENV: 'test', TEST_PASSWORD_SIGN_IN: '1' })).toEqual([
        'google',
        'facebook',
        'credentials',
      ]);
      expect(providerIds({ DEPLOY_ENV: 'test', TEST_PASSWORD_SIGN_IN: '1' })).toEqual([
        'credentials',
      ]);
    });

    it('does not, when it does not', () => {
      expect(providerIds({ ...BOTH, DEPLOY_ENV: 'test' })).toEqual(['google', 'facebook']);
      expect(providerIds({ ...BOTH, DEPLOY_ENV: 'test', TEST_PASSWORD_SIGN_IN: '0' })).toEqual([
        'google',
        'facebook',
      ]);
    });
  });

  it('never registers Microsoft, whatever the environment says', () => {
    // The MICROSOFT_* variables are gone with the provider (#361). A
    // deployment that still has them in its .env gets no Microsoft button.
    const legacy = {
      MICROSOFT_CLIENT_ID: 'ms-id',
      MICROSOFT_CLIENT_SECRET: 'ms-secret', // pragma: allowlist secret
      MICROSOFT_TENANT_ID: 'common',
    };
    Object.assign(process.env, legacy);
    try {
      expect(providerIds({ ...BOTH })).toEqual(['google', 'facebook']);
      expect(
        providerIds({ ...BOTH, DEPLOY_ENV: 'test', TEST_PASSWORD_SIGN_IN: '1' }),
      ).not.toContain('azure-ad');
    } finally {
      for (const k of Object.keys(legacy)) delete process.env[k];
    }
  });
});
