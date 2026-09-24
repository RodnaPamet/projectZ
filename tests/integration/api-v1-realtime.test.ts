import { NextRequest } from 'next/server';

import { POST as subscribeRoute } from '@/app/api/v1/realtime/subscribe/route';
import { POST as tokenRoute } from '@/app/api/v1/realtime/token/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Realtime: getting a connection, and being allowed onto a channel.
 *
 * `channels.ts` says a channel name IS an authorization boundary, and
 * `mintConnectionToken` carries no capabilities on purpose because
 * authorization is meant to happen per-subscription against the database.
 * `parseChannel` was written for that and had zero call sites — so the design
 * existed and the half that enforces it did not.
 */
describe('realtime', () => {
  const db = prismaTestClient();

  const PROXY_SECRET = 'realtime-fixture-not-a-real-secret'; // pragma: allowlist secret

  let tenant: SeededTenant;
  let member: TestIdentity;
  let outsiderId: string;
  let departedId: string;
  let conversationId: string;

  beforeEach(async () => {
    process.env.CENTRIFUGO_PROXY_SECRET = PROXY_SECRET;
    process.env.CENTRIFUGO_TOKEN_SECRET = 'token-fixture-secret'; // pragma: allowlist secret

    tenant = await seedTenant({});

    const memberId = await seedPlayer(db, tenant.tenantId, 'member');
    member = await signInAs(db, {
      userId: memberId,
      memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'PLAYER' }],
    });

    outsiderId = await seedPlayer(db, tenant.tenantId, 'outsider');
    departedId = await seedPlayer(db, tenant.tenantId, 'departed');

    conversationId = await asAppSuperuser(db, async (tx) => {
      const conv = await tx.conversation.create({
        data: { tenantId: tenant.tenantId, type: 'DM', createdById: memberId },
      });

      await tx.conversationParticipant.create({
        data: { conversationId: conv.id, userId: memberId },
      });

      // Kept, not deleted — the row survives a departure by design.
      await tx.conversationParticipant.create({
        data: { conversationId: conv.id, userId: departedId, leftAt: new Date() },
      });

      return conv.id;
    });
  });

  const subscribe = async (
    body: Record<string, unknown>,
    headers: Record<string, string> = { 'x-centrifugo-secret': PROXY_SECRET },
  ) => {
    const res = await subscribeRoute(
      new NextRequest('http://t/api/v1/realtime/subscribe', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return { res, body: (await res.json()) as Record<string, unknown> };
  };

  describe('subscribe authorization', () => {
    it('allows a participant onto their conversation', async () => {
      const { res, body } = await subscribe({
        user: member.userId,
        channel: `conv:${conversationId}`,
      });

      expect(res.status).toBe(200);
      expect(body).toEqual({ result: {} });
    });

    it('DENIES someone who LEFT the conversation', async () => {
      // The row is kept so a departed member does not vanish from history.
      // That makes "is there a participant row?" the wrong question: it would
      // let them keep receiving every new message, live, indefinitely.
      const { body } = await subscribe({
        user: departedId,
        channel: `conv:${conversationId}`,
      });

      expect(body).toHaveProperty('error');
      expect(body).not.toHaveProperty('result');
    });

    it('denies a non-participant', async () => {
      const { body } = await subscribe({
        user: outsiderId,
        channel: `conv:${conversationId}`,
      });

      expect(body).toHaveProperty('error');
    });

    it('allows your own notification channel and refuses everyone else’s', async () => {
      const mine = await subscribe({ user: member.userId, channel: `notif:${member.userId}` });
      const theirs = await subscribe({ user: member.userId, channel: `notif:${outsiderId}` });

      expect(mine.body).toEqual({ result: {} });
      expect(theirs.body).toHaveProperty('error');
    });

    it('allows your own presence channel and refuses everyone else’s', async () => {
      const mine = await subscribe({
        user: member.userId,
        channel: `presence:user:${member.userId}`,
      });
      const theirs = await subscribe({
        user: member.userId,
        channel: `presence:user:${outsiderId}`,
      });

      expect(mine.body).toEqual({ result: {} });
      expect(theirs.body).toHaveProperty('error');
    });

    it('denies a channel shape it does not recognise', async () => {
      // A shape we do not issue is one whose authorization rules were never
      // written. Wildcards and namespace tricks land here.
      for (const channel of ['conv:*', 'admin:secrets', `conv:${conversationId}:extra`, '*']) {
        const { body } = await subscribe({ user: member.userId, channel });
        expect(body).toHaveProperty('error');
      }
    });

    it('denies an anonymous connection', async () => {
      const { body } = await subscribe({ user: '', channel: `conv:${conversationId}` });
      expect(body).toHaveProperty('error');
    });

    it('never says WHY it denied — that would be a membership oracle', async () => {
      // "not a participant" rather than "no such channel" confirms the
      // conversation exists to anyone who can guess an id.
      const { body } = await subscribe({ user: outsiderId, channel: `conv:${conversationId}` });

      expect(JSON.stringify(body)).not.toMatch(/participant|conversation|exists/i);
    });
  });

  describe('the proxy secret, which is the only thing guarding this', () => {
    it('refuses a wrong secret', async () => {
      const { body } = await subscribe(
        { user: member.userId, channel: `conv:${conversationId}` },
        { 'x-centrifugo-secret': 'wrong-but-the-same-length-ok!!!!!!' },
      );

      expect(body).toHaveProperty('error');
    });

    it('refuses when no secret is presented', async () => {
      const { body } = await subscribe(
        { user: member.userId, channel: `conv:${conversationId}` },
        {},
      );
      expect(body).toHaveProperty('error');
    });

    it('refuses EVERYTHING when the secret is not configured', async () => {
      // Never "unset means allow". This path sits outside /api/t/, so no
      // middleware and no permission rule covers it — the secret is the whole
      // boundary, and an unconfigured boundary must be closed.
      delete process.env.CENTRIFUGO_PROXY_SECRET;

      const { body } = await subscribe({ user: member.userId, channel: `conv:${conversationId}` });

      expect(body).toHaveProperty('error');
      expect(body).not.toHaveProperty('result');

      process.env.CENTRIFUGO_PROXY_SECRET = PROXY_SECRET;
    });

    it('answers 200 even when denying — Centrifugo reads the BODY, not the status', async () => {
      // A non-200 makes Centrifugo treat the proxy as broken rather than as
      // having decided, and its behaviour then depends on its own config.
      const { res } = await subscribe({ user: outsiderId, channel: `conv:${conversationId}` });

      expect(res.status).toBe(200);
    });
  });

  describe('connection token', () => {
    const mintFor = async (who: TestIdentity | null) =>
      tokenRoute(
        new NextRequest('http://t/api/v1/realtime/token', {
          method: 'POST',
          headers: who ? { authorization: `Bearer ${who.bearer}` } : {},
        }),
        undefined as never,
      );

    it('mints a short-lived token for the signed-in user', async () => {
      const res = await mintFor(member);
      const body = (await res.json()) as {
        data: { token: string; expiresInSeconds: number };
      };

      expect(res.status).toBe(200);
      expect(body.data.token.split('.')).toHaveLength(3);
      expect(body.data.expiresInSeconds).toBe(15 * 60);

      // `sub` is the user and there are no capability claims — what you may
      // subscribe to is decided at subscribe time, not frozen into the token.
      const payload = JSON.parse(
        Buffer.from(body.data.token.split('.')[1]!, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;

      expect(payload.sub).toBe(member.userId);
      expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub']);
    });

    it('401s without a session', async () => {
      expect((await mintFor(null)).status).toBe(401);
    });
  });
});
