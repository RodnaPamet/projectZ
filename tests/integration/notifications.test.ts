import type { PrismaClient } from '@prisma/client';

import {
  listNotifications,
  markAllRead,
  markRead,
  notify,
  notifyAfterCommit,
  subscribeDevice,
  unreadCount,
  unsubscribeDevice,
} from '@/app-layer/usecases/notifications';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser, asAppUser, asAppUserAs } from '../helpers/rls';

let db: PrismaClient;
let tenant: SeededTenant;
let me: string;
let other: string;

beforeAll(() => {
  db = prismaTestClient();
});

beforeEach(async () => {
  tenant = await seedTenant();
  me = tenant.userId;

  const u = await asAppSuperuser(db, (tx) =>
    tx.user.create({
      data: { email: `o-${Math.random().toString(36).slice(2, 8)}@playerz.test` },
    }),
  );
  other = u.id;
});

// ══ Notifying after somebody else's transaction committed ════════════

describe('notifyAfterCommit', () => {
  it('binds the recipient itself, so a tenant-bound caller can still notify', () => {
    // The reason this function exists. `notification` is owner-only on
    // app.user_id, and the checkout route holds a TENANT binding — writing the
    // row inside its transaction fails the policy's WITH CHECK and takes the
    // payment down with it. The caller therefore hands over a description and
    // this binds app.user_id for the insert.
    //
    // Proven by the sibling test below: the same input, written from a
    // tenant-bound handle, is refused by the database.
    return expect(
      notifyAfterCommit({
        tenantId: tenant.tenantId,
        userId: me,
        kind: 'BOOKING_CONFIRMED',
        messageKey: 'bookingConfirmed',
        money: { amount: { cents: 2400, currency: 'EUR' } },
        refType: 'booking',
        refId: 'bk_test',
      }),
    ).resolves.toBeDefined();
  });

  it('actually wrote the row', async () => {
    await notifyAfterCommit({
      tenantId: tenant.tenantId,
      userId: me,
      kind: 'BOOKING_CONFIRMED',
      messageKey: 'bookingConfirmed',
      money: { amount: { cents: 2400, currency: 'EUR' } },
      refType: 'booking',
      refId: 'bk_written',
    });

    const rows = await asAppSuperuser(db, (tx) =>
      tx.notification.findMany({ where: { userId: me, refId: 'bk_written' } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('BOOKING_CONFIRMED');
  });

  it('a TENANT-bound write of the same row is refused by the database', async () => {
    // Pins the constraint the design is built around. If this ever starts
    // passing, `notifyAfterCommit` can be simplified back into the caller's
    // transaction — and until it does, it cannot.
    await expect(
      // `asAppUser` sets app.tenant_id and NOT app.user_id — exactly the
      // context `inTenant` gives the checkout route.
      asAppUser(db, tenant.tenantId, (tx) =>
        tx.notification.create({
          data: {
            tenantId: tenant.tenantId,
            userId: me,
            kind: 'BOOKING_CONFIRMED',
            title: 'Booking confirmed',
            body: 'Your court is booked.',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("writes the notification in the RECIPIENT's language, not the default", async () => {
    // The point of the whole design. `User.locale` defaults to `bg`, so this
    // user gets Bulgarian — and the same call for an English user gets
    // English, decided at send time by the recipient rather than by whoever
    // triggered it. A Stripe webhook has no user and no request locale at all.
    await notifyAfterCommit({
      tenantId: tenant.tenantId,
      userId: me,
      kind: 'BOOKING_CONFIRMED',
      messageKey: 'bookingConfirmed',
      money: { amount: { cents: 2400, currency: 'EUR' } },
      refType: 'booking',
      refId: 'bk_bg',
    });

    const [bgRow] = await asAppSuperuser(db, (tx) =>
      tx.notification.findMany({ where: { userId: me, refId: 'bk_bg' } }),
    );
    expect(bgRow!.title).toBe('Резервацията е потвърдена');
    // Bulgarian money: amount first, comma decimal, symbol last.
    expect(bgRow!.body).toMatch(/24,00/);
    expect(bgRow!.body).not.toMatch(/Your court/);

    // Now the same notification for someone who has chosen English.
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: other }, data: { locale: 'en' } }),
    );

    await notifyAfterCommit({
      tenantId: tenant.tenantId,
      userId: other,
      kind: 'BOOKING_CONFIRMED',
      messageKey: 'bookingConfirmed',
      money: { amount: { cents: 2400, currency: 'EUR' } },
      refType: 'booking',
      refId: 'bk_en',
    });

    const [enRow] = await asAppSuperuser(db, (tx) =>
      tx.notification.findMany({ where: { userId: other, refId: 'bk_en' } }),
    );
    expect(enRow!.title).toBe('Booking confirmed');
    expect(enRow!.body).toMatch(/€24\.00/);
  });

  it('NEVER throws — the caller has already committed money', async () => {
    // A push failure must not turn a completed payment into a 500, and for the
    // Stripe webhook it must not produce a non-2xx for an event already
    // claimed, since the retry would be discarded as a duplicate.
    //
    // `not-a-cuid` fails runAsUserOnly's own id guard, so this exercises the
    // catch with a real throw from inside rather than a mocked one.
    await expect(
      notifyAfterCommit({
        tenantId: tenant.tenantId,
        userId: 'not-a-cuid',
        kind: 'BOOKING_CONFIRMED',
        messageKey: 'bookingConfirmed',
        money: { amount: { cents: 2400, currency: 'EUR' } },
      }),
    ).resolves.toBe(0);
  });
});

// ══ The row is the notification ══════════════════════════════════════

describe('persist, then push', () => {
  it('the notification EXISTS even when no push can be sent', async () => {
    // No VAPID keys are configured in tests. Push therefore does nothing — and
    // that must not stop the notification existing.
    //
    // The failure this prevents: push-then-persist. The banner appears on the
    // phone, the write fails, and the notification is nowhere to be found when
    // the user opens the app. They saw it. It does not exist.
    const r = await notify(db, {
      tenantId: tenant.tenantId,
      userId: me,
      kind: 'BOOKING_CONFIRMED',
      title: 'Booking confirmed',
      body: 'Court 1, Saturday at 10:00.',
      href: '/bookings/bk_1',
    });

    expect(r.id).toBeTruthy();
    expect(r.pushed).toBe(0); // no VAPID keys — push did nothing

    const row = await db.notification.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.title).toBe('Booking confirmed');
    expect(row.readAt).toBeNull();
  });

  it('SANITISES the title and body — both can come from user-supplied text', async () => {
    // A venue name, a player's display name. Both end up in a notification the
    // recipient's browser renders.
    const r = await notify(db, {
      userId: me,
      kind: 'MESSAGE_RECEIVED',
      title: '<script>alert(1)</script>Ivan',
      body: '<img src=x onerror=alert(1)>',
    });

    const row = await db.notification.findUniqueOrThrow({ where: { id: r.id } });

    expect(row.title).not.toContain('<script>');
    expect(row.body).not.toContain('onerror');
  });

  it('CAPS the body, so a chat message cannot become a lock-screen transcript', async () => {
    const r = await notify(db, {
      userId: me,
      kind: 'MESSAGE_RECEIVED',
      title: 'New message',
      body: 'x'.repeat(5000),
    });

    const row = await db.notification.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.body.length).toBeLessThanOrEqual(200);
  });
});

// ══ Read state ═══════════════════════════════════════════════════════

describe('read state', () => {
  async function seedThree() {
    const ids: string[] = [];
    for (const i of [1, 2, 3]) {
      const r = await notify(db, {
        userId: me,
        kind: 'BOOKING_REMINDER',
        title: `Reminder ${i}`,
        body: 'Your booking is soon.',
      });
      ids.push(r.id);
    }
    return ids;
  }

  it('counts the unread', async () => {
    await seedThree();
    expect(await unreadCount(db, me)).toBe(3);
  });

  it('marking read is IDEMPOTENT and never rewrites the timestamp', async () => {
    // A second call rewriting readAt would make "when did I read this?"
    // unanswerable, and would move the item in any list sorted by it.
    const [first] = await seedThree();

    const a = await markRead(db, { userId: me, notificationIds: [first!] });
    expect(a.marked).toBe(1);

    const readAt = (await db.notification.findUniqueOrThrow({ where: { id: first! } })).readAt;

    const b = await markRead(db, { userId: me, notificationIds: [first!] });
    expect(b.marked).toBe(0); // a no-op, not an error

    const after = (await db.notification.findUniqueOrThrow({ where: { id: first! } })).readAt;
    expect(after).toEqual(readAt);
  });

  it('cannot mark SOMEBODY ELSE’S notification read', async () => {
    const [first] = await seedThree();

    const r = await markRead(db, { userId: other, notificationIds: [first!] });

    expect(r.marked).toBe(0);
    expect((await db.notification.findUniqueOrThrow({ where: { id: first! } })).readAt).toBeNull();
  });

  it('mark-all-read clears the badge', async () => {
    await seedThree();

    const r = await markAllRead(db, { userId: me });

    expect(r.marked).toBe(3);
    expect(await unreadCount(db, me)).toBe(0);
  });

  it('the list is newest-first regardless of read state', async () => {
    // Sorting unread to the top makes the list JUMP the moment something is
    // marked read — and the thing the user was about to tap moves out from
    // under their finger.
    const ids = await seedThree();
    await markRead(db, { userId: me, notificationIds: [ids[2]!] }); // the newest

    const list = await listNotifications(db, { userId: me });

    expect(list[0]!.id).toBe(ids[2]); // still first, even though it is read
    expect(list[0]!.readAt).not.toBeNull();
  });
});

// ══ Devices ══════════════════════════════════════════════════════════

describe('push subscriptions', () => {
  const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

  it('re-subscribing the SAME browser updates its row rather than adding one', async () => {
    // Two rows for one device means every notification is delivered to it twice.
    await subscribeDevice(db, {
      userId: me,
      endpoint: ENDPOINT,
      p256dh: 'key1',
      auth: 'auth1',
    });
    await subscribeDevice(db, {
      userId: me,
      endpoint: ENDPOINT,
      p256dh: 'key2', // the browser rotated its keys
      auth: 'auth2',
    });

    const rows = await asAppSuperuser(db, (tx) =>
      tx.pushSubscription.findMany({ where: { userId: me } }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.p256dh).toBe('key2');
  });

  it('a shared device re-subscribed by ANOTHER user is reassigned, not duplicated', async () => {
    // The club's front-desk laptop. If the endpoint stayed with the previous
    // user, THEIR notifications would keep arriving on a machine somebody else
    // is now signed in to.
    await subscribeDevice(db, { userId: me, endpoint: ENDPOINT, p256dh: 'k', auth: 'a' });
    await subscribeDevice(db, { userId: other, endpoint: ENDPOINT, p256dh: 'k', auth: 'a' });

    const rows = await asAppSuperuser(db, (tx) =>
      tx.pushSubscription.findMany({ where: { endpoint: ENDPOINT } }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(other);
  });

  it('a person can have several DEVICES, and all of them are kept', async () => {
    await subscribeDevice(db, {
      userId: me,
      endpoint: `${ENDPOINT}/phone`,
      p256dh: 'k',
      auth: 'a',
    });
    await subscribeDevice(db, {
      userId: me,
      endpoint: `${ENDPOINT}/laptop`,
      p256dh: 'k',
      auth: 'a',
    });

    const rows = await asAppSuperuser(db, (tx) =>
      tx.pushSubscription.findMany({ where: { userId: me } }),
    );

    expect(rows).toHaveLength(2);
  });

  it('unsubscribing removes the device', async () => {
    await subscribeDevice(db, { userId: me, endpoint: ENDPOINT, p256dh: 'k', auth: 'a' });
    await unsubscribeDevice(db, { endpoint: ENDPOINT });

    const rows = await asAppSuperuser(db, (tx) =>
      tx.pushSubscription.findMany({ where: { endpoint: ENDPOINT } }),
    );

    expect(rows).toHaveLength(0);
  });
});

// ══ The database's own boundary ══════════════════════════════════════

describe('the DATABASE refuses cross-user reads', () => {
  it('one user cannot read another user’s notifications', async () => {
    await notify(db, {
      tenantId: tenant.tenantId,
      userId: me,
      kind: 'PAYMENT_RECEIVED',
      title: 'Payment received',
      body: 'Your booking is paid.',
    });

    // The application code here is deliberately naive — it asks for my
    // notifications while bound to somebody else's session. Postgres refuses.
    const rows = await asAppUserAs(db, tenant.tenantId, other, (tx) =>
      tx.notification.findMany({ where: { userId: me } }),
    );

    expect(rows).toEqual([]);
  });

  it('one user cannot read another user’s push subscriptions', async () => {
    // An endpoint plus its keys is a CAPABILITY: it lets the holder put a
    // notification on that person's lock screen. It is owner-only for the same
    // reason a wearable token is (P20).
    await subscribeDevice(db, {
      userId: me,
      endpoint: 'https://fcm.googleapis.com/fcm/send/secret',
      p256dh: 'k',
      auth: 'a',
    });

    const rows = await asAppUserAs(db, tenant.tenantId, other, (tx) =>
      tx.pushSubscription.findMany({ where: { userId: me } }),
    );

    expect(rows).toEqual([]);
  });

  it('a session with NO app.user_id sees nothing — fail-closed', async () => {
    await notify(db, {
      tenantId: tenant.tenantId,
      userId: me,
      kind: 'BOOKING_CONFIRMED',
      title: 'Confirmed',
      body: 'See you Saturday.',
    });

    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, tenant.tenantId);
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
      return tx.notification.findMany({ where: { userId: me } });
    });

    expect(rows).toEqual([]);
  });

  it('the OWNER can read their own', async () => {
    const r = await notify(db, {
      tenantId: tenant.tenantId,
      userId: me,
      kind: 'BOOKING_CONFIRMED',
      title: 'Confirmed',
      body: 'See you Saturday.',
    });

    const rows = await asAppUserAs(db, tenant.tenantId, me, (tx) =>
      tx.notification.findMany({ where: { userId: me } }),
    );

    expect(rows.map((n) => n.id)).toContain(r.id);
  });
});
