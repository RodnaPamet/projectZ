import { randomUUID } from 'node:crypto';

import { PlatformCapability } from '@prisma/client';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { GET as contactListRoute } from '@/app/api/v1/platform/contact-requests/route';
import {
  CONTACT_RATE_LIMIT,
  contactDedupeKey,
  submitContactRequest,
} from '@/app-layer/usecases/contact-requests';
import { drainEmailOutbox } from '@/app-layer/usecases/notification-outbox';
import { listPilotClubs } from '@/app-layer/usecases/pilot-clubs';
import { createUserSession, newSessionSecret } from '@/lib/auth/sessions';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import type { EmailProvider, OutgoingEmail } from '@/lib/email/provider';
import { clearAllRateLimits } from '@/lib/security/rate-limit';

import { prismaTestClient, resetDatabase, seedTenant, seedVenue } from '../helpers/db';
import { asAppSuperuser, asAppUserAs } from '../helpers/rls';

/**
 * THE LANDING PAGE'S BACK END (#369), against a real database.
 *
 *   - the "For clubs" form: zod validation, the honeypot, the per-IP rate
 *     limit, the stored row, and an outbox email to the operator ONLY when
 *     CONTACT_INBOX_EMAIL is set; the drain sends it to that inbox;
 *   - the platform list: signed in, a reason, CONTACT_READ, audited;
 *   - the pilot clubs: live, public venues only, never a suspended club.
 */

const db = prismaTestClient();
const INBOX = 'owner@playerz.test';

const valid = {
  name: '  Мария Иванова ',
  clubName: 'Падел Клуб Лозенец',
  phone: '+359 88 123 4567',
  email: '',
  message: 'Имаме 4 корта за падел.\nКак да започнем?',
  website: '',
};

/** A fresh IP per test, so the limiter never carries over. */
let ip: string;
const submit = (input: Record<string, unknown>, at = ip) =>
  submitContactRequest(input, { clientIp: at, locale: 'bg' });

const rows = () =>
  asAppSuperuser(db, (tx) => tx.contactRequest.findMany({ orderBy: { createdAt: 'asc' } }));
const outbox = () =>
  asAppSuperuser(db, (tx) => tx.emailOutbox.findMany({ where: { category: 'contact' } }));

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

beforeEach(async () => {
  await resetDatabase(db);
  await clearAllRateLimits();
  ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
  delete process.env.CONTACT_INBOX_EMAIL;
});

afterAll(() => {
  delete process.env.CONTACT_INBOX_EMAIL;
});

describe('the "For clubs" form (#369)', () => {
  it('stores a valid enquiry, trimmed, in the language it was read in', async () => {
    expect(await submit(valid)).toEqual({ ok: true });
    const [row] = await rows();
    expect(row).toMatchObject({
      name: 'Мария Иванова',
      clubName: 'Падел Клуб Лозенец',
      phone: '+359 88 123 4567',
      email: null,
      message: 'Имаме 4 корта за падел.\nКак да започнем?',
      locale: 'bg',
    });
  });

  it('refuses invalid input with a code per field, and stores nothing', async () => {
    const result = await submit({
      name: '',
      clubName: 'x'.repeat(161),
      phone: 'call me',
      email: 'not-an-email',
      message: '   ',
    });
    expect(result).toEqual({
      ok: false,
      code: 'invalid',
      fieldErrors: {
        name: 'required',
        clubName: 'tooLong',
        phone: 'phone',
        email: 'email',
        message: 'required',
      },
    });
    expect(await rows()).toHaveLength(0);
  });

  it('needs a phone OR an email', async () => {
    expect(await submit({ ...valid, phone: ' ', email: '' })).toEqual({
      ok: false,
      code: 'invalid',
      fieldErrors: { phone: 'reachable' },
    });
    expect(await submit({ ...valid, phone: '', email: 'club@example.bg' })).toEqual({ ok: true });
    expect((await rows())[0]).toMatchObject({ phone: null, email: 'club@example.bg' });
  });

  it('a missing field (a crafted post) reads as required, not as a crash', async () => {
    expect(await submit({ clubName: 'Club', email: 'a@b.bg' })).toMatchObject({
      ok: false,
      code: 'invalid',
      fieldErrors: { name: 'required', message: 'required' },
    });
  });

  it('the honeypot: answered like a success, nothing stored, nothing queued, not counted', async () => {
    process.env.CONTACT_INBOX_EMAIL = INBOX;
    for (let i = 0; i < CONTACT_RATE_LIMIT.maxAttempts + 2; i++) {
      expect(await submit({ ...valid, website: 'https://spam.example' })).toEqual({ ok: true });
    }
    expect(await rows()).toHaveLength(0);
    expect(await outbox()).toHaveLength(0);
    // The limiter was never touched, so a person from the same address gets through.
    expect(await submit(valid)).toEqual({ ok: true });
  });

  it('rate-limits per IP, without storing the IP anywhere', async () => {
    for (let i = 0; i < CONTACT_RATE_LIMIT.maxAttempts; i++) {
      expect(await submit({ ...valid, message: `enquiry ${i}` })).toEqual({ ok: true });
    }
    expect(await submit(valid)).toEqual({ ok: false, code: 'rateLimited' });
    // Another address is its own bucket.
    expect(await submit(valid, '198.51.100.7')).toEqual({ ok: true });

    const stored = await rows();
    expect(stored).toHaveLength(CONTACT_RATE_LIMIT.maxAttempts + 1);
    // No column holds it, and no value does either.
    expect(JSON.stringify(stored)).not.toContain(ip);
    expect(Object.keys(stored[0]!)).not.toEqual(expect.arrayContaining(['ip', 'ipAddress']));
  });

  it('queues NO email when CONTACT_INBOX_EMAIL is unset; the row is still stored', async () => {
    expect(await submit(valid)).toEqual({ ok: true });
    expect(await rows()).toHaveLength(1);
    expect(await outbox()).toHaveLength(0);
  });

  it('queues one email to the operator when CONTACT_INBOX_EMAIL is set, and the drain sends it there', async () => {
    process.env.CONTACT_INBOX_EMAIL = INBOX;
    expect(await submit({ ...valid, email: 'maria@example.bg' })).toEqual({ ok: true });
    const [row] = await rows();
    const [mail] = await outbox();
    expect(mail).toMatchObject({
      userId: null,
      kind: 'CONTACT_REQUEST',
      category: 'contact',
      dedupeKey: contactDedupeKey(row!.id),
      refType: 'contact_request',
      refId: row!.id,
      status: 'PENDING',
      locale: 'bg',
    });
    expect(mail!.subject).toBe('Запитване от клуб: Падел Клуб Лозенец');
    expect(mail!.text).toContain('Мария Иванова');
    expect(mail!.text).toContain('+359 88 123 4567');
    expect(mail!.text).toContain('maria@example.bg');
    expect(mail!.text).toContain('Имаме 4 корта за падел.\nКак да започнем?');
    expect(mail!.text).toContain('/platform/contact-requests');

    const { sent, provider } = recorder();
    expect(await drainEmailOutbox({ provider })).toMatchObject({ claimed: 1, sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: INBOX, subject: mail!.subject });
    const after = await asAppSuperuser(db, (tx) =>
      tx.emailOutbox.findUniqueOrThrow({ where: { id: mail!.id } }),
    );
    expect(after.status).toBe('SENT');
  });

  it('a queued email whose inbox was removed before the drain is skipped, not sent anywhere', async () => {
    process.env.CONTACT_INBOX_EMAIL = INBOX;
    await submit(valid);
    delete process.env.CONTACT_INBOX_EMAIL;
    const { sent, provider } = recorder();
    expect(await drainEmailOutbox({ provider })).toMatchObject({ claimed: 1, skipped: 1 });
    expect(sent).toHaveLength(0);
    const [mail] = await outbox();
    expect(mail).toMatchObject({ status: 'SKIPPED', lastError: 'no-address' });
  });

  it('a subject cannot carry a line break, whatever the club is called', async () => {
    process.env.CONTACT_INBOX_EMAIL = INBOX;
    await submit({ ...valid, clubName: 'Club\r\nBcc: x@evil.example' });
    const [mail] = await outbox();
    expect(mail!.subject).not.toMatch(/[\r\n]/);
  });

  it('app_user can neither read the enquiries nor see their emails (RLS)', async () => {
    process.env.CONTACT_INBOX_EMAIL = INBOX;
    await submit(valid);
    const someone = await seedTenant({});
    const as = <T>(fn: Parameters<typeof asAppUserAs<T>>[3]) =>
      asAppUserAs(db, someone.tenantId, someone.userId, fn);
    // No privilege at all on the table, so the read is refused outright (and
    // aborts its transaction, hence two).
    await expect(as((tx) => tx.contactRequest.findMany())).rejects.toThrow();
    expect(await as((tx) => tx.emailOutbox.findMany({ where: { category: 'contact' } }))).toEqual(
      [],
    );
  });

  it('the database refuses a row with neither phone nor email, and an outbox row with no user outside `contact`', async () => {
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.contactRequest.create({
          data: { name: 'A', clubName: 'B', message: 'C', locale: 'bg' },
        }),
      ),
    ).rejects.toThrow(/contact_request_reachable/);
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.emailOutbox.create({
          data: {
            userId: null,
            kind: 'BOOKING_CONFIRMED',
            category: 'confirmation',
            dedupeKey: 'x',
            locale: 'bg',
            subject: 's',
            text: 't',
          },
        }),
      ),
    ).rejects.toThrow(/email_outbox_user_or_contact/);
  });
});

describe('GET /api/v1/platform/contact-requests (#369)', () => {
  let admin: string;
  let granter: string;

  beforeEach(async () => {
    admin = `cadm${randomUUID().replace(/-/g, '').slice(0, 21)}`;
    granter = `cgrn${randomUUID().replace(/-/g, '').slice(0, 21)}`;
    await asAppSuperuser(db, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO app_user (id,email,"createdAt","updatedAt")
         VALUES ($1,$2,now(),now()), ($3,$4,now(),now())`,
        admin,
        `${admin}@test.invalid`,
        granter,
        `${granter}@test.invalid`,
      ),
    );
  });

  async function grant(caps: PlatformCapability[]) {
    await asAppSuperuser(db, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO platform_admin_grant
           (id,"userId","grantedByUserId",reason,capabilities,"grantedAt","expiresAt")
         VALUES ($1,$2,$3,'reading club enquiries',$4::"PlatformCapability"[],
                 now(), now() + interval '30 days')`,
        `cg${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        admin,
        granter,
        `{${caps.join(',')}}`,
      ),
    );
  }

  async function bearer() {
    const { userSessionId, sessionVersion } = await createUserSession({
      userId: admin,
      sessionSecret: newSessionSecret(),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return encode({
      secret: process.env.NEXTAUTH_SECRET!,
      maxAge: 900,
      token: { sub: admin, userSessionId, sessionVersion },
    });
  }

  const REASON = 'replying to the new club enquiries';
  const list = (token?: string, query = `?reason=${encodeURIComponent(REASON)}`) =>
    (contactListRoute as (req: NextRequest, ctx: unknown) => Promise<Response>)(
      new NextRequest(`http://t/api/v1/platform/contact-requests${query}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
      undefined,
    );

  it('401 signed out, 400 with no reason, 403 without CONTACT_READ', async () => {
    await submit(valid);
    expect((await list()).status).toBe(401);
    const token = await bearer();
    expect((await list(token, '')).status).toBe(400);
    expect((await list(token)).status).toBe(403);
    await grant([PlatformCapability.TENANT_READ]);
    const refused = await list(token);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'PLATFORM_CAPABILITY_REQUIRED',
    );
  });

  it('lists the enquiries newest first for CONTACT_READ, and audits the read', async () => {
    await submit({ ...valid, clubName: 'First club' });
    await submit({ ...valid, clubName: 'Second club', email: 'second@example.bg' });
    await grant([PlatformCapability.CONTACT_READ]);

    const res = await list(await bearer());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: Array<Record<string, unknown>>; nextCursor: string | null };
    };
    expect(body.data.items.map((i) => i.clubName)).toEqual(['Second club', 'First club']);
    expect(body.data.items[0]).toMatchObject({
      name: 'Мария Иванова',
      phone: '+359 88 123 4567',
      email: 'second@example.bg',
      locale: 'bg',
    });
    expect(body.data.items[0]!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(body.data.nextCursor).toBeNull();

    const audit = await asAppSuperuser(db, (tx) =>
      tx.platformAuditEntry.findMany({ where: { actorUserId: admin } }),
    );
    expect(audit).toEqual([
      expect.objectContaining({
        capability: 'CONTACT_READ',
        action: 'PLATFORM_CONTACT_REQUEST_LIST',
        reason: REASON,
        subjectTenantId: null,
      }),
    ]);
  });
});

describe('the pilot clubs on the landing page (#369)', () => {
  it('lists ACTIVE clubs with a public venue, and never a suspended one', async () => {
    const live = await seedTenant({ name: 'Live Club' });
    const suspended = await seedTenant({ name: 'Suspended Club' });
    const empty = await seedTenant({ name: 'No Venue Club' });
    await seedVenue(live.tenantId, { name: 'Live Courts' });
    await seedVenue(live.tenantId, { name: 'Live Courts Two' });
    await seedVenue(suspended.tenantId, { name: 'Hidden Courts' });
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: suspended.tenantId }, data: { status: 'SUSPENDED' } }),
    );

    const clubs = await runAsSuperuser((tx) => listPilotClubs(tx));
    expect(clubs.map((c) => c.id)).toEqual([live.tenantId]);
    expect(clubs[0]).toMatchObject({
      slug: live.tenantSlug,
      venueCount: 2,
      sports: ['PADEL'],
      cover: null,
    });
    expect(clubs[0]!.cities).toHaveLength(1);
    expect(clubs.map((c) => c.id)).not.toContain(empty.tenantId);
  });

  it('is empty, not invented, before any club is onboarded', async () => {
    expect(await runAsSuperuser((tx) => listPilotClubs(tx))).toEqual([]);
  });
});
