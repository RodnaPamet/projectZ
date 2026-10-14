import { randomUUID } from 'node:crypto';

import { NextRequest } from 'next/server';

import {
  DELETE as certificateDelete,
  PUT as certificatePut,
} from '@/app/api/v1/me/coach-profile/certificate/route';
import { GET as profileGet, PUT as profilePut } from '@/app/api/v1/me/coach-profile/route';
import { POST as submitRoute } from '@/app/api/v1/me/coach-profile/submit/route';
import { POST as withdrawRoute } from '@/app/api/v1/me/coach-profile/withdraw/route';
import { GET as platformCertificate } from '@/app/api/v1/platform/coaches/[userId]/certificate/route';
import { POST as platformDecision } from '@/app/api/v1/platform/coaches/[userId]/decision/route';
import { GET as platformOne } from '@/app/api/v1/platform/coaches/[userId]/route';
import { GET as platformList } from '@/app/api/v1/platform/coaches/route';
import { drainEmailOutbox } from '@/app-layer/usecases/notification-outbox';
import { openCertificate } from '@/lib/coaches/certificate';
import { runAsUserOnly } from '@/lib/db/rls-middleware';
import type { EmailProvider, OutgoingEmail } from '@/lib/email/provider';
import { clearAllRateLimits } from '@/lib/security/rate-limit';

import { signInAs } from '../helpers/auth';
import { prismaTestClient, resetDatabase, seedAccount, seedTenant, seedVenue } from '../helpers/db';
import { enrolAndStepUp } from '../helpers/mfa';
import { asAppSuperuser } from '../helpers/rls';

/**
 * A COACH'S PROFILE, FROM THE FIRST SAVE TO THE OWNER'S DECISION (#545, #377),
 * through the real routes and a real database.
 *
 *   - the coach fills it in, uploads a certificate, sends it, takes it back;
 *   - what each state locks;
 *   - the owner's queue: the grant, the second factor, the audit row;
 *   - the certificate: sealed at rest, opened by nobody but a platform admin;
 *   - approve, decline (correct and send again), remove;
 *   - a decision cannot be written by anyone else, the coach least of all.
 */

const db = prismaTestClient();
const INBOX = 'owner@playerz.test';
const REASON = 'reading the coaches waiting for approval';

type Json = { data?: Record<string, unknown>; error?: { code: string; details?: unknown } };
type Route = (req: NextRequest, ctx: never) => Promise<Response>;

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('Лиценз на треньор №123')]);
const BIO = 'Треньор по тенис от 2010 г. Работя с начинаещи и с напреднали играчи.';
const FULL = {
  bio: BIO,
  qualifications: 'Лиценз ББФТ, ниво 2',
  sports: [{ sport: 'TENNIS', levelMin: 1, levelMax: 5 }],
};

async function call(
  route: unknown,
  url: string,
  init: {
    method?: string;
    bearer?: string;
    json?: unknown;
    form?: FormData;
    headers?: Record<string, string>;
  } = {},
  params?: Record<string, string>,
): Promise<{ status: number; json: Json; res: Response }> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form) {
    // Serialised by a Request, so the boundary header and the body agree.
    const encoded = new Request('http://t/', { method: 'POST', body: init.form });
    headers['content-type'] = encoded.headers.get('content-type')!;
    body = Buffer.from(await encoded.arrayBuffer());
  }
  const req = new NextRequest(`http://t${url}`, { method: init.method ?? 'GET', headers, body });
  const res = await (route as Route)(req, { params: Promise.resolve(params ?? {}) } as never);
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  return { status: res.status, json: isJson ? ((await res.clone().json()) as Json) : {}, res };
}

const upload = (bearer: string, bytes: Buffer, name: string, type = 'application/pdf') => {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], name, { type }));
  return call(certificatePut, '/api/v1/me/coach-profile/certificate', {
    method: 'PUT',
    bearer,
    form,
  });
};
const save = (bearer: string, json: unknown) =>
  call(profilePut, '/api/v1/me/coach-profile', { method: 'PUT', bearer, json });
const read = (bearer: string) => call(profileGet, '/api/v1/me/coach-profile', { bearer });
const submit = (bearer: string) =>
  call(submitRoute, '/api/v1/me/coach-profile/submit', { method: 'POST', bearer });
const withdraw = (bearer: string) =>
  call(withdrawRoute, '/api/v1/me/coach-profile/withdraw', { method: 'POST', bearer });

function recorder() {
  const sent: OutgoingEmail[] = [];
  const provider: EmailProvider = {
    name: 'resend',
    send: async (m) => {
      sent.push(m);
      return { ok: true, messageId: 'm' };
    },
  };
  return { sent, provider };
}

const outbox = () =>
  asAppSuperuser(db, (tx) =>
    tx.emailOutbox.findMany({
      orderBy: { createdAt: 'asc' },
      select: { userId: true, kind: true, category: true, subject: true, text: true },
    }),
  );
const bell = (userId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        kind: true,
        title: true,
        body: true,
        href: true,
        refType: true,
        refId: true,
        tenantId: true,
      },
    }),
  );
const audit = (actorUserId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.platformAuditEntry.findMany({
      where: { actorUserId },
      orderBy: { createdAt: 'asc' },
      select: {
        action: true,
        capability: true,
        entity: true,
        entityId: true,
        reason: true,
        detailsJson: true,
      },
    }),
  );
const profileRow = (userId: string) =>
  asAppSuperuser(db, (tx) => tx.coachProfile.findUnique({ where: { userId } }));

/** A coach account with a name, signed in. */
async function coachNamed(name: string) {
  const userId = await seedAccount('COACH', db);
  await asAppSuperuser(db, (tx) => tx.user.update({ where: { id: userId }, data: { name } }));
  return signInAs(db, { userId, memberships: [] });
}

/** A coach whose complete profile is waiting for a decision. */
async function submittedCoach(name = 'Иван Петров') {
  const coach = await coachNamed(name);
  expect((await save(coach.bearer, FULL)).status).toBe(200);
  expect((await upload(coach.bearer, PDF, 'licence.pdf')).status).toBe(200);
  expect((await submit(coach.bearer)).status).toBe(200);
  return coach;
}

/** A platform admin: a live grant with these capabilities, and (unless told not to) a fresh step-up. */
async function platformAdmin(caps: string[], opts: { stepUp?: boolean } = {}) {
  const id = (p: string) => `${p}${randomUUID().replace(/-/g, '').slice(0, 21)}`;
  const [admin, granter] = [id('cadm'), id('cgrn')];
  await asAppSuperuser(db, async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO app_user (id,email,"createdAt","updatedAt")
       VALUES ($1,$2,now(),now()), ($3,$4,now(),now())`,
      admin,
      `${admin}@test.invalid`,
      granter,
      `${granter}@test.invalid`,
    );
    if (caps.length > 0) {
      await tx.$executeRawUnsafe(
        `INSERT INTO platform_admin_grant
           (id,"userId","grantedByUserId",reason,capabilities,"grantedAt","expiresAt")
         VALUES ($1,$2,$3,'approving the pilot coaches',$4::"PlatformCapability"[],
                 now(), now() + interval '30 days')`,
        id('cg'),
        admin,
        granter,
        `{${caps.join(',')}}`,
      );
    }
  });
  const identity = await signInAs(db, { userId: admin, memberships: [] });
  if (opts.stepUp !== false) await enrolAndStepUp(identity.bearer);
  return identity;
}

const q = `?reason=${encodeURIComponent(REASON)}`;
const list = (bearer?: string, query = q) =>
  call(platformList, `/api/v1/platform/coaches${query}`, { bearer });
const one = (bearer: string, userId: string, query = q) =>
  call(platformOne, `/api/v1/platform/coaches/${userId}${query}`, { bearer }, { userId });
const certificate = (bearer: string | undefined, userId: string, query = q) =>
  call(
    platformCertificate,
    `/api/v1/platform/coaches/${userId}/certificate${query}`,
    { bearer },
    { userId },
  );
const decide = (bearer: string, userId: string, json: unknown) =>
  call(
    platformDecision,
    `/api/v1/platform/coaches/${userId}/decision`,
    { method: 'POST', bearer, json },
    { userId },
  );

beforeEach(async () => {
  await resetDatabase(db);
  await clearAllRateLimits();
  delete process.env.CONTACT_INBOX_EMAIL;
});
afterAll(() => {
  delete process.env.CONTACT_INBOX_EMAIL;
});

// ─── The coach fills it in ─────────────────────────────────────────────────

describe('a coach’s own profile', () => {
  it('is for coach accounts: 401 signed out, 403 for a player, on every route', async () => {
    expect((await read('')).status).toBe(401);
    const player = await signInAs(db, { userId: await seedAccount('PLAYER', db), memberships: [] });
    for (const res of [
      await read(player.bearer),
      await save(player.bearer, FULL),
      await upload(player.bearer, PDF, 'a.pdf'),
      await call(certificateDelete, '/api/v1/me/coach-profile/certificate', {
        method: 'DELETE',
        bearer: player.bearer,
      }),
      await submit(player.bearer),
      await withdraw(player.bearer),
    ]) {
      expect(res.status).toBe(403);
      expect(res.json.error?.code).toBe('COACH_ACCOUNT_REQUIRED');
    }
    // Nothing was made for the player by asking.
    expect(await asAppSuperuser(db, (tx) => tx.coachProfile.count())).toBe(0);
    expect(await asAppSuperuser(db, (tx) => tx.coachCertificate.count())).toBe(0);
  });

  it('a coach who has not started has an empty profile, and is told what it needs', async () => {
    const coach = await coachNamed('Иван Петров');
    const res = await read(coach.bearer);
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({
      state: 'NONE',
      slug: null,
      bio: null,
      qualifications: null,
      sports: [],
      certificate: null,
      submittedAt: null,
      decidedAt: null,
      decisionNote: null,
      missing: ['bio', 'sports', 'certificate'],
      canEdit: { text: true, certificate: true },
    });
    // Reading made nothing.
    expect(await profileRow(coach.userId)).toBeNull();
  });

  it('saves the text and the sports, makes the address from the name, and strips markup', async () => {
    const coach = await coachNamed('Иван Петров');
    const res = await save(coach.bearer, {
      bio: `  <b>${BIO}</b><script>alert(1)</script>  \r\n\r\n\r\n\r\nВтори ред. `,
      qualifications: '',
      sports: [
        { sport: 'PADEL', levelMin: 3, levelMax: 7 },
        { sport: 'TENNIS', levelMin: 1, levelMax: 5 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({
      state: 'DRAFT',
      slug: 'ivan-petrov',
      qualifications: null,
      missing: ['certificate'],
    });
    const bio = res.json.data!.bio as string;
    expect(bio).not.toMatch(/[<>]|script/);
    expect(bio.startsWith(BIO)).toBe(true);
    expect(bio.endsWith('\n\nВтори ред.')).toBe(true);
    expect((res.json.data!.sports as Array<{ sport: string }>).map((s) => s.sport).sort()).toEqual([
      'PADEL',
      'TENNIS',
    ]);

    // PUT replaces the whole list of sports.
    const again = await save(coach.bearer, {
      ...FULL,
      sports: [{ sport: 'PADEL', levelMin: 2, levelMax: 2 }],
    });
    expect(again.json.data!.sports).toEqual([{ sport: 'PADEL', levelMin: 2, levelMax: 2 }]);
    // And the address does not change with a later save.
    expect(again.json.data!.slug).toBe('ivan-petrov');
  });

  it('two coaches of one name get two addresses, neither seeing the other', async () => {
    const first = await coachNamed('Иван Петров');
    const second = await coachNamed('Иван Петров');
    const third = await coachNamed('Иван  ПЕТРОВ');
    expect((await save(first.bearer, FULL)).json.data!.slug).toBe('ivan-petrov');
    expect((await save(second.bearer, FULL)).json.data!.slug).toBe('ivan-petrov-2');
    expect((await save(third.bearer, FULL)).json.data!.slug).toBe('ivan-petrov-3');
    // Bound to the second coach, only the second coach's profile exists.
    const seen = await runAsUserOnly(second.userId, (tx) =>
      tx.coachProfile.findMany({ select: { slug: true } }),
    );
    expect(seen).toEqual([{ slug: 'ivan-petrov-2' }]);
  });

  it.each([
    ['a text over the limit', { bio: 'я'.repeat(1001) }, { field: 'bio', reason: 'TOO_LONG' }],
    [
      'a sport with no level scale',
      { sports: [{ sport: 'KARTING', levelMin: 1, levelMax: 2 }] },
      { field: 'sports', reason: 'UNKNOWN_SPORT' },
    ],
    [
      'levels the wrong way round',
      { sports: [{ sport: 'TENNIS', levelMin: 6, levelMax: 2 }] },
      { field: 'sports', reason: 'LEVELS' },
    ],
    [
      'the same sport twice',
      {
        sports: [
          { sport: 'TENNIS', levelMin: 1, levelMax: 2 },
          { sport: 'TENNIS', levelMin: 3, levelMax: 4 },
        ],
      },
      { field: 'sports', reason: 'DUPLICATE_SPORT' },
    ],
  ])('refuses %s with 400 and says which field, and saves nothing', async (_l, body, details) => {
    const coach = await coachNamed('Иван Петров');
    const res = await save(coach.bearer, body);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'VALIDATION_ERROR', details });
    expect(await profileRow(coach.userId)).toBeNull();
  });

  it('a body that is not an object is a 400', async () => {
    const coach = await coachNamed('Иван Петров');
    expect((await save(coach.bearer, [1, 2])).status).toBe(400);
    expect((await save(coach.bearer, 'text')).status).toBe(400);
  });
});

// ─── The certificate ───────────────────────────────────────────────────────

describe('the certificate', () => {
  it('is kept sealed: the stored bytes are not the document, and the answer never carries it', async () => {
    const coach = await coachNamed('Иван Петров');
    const res = await upload(coach.bearer, PDF, 'Лиценз ББФТ 2024.PDF');
    expect(res.status).toBe(200);
    expect(res.json.data!.certificate).toMatchObject({
      fileName: 'Лиценз ББФТ 2024.pdf',
      mimeType: 'application/pdf',
      byteSize: PDF.byteLength,
    });
    expect(JSON.stringify(res.json)).not.toContain('%PDF');
    expect(Object.keys(res.json.data!.certificate as object).sort()).toEqual([
      'byteSize',
      'fileName',
      'mimeType',
      'uploadedAt',
    ]);

    const stored = await asAppSuperuser(db, (tx) =>
      tx.coachCertificate.findUniqueOrThrow({ where: { userId: coach.userId } }),
    );
    const content = Buffer.from(stored.content);
    expect(content.includes(Buffer.from('%PDF'))).toBe(false);
    expect(content.includes(Buffer.from('Лиценз на треньор'))).toBe(false);
    expect(Buffer.compare(openCertificate(content), PDF)).toBe(0);
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('what the file IS decides: a renamed program is refused, a JPEG called .pdf is kept as a JPEG', async () => {
    const coach = await coachNamed('Иван Петров');
    const exe = await upload(
      coach.bearer,
      Buffer.from('MZ\x90\x00 not a certificate'),
      'licence.pdf',
    );
    expect(exe.status).toBe(400);
    expect(exe.json.error).toMatchObject({
      code: 'CERTIFICATE_REFUSED',
      details: { reason: 'NOT_A_CERTIFICATE' },
    });
    const html = await upload(
      coach.bearer,
      Buffer.from('<html><script>alert(1)</script>'),
      'x.pdf',
      'application/pdf',
    );
    expect(html.json.error?.details).toEqual({ reason: 'NOT_A_CERTIFICATE' });
    expect(await asAppSuperuser(db, (tx) => tx.coachCertificate.count())).toBe(0);

    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
    const kept = await upload(coach.bearer, jpeg, 'licence.pdf', 'application/pdf');
    expect(kept.status).toBe(200);
    expect(kept.json.data!.certificate).toMatchObject({
      fileName: 'licence.jpg',
      mimeType: 'image/jpeg',
    });
  });

  it('refuses an empty file, a body that is not a form, and one that declares itself too large', async () => {
    const coach = await coachNamed('Иван Петров');
    const empty = await upload(coach.bearer, Buffer.alloc(0), 'a.pdf');
    expect(empty.json.error).toMatchObject({
      code: 'CERTIFICATE_REFUSED',
      details: { reason: 'EMPTY' },
    });

    const raw = await call(certificatePut, '/api/v1/me/coach-profile/certificate', {
      method: 'PUT',
      bearer: coach.bearer,
      json: { file: 'not a form' },
    });
    expect(raw.json.error?.details).toEqual({ reason: 'NOT_A_CERTIFICATE' });

    // Refused on the declared length, before a byte is read.
    const big = await call(certificatePut, '/api/v1/me/coach-profile/certificate', {
      method: 'PUT',
      bearer: coach.bearer,
      headers: {
        'content-length': String(6 * 1024 * 1024),
        'content-type': 'multipart/form-data; boundary=x',
      },
    });
    expect(big.status).toBe(400);
    expect(big.json.error?.details).toEqual({ reason: 'TOO_LARGE' });

    // Over the limit without saying so: cut off while reading.
    const over = await upload(
      coach.bearer,
      Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5 * 1024 * 1024 + 70_000)]),
      'big.pdf',
    );
    expect(over.json.error?.details).toEqual({ reason: 'TOO_LARGE' });
    expect(await asAppSuperuser(db, (tx) => tx.coachCertificate.count())).toBe(0);
  });

  it('a new upload replaces the one before it, and it can be removed', async () => {
    const coach = await coachNamed('Иван Петров');
    await upload(coach.bearer, PDF, 'first.pdf');
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 1),
    ]);
    const second = await upload(coach.bearer, png, 'second.png', 'image/png');
    expect(second.json.data!.certificate).toMatchObject({
      fileName: 'second.png',
      mimeType: 'image/png',
    });
    expect(await asAppSuperuser(db, (tx) => tx.coachCertificate.count())).toBe(1);

    const gone = await call(certificateDelete, '/api/v1/me/coach-profile/certificate', {
      method: 'DELETE',
      bearer: coach.bearer,
    });
    expect(gone.status).toBe(200);
    expect(gone.json.data).toMatchObject({
      certificate: null,
      missing: expect.arrayContaining(['certificate']),
    });
    // Removing none is not an error.
    expect(
      (
        await call(certificateDelete, '/api/v1/me/coach-profile/certificate', {
          method: 'DELETE',
          bearer: coach.bearer,
        })
      ).status,
    ).toBe(200);
  });
});

// ─── Sending it ────────────────────────────────────────────────────────────

describe('sending the profile for approval', () => {
  it('names what is missing, and takes a complete one', async () => {
    const coach = await coachNamed('Иван Петров');
    const nothing = await submit(coach.bearer);
    expect(nothing.status).toBe(409);
    expect(nothing.json.error).toMatchObject({
      code: 'COACH_PROFILE_INCOMPLETE',
      details: { missing: ['bio', 'sports', 'certificate'] },
    });

    await save(coach.bearer, { ...FULL, bio: 'Твърде кратко.' });
    await upload(coach.bearer, PDF, 'licence.pdf');
    expect((await submit(coach.bearer)).json.error?.details).toEqual({ missing: ['bio'] });

    await save(coach.bearer, FULL);
    const sent = await submit(coach.bearer);
    expect(sent.status).toBe(200);
    expect(sent.json.data).toMatchObject({
      state: 'SUBMITTED',
      missing: [],
      canEdit: { text: false, certificate: false },
    });
    expect(sent.json.data!.submittedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('while it waits nothing changes; it can be taken back, changed and sent again', async () => {
    const coach = await submittedCoach();
    for (const res of [
      await save(coach.bearer, { ...FULL, bio: `${BIO} И още.` }),
      await upload(coach.bearer, PDF, 'other.pdf'),
      await call(certificateDelete, '/api/v1/me/coach-profile/certificate', {
        method: 'DELETE',
        bearer: coach.bearer,
      }),
    ]) {
      expect(res.status).toBe(409);
      expect(res.json.error).toMatchObject({
        code: 'COACH_PROFILE_LOCKED',
        details: { state: 'SUBMITTED' },
      });
    }
    expect((await read(coach.bearer)).json.data!.bio).toBe(BIO);

    const back = await withdraw(coach.bearer);
    expect(back.json.data).toMatchObject({ state: 'DRAFT', submittedAt: null, bio: BIO });
    expect(back.json.data!.certificate).not.toBeNull();
    const twice = await withdraw(coach.bearer);
    expect(twice.status).toBe(409);
    expect(twice.json.error?.code).toBe('COACH_PROFILE_NOT_SUBMITTED');

    expect((await save(coach.bearer, { ...FULL, bio: `${BIO} И още.` })).status).toBe(200);
    expect((await submit(coach.bearer)).json.data!.state).toBe('SUBMITTED');
  });

  it('tells the operator once, naming nobody; with no inbox set it queues nothing', async () => {
    const quiet = await submittedCoach('Мария Илиева');
    expect(await outbox()).toEqual([]);
    expect((await profileRow(quiet.userId))!.status).toBe('SUBMITTED');

    process.env.CONTACT_INBOX_EMAIL = INBOX;
    const coach = await submittedCoach('Иван Петров');
    // Sending again while it waits is not news.
    expect((await submit(coach.bearer)).status).toBe(200);
    const mails = await outbox();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      userId: null,
      kind: 'COACH_PROFILE_SUBMITTED',
      category: 'contact',
      subject: 'Нов профил на треньор чака одобрение',
    });
    expect(mails[0]!.text).toContain('/platform/coaches');
    expect(mails[0]!.text).not.toMatch(/Иван|Петров|ivan/i);

    const { sent, provider } = recorder();
    expect(await drainEmailOutbox({ provider })).toMatchObject({ claimed: 1, sent: 1 });
    expect(sent[0]).toMatchObject({ to: INBOX });
  });
});

// ─── A decision is the platform's ──────────────────────────────────────────

describe('a decision cannot be written by anyone but a platform admin', () => {
  it('the coach cannot approve their own profile, by any handle', async () => {
    const coach = await submittedCoach();
    const self = {
      status: 'APPROVED' as const,
      decidedAt: new Date(),
      decidedByUserId: coach.userId,
    };
    // Bound to the coach, as every route of theirs is.
    await expect(
      runAsUserOnly(coach.userId, (tx) =>
        tx.coachProfile.update({ where: { userId: coach.userId }, data: self }),
      ),
    ).rejects.toThrow(/approved or declined by a platform admin/);
    // With every policy bypassed and no admin bound: still refused.
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.coachProfile.update({ where: { userId: coach.userId }, data: self }),
      ),
    ).rejects.toThrow(/approved or declined by a platform admin/);
    // Bound to an admin, but naming somebody else as the one who decided.
    await expect(
      asAppSuperuser(db, async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.platform_admin_id', 'someoneelse', true)`,
        );
        return tx.coachProfile.update({ where: { userId: coach.userId }, data: self });
      }),
    ).rejects.toThrow(/the decision names/);
    // A profile cannot be born decided either.
    const other = await seedAccount('COACH', db);
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.coachProfile.create({
          data: { userId: other, slug: 'born-approved', ...self, decidedByUserId: other },
        }),
      ),
    ).rejects.toThrow(/approved or declined by a platform admin/);
    expect((await profileRow(coach.userId))!.status).toBe('SUBMITTED');
  });
});

// ─── The owner's queue ─────────────────────────────────────────────────────

describe('the platform’s queue', () => {
  it('401 signed out, 400 with no reason, 403 without the capability, 403 without the second factor', async () => {
    const coach = await submittedCoach();
    expect((await list()).status).toBe(401);

    // No grant at all (and so no second factor to set up either).
    const stranger = await platformAdmin([], { stepUp: false });
    expect((await list(stranger.bearer, '')).status).toBe(400);
    expect((await list(stranger.bearer)).status).toBe(403);

    // Every other capability there is, and still not this.
    const other = await platformAdmin([
      'TENANT_READ',
      'USER_READ',
      'REVIEW_MODERATE',
      'CONTACT_READ',
    ]);
    for (const res of [
      await list(other.bearer),
      await one(other.bearer, coach.userId),
      await certificate(other.bearer, coach.userId),
      await decide(other.bearer, coach.userId, {
        decision: 'APPROVE',
        note: 'the licence checks out',
      }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.json.error?.code).toBe('PLATFORM_CAPABILITY_REQUIRED');
    }

    // The capability, but no second factor: the reads too.
    const cold = await platformAdmin(['COACH_APPROVE'], { stepUp: false });
    for (const res of [
      await list(cold.bearer),
      await one(cold.bearer, coach.userId),
      await certificate(cold.bearer, coach.userId),
      await decide(cold.bearer, coach.userId, {
        decision: 'APPROVE',
        note: 'the licence checks out',
      }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.json.error?.code).toMatch(/^(MFA_ENROLMENT_REQUIRED|STEP_UP_REQUIRED)$/);
    }
    // A refusal leaves no audit row, and decides nothing.
    expect(await audit(cold.userId)).toEqual([]);
    expect(await audit(other.userId)).toEqual([]);
    expect((await profileRow(coach.userId))!.status).toBe('SUBMITTED');
  });

  it('a coach, a player and a club owner cannot reach it, or the certificate', async () => {
    const coach = await submittedCoach();
    const player = await signInAs(db, { userId: await seedAccount('PLAYER', db), memberships: [] });
    const club = await seedTenant({ name: 'Club A' }, db);
    const owner = await signInAs(db, {
      userId: club.userId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'OWNER' }],
    });
    for (const who of [coach, player, owner]) {
      expect((await list(who.bearer)).status).toBe(403);
      expect((await one(who.bearer, coach.userId)).status).toBe(403);
      const file = await certificate(who.bearer, coach.userId);
      expect(file.status).toBe(403);
      expect(Buffer.from(await file.res.arrayBuffer()).includes(Buffer.from('%PDF'))).toBe(false);
    }
    expect((await certificate(undefined, coach.userId)).status).toBe(401);
  });

  it('lists what is waiting, oldest first, never a draft, and audits the read', async () => {
    const first = await submittedCoach('Първи Треньор');
    const second = await submittedCoach('Втори Треньор');
    const draft = await coachNamed('Чернова Треньор');
    await save(draft.bearer, FULL);
    // Make the order certain whatever the clock did.
    await asAppSuperuser(db, async (tx) => {
      await tx.coachProfile.update({
        where: { userId: first.userId },
        data: { submittedAt: new Date('2026-10-01T08:00:00Z') },
      });
      await tx.coachProfile.update({
        where: { userId: second.userId },
        data: { submittedAt: new Date('2026-10-02T08:00:00Z') },
      });
    });

    const admin = await platformAdmin(['COACH_APPROVE']);
    const res = await list(admin.bearer);
    expect(res.status).toBe(200);
    const body = res.json.data as unknown as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(body.items.map((i) => i.name)).toEqual(['Първи Треньор', 'Втори Треньор']);
    expect(body.items[0]).toEqual({
      userId: first.userId,
      name: 'Първи Треньор',
      slug: 'parvi-trenyor',
      status: 'SUBMITTED',
      submittedAt: '2026-10-01T08:00:00Z',
      decidedAt: null,
      sports: [{ sport: 'TENNIS', levelMin: 1, levelMax: 5 }],
      bio: BIO,
      qualifications: 'Лиценз ББФТ, ниво 2',
      decisionNote: null,
      certificate: {
        fileName: 'licence.pdf',
        mimeType: 'application/pdf',
        byteSize: PDF.byteLength,
        uploadedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      },
      // Nothing booked with somebody who is not approved yet.
      upcomingLessons: 0,
    });
    // What was uploaded, never the file.
    expect(JSON.stringify(res.json)).not.toMatch(/%PDF|content|sha256/);
    expect(body.nextCursor).toBeNull();
    // Nothing decided yet.
    expect(
      (
        (await list(admin.bearer, `${q}&status=APPROVED`)).json.data as unknown as {
          items: unknown[];
        }
      ).items,
    ).toEqual([]);
    expect((await list(admin.bearer, `${q}&status=DRAFT`)).status).toBe(400);
    // A cursor that names no row of this list is refused, not answered with an empty page.
    const stale = await list(admin.bearer, `${q}&cursor=${draft.userId}`);
    expect(stale.status).toBe(400);
    expect(stale.json.error?.code).toBe('INVALID_CURSOR');

    expect(
      (await audit(admin.userId)).filter((a) => a.action === 'PLATFORM_COACH_APPLICATION_LIST')[0],
    ).toMatchObject({
      capability: 'COACH_APPROVE',
      entity: 'CoachProfile',
      reason: REASON,
      detailsJson: { status: 'SUBMITTED' },
    });
  });

  it('one profile as the owner reads it; a draft is not there', async () => {
    const coach = await submittedCoach();
    const draft = await coachNamed('Чернова Треньор');
    await save(draft.bearer, FULL);
    await upload(draft.bearer, PDF, 'draft.pdf');
    const admin = await platformAdmin(['COACH_APPROVE']);

    const res = await one(admin.bearer, coach.userId);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({
      userId: coach.userId,
      name: 'Иван Петров',
      status: 'SUBMITTED',
      bio: BIO,
      qualifications: 'Лиценз ББФТ, ниво 2',
      decisionNote: null,
      decidedByUserId: null,
      upcomingLessons: 0,
      certificate: {
        fileName: 'licence.pdf',
        mimeType: 'application/pdf',
        byteSize: PDF.byteLength,
      },
    });
    // The account's address and phone are not part of an application.
    expect(JSON.stringify(res.json)).not.toMatch(/@playerz\.test|email|phone/);

    for (const res404 of [
      await one(admin.bearer, draft.userId),
      await certificate(admin.bearer, draft.userId),
      await one(admin.bearer, 'cnosuchaccount0000000000'),
      await decide(admin.bearer, draft.userId, {
        decision: 'APPROVE',
        note: 'the licence checks out',
      }),
    ]) {
      expect(res404.status).toBe(404);
      expect(res404.json.error?.code).toBe('COACH_APPLICATION_NOT_FOUND');
    }
    expect((await one(admin.bearer, coach.userId, '')).status).toBe(400);
  });

  it('opens the certificate as a download, exactly as uploaded, and writes down who opened whose', async () => {
    const coach = await coachNamed('Иван Петров');
    await save(coach.bearer, FULL);
    await upload(coach.bearer, PDF, 'Лиценз ББФТ.pdf');
    await submit(coach.bearer);
    const admin = await platformAdmin(['COACH_APPROVE']);

    expect((await certificate(admin.bearer, coach.userId, '')).status).toBe(400);
    const file = await certificate(admin.bearer, coach.userId);
    expect(file.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await file.res.arrayBuffer()), PDF)).toBe(0);
    const h = file.res.headers;
    expect(h.get('content-type')).toBe('application/pdf');
    // Never rendered by this origin, never cached, and the name cannot break the header.
    expect(h.get('content-disposition')).toBe(
      `attachment; filename="certificate.pdf"; filename*=UTF-8''${encodeURIComponent('Лиценз ББФТ.pdf')}`,
    );
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('cache-control')).toBe('private, no-store');
    expect(h.get('content-security-policy')).toContain('sandbox');

    const opened = (await audit(admin.userId)).filter(
      (a) => a.action === 'PLATFORM_COACH_CERTIFICATE_OPEN',
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      capability: 'COACH_APPROVE',
      entity: 'CoachCertificate',
      entityId: coach.userId,
      reason: REASON,
    });
  });
});

// ─── The three decisions ───────────────────────────────────────────────────

describe('the owner’s decision', () => {
  it('approve: the coach is approved and told; the text stays theirs, the certificate is locked', async () => {
    const coach = await submittedCoach();
    const admin = await platformAdmin(['COACH_APPROVE']);

    expect(
      (
        await decide(admin.bearer, coach.userId, {
          decision: 'MAYBE',
          note: 'the licence checks out',
        })
      ).status,
    ).toBe(400);
    const short = await decide(admin.bearer, coach.userId, { decision: 'APPROVE', note: 'ok' });
    expect(short.status).toBe(400);
    expect(short.json.error?.code).toBe('REASON_REQUIRED');

    const res = await decide(admin.bearer, coach.userId, {
      decision: 'APPROVE',
      note: 'Лицензът е проверен в регистъра на ББФТ.',
    });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ userId: coach.userId, status: 'APPROVED' });

    const row = (await profileRow(coach.userId))!;
    expect(row).toMatchObject({
      status: 'APPROVED',
      decidedByUserId: admin.userId,
      decisionNote: null,
    });
    expect(row.decidedAt).not.toBeNull();
    // The note is the audit trail's, not the coach's.
    const decided = (await audit(admin.userId)).filter(
      (a) => a.action === 'PLATFORM_COACH_APPLICATION_DECIDE',
    );
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({
      capability: 'COACH_APPROVE',
      entityId: coach.userId,
      reason: 'Лицензът е проверен в регистъра на ББФТ.',
      detailsJson: { decision: 'APPROVE' },
    });

    // Told in the bell and by email, in their own language, with no club named.
    expect(await bell(coach.userId)).toEqual([
      {
        kind: 'COACH_PROFILE_APPROVED',
        title: 'Профилът ви на треньор е одобрен',
        body: 'Вече можете да преподавате в playerz.bg.',
        href: '/me/coach',
        refType: 'coach_profile',
        refId: coach.userId,
        tenantId: null,
      },
    ]);
    const mails = await outbox();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      userId: coach.userId,
      kind: 'COACH_PROFILE_APPROVED',
      category: 'account',
      subject: 'Профилът ви на треньор е одобрен',
    });
    expect(mails[0]!.text).toContain('/me/coach');
    expect(mails[0]!.text).not.toContain('регистъра');
    // It is sent whatever the person switched off, and carries no "stop these" line.
    await asAppSuperuser(db, (tx) =>
      tx.user.update({
        where: { id: coach.userId },
        data: {
          emailBookingConfirmations: false,
          emailBookingReminders: false,
          emailClubChanges: false,
          emailMessages: false,
          emailOpenPlay: false,
          emailLessonsTaught: false,
        },
      }),
    );
    const { sent, provider } = recorder();
    expect(await drainEmailOutbox({ provider })).toMatchObject({ claimed: 1, sent: 1 });
    expect(sent[0]!.text).not.toMatch(/unsubscribe|Спиране на тези имейли/);

    // Decided once.
    const again = await decide(admin.bearer, coach.userId, {
      decision: 'APPROVE',
      note: 'approving it a second time',
    });
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({
      code: 'COACH_APPLICATION_STATE',
      details: { status: 'APPROVED' },
    });
    expect(await bell(coach.userId)).toHaveLength(1);

    // What the coach may do now.
    const mine = (await read(coach.bearer)).json.data!;
    expect(mine).toMatchObject({
      state: 'APPROVED',
      decisionNote: null,
      canEdit: { text: true, certificate: false },
    });
    const edited = await save(coach.bearer, { ...FULL, bio: `${BIO} Вече и за деца.` });
    expect(edited.status).toBe(200);
    expect(edited.json.data).toMatchObject({ state: 'APPROVED', bio: `${BIO} Вече и за деца.` });
    // An approved profile is what players read: it cannot be emptied.
    const emptied = await save(coach.bearer, { bio: '', sports: [] });
    expect(emptied.status).toBe(409);
    expect(emptied.json.error).toMatchObject({
      code: 'COACH_PROFILE_INCOMPLETE',
      details: { missing: ['bio', 'sports'] },
    });
    expect((await upload(coach.bearer, PDF, 'new.pdf')).json.error?.code).toBe(
      'COACH_PROFILE_LOCKED',
    );
    expect((await submit(coach.bearer)).json.error?.code).toBe('COACH_PROFILE_LOCKED');
    expect((await profileRow(coach.userId))!.status).toBe('APPROVED');
  });

  it('decline: the coach reads why, corrects it and sends it again as a new application', async () => {
    process.env.CONTACT_INBOX_EMAIL = INBOX;
    const coach = await submittedCoach();
    const admin = await platformAdmin(['COACH_APPROVE']);
    const NOTE = 'Сертификатът не се чете.\nКачете по-ясна снимка, моля.';

    const res = await decide(admin.bearer, coach.userId, { decision: 'DECLINE', note: NOTE });
    expect(res.json.data).toMatchObject({ status: 'DECLINED' });

    const mine = (await read(coach.bearer)).json.data!;
    expect(mine).toMatchObject({
      state: 'DECLINED',
      decisionNote: NOTE,
      canEdit: { text: true, certificate: true },
    });
    // The certificate is kept: replacing it is the coach's to do.
    expect(mine.certificate).not.toBeNull();

    const [told] = await bell(coach.userId);
    expect(told).toMatchObject({
      kind: 'COACH_PROFILE_DECLINED',
      title: 'Профилът ви на треньор не е одобрен',
      href: '/me/coach',
    });
    const mail = (await outbox()).find((m) => m.kind === 'COACH_PROFILE_DECLINED')!;
    expect(mail).toMatchObject({ userId: coach.userId, category: 'account' });
    expect(mail.text).toContain(NOTE);

    // The queue no longer holds it; the declined list does.
    expect(((await list(admin.bearer)).json.data as unknown as { items: unknown[] }).items).toEqual(
      [],
    );
    expect(
      (
        (await list(admin.bearer, `${q}&status=DECLINED`)).json.data as unknown as {
          items: Array<{ userId: string }>;
        }
      ).items.map((i) => i.userId),
    ).toEqual([coach.userId]);

    // Corrected and sent again: a new application, the old decision cleared.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9)]);
    expect((await upload(coach.bearer, jpeg, 'clear-photo.jpg', 'image/jpeg')).status).toBe(200);
    const sent = await submit(coach.bearer);
    expect(sent.json.data).toMatchObject({
      state: 'SUBMITTED',
      decisionNote: null,
      decidedAt: null,
    });
    expect(await profileRow(coach.userId)).toMatchObject({
      decidedByUserId: null,
      decisionNote: null,
    });
    // The operator hears of both submissions, once each.
    expect((await outbox()).filter((m) => m.kind === 'COACH_PROFILE_SUBMITTED')).toHaveLength(2);

    // And it can now be approved.
    expect(
      (
        await decide(admin.bearer, coach.userId, {
          decision: 'APPROVE',
          note: 'the new photo is readable',
        })
      ).status,
    ).toBe(200);
    expect((await bell(coach.userId)).map((b) => b.kind)).toEqual([
      'COACH_PROFILE_DECLINED',
      'COACH_PROFILE_APPROVED',
    ]);
  });

  it('remove: only an approved coach; the certificate is deleted and the links to venues end', async () => {
    const coach = await submittedCoach();
    const admin = await platformAdmin(['COACH_APPROVE']);
    const NOTE = 'Спираме профила след проверка на оплакване.';

    // Not yet approved: there is nothing to remove.
    const early = await decide(admin.bearer, coach.userId, { decision: 'REMOVE', note: NOTE });
    expect(early.status).toBe(409);
    expect(early.json.error).toMatchObject({
      code: 'COACH_APPLICATION_STATE',
      details: { status: 'SUBMITTED' },
    });
    await decide(admin.bearer, coach.userId, {
      decision: 'APPROVE',
      note: 'the licence checks out',
    });

    // The coach teaches at two clubs, with hours at one and a lesson to teach.
    const [a, b] = [
      await seedTenant({ name: 'Club A' }, db),
      await seedTenant({ name: 'Club B' }, db),
    ];
    const [va, vb] = [await seedVenue(a.tenantId, {}, db), await seedVenue(b.tenantId, {}, db)];
    const player = await seedAccount('PLAYER', db);
    const links = await asAppSuperuser(db, async (tx) => {
      const mk = (tenantId: string, venueId: string, status: 'ACTIVE' | 'REQUESTED') =>
        tx.coach.create({
          data: {
            tenantId,
            venueId,
            userId: coach.userId,
            status,
            startedBy: 'COACH',
            hourlyRateCents: 4000,
            lessonMinutes: [60],
          },
          select: { id: true },
        });
      const la = await mk(a.tenantId, va.venueId, 'ACTIVE');
      const lb = await mk(b.tenantId, vb.venueId, 'REQUESTED');
      await tx.coachAvailability.create({
        data: {
          tenantId: a.tenantId,
          coachId: la.id,
          dayOfWeek: 1,
          openTime: new Date('1970-01-01T09:00:00Z'),
          closeTime: new Date('1970-01-01T12:00:00Z'),
        },
      });
      const start = new Date(Date.now() + 24 * 3_600_000);
      const end = new Date(start.getTime() + 3_600_000);
      const booking = await tx.booking.create({
        data: {
          tenantId: a.tenantId,
          resourceId: va.resourceId,
          startTs: start,
          endTs: end,
          status: 'CONFIRMED',
          totalCents: 2400,
          idempotencyKey: 'lesson',
          bookedByUserId: player,
        },
        select: { id: true },
      });
      await tx.coachLesson.create({
        data: {
          tenantId: a.tenantId,
          bookingId: booking.id,
          coachId: la.id,
          coachUserId: coach.userId,
          startTs: start,
          endTs: end,
          hourlyRateCents: 4000,
          cancelCutoffHours: 24,
          coachFeeCents: 4000,
        },
      });
      return { la: la.id, lb: lb.id, bookingId: booking.id };
    });

    // A second lesson, already under way: it is being taught as this runs.
    const underway = await asAppSuperuser(db, async (tx) => {
      const start = new Date(Date.now() - 20 * 60_000);
      const end = new Date(start.getTime() + 3_600_000);
      const booking = await tx.booking.create({
        data: {
          tenantId: a.tenantId,
          resourceId: va.resourceId,
          startTs: start,
          endTs: end,
          status: 'CONFIRMED',
          totalCents: 2400,
          idempotencyKey: 'lesson-underway',
          bookedByUserId: player,
        },
        select: { id: true },
      });
      await tx.coachLesson.create({
        data: {
          tenantId: a.tenantId,
          bookingId: booking.id,
          coachId: links.la,
          coachUserId: coach.userId,
          startTs: start,
          endTs: end,
          hourlyRateCents: 4000,
          cancelCutoffHours: 24,
          coachFeeCents: 4000,
        },
      });
      return booking.id;
    });

    // The queue says how many lessons a removal would cancel: the one not
    // yet started. Both the list and the single read say it.
    expect((await one(admin.bearer, coach.userId)).json.data!.upcomingLessons).toBe(1);
    await asAppSuperuser(db, async (tx) => {
      await tx.notification.deleteMany({ where: { userId: player } });
      await tx.emailOutbox.deleteMany({ where: { userId: player } });
    });

    // Owner decision 21: removing the coach cancels it, in the same act.
    const res = await decide(admin.bearer, coach.userId, { decision: 'REMOVE', note: NOTE });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: 'DECLINED', cancelledLessons: 1 });

    const [cancelled, still, cancellation, clubAudit] = await asAppSuperuser(db, async (tx) => [
      await tx.booking.findUniqueOrThrow({ where: { id: links.bookingId } }),
      await tx.booking.findUniqueOrThrow({ where: { id: underway } }),
      await tx.cancellation.findFirst({ where: { bookingId: links.bookingId } }),
      await tx.auditEntry.findFirst({
        where: { action: 'BOOKING_CANCELLED', entityId: links.bookingId },
      }),
    ]);
    // The court is released; the lesson under way is left to finish.
    expect(cancelled.status).toBe('CANCELLED');
    expect(still.status).toBe('CONFIRMED');
    // On the club's own record, as the platform's act, by the admin who did it.
    expect(cancellation).toMatchObject({ cancelledByUserId: admin.userId });
    expect(clubAudit).toMatchObject({
      tenantId: a.tenantId,
      actorUserId: admin.userId,
      details: 'Cancelled by the platform',
    });
    // The player is told, in the bell and by email, and told why.
    const [playerBell, playerMail] = await asAppSuperuser(db, async (tx) => [
      await tx.notification.findMany({ where: { userId: player }, take: 5 }),
      await tx.emailOutbox.findMany({ where: { userId: player }, take: 5 }),
    ]);
    expect(playerBell).toHaveLength(1);
    expect(playerBell[0]).toMatchObject({
      kind: 'BOOKING_CANCELLED',
      title: 'Урокът ви е отменен',
    });
    expect(playerBell[0]!.body).toContain('вече не преподава в playerz.bg');
    expect(playerMail).toHaveLength(1);
    expect(playerMail[0]!.text).toContain('не дължите нищо');

    expect(await profileRow(coach.userId)).toMatchObject({
      status: 'DECLINED',
      decisionNote: NOTE,
      decidedByUserId: admin.userId,
    });
    // The certificate is gone, for the owner too.
    expect(await asAppSuperuser(db, (tx) => tx.coachCertificate.count())).toBe(0);
    expect((await certificate(admin.bearer, coach.userId)).status).toBe(404);
    // Both links ended, by the admin; the hours with them.
    expect(
      await asAppSuperuser(db, (tx) =>
        tx.coach.findMany({
          where: { userId: coach.userId },
          select: { status: true, endedByUserId: true },
          orderBy: { id: 'asc' },
        }),
      ),
    ).toEqual([
      { status: 'ENDED', endedByUserId: admin.userId },
      { status: 'ENDED', endedByUserId: admin.userId },
    ]);
    expect(await asAppSuperuser(db, (tx) => tx.coachAvailability.count())).toBe(0);
    // The lessons stay with their bookings, as what was booked and what became of it.
    expect(
      await asAppSuperuser(db, (tx) =>
        tx.coachLesson.findMany({ select: { active: true }, orderBy: { startTs: 'asc' } }),
      ),
    ).toEqual([{ active: true }, { active: false }]);

    const told = (await bell(coach.userId)).at(-1)!;
    expect(told).toMatchObject({
      kind: 'COACH_PROFILE_DECLINED',
      title: 'Профилът ви на треньор е спрян',
    });
    // The coach's own email (the player's, about the lesson, is checked above).
    const mail = (await outbox()).filter((m) => m.userId === coach.userId).at(-1)!;
    expect(mail.subject).toBe('Профилът ви на треньор е спрян');
    expect(mail.text).toContain(NOTE);
    expect(mail.text).toContain('сертификатът ви е изтрит');

    // The coach may start again: a new certificate, a new application.
    const mine = (await read(coach.bearer)).json.data!;
    expect(mine).toMatchObject({
      state: 'DECLINED',
      certificate: null,
      missing: ['certificate'],
      decisionNote: NOTE,
    });
  });

  it('two admins deciding at once: one decision, one refusal, one notification', async () => {
    const coach = await submittedCoach();
    const [first, second] = [
      await platformAdmin(['COACH_APPROVE']),
      await platformAdmin(['COACH_APPROVE']),
    ];
    const results = await Promise.all([
      decide(first.bearer, coach.userId, { decision: 'APPROVE', note: 'the licence checks out' }),
      decide(second.bearer, coach.userId, {
        decision: 'DECLINE',
        note: 'Сертификатът не се чете добре.',
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.json.error?.code).toBe('COACH_APPLICATION_STATE');
    expect(await bell(coach.userId)).toHaveLength(1);
    const row = (await profileRow(coach.userId))!;
    const winner = results[0]!.status === 200 ? first : second;
    expect(row.decidedByUserId).toBe(winner.userId);
  });
});
