import { NextRequest } from 'next/server';

import { POST as sweepRoute } from '@/app/api/cron/sweep-retention/route';
import { sweepRetention } from '@/app-layer/usecases/retention-sweep';

import { prismaTestClient, seedAccount, seedTenant, seedVenue } from '../helpers/db';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * The privacy policy's periods (#717), against a real database: what is past
 * its period goes (deleted or anonymised), what is a day short of it stays,
 * and the append-only logs admit the sweep's deletes and nothing else.
 */
const db = prismaTestClient();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const YEAR = 365.25 * DAY;
const ago = (ms: number) => new Date(Date.now() - ms);

interface World {
  tenantId: string;
  resourceId: string;
  player: string;
  friend: string;
}

async function world(): Promise<World> {
  const club = await seedTenant({}, db);
  const court = await seedVenue(club.tenantId, {}, db);
  return {
    tenantId: club.tenantId,
    resourceId: court.resourceId,
    player: await seedAccount('PLAYER', db),
    friend: await seedAccount('PLAYER', db),
  };
}

/** A booking that ended `endedAgo` ago, with something personal in every place a booking keeps it. */
async function fullBooking(w: World, endedAgo: number): Promise<string> {
  return asAppSuperuser(db, async (tx) => {
    const end = ago(endedAgo);
    const b = await tx.booking.create({
      data: {
        tenantId: w.tenantId,
        resourceId: w.resourceId,
        startTs: new Date(end.getTime() - HOUR),
        endTs: end,
        bookedByUserId: w.player,
        guestName: 'Иван Петров',
        guestPhone: '+359888000111',
        guestEmail: 'ivan@example.test',
        notes: 'gate code 4471',
        totalCents: 2400,
        status: 'CANCELLED',
        cancellationReasonJson: { reason: 'sick', refundPercent: 50 },
        stripePaymentIntentId: `pi_${Math.random()}`,
        idempotencyKey: `k-${Math.random()}`,
      },
      select: { id: true },
    });
    await tx.bookingParticipant.createMany({
      data: [
        { tenantId: w.tenantId, bookingId: b.id, userId: w.friend, position: 1 },
        {
          tenantId: w.tenantId,
          bookingId: b.id,
          guestName: 'Гост',
          guestEmail: 'guest@example.test',
          position: 2,
        },
      ],
    });
    await tx.cancellation.create({
      data: { tenantId: w.tenantId, bookingId: b.id, cancelledByUserId: w.player, reason: 'sick' },
    });
    await tx.checkIn.create({ data: { tenantId: w.tenantId, bookingId: b.id, userId: w.player } });
    const pay = await tx.payment.create({
      data: {
        tenantId: w.tenantId,
        bookingId: b.id,
        amountCents: 2400,
        providerRefId: `ch_${Math.random()}`,
        failureReasonJson: { message: 'card declined' },
      },
      select: { id: true },
    });
    await tx.refund.create({
      data: {
        tenantId: w.tenantId,
        bookingId: b.id,
        paymentId: pay.id,
        amountCents: 1200,
        reason: 'sick',
        providerRefId: `re_${Math.random()}`,
      },
    });
    await tx.bookingSplit.create({
      data: {
        tenantId: w.tenantId,
        bookingId: b.id,
        userId: w.friend,
        inviteEmail: 'friend@example.test',
        shareCents: 1200,
        paymentIntentId: `pi_${Math.random()}`,
        expiresAt: end,
        tokenHash: `split-${Math.random()}`,
      },
    });
    await tx.bookingInviteLink.create({
      data: {
        tenantId: w.tenantId,
        bookingId: b.id,
        tokenHash: `link-${Math.random()}`,
        createdByUserId: w.player,
        expiresAt: end,
      },
    });
    const game = await tx.openGame.create({
      data: { tenantId: w.tenantId, bookingId: b.id, spotsWanted: 1, note: 'come and play' },
      select: { id: true },
    });
    await tx.openGameRequest.create({
      data: { tenantId: w.tenantId, gameId: game.id, userId: w.friend, note: 'me please' },
    });
    return b.id;
  });
}

/** Everything personal that is left on one booking and its children. */
async function personalOn(bookingId: string) {
  return asAppSuperuser(db, async (tx) => {
    const b = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: {
        bookedByUserId: true,
        guestName: true,
        guestPhone: true,
        guestEmail: true,
        notes: true,
        stripePaymentIntentId: true,
        cancellationReasonJson: true,
        anonymisedAt: true,
        totalCents: true,
        status: true,
        participants: { select: { userId: true, guestName: true, guestEmail: true } },
        cancellation: { select: { cancelledByUserId: true, reason: true } },
        checkIns: { select: { userId: true } },
        payments: { select: { providerRefId: true, failureReasonJson: true, amountCents: true } },
        refunds: { select: { providerRefId: true, reason: true, amountCents: true } },
        bookingSplits: { select: { userId: true, inviteEmail: true, paymentIntentId: true } },
        inviteLinks: { select: { id: true } },
        openGame: { select: { note: true, requests: { select: { id: true } } } },
      },
    });
    return b;
  });
}

const restoreSecret = process.env.CRON_SECRET;
afterAll(() => {
  if (restoreSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = restoreSecret;
});

describe('bookings: anonymised 5 years after they ended', () => {
  it('takes every person out of a booking and its children, and keeps the rest', async () => {
    const w = await world();
    const old = await fullBooking(w, 5 * YEAR + 2 * DAY);
    const young = await fullBooking(w, 5 * YEAR - 2 * DAY);

    const result = await sweepRetention();
    expect(result.anonymised.bookings).toBe(1);

    const o = await personalOn(old);
    expect(o).toMatchObject({
      bookedByUserId: null,
      guestName: null,
      guestPhone: null,
      guestEmail: null,
      notes: null,
      stripePaymentIntentId: null,
      // The refund quote stays as the record of the money; the words go.
      cancellationReasonJson: { reason: null, refundPercent: 50 },
      totalCents: 2400,
      status: 'CANCELLED',
      cancellation: { cancelledByUserId: null, reason: null },
      checkIns: [{ userId: null }],
      payments: [{ providerRefId: null, failureReasonJson: null, amountCents: 2400 }],
      refunds: [{ providerRefId: null, reason: null, amountCents: 1200 }],
      bookingSplits: [{ userId: null, inviteEmail: null, paymentIntentId: null }],
      inviteLinks: [],
      openGame: { note: null, requests: [] },
    });
    expect(o.anonymisedAt).toBeInstanceOf(Date);
    // The places stay, so "2 played" still reads; nobody is on them.
    expect(o.participants).toHaveLength(2);
    expect(o.participants.every((p) => !p.userId && !p.guestName && !p.guestEmail)).toBe(true);

    const y = await personalOn(young);
    expect(y).toMatchObject({
      bookedByUserId: w.player,
      guestName: 'Иван Петров',
      notes: 'gate code 4471',
      anonymisedAt: null,
      cancellation: { cancelledByUserId: w.player, reason: 'sick' },
      openGame: { note: 'come and play' },
    });
    expect(y.inviteLinks).toHaveLength(1);
    expect(y.openGame?.requests).toHaveLength(1);

    // Done is done: the next day reads nothing.
    expect((await sweepRetention()).anonymised.bookings).toBe(0);
  });

  it('works in batches and says when it stopped short', async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) await fullBooking(w, 6 * YEAR + i * DAY);
    const first = await sweepRetention(new Date(), { batch: 2, maxBatches: 2 });
    expect(first.anonymised.bookings).toBe(4);
    expect(first.truncated).toBe(true);
    const second = await sweepRetention(new Date(), { batch: 2, maxBatches: 2 });
    expect(second.anonymised.bookings).toBe(1);
    expect(second.truncated).toBe(false);
  });

  it('anonymises a weekly series 5 years after its last occurrence', async () => {
    const w = await world();
    const series = (lastDaysAgo: number) =>
      asAppSuperuser(db, (tx) =>
        tx.bookingSeries.create({
          data: {
            tenantId: w.tenantId,
            resourceId: w.resourceId,
            startTime: '19:00',
            durationMinutes: 60,
            timezone: 'Europe/Sofia',
            firstDate: ago(lastDaysAgo * DAY + 60 * DAY),
            lastDate: ago(lastDaysAgo * DAY),
            customerName: 'Мария',
            customerPhone: '+359888222333',
            customerUserId: w.player,
            notes: 'pays cash',
            idempotencyKey: `s-${Math.random()}`,
          },
          select: { id: true },
        }),
      );
    const old = await series(Math.ceil((5 * YEAR) / DAY) + 3);
    const young = await series(Math.floor((5 * YEAR) / DAY) - 3);

    expect((await sweepRetention()).anonymised.weeklySeries).toBe(1);
    const rows = await asAppSuperuser(db, (tx) =>
      tx.bookingSeries.findMany({
        select: {
          id: true,
          customerName: true,
          customerPhone: true,
          customerUserId: true,
          notes: true,
        },
      }),
    );
    expect(rows.find((r) => r.id === old.id)).toMatchObject({
      customerName: '',
      customerPhone: '',
      customerUserId: null,
      notes: null,
    });
    expect(rows.find((r) => r.id === young.id)).toMatchObject({
      customerName: 'Мария',
      customerUserId: w.player,
    });
  });
});

describe('the club’s history: 5 years', () => {
  it('deletes old changes, keeps young ones and any about a booking still inside its 5 years', async () => {
    const w = await world();
    const oldBooking = await fullBooking(w, 6 * YEAR);
    // Made long ago for a booking that ended recently (a far-ahead booking).
    const youngBooking = await fullBooking(w, 4 * YEAR);
    const entry = (createdAt: Date, entity: string, entityId: string, action: string) =>
      asAppSuperuser(db, (tx) =>
        tx.auditEntry.create({
          data: { tenantId: w.tenantId, entity, entityId, action, createdAt },
          select: { id: true },
        }),
      );
    const staffOld = await entry(ago(6 * YEAR), 'TenantMembership', 'm1', 'MEMBER_ROLE_CHANGED');
    const staffYoung = await entry(ago(4 * YEAR), 'TenantMembership', 'm1', 'MEMBER_ROLE_CHANGED');
    const aboutOld = await entry(ago(6 * YEAR), 'Booking', oldBooking, 'BOOKING_CANCELLED');
    const aboutYoung = await entry(ago(6 * YEAR), 'Booking', youngBooking, 'BOOKING_CREATED');

    const result = await sweepRetention();
    expect(result.deleted.auditEntries).toBe(2);
    const left = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({
        where: { id: { in: [staffOld.id, staffYoung.id, aboutOld.id, aboutYoung.id] } },
        select: { id: true },
      }),
    );
    expect(left.map((r) => r.id).sort()).toEqual([staffYoung.id, aboutYoung.id].sort());
  });

  it('stays append-only for everything but the sweep', async () => {
    const w = await world();
    const make = (createdAt: Date) =>
      asAppSuperuser(db, (tx) =>
        tx.auditEntry.create({
          data: { tenantId: w.tenantId, entity: 'Venue', entityId: 'v', action: 'X', createdAt },
          select: { id: true },
        }),
      );
    const young = await make(ago(4 * YEAR));
    const old = await make(ago(6 * YEAR));
    const del = (id: string) => `DELETE FROM audit_entry WHERE id = '${id}'`;

    // The setting on, as app_superuser, but the row is inside its 5 years.
    await expect(
      asAppSuperuser(db, async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.retention_sweep', 'on', true)`);
        await tx.$executeRawUnsafe(del(young.id));
      }),
    ).rejects.toThrow(/APPEND-ONLY/);
    // An old row, but without the setting.
    await expect(asAppSuperuser(db, (tx) => tx.$executeRawUnsafe(del(old.id)))).rejects.toThrow(
      /APPEND-ONLY/,
    );
    // An old row with the setting, but as the role every request uses.
    await expect(
      asAppUser(db, w.tenantId, async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.retention_sweep', 'on', true)`);
        await tx.$executeRawUnsafe(del(old.id));
      }),
    ).rejects.toThrow(/APPEND-ONLY/);
    // An UPDATE never.
    await expect(
      asAppSuperuser(db, async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.retention_sweep', 'on', true)`);
        await tx.$executeRawUnsafe(`UPDATE audit_entry SET action = 'Y' WHERE id = '${old.id}'`);
      }),
    ).rejects.toThrow(/APPEND-ONLY/);
  });
});

describe('the team’s second-factor attempts: 1 year', () => {
  it('deletes events over a year old and keeps the rest, and nothing else may', async () => {
    const userId = await seedAccount('PLAYER', db);
    const event = (createdAt: Date) =>
      asAppSuperuser(db, (tx) =>
        tx.accountSecurityEvent.create({
          data: {
            userId,
            action: 'MFA_STEP_UP',
            ipAddress: '203.0.113.9',
            userAgent: 'ua',
            createdAt,
          },
          select: { id: true },
        }),
      );
    const old = await event(ago(YEAR + 5 * DAY));
    const young = await event(ago(YEAR - 5 * DAY));

    await expect(
      asAppSuperuser(db, async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.retention_sweep', 'on', true)`);
        await tx.$executeRawUnsafe(`DELETE FROM account_security_event WHERE id = '${young.id}'`);
      }),
    ).rejects.toThrow(/APPEND-ONLY/);

    expect((await sweepRetention()).deleted.securityEvents).toBe(1);
    const left = await asAppSuperuser(db, (tx) =>
      tx.accountSecurityEvent.findMany({ select: { id: true } }),
    );
    expect(left.map((r) => r.id)).toEqual([young.id]);
    expect(old.id).toBeTruthy();
  });
});

describe('moderation records: 5 years', () => {
  it('deletes decided cases and reports past 5 years, never an open case or its reports', async () => {
    const reporter = await seedAccount('PLAYER', db);
    const ids = await asAppSuperuser(db, async (tx) => {
      const kase = (status: 'OPEN' | 'APPROVED' | 'REJECTED', subjectId: string, at: Date) =>
        tx.moderationCase.create({
          data: {
            subjectType: 'CHAT_MESSAGE',
            subjectId,
            status,
            reason: 'user_report',
            createdAt: at,
            ...(status === 'OPEN' ? {} : { resolvedAt: at }),
          },
          select: { id: true },
        });
      const report = (subjectId: string, at: Date) =>
        tx.contentReport.create({
          data: {
            subjectType: 'CHAT_MESSAGE',
            subjectId,
            reporterUserId: reporter,
            reason: 'spam',
            createdAt: at,
          },
          select: { id: true },
        });
      return {
        closedOld: (await kase('REJECTED', 's-old', ago(6 * YEAR))).id,
        closedYoung: (await kase('APPROVED', 's-young', ago(4 * YEAR))).id,
        openOld: (await kase('OPEN', 's-open', ago(6 * YEAR))).id,
        reportOld: (await report('s-old', ago(6 * YEAR))).id,
        reportYoung: (await report('s-young', ago(4 * YEAR))).id,
        reportOnOpen: (await report('s-open', ago(6 * YEAR))).id,
      };
    });

    const result = await sweepRetention();
    expect(result.deleted).toMatchObject({ moderationCases: 1, contentReports: 1 });
    const [cases, reports] = await asAppSuperuser(db, (tx) =>
      Promise.all([
        tx.moderationCase.findMany({ select: { id: true } }),
        tx.contentReport.findMany({ select: { id: true } }),
      ]),
    );
    expect(cases.map((c) => c.id).sort()).toEqual([ids.closedYoung, ids.openOld].sort());
    expect(reports.map((r) => r.id).sort()).toEqual([ids.reportYoung, ids.reportOnOpen].sort());
  });
});

describe('accepted texts: 5 years after the account was deleted', () => {
  it('deletes a long-deleted account’s record and keeps the rest', async () => {
    const accepted = async (deletedAgo: number | null) => {
      const userId = await seedAccount('PLAYER', db);
      await asAppSuperuser(db, async (tx) => {
        await tx.legalAcceptance.create({
          data: {
            userId,
            document: 'privacy',
            version: '2020-01-01',
            locale: 'bg',
            acceptedAt: ago(7 * YEAR),
          },
        });
        if (deletedAgo !== null) {
          await tx.$executeRawUnsafe(
            `UPDATE app_user
                SET "deletedAt" = (now() AT TIME ZONE 'UTC') - make_interval(days => $2::int),
                    email = 'deleted-' || id || '@deleted.playerz.invalid',
                    name = NULL, phone = NULL, "phoneHash" = NULL, "phoneVerifiedAt" = NULL,
                    "avatarUrl" = NULL, "passwordHash" = NULL, "emailVerified" = NULL
              WHERE id = $1`,
            userId,
            Math.round(deletedAgo / DAY),
          );
        }
      });
      return userId;
    };
    await accepted(5 * YEAR + 3 * DAY);
    const recent = await accepted(5 * YEAR - 3 * DAY);
    const alive = await accepted(null);

    expect((await sweepRetention()).deleted.acceptedTexts).toBe(1);
    const left = await asAppSuperuser(db, (tx) =>
      tx.legalAcceptance.findMany({ select: { userId: true } }),
    );
    expect(left.map((r) => r.userId).sort()).toEqual([recent, alive].sort());
  });
});

describe('"For clubs" enquiries: 2 years after the last contact', () => {
  it('deletes an enquiry and its email copy once the person’s last enquiry is 2 years old', async () => {
    const ids = await asAppSuperuser(db, async (tx) => {
      const enquiry = async (email: string | null, phone: string | null, at: Date) => {
        const row = await tx.contactRequest.create({
          data: {
            name: 'Ани',
            clubName: 'Клуб',
            email,
            phone,
            message: 'hi',
            locale: 'bg',
            createdAt: at,
          },
          select: { id: true },
        });
        await tx.emailOutbox.create({
          data: {
            userId: null,
            kind: 'CONTACT_REQUEST',
            category: 'contact',
            dedupeKey: `contact:${row.id}`,
            locale: 'bg',
            subject: 'Запитване',
            text: 'Ани, Клуб',
            refType: 'contact_request',
            refId: row.id,
            createdAt: at,
          },
        });
        return row.id;
      };
      return {
        alone: await enquiry('alone@example.test', null, ago(2 * YEAR + 5 * DAY)),
        // Wrote again a year ago, in other words: the last contact is recent.
        earlier: await enquiry('Again@Example.test', null, ago(3 * YEAR)),
        later: await enquiry('again@example.test', null, ago(YEAR)),
        byPhoneOld: await enquiry(null, '+359 888 123 456', ago(3 * YEAR)),
        byPhoneNew: await enquiry('other@example.test', '359-888-123-456', ago(YEAR)),
        young: await enquiry(null, '+359 1', ago(2 * YEAR - 5 * DAY)),
      };
    });
    // A copy whose enquiry the operator already deleted on request.
    await asAppSuperuser(db, (tx) =>
      tx.emailOutbox.create({
        data: {
          userId: null,
          kind: 'CONTACT_REQUEST',
          category: 'contact',
          dedupeKey: 'contact:gone',
          locale: 'bg',
          subject: 'Запитване',
          text: 'x',
          refType: 'contact_request',
          refId: 'gone',
          createdAt: ago(3 * YEAR),
        },
      }),
    );

    const result = await sweepRetention();
    expect(result.deleted).toMatchObject({ contactRequests: 1, contactEmails: 2 });
    const [requests, emails] = await asAppSuperuser(db, (tx) =>
      Promise.all([
        tx.contactRequest.findMany({ select: { id: true } }),
        tx.emailOutbox.findMany({ where: { category: 'contact' }, select: { refId: true } }),
      ]),
    );
    const kept = [ids.earlier, ids.later, ids.byPhoneOld, ids.byPhoneNew, ids.young].sort();
    expect(requests.map((r) => r.id).sort()).toEqual(kept);
    expect(emails.map((e) => e.refId).sort()).toEqual(kept);
  });
});

describe('sessions: 90 days after they ended', () => {
  it('deletes a session expired or signed out over 90 days ago, keeps the rest', async () => {
    const userId = await seedAccount('PLAYER', db);
    const session = (expiresAt: Date, revokedAt: Date | null = null) =>
      asAppSuperuser(db, (tx) =>
        tx.userSession.create({
          data: {
            userId,
            tokenHash: `t-${Math.random()}`,
            ipAddress: '203.0.113.7',
            userAgent: 'playerz-ios',
            expiresAt,
            revokedAt,
          },
          select: { id: true },
        }),
      );
    await session(ago(91 * DAY));
    await session(new Date(Date.now() + 10 * DAY), ago(95 * DAY)); // signed out long ago
    const recent = await session(ago(89 * DAY));
    const live = await session(new Date(Date.now() + 10 * DAY));

    expect((await sweepRetention()).deleted.sessions).toBe(2);
    const left = await asAppSuperuser(db, (tx) =>
      tx.userSession.findMany({ select: { id: true } }),
    );
    expect(left.map((s) => s.id).sort()).toEqual([recent.id, live.id].sort());
  });
});

describe('POST /api/cron/sweep-retention', () => {
  const call = (secret?: string) =>
    sweepRoute(
      new NextRequest('http://t/api/cron/sweep-retention', {
        method: 'POST',
        headers: secret ? { 'x-cron-secret': secret } : {},
      }),
    );

  it('refuses without the secret, and answers the counts with it', async () => {
    process.env.CRON_SECRET = 'cron-test-secret-0123456789'; // pragma: allowlist secret
    expect((await call()).status).toBe(401);
    expect((await call('wrong-secret-wrong-secret-0')).status).toBe(401);

    const userId = await seedAccount('PLAYER', db);
    await asAppSuperuser(db, (tx) =>
      tx.userSession.create({
        data: { userId, tokenHash: `t-${Math.random()}`, expiresAt: ago(100 * DAY) },
      }),
    );
    const res = await call('cron-test-secret-0123456789');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      total: 1,
      truncated: false,
      anonymised: { bookings: 0, weeklySeries: 0 },
      deleted: {
        auditEntries: 0,
        securityEvents: 0,
        moderationCases: 0,
        contentReports: 0,
        acceptedTexts: 0,
        contactRequests: 0,
        contactEmails: 0,
        sessions: 1,
      },
    });
    // The compose loop stays quiet on exactly this prefix.
    const quiet = JSON.stringify(await (await call('cron-test-secret-0123456789')).json());
    expect(quiet.startsWith('{"total":0,"truncated":false')).toBe(true);
  });

  it('fails closed with no secret configured', async () => {
    delete process.env.CRON_SECRET;
    expect((await call('anything')).status).toBe(503);
  });
});
