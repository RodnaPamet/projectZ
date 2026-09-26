import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { POST as registerDevice } from '@/app/api/v1/devices/route';
import { createUserSession, newSessionSecret } from '@/lib/auth/sessions';

import { prismaTestClient, seedTenant } from '../helpers/db';

/**
 * POST /api/v1/devices — APNs token registration.
 *
 * ═══ THIS ROUTE HAD NO TESTS AT ALL ═══
 *
 * Not one, anywhere in the repo. It is the only way an APNs token ever reaches
 * the database, so it is the entire foundation of #166 — a feature whose whole
 * complaint is that it is "wired but unexercised". The registration half was
 * unexercised too, and by something cheaper to fix than a real device.
 *
 * ═══ WHAT THE ENVIRONMENT TESTS ARE ACTUALLY PROTECTING ═══
 *
 * The line was:
 *
 *   const environment = body.environment === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION';
 *
 * so a missing field, `"sandbox"` in the wrong case, or `null` all became
 * PRODUCTION silently. A DEBUG BUILD registers a SANDBOX token; stored as
 * PRODUCTION it is sent to api.push.apple.com, Apple returns `400
 * BadDeviceToken` — a correct device verdict — and the row is DELETED. The app
 * re-registers on next launch and the cycle repeats: push simply never works,
 * the row keeps disappearing, and nothing anywhere reports a reason.
 *
 * So these are not input-validation manners. Each one is a device registration
 * that would have been destroyed on its first push.
 */
describe('POST /api/v1/devices', () => {
  const db = prismaTestClient();

  async function bearerFor(userId: string) {
    const { userSessionId, sessionVersion } = await createUserSession({
      userId,
      sessionSecret: newSessionSecret(),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    return encode({
      secret: process.env.NEXTAUTH_SECRET!,
      maxAge: 900,
      token: { sub: userId, userSessionId, sessionVersion },
    });
  }

  const TOKEN = 'a'.repeat(64);

  const post = (bearer: string, body: unknown) =>
    registerDevice(
      new NextRequest('http://t/api/v1/devices', {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      // This route takes no path params, but defineV1Route's signature is
      // (req, ctx) — jest does not mind the missing second argument and tsc
      // does, so it is passed explicitly rather than left to drift.
      undefined,
    );

  const base = { deviceToken: TOKEN, bundleId: 'bg.playerz.app' };

  it('registers a token when the environment is stated explicitly', async () => {
    const t = await seedTenant({}, db);
    const res = await post(await bearerFor(t.userId), { ...base, environment: 'SANDBOX' });

    expect(res.status).toBeLessThan(300);

    const row = await db.deviceToken.findFirst({ where: { deviceToken: TOKEN } });
    expect(row).toMatchObject({ environment: 'SANDBOX', bundleId: 'bg.playerz.app' });
  });

  it.each([
    ['omitted', undefined],
    ['lower case', 'sandbox'],
    ['null', null],
    ['mixed case', 'Sandbox'],
    ['nonsense', 'STAGING'],
  ])('REFUSES an environment that is %s rather than assuming PRODUCTION', async (_label, value) => {
    const t = await seedTenant({}, db);
    const body: Record<string, unknown> = { ...base };
    if (value !== undefined) body.environment = value;

    const res = await post(await bearerFor(t.userId), body);

    expect(res.status).toBe(400);
    // Nothing stored: a row written under a guessed environment is the thing
    // that gets deleted later, so there must not be one.
    expect(await db.deviceToken.findFirst({ where: { deviceToken: TOKEN } })).toBeNull();
  });

  it('keeps SANDBOX and PRODUCTION as separate registrations of the same token', async () => {
    // The unique key is (deviceToken, environment). They are genuinely
    // different registrations, and collapsing them would delete one when the
    // other dies.
    const t = await seedTenant({}, db);
    const bearer = await bearerFor(t.userId);

    await post(bearer, { ...base, environment: 'SANDBOX' });
    await post(bearer, { ...base, environment: 'PRODUCTION' });

    const rows = await db.deviceToken.findMany({ where: { deviceToken: TOKEN } });
    expect(rows.map((r) => r.environment).sort()).toEqual(['PRODUCTION', 'SANDBOX']);
  });
});
