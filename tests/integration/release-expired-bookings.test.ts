import { NextRequest } from 'next/server';

import { POST as cron } from '@/app/api/cron/release-expired-bookings/route';
import { releaseExpiredBookings } from '@/app-layer/usecases/release-expired-bookings';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Releasing abandoned checkouts — against a real database.
 *
 * `Booking.expiresAt` has been written on every booking since P05 and read by
 * NOTHING, so a player who opened checkout and closed the tab held a court for
 * ever. The exclusion constraint counts PENDING as occupying a slot, and the
 * availability endpoint mirrors it exactly, so those holds were invisible too.
 */
describe('releasing expired PENDING bookings', () => {
  const db = prismaTestClient();

  // Fixture only: never a real credential, and the scanner is right to ask.
  // Same treatment as TEST_WEBHOOK_SECRET in tests/helpers/stripe-webhook.ts.
  const SECRET = 'cron-fixture-not-a-real-secret'; // pragma: allowlist secret

  let tenant: SeededTenant;
  let resourceId: string;

  beforeEach(async () => {
    process.env.CRON_SECRET = SECRET;
    tenant = await seedTenant({});

    resourceId = await asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: tenant.tenantId,
          slug: `sweep-${Date.now()}`,
          name: 'Sweep Club',
          description: 'Courts',
          addressLine: '1 St',
          city: 'Sofia',
          email: 'i@c.test',
          phone: '+359',
          lat: 42.69,
          lng: 23.32,
        },
      });
      const r = await tx.resource.create({
        data: {
          tenantId: tenant.tenantId,
          venueId: venue.id,
          name: 'Court 1',
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 2400,
        },
      });
      return r.id;
    });
  });

  const makeBooking = (opts: {
    status?: 'PENDING' | 'CONFIRMED';
    expiresAt?: Date | null;
    hour?: number;
  }) =>
    asAppSuperuser(db, (tx) =>
      tx.booking
        .create({
          data: {
            tenantId: tenant.tenantId,
            resourceId,
            startTs: new Date(`2026-10-0${opts.hour ?? 1}T08:00:00Z`),
            endTs: new Date(`2026-10-0${opts.hour ?? 1}T09:00:00Z`),
            status: opts.status ?? 'PENDING',
            totalCents: 2400,
            idempotencyKey: `sw-${Math.random()}`,
            expiresAt:
              opts.expiresAt === undefined ? new Date(Date.now() - 60_000) : opts.expiresAt,
          },
        })
        .then((b) => b.id),
    );

  const statusOf = (id: string) =>
    asAppSuperuser(db, (tx) =>
      tx.booking.findFirstOrThrow({ where: { id } }).then((b) => b.status),
    );

  const sweep = () => asAppSuperuser(db, (tx) => releaseExpiredBookings(tx));

  it('releases a booking whose checkout window has passed', async () => {
    const id = await makeBooking({});

    const r = await sweep();

    expect(r.released).toBe(1);
    expect(await statusOf(id)).toBe('CANCELLED');
  });

  it('audits it as SYSTEM, not as somebody cancelling', async () => {
    await makeBooking({});
    await sweep();

    const audit = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({ where: { tenantId: tenant.tenantId } }),
    );

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'BOOKING_EXPIRED', actorType: 'SYSTEM' });
  });

  it('frees the slot for a new booking', async () => {
    // The whole point. Until this ran, the exclusion constraint kept rejecting
    // anyone else who wanted that court.
    await makeBooking({});
    await sweep();

    const replacement = await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: tenant.tenantId,
          resourceId,
          startTs: new Date('2026-10-01T08:00:00Z'),
          endTs: new Date('2026-10-01T09:00:00Z'),
          status: 'PENDING',
          totalCents: 2400,
          idempotencyKey: `new-${Math.random()}`,
        },
      }),
    );

    expect(replacement.id).toBeTruthy();
  });

  it('leaves a booking whose window has NOT passed', async () => {
    const id = await makeBooking({ expiresAt: new Date(Date.now() + 600_000) });

    expect((await sweep()).released).toBe(0);
    expect(await statusOf(id)).toBe('PENDING');
  });

  it('NEVER touches a CONFIRMED booking, even with a stale expiresAt', async () => {
    // A paid booking with a leftover expiry must not be cancelled by a timer.
    // This is the failure that would take money and then remove the court.
    const id = await makeBooking({ status: 'CONFIRMED', hour: 2 });

    expect((await sweep()).released).toBe(0);
    expect(await statusOf(id)).toBe('CONFIRMED');
  });

  it('ignores a booking with no expiry at all', async () => {
    const id = await makeBooking({ expiresAt: null, hour: 3 });

    expect((await sweep()).released).toBe(0);
    expect(await statusOf(id)).toBe('PENDING');
  });

  it('does not write a Cancellation receipt — there was nothing to refund', async () => {
    // Deliberately not routed through cancelBooking, which quotes a refund. A
    // refund receipt for money never taken would be a lie in the ledger.
    await makeBooking({});
    await sweep();

    const cancellations = await asAppSuperuser(db, (tx) =>
      tx.cancellation.findMany({ where: { tenantId: tenant.tenantId } }),
    );

    expect(cancellations).toHaveLength(0);
  });

  it('is idempotent — a second sweep releases nothing', async () => {
    await makeBooking({});

    expect((await sweep()).released).toBe(1);
    expect((await sweep()).released).toBe(0);
  });

  describe('the endpoint, which nothing else guards', () => {
    const call = (headers: Record<string, string>) =>
      cron(
        new NextRequest('http://t/api/cron/release-expired-bookings', { method: 'POST', headers }),
      );

    it('runs with the right secret', async () => {
      await makeBooking({});

      const res = await call({ 'x-cron-secret': SECRET });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ released: 1 });
    });

    it('accepts the Bearer form a scheduler sends', async () => {
      const res = await call({ authorization: `Bearer ${SECRET}` });
      expect(res.status).toBe(200);
    });

    it('401s on a wrong secret', async () => {
      const id = await makeBooking({});

      const res = await call({ 'x-cron-secret': 'wrong-but-same-length!!' });

      expect(res.status).toBe(401);
      // And nothing ran.
      expect(await statusOf(id)).toBe('PENDING');
    });

    it('401s with no secret at all', async () => {
      expect((await call({})).status).toBe(401);
    });

    it('503s — never runs — when CRON_SECRET is unset', async () => {
      // THE inversion this must not have: "no credential configured, therefore
      // no check". That is how an internal endpoint ends up open on the day
      // somebody forgets an env var.
      delete process.env.CRON_SECRET;
      const id = await makeBooking({});

      const res = await call({ 'x-cron-secret': 'anything' });

      expect(res.status).toBe(503);
      expect(await statusOf(id)).toBe('PENDING');

      process.env.CRON_SECRET = SECRET;
    });

    it('answers in the canonical error envelope', async () => {
      // A scheduler is a client too, and a bare string where every other route
      // returns a struct is what api-error-envelope exists to prevent.
      const res = await call({});
      const body = (await res.json()) as { error: { code: string; message: string } };

      expect(body.error).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(typeof body.error.message).toBe('string');
    });
  });
});
