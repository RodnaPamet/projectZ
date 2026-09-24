import { NextRequest } from 'next/server';

import { POST as webhook } from '@/app/api/webhooks/stripe/route';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';
import { signStripeWebhook, TEST_WEBHOOK_SECRET } from '../helpers/stripe-webhook';

/**
 * Payment confirms a booking — against a real database, through the real
 * signature verifier.
 *
 * Before this, `payment_intent.succeeded` returned 200 and touched nothing:
 * a booking was created PENDING and stayed PENDING for ever, and nothing in
 * the application had ever written a `Payment` row.
 */
describe('POST /api/webhooks/stripe — payment_intent.succeeded', () => {
  const db = prismaTestClient();

  let tenant: SeededTenant;
  let bookingId: string;
  let resourceId: string;

  const PI = 'pi_test_confirms_booking';

  beforeEach(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    tenant = await seedTenant({});

    const seeded = await asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: tenant.tenantId,
          slug: `pay-club-${Date.now()}`,
          name: 'Pay Club',
          description: 'Courts',
          addressLine: '1 St',
          city: 'Sofia',
          email: 'i@club.test',
          phone: '+359',
          lat: 42.69,
          lng: 23.32,
        },
      });
      const resource = await tx.resource.create({
        data: {
          tenantId: tenant.tenantId,
          venueId: venue.id,
          name: 'Court 1',
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 2400,
        },
      });
      const booking = await tx.booking.create({
        data: {
          tenantId: tenant.tenantId,
          resourceId: resource.id,
          startTs: new Date('2026-08-01T08:00:00Z'),
          endTs: new Date('2026-08-01T09:00:00Z'),
          status: 'PENDING',
          totalCents: 2400,
          idempotencyKey: `k-${Math.random()}`,
          stripePaymentIntentId: PI,
          expiresAt: new Date(Date.now() + 900_000),
        },
      });
      return { resource, booking };
    });

    resourceId = seeded.resource.id;
    bookingId = seeded.booking.id;
  });

  const send = async (
    overrides: Record<string, unknown> = {},
    eventId = `evt_${Math.random()}`,
  ) => {
    const event = {
      id: eventId,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: PI,
          amount_received: 2400,
          metadata: { bookingId },
          ...overrides,
        },
      },
    };

    const signed = signStripeWebhook(event);
    const res = await webhook(
      new NextRequest('http://t/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': signed.header, 'content-type': 'application/json' },
        body: signed.payload,
      }),
    );
    return { res, body: (await res.json()) as Record<string, unknown> };
  };

  const payments = () => asAppSuperuser(db, (tx) => tx.payment.findMany({ where: { bookingId } }));

  const audits = () =>
    asAppSuperuser(db, (tx) => tx.auditEntry.findMany({ where: { tenantId: tenant.tenantId } }));

  const bookingRow = () =>
    asAppSuperuser(db, (tx) => tx.booking.findFirstOrThrow({ where: { id: bookingId } }));

  it('confirms the booking and records the payment', async () => {
    const { res, body } = await send();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ received: true, handled: true, reason: 'confirmed' });

    const b = await bookingRow();
    expect(b.status).toBe('CONFIRMED');
    // A confirmed booking no longer needs an expiry — it is not holding a slot
    // pending checkout any more, it IS the booking.
    expect(b.expiresAt).toBeNull();

    const p = await payments();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ status: 'PAID', providerRefId: PI, amountCents: 2400 });
  });

  it('tells the player their booking is confirmed', async () => {
    // Until this was wired, `notify` had no production call site anywhere. A
    // device could register through POST /v1/devices, the APNs transport was
    // correct and tested, and the phone never rang — for anything.
    await asAppSuperuser(db, (tx) =>
      tx.booking.update({
        where: { id: bookingId },
        data: { bookedByUserId: tenant.userId },
      }),
    );

    await send();

    const notes = await asAppSuperuser(db, (tx) =>
      tx.notification.findMany({ where: { userId: tenant.userId } }),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: 'BOOKING_CONFIRMED',
      refType: 'booking',
      refId: bookingId,
    });
    // The money is on the receipt, because "confirmed" without an amount is
    // the notification people screenshot and then argue about.
    expect(notes[0].body).toMatch(/24\.00 EUR/);
  });

  it('notifies NOBODY for a guest booking, and still confirms it', async () => {
    // The fixture booking has no `bookedByUserId` — a walk-in who gave an
    // email. There is no account to notify and no device to notify it on, and
    // that must not be an error on the payment path.
    const { res, body } = await send();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ handled: true, reason: 'confirmed' });
    expect((await bookingRow()).status).toBe('CONFIRMED');

    const notes = await asAppSuperuser(db, (tx) => tx.notification.findMany({}));
    expect(notes).toHaveLength(0);
  });

  it('audits the confirmation as SYSTEM', async () => {
    await send();

    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'BOOKING_CONFIRMED', actorType: 'SYSTEM' });
  });

  it('a REPLAYED event is a no-op, not a second confirmation', async () => {
    // Stripe guarantees at-least-once delivery. Without the event claim, the
    // second delivery would write a second Payment row and a second audit
    // entry for one payment.
    const eventId = 'evt_replayed_once';

    const first = await send({}, eventId);
    const second = await send({}, eventId);

    expect(first.body).toMatchObject({ handled: true });
    expect(second.body).toMatchObject({ duplicate: true });

    expect(await payments()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it('a DIFFERENT event for the same intent does not confirm twice', async () => {
    // Belt and braces: the dedupe key is the event, but the PENDING filter is
    // what stops two genuinely distinct events double-confirming.
    await send({}, 'evt_one');
    const { body } = await send({}, 'evt_two');

    expect(body).toMatchObject({ handled: false, reason: 'not-pending' });

    // One Payment row, not two: the intent is the key.
    expect(await payments()).toHaveLength(1);
  });

  it('REFUSES to confirm when less was paid than the court costs', async () => {
    // A booking confirmed for less than its price is a free court, and nothing
    // downstream re-checks the amount.
    const { body } = await send({ amount_received: 100 });

    expect(body).toMatchObject({ handled: false, reason: 'amount-short' });
    expect((await bookingRow()).status).toBe('PENDING');
  });

  it('still RECORDS the money when it refuses to confirm', async () => {
    // Review caught the original of this: every refusal returned early, wrote
    // nothing, and committed the dedupe claim — so a captured charge left no
    // Payment row, no audit entry, and could not even be replayed from the
    // Stripe dashboard. Refusing to confirm is right; losing the money is not.
    await send({ amount_received: 100 });

    const p = await payments();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ amountCents: 100, providerRefId: PI });

    const a = await audits();
    expect(a.map((e) => e.action)).toContain('PAYMENT_UNAPPLIED');
  });

  it('accepts a short card charge when wallet credit covers the rest', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.creditLedgerEntry.create({
        data: {
          tenantId: tenant.tenantId,
          userId: tenant.userId,
          deltaCents: -1000,
          reason: 'SPEND',
          refType: 'booking',
          refId: bookingId,
          balanceAfterCents: 0,
        },
      }),
    );

    const { body } = await send({ amount_received: 1400 });

    expect(body).toMatchObject({ handled: true });
    expect((await bookingRow()).status).toBe('CONFIRMED');
  });

  it('refuses when metadata names a different booking', async () => {
    const { body } = await send({ metadata: { bookingId: 'some-other-booking' } });

    expect(body).toMatchObject({ handled: false, reason: 'metadata-mismatch' });
    expect((await bookingRow()).status).toBe('PENDING');
  });

  it('acknowledges an intent that matches no booking', async () => {
    // Stripe cannot fix this by retrying, so it must not be a 5xx.
    const { res, body } = await send({ id: 'pi_unknown_to_us' });

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ handled: false, reason: 'no-payment-intent-link' });
  });

  it('does not resurrect a CANCELLED booking', async () => {
    // A player cancels, then a delayed webhook arrives. `updateMany` filtered
    // on PENDING is what makes that harmless.
    await asAppSuperuser(db, (tx) =>
      tx.booking.updateMany({ where: { id: bookingId }, data: { status: 'CANCELLED' } }),
    );

    const { body } = await send();

    expect(body).toMatchObject({ handled: false, reason: 'not-pending' });
    expect((await bookingRow()).status).toBe('CANCELLED');

    // THE part the original test missed, and by missing it codified the bug:
    // the player was charged. A cancelled booking with a captured payment and
    // no record of it is money the club cannot find and cannot refund.
    const p = await payments();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ status: 'PAID', providerRefId: PI });

    const a = await audits();
    expect(a.map((e) => e.action)).toContain('PAYMENT_UNAPPLIED');
  });

  it('still rejects a forged signature', async () => {
    const res = await webhook(
      new NextRequest('http://t/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': 't=1,v1=deadbeef', 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'evt_forged', type: 'payment_intent.succeeded' }),
      }),
    );

    expect(res.status).toBe(400);
    // And nothing was claimed, so a legitimate event with that id could still
    // be processed later.
    const claimed = await asAppSuperuser(db, (tx) =>
      tx.webhookEvent.findMany({ where: { eventId: 'evt_forged' } }),
    );
    expect(claimed).toHaveLength(0);
  });

  it('frees the slot for nobody — a confirmed booking still holds it', async () => {
    // booking_no_overlap counts CONFIRMED as occupying, same as PENDING.
    await send();

    await expect(
      asAppSuperuser(db, (tx) =>
        tx.booking.create({
          data: {
            tenantId: tenant.tenantId,
            resourceId,
            startTs: new Date('2026-08-01T08:00:00Z'),
            endTs: new Date('2026-08-01T09:00:00Z'),
            status: 'PENDING',
            totalCents: 2400,
            idempotencyKey: `clash-${Math.random()}`,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
