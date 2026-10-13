import { NextRequest } from 'next/server';

import { GET as openHeaderLink, POST as oneClick } from '@/app/api/email/unsubscribe/[token]/route';
import { unsubscribeByToken, unsubscribeStanding } from '@/app-layer/usecases/email-unsubscribe';
import { getMyNotificationSettings } from '@/app-layer/usecases/my-notifications';
import { deleteAccount } from '@/app-layer/usecases/account-deletion';
import { unsubscribeToken } from '@/lib/email/unsubscribe';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { seedPlayer } from '../helpers/auth';
import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';

/**
 * ONE-CLICK UNSUBSCRIBE (#528), against a real database: the link switches
 * off exactly one kind of email for exactly one account, without a session,
 * and nothing else.
 */
describe('one-click unsubscribe (#528)', () => {
  const db = prismaTestClient();
  let me: string;
  let other: string;

  const ALL_ON = {
    confirmation: true,
    reminder: true,
    clubChanges: true,
    messages: true,
    openPlay: true,
  };
  const emails = async (userId: string) => (await getMyNotificationSettings(userId))?.email;

  const post = (token: string, body = 'List-Unsubscribe=One-Click') =>
    oneClick(
      new NextRequest(`http://localhost/api/email/unsubscribe/${token}`, {
        method: 'POST',
        // What a mail client sends: a form body, no cookie, no origin.
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }),
      { params: Promise.resolve({ token }) },
    );

  beforeEach(async () => {
    await resetDatabase(db);
    const club = await seedTenant({}, db);
    me = await seedPlayer(db, club.tenantId, 'me');
    other = await seedPlayer(db, club.tenantId, 'other');
  });

  it('switches off the one kind the link was signed for, and nothing else', async () => {
    expect(await emails(me)).toEqual(ALL_ON);
    const token = unsubscribeToken(me, 'reminder');

    expect(await unsubscribeStanding(token)).toEqual({ category: 'reminder', on: true });
    expect(await unsubscribeByToken(token)).toEqual({ category: 'reminder' });

    expect(await emails(me)).toEqual({ ...ALL_ON, reminder: false });
    expect(await unsubscribeStanding(token)).toEqual({ category: 'reminder', on: false });
    // Nobody else's settings moved.
    expect(await emails(other)).toEqual(ALL_ON);
  });

  it('pressing twice is pressing once, and a second kind needs its own link', async () => {
    const token = unsubscribeToken(me, 'messages');
    await unsubscribeByToken(token);
    await unsubscribeByToken(token);
    expect(await emails(me)).toEqual({ ...ALL_ON, messages: false });

    await unsubscribeByToken(unsubscribeToken(me, 'openPlay'));
    expect(await emails(me)).toEqual({ ...ALL_ON, messages: false, openPlay: false });
  });

  it('a mail client’s POST does it, with no session: 200, and again 200', async () => {
    const token = unsubscribeToken(me, 'confirmation');
    const res = await post(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unsubscribed: true });
    expect(await emails(me)).toEqual({ ...ALL_ON, confirmation: false });

    expect((await post(token, '')).status).toBe(200);
  });

  it('a link this server did not sign is 404 for every reason alike, and changes nothing', async () => {
    const real = unsubscribeToken(me, 'reminder');
    const [payload, tag] = real.split('.') as [string, string];
    const otherKind = Buffer.from(`${me}:messages`, 'utf8').toString('base64url');
    for (const bad of ['garbage', `${payload}.AAAA`, `${otherKind}.${tag}`, `${payload}`]) {
      const res = await post(bad);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
      expect(await unsubscribeStanding(bad)).toBeNull();
      expect(await unsubscribeByToken(bad)).toBeNull();
    }
    expect(await emails(me)).toEqual(ALL_ON);
  });

  it('opening the header’s link in a browser switches nothing off: it leads to the page that asks', async () => {
    const token = unsubscribeToken(me, 'clubChanges');
    const res = await openHeaderLink(
      new NextRequest(`http://localhost/api/email/unsubscribe/${token}`),
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).pathname).toBe(`/email/unsubscribe/${token}`);
    expect(await emails(me)).toEqual(ALL_ON);
  });

  it('a link for an account since deleted answers as done, and says nothing about the account', async () => {
    const token = unsubscribeToken(me, 'reminder');
    await runAsSuperuser((tx) => deleteAccount(tx, { userId: me, by: 'self' }));

    const res = await post(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unsubscribed: true });
    expect(await unsubscribeStanding(token)).toEqual({ category: 'reminder', on: false });
  });
});
