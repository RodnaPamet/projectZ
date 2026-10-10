import { randomUUID } from 'node:crypto';

import { PlatformCapability } from '@prisma/client';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { POST as reportMessageRoute } from '@/app/api/v1/me/messages/[id]/report/route';
import { GET as queueRoute } from '@/app/api/v1/platform/moderation/cases/route';
import {
  getConversation,
  openPlayerConversation,
  sendMessage,
} from '@/app-layer/usecases/messaging';
import { createUserSession, newSessionSecret } from '@/lib/auth/sessions';

import { prismaTestClient, seedAccount, seedTenant } from '../helpers/db';
import { enrolAndStepUp } from '../helpers/mfa';
import { asAppSuperuser, asAppUser, asAppUserAs, expectRlsIsolated } from '../helpers/rls';

/**
 * Platform-level reports are not readable by app_user (#483, P57).
 *
 * A message report (#375) is platform-level: its case and its report carry no
 * club. Before P57 every app_user session read them anyway, bound to any club
 * or to none: the reported message's id, the reporter's id, their words. It
 * could also delete them, or move one into its own club.
 *
 * Here the report is filed through the real route, and the moderator reads it
 * through the real queue route, on the audited platform binding. Between the
 * two, app_user sees none of it, and a club still sees its own rows.
 */
const db = prismaTestClient();
const HOUR = 3_600_000;
const REASON = 'message report shift 2026-10-10';

const uid = (prefix: string) => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 21)}`;

/** A Bearer token the way /auth/token mints one. */
async function bearerFor(userId: string) {
  const { userSessionId, sessionVersion } = await createUserSession({
    userId,
    sessionSecret: newSessionSecret(),
    expiresAt: new Date(Date.now() + HOUR),
  });
  return encode({
    secret: process.env.NEXTAUTH_SECRET!,
    maxAge: 900,
    token: { sub: userId, userSessionId, sessionVersion },
  });
}

/** A moderator who belongs to no club, with a live REVIEW_MODERATE grant and a stepped-up session. */
async function moderatorBearer() {
  const admin = await seedAccount(null, db);
  const granter = await seedAccount(null, db);
  await asAppSuperuser(db, (tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO platform_admin_grant
         (id,"userId","grantedByUserId",reason,capabilities,"expiresAt")
       VALUES ($1,$2,$3,'moderation rota',$4::"PlatformCapability"[], now() + interval '7 days')`,
      uid('cg'),
      admin,
      granter,
      `{${PlatformCapability.REVIEW_MODERATE}}`,
    ),
  );
  const bearer = await bearerFor(admin);
  await enrolAndStepUp(bearer);
  return bearer;
}

async function reportViaRoute(bearer: string, messageId: string) {
  const res = await reportMessageRoute(
    new NextRequest(`http://t/api/v1/me/messages/${messageId}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ reason: 'abuse', details: 'обижда ме' }),
    }),
    { params: Promise.resolve({ id: messageId }) },
  );
  return { status: res.status, json: (await res.json()) as unknown };
}

type QueuePage = { data: { items: Array<{ caseId: string; subject: string }> } };

async function queue(bearer: string) {
  const res = await queueRoute(
    new NextRequest(
      `http://t/api/v1/platform/moderation/cases?${new URLSearchParams({ reason: REASON })}`,
      { headers: { authorization: `Bearer ${bearer}` } },
    ),
    {},
  );
  return { status: res.status, json: (await res.json()) as QueuePage };
}

/** A player reports another player's message through POST /me/messages/{id}/report. */
async function reportedMessage() {
  const sender = await seedAccount('PLAYER', db);
  const reporter = await seedAccount('PLAYER', db);
  const { id } = await openPlayerConversation({ kind: 'player', userId: sender }, reporter);
  await sendMessage({ kind: 'player', userId: sender }, id, 'ти си никой');
  const messageId = (await getConversation({ kind: 'player', userId: reporter }, id)).messages[0]!
    .id;

  const res = await reportViaRoute(await bearerFor(reporter), messageId);
  expect(res.status).toBe(201);
  expect(res.json).toEqual({ data: { reported: true } });

  const [kase, report] = await asAppSuperuser(db, (tx) =>
    Promise.all([
      tx.moderationCase.findFirstOrThrow({ where: { subjectId: messageId, status: 'OPEN' } }),
      tx.contentReport.findFirstOrThrow({ where: { subjectId: messageId } }),
    ]),
  );
  // Platform-level by design (#375): no club owns a report about a DM.
  expect(kase).toMatchObject({ tenantId: null, subjectType: 'CHAT_MESSAGE' });
  expect(report).toMatchObject({ tenantId: null, reporterUserId: reporter });
  return { messageId, reporter, caseId: kase.id, reportId: report.id };
}

describe('platform-level reports and app_user (#483)', () => {
  it('a message reported through the route reaches the platform queue', async () => {
    const { caseId } = await reportedMessage();

    const { status, json } = await queue(await moderatorBearer());

    expect(status).toBe(200);
    expect(json.data.items).toContainEqual(
      expect.objectContaining({ caseId, subject: 'CHAT_MESSAGE' }),
    );
  });

  it('a session bound to a club sees none of it, the reporter included', async () => {
    const { messageId, reporter } = await reportedMessage();
    const club = await seedTenant({ name: 'Bystander Club' });

    const seen = await asAppUser(db, club.tenantId, (tx) =>
      Promise.all([
        tx.moderationCase.findMany({ where: { subjectId: messageId } }),
        tx.contentReport.findMany({ where: { subjectId: messageId } }),
        tx.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT (SELECT count(*) FROM moderation_case WHERE "tenantId" IS NULL)::int
                + (SELECT count(*) FROM content_report WHERE "tenantId" IS NULL)::int AS n`,
        ),
      ]),
    );
    expect(seen).toEqual([[], [], [{ n: 0 }]]);

    // Not the reporter either: no app_user path reads a report back, so P57
    // grants no `app.user_id` branch.
    const own = await asAppUserAs(db, club.tenantId, reporter, (tx) =>
      tx.contentReport.findMany({ where: { reporterUserId: reporter } }),
    );
    expect(own).toEqual([]);
  });

  it('a session bound to no club sees none of it', async () => {
    const { messageId } = await reportedMessage();

    await expectRlsIsolated(db, (tx) =>
      tx.moderationCase.findMany({ where: { subjectId: messageId } }),
    );
    await expectRlsIsolated(db, (tx) =>
      tx.contentReport.findMany({ where: { subjectId: messageId } }),
    );
  });

  it('a club can neither delete a platform report nor move it into its own club', async () => {
    const { caseId, reportId } = await reportedMessage();
    const club = await seedTenant({ name: 'Other Club' });

    const touched = await asAppUser(db, club.tenantId, async (tx) => [
      (
        await tx.moderationCase.updateMany({
          where: { id: caseId },
          data: { tenantId: club.tenantId },
        })
      ).count,
      (
        await tx.contentReport.updateMany({
          where: { id: reportId },
          data: { tenantId: club.tenantId },
        })
      ).count,
      (await tx.moderationCase.deleteMany({ where: { id: caseId } })).count,
      (await tx.contentReport.deleteMany({ where: { id: reportId } })).count,
    ]);
    expect(touched).toEqual([0, 0, 0, 0]);

    const after = await asAppSuperuser(db, (tx) =>
      Promise.all([
        tx.moderationCase.findUniqueOrThrow({ where: { id: caseId } }),
        tx.contentReport.findUniqueOrThrow({ where: { id: reportId } }),
      ]),
    );
    expect(after.map((r) => r.tenantId)).toEqual([null, null]);
  });

  it('a club still writes and reads its own rows, and only its own', async () => {
    const mine = await seedTenant({ name: 'Own Club' });
    const theirs = await seedTenant({ name: 'Their Club' });
    const reporter = await seedAccount('PLAYER', db);
    const subjectId = uid('rev');

    // WITH CHECK still admits the bound club's own tenant.
    await asAppUser(db, mine.tenantId, async (tx) => {
      await tx.contentReport.create({
        data: {
          tenantId: mine.tenantId,
          subjectType: 'REVIEW',
          subjectId,
          reporterUserId: reporter,
          reason: 'fake review',
        },
      });
      await tx.moderationCase.create({
        data: {
          tenantId: mine.tenantId,
          subjectType: 'REVIEW',
          subjectId,
          reason: 'user_report',
        },
      });
    });

    const read = (tenantId: string) =>
      asAppUser(db, tenantId, (tx) =>
        Promise.all([
          tx.moderationCase.count({ where: { subjectId } }),
          tx.contentReport.count({ where: { subjectId } }),
        ]),
      );
    expect(await read(mine.tenantId)).toEqual([1, 1]);
    expect(await read(theirs.tenantId)).toEqual([0, 0]);

    // And still refuses a NULL tenant from app_user, as P23 made it.
    await expect(
      asAppUser(db, mine.tenantId, (tx) =>
        tx.moderationCase.create({
          data: { tenantId: null, subjectType: 'REVIEW', subjectId, reason: 'user_report' },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
