import { readFileSync } from 'node:fs';

import {
  assertPasswordSignInNotDeployed,
  isDeployment,
  passwordSignInEnabled,
  PasswordSignInInDeploymentError,
} from '@/lib/auth/password-sign-in';

/**
 * EMAIL + PASSWORD: THE TEST SUITES ONLY, AND A DEPLOYMENT CANNOT TURN IT ON (#361).
 *
 * Every case passes its environment explicitly. jest.setup.ts sets the pair
 * for the whole run — the integration suites sign in with passwords — so a
 * test that read `process.env` here would only ever see a test run.
 */

describe('passwordSignInEnabled', () => {
  it('is on in a test run that asks for it, and nowhere else', () => {
    expect(passwordSignInEnabled({ TEST_PASSWORD_SIGN_IN: '1', DEPLOY_ENV: 'test' })).toBe(true);

    expect(passwordSignInEnabled({ DEPLOY_ENV: 'test' })).toBe(false);
    expect(passwordSignInEnabled({ TEST_PASSWORD_SIGN_IN: '0', DEPLOY_ENV: 'test' })).toBe(false);
    expect(passwordSignInEnabled({ TEST_PASSWORD_SIGN_IN: 'true', DEPLOY_ENV: 'test' })).toBe(
      false,
    );
  });

  it.each([
    ['DEPLOY_ENV unset — how production runs', {}],
    ['production', { DEPLOY_ENV: 'production' }],
    ['staging', { DEPLOY_ENV: 'staging' }],
    ['an empty DEPLOY_ENV', { DEPLOY_ENV: '' }],
    ['a value nobody anticipated', { DEPLOY_ENV: 'prod' }],
  ])('is OFF in %s, whatever the flag says', (_label, deploy) => {
    expect(passwordSignInEnabled({ ...deploy, TEST_PASSWORD_SIGN_IN: '1' })).toBe(false);
  });
});

describe('isDeployment', () => {
  it('is everything that is not explicitly a test run', () => {
    // An allow-list of one. A deny-list of production and staging would
    // admit the unset value production actually runs with.
    expect(isDeployment({})).toBe(true);
    expect(isDeployment({ DEPLOY_ENV: 'production' })).toBe(true);
    expect(isDeployment({ DEPLOY_ENV: 'staging' })).toBe(true);
    expect(isDeployment({ DEPLOY_ENV: 'Test' })).toBe(true);
    expect(isDeployment({ DEPLOY_ENV: 'test' })).toBe(false);
  });
});

describe('the startup check: a deployment carrying the flag refuses to start', () => {
  it.each([
    ['DEPLOY_ENV unset', {}, /DEPLOY_ENV=production, because DEPLOY_ENV is unset/],
    ['production', { DEPLOY_ENV: 'production' }, /DEPLOY_ENV=production\)/],
    ['staging', { DEPLOY_ENV: 'staging' }, /DEPLOY_ENV=staging\)/],
  ])('%s + TEST_PASSWORD_SIGN_IN=1 throws', (_label, deploy, says) => {
    const start = () => assertPasswordSignInNotDeployed({ ...deploy, TEST_PASSWORD_SIGN_IN: '1' });

    expect(start).toThrow(PasswordSignInInDeploymentError);
    expect(start).toThrow(/Refusing to start: TEST_PASSWORD_SIGN_IN is set/);
    expect(start).toThrow(says);
  });

  it('refuses ANY value of the flag in a deployment, not only "1"', () => {
    // `true` turns nothing on — but it says somebody tried, in production.
    for (const value of ['true', '0', 'yes']) {
      expect(() =>
        assertPasswordSignInNotDeployed({ DEPLOY_ENV: 'production', TEST_PASSWORD_SIGN_IN: value }),
      ).toThrow(PasswordSignInInDeploymentError);
    }
  });

  it('lets every correctly configured process start', () => {
    // A deployment without the flag, and a test run with or without it.
    expect(() => assertPasswordSignInNotDeployed({})).not.toThrow();
    expect(() => assertPasswordSignInNotDeployed({ DEPLOY_ENV: 'production' })).not.toThrow();
    expect(() => assertPasswordSignInNotDeployed({ DEPLOY_ENV: 'staging' })).not.toThrow();
    expect(() =>
      assertPasswordSignInNotDeployed({ DEPLOY_ENV: 'production', TEST_PASSWORD_SIGN_IN: '' }),
    ).not.toThrow();
    expect(() =>
      assertPasswordSignInNotDeployed({ DEPLOY_ENV: 'test', TEST_PASSWORD_SIGN_IN: '1' }),
    ).not.toThrow();
  });

  it('runs at server start, before anything else, and ends the process (instrumentation-node.ts)', () => {
    // A throw alone does not stop `next start`: measured on Next 16.3, it keeps
    // its port and answers 500 to everything, which compose counts as started.
    // So the refusal exits. The check reads only the environment, so it goes
    // before the database one — a refused deploy opens no connection.
    const src = readFileSync('src/instrumentation-node.ts', 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const check = code.indexOf('assertPasswordSignInNotDeployed();');
    const exit = code.indexOf('process.exit(1);');
    const db = code.indexOf('await assertLeastPrivilegeConnection();');

    expect(check).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(check);
    expect(db).toBeGreaterThan(exit);
    expect(readFileSync('src/instrumentation.ts', 'utf8')).toMatch(
      /NEXT_RUNTIME === 'nodejs'[\s\S]*import\('\.\/instrumentation-node'\)/,
    );
  });
});
