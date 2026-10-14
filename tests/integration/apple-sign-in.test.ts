import { NextRequest } from 'next/server';

import { deleteMyAccount } from '@/app-layer/usecases/account-deletion';
import { POST as confirm } from '@/app/api/v1/auth/apple/confirm/route';
import { POST as emailStep } from '@/app/api/v1/auth/apple/email/route';
import { POST as token } from '@/app/api/v1/auth/token/route';
import { verifyAppleIdToken } from '@/lib/auth/native-grants';
import { sendMail } from '@/lib/email/mailer';

import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * SIGN IN WITH APPLE, END TO END (#442; owner decisions 2026-10-14).
 *
 * Apple's verifier and the mail send are stand-ins; the ticket, the code,
 * the account resolution, the Apple subject on the account (P76) and the
 * sessions are real, against the database.
 */
jest.mock('@/lib/auth/native-grants', () => ({
  ...jest.requireActual('@/lib/auth/native-grants'),
  verifyAppleIdToken: jest.fn(),
}));
jest.mock('@/lib/email/mailer', () => ({
  ...jest.requireActual('@/lib/email/mailer'),
  sendMail: jest.fn(async () => ({ delivered: true })),
}));
const mockApple = verifyAppleIdToken as jest.Mock;
const mockMail = sendMail as jest.Mock;

describe('Sign in with Apple', () => {
  const db = prismaTestClient();
  let ip = 0;
  const post = (handler: typeof token, url: string, body: unknown) =>
    handler(
      new NextRequest(url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `10.45.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`,
        },
      }),
      undefined,
    );
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  const appleSays = (subject: string, email: string | null, privateEmail: boolean) =>
    mockApple.mockResolvedValue({
      provider: 'apple',
      subject,
      email,
      emailVerified: email !== null,
      privateEmail,
      name: null,
      picture: null,
    });

  const userBySubject = (subject: string) =>
    asAppSuperuser(db, (tx) =>
      tx.user.findUnique({
        where: { appleSubject: subject },
        select: { id: true, email: true, name: true, locale: true, accountKind: true },
      }),
    );

  /** The code in the last email sent, and where it went. */
  const lastMail = () => {
    const mail = mockMail.mock.calls.at(-1)?.[0] as { to: string; text: string; subject: string };
    return { to: mail.to, code: /\b(\d{6})\b/.exec(mail.text)?.[1] ?? '', subject: mail.subject };
  };

  beforeEach(() => mockMail.mockClear());

  it('a hidden address: ticket, code, confirm; then the next sign-in asks nothing', async () => {
    const subject = `apple-hidden-${Date.now()}`;
    const real = `real-${Date.now()}@playerz.test`;
    appleSays(subject, `${subject}@privaterelay.appleid.com`, true);

    // 1. Apple hid the address: a ticket, no session.
    let res = await post(token, 'http://t/api/v1/auth/token', {
      grant: 'apple',
      idToken: 'a',
      givenName: 'Петя',
      familyName: 'Иванова',
      locale: 'en',
    });
    expect(res.status).toBe(403);
    const refused = await json(res);
    expect(refused.error.code).toBe('REAL_EMAIL_REQUIRED');
    const ticket = refused.error.details.ticket as string;
    expect(await userBySubject(subject)).toBeNull();

    // The relay address itself is not accepted as the real one.
    res = await post(emailStep, 'http://t/api/v1/auth/apple/email', {
      ticket,
      email: `${subject}@privaterelay.appleid.com`,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('EMAIL_IS_RELAY');

    // 2. A code to the real address, in the app's language.
    res = await post(emailStep, 'http://t/api/v1/auth/apple/email', {
      ticket,
      email: ` ${real.toUpperCase()} `,
    });
    expect(res.status).toBe(200);
    const { challenge } = (await json(res)).data as { challenge: string };
    const mail = lastMail();
    expect(mail.to).toBe(real);
    expect(mail.subject).toContain(mail.code);
    expect(mail.subject).toMatch(/^Your playerz\.bg code/);

    // 3. A wrong code is refused; the right one signs in.
    res = await post(confirm, 'http://t/api/v1/auth/apple/confirm', {
      challenge,
      code: mail.code === '000000' ? '000001' : '000000',
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('EMAIL_CODE_WRONG');

    res = await post(confirm, 'http://t/api/v1/auth/apple/confirm', { challenge, code: mail.code });
    expect(res.status).toBe(200);
    expect(typeof (await json(res)).data.accessToken).toBe('string');

    const user = await userBySubject(subject);
    expect(user).toMatchObject({
      email: real,
      name: 'Петя Иванова',
      locale: 'en',
      accountKind: null,
    });

    // 4. The same Apple ID again: straight in, same account, no mail.
    res = await post(token, 'http://t/api/v1/auth/token', { grant: 'apple', idToken: 'a' });
    expect(res.status).toBe(200);
    expect(mockMail).toHaveBeenCalledTimes(1);
    expect((await userBySubject(subject))?.id).toBe(user!.id);
  });

  it('a real address Apple vouches for links an existing account at once', async () => {
    const t = await seedTenant({}, db);
    const owner = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: t.userId }, select: { email: true } }),
    );
    const subject = `apple-real-${Date.now()}`;
    appleSays(subject, owner.email, false);

    const res = await post(token, 'http://t/api/v1/auth/token', { grant: 'apple', idToken: 'a' });

    expect(res.status).toBe(200);
    expect((await userBySubject(subject))?.id).toBe(t.userId);
    expect(mockMail).not.toHaveBeenCalled();
  });

  it('a confirmed address that already has an account signs into it', async () => {
    const t = await seedTenant({}, db);
    const owner = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: t.userId }, select: { email: true } }),
    );
    const subject = `apple-existing-${Date.now()}`;
    appleSays(subject, `${subject}@privaterelay.appleid.com`, true);

    const refused = await json(
      await post(token, 'http://t/api/v1/auth/token', { grant: 'apple', idToken: 'a' }),
    );
    const sent = await json(
      await post(emailStep, 'http://t/api/v1/auth/apple/email', {
        ticket: refused.error.details.ticket,
        email: owner.email,
      }),
    );
    const res = await post(confirm, 'http://t/api/v1/auth/apple/confirm', {
      challenge: sent.data.challenge,
      code: lastMail().code,
    });

    expect(res.status).toBe(200);
    expect((await userBySubject(subject))?.id).toBe(t.userId);
  });

  it('deleting the account frees the Apple ID: the next sign-in starts afresh', async () => {
    const subject = `apple-deleted-${Date.now()}`;
    const email = `apple-deleted-${Date.now()}@playerz.test`;
    appleSays(subject, email, false);
    expect(
      (await post(token, 'http://t/api/v1/auth/token', { grant: 'apple', idToken: 'a' })).status,
    ).toBe(200);
    const before = await userBySubject(subject);

    await deleteMyAccount(before!.id);

    // The tombstone holds no subject (CHECK app_user_deleted_has_no_apple_subject).
    const tomb = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: before!.id }, select: { appleSubject: true } }),
    );
    expect(tomb.appleSubject).toBeNull();

    expect(
      (await post(token, 'http://t/api/v1/auth/token', { grant: 'apple', idToken: 'a' })).status,
    ).toBe(200);
    const after = await userBySubject(subject);
    expect(after?.id).not.toBe(before!.id);
  });
});
