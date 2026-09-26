import { readFileSync, globSync } from 'node:fs';

/**
 * AN OVERRIDE IS A CLAIM ABOUT THE CODE, AND CLAIMS ROT.
 *
 * `package.json` pins `nodemailer: "$nodemailer"` so the root's 10.x wins over
 * the `peerOptional nodemailer@^7.0.7` that `next-auth@4.24.15` declares —
 * 4.24.15 being the last of v4, with no newer release that widens the range.
 *
 * Staying on 7.x was not an option: it carries ten advisories, two of them HIGH
 * (GHSA-2x7j-588g-ccc2, GHSA-p6gq-j5cr-w38f), and the CI security gate blocks a
 * merge on them. The highest fix line is 9.1.1.
 *
 * The override is safe for exactly ONE reason: nothing loads next-auth's email
 * provider. `next-auth/providers/email` is the only module in that package that
 * requires nodemailer, and this app registers Credentials, AzureAD and Google.
 * Overriding a peer nobody exercises costs nothing.
 *
 * Add an Email provider and that stops being true the moment it is imported:
 * next-auth's code would run against a nodemailer three majors ahead of what it
 * was written for, and the failure would be at send time — the worst place, in
 * the least-tested path, in production, for a magic link somebody is waiting on.
 *
 * `docs/implementation-notes/p01-deviations.md` says as much in prose. This is
 * the same sentence, enforced.
 */

const SOURCE = globSync('src/**/*.{ts,tsx}', { cwd: process.cwd() });

describe('the nodemailer override stays safe', () => {
  it('no source file imports next-auth’s email provider', () => {
    // If this fails the override is no longer free. Either drop back to a
    // nodemailer next-auth actually supports and re-open the advisories, or
    // send the magic link through src/lib/email/mailer.ts and keep the pin.
    const offenders = SOURCE.filter((file) =>
      /from\s+['"]next-auth\/providers\/email['"]|require\(['"]next-auth\/providers\/email['"]\)/.test(
        readFileSync(file, 'utf8'),
      ),
    );

    expect(offenders).toEqual([]);
  });

  it('the override is still present and still points at the root version', () => {
    // Removing the override without removing the reason reintroduces the peer
    // conflict, and `npm ci` is where that surfaces — after review, in CI.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      overrides?: Record<string, string>;
      dependencies?: Record<string, string>;
    };

    expect(pkg.overrides?.nodemailer).toBe('$nodemailer');
    // `$nodemailer` resolves to whatever `dependencies` says, so the advisory
    // floor has to be asserted there rather than in the override.
    const major = Number(/(\d+)/.exec(pkg.dependencies?.nodemailer ?? '')?.[1]);
    expect(major).toBeGreaterThanOrEqual(10);
  });
});
