import { NextRequest } from 'next/server';

import { POST as checkoutRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/checkout/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { findRequest, useMswServer } from '../helpers/msw';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Paying for a booking, through the real route and the real Stripe client
 * (with Stripe's HTTP endpoints intercepted, not the SDK stubbed).
 *
 * The case worth the most attention is the one with no Stripe leg at all:
 * a booking paid entirely from wallet credit produces no PaymentIntent, so
 * no webhook ever fires, so nothing else in the system would ever confirm it.
 */
describe('POST /api/v1/t/:slug/bookings/:id/checkout', () => {
  useMswServer();

  const db = prismaTestClient();

  let tenant: SeededTenant;
  let player: TestIdentity;
  let otherPlayer: TestIdentity;
  let bookingId: string;

  const TOTAL = 2400;

  beforeEach(async () => {
    tenant = await seedTenant({});

    const playerId = await seedPlayer(db, tenant.tenantId);
    player = await signInAs(db, {
      userId: playerId,
      memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'PLAYER' }],
    });

    const otherId = await seedPlayer(db, tenant.tenantId, 'other');
    otherPlayer = await signInAs(db, {
      userId: otherId,
      memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'PLAYER' }],
    });

    bookingId = await asAppSuperuser(db, async (tx) => {
      // The venue must be able to receive money at all.
      await tx.venueOrg.update({
        where: { id: tenant.tenantId },
        data: { stripeAccountId: 'acct_test_club', payoutsEnabled: true },
      });

      const venue = await tx.venue.create({
        data: {
          tenantId: tenant.tenantId,
          slug: `co-club-${Date.now()}`,
          name: 'Checkout Club',
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
          basePriceCents: TOTAL,
        },
      });
      const booking = await tx.booking.create({
        data: {
          tenantId: tenant.tenantId,
          resourceId: resource.id,
          startTs: new Date('2026-09-01T08:00:00Z'),
          endTs: new Date('2026-09-01T09:00:00Z'),
          status: 'PENDING',
          totalCents: TOTAL,
          bookedByUserId: playerId,
          idempotencyKey: `co-${Math.random()}`,
          expiresAt: new Date(Date.now() + 900_000),
        },
      });
      return booking.id;
    });
  });

  const checkout = async (
    who: TestIdentity,
    body: Record<string, unknown> = {},
    id = bookingId,
  ) => {
    const res = await checkoutRoute(
      new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings/${id}/checkout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${who.bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug: tenant.tenantSlug, id }) },
    );
    return { res, body: (await res.json()) as never };
  };

  const bookingRow = () =>
    asAppSuperuser(db, (tx) => tx.booking.findFirstOrThrow({ where: { id: bookingId } }));

  const giveCredit = (cents: number) =>
    asAppSuperuser(db, (tx) =>
      tx.creditLedgerEntry.create({
        data: {
          tenantId: tenant.tenantId,
          userId: player.userId,
          deltaCents: cents,
          reason: 'ADMIN_ADJUST',
          balanceAfterCents: cents,
        },
      }),
    );

  type Body = {
    data: {
      cardDueCents: number;
      walletAppliedCents: number;
      clientSecret: string | null;
      publishableKey: string | null;
      confirmed: boolean;
    };
  };

  it('returns what a PaymentSheet needs for a card payment', async () => {
    const { res, body } = await checkout(player);
    const d = (body as Body).data;

    expect(res.status).toBe(200);
    expect(d.cardDueCents).toBe(TOTAL);
    expect(d.clientSecret).toBeTruthy();
    expect(d.confirmed).toBe(false);
    // Still PENDING — the webhook confirms it once the card actually clears.
    expect((await bookingRow()).status).toBe('PENDING');
  });

  it('CONFIRMS INLINE when wallet credit covers the whole price', async () => {
    // THE case this route exists to close. No card is due, so no PaymentIntent
    // is created, so `payment_intent.succeeded` never fires — without this the
    // booking would sit PENDING until its slot expired, having been paid for.
    await giveCredit(TOTAL);

    const { body } = await checkout(player, { useWallet: true });
    const d = (body as Body).data;

    expect(d.cardDueCents).toBe(0);
    expect(d.walletAppliedCents).toBe(TOTAL);
    expect(d.clientSecret).toBeNull();
    expect(d.confirmed).toBe(true);

    expect((await bookingRow()).status).toBe('CONFIRMED');

    const payments = await asAppSuperuser(db, (tx) =>
      tx.payment.findMany({ where: { bookingId } }),
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ provider: 'WALLET', status: 'PAID' });

    const audit = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({ where: { tenantId: tenant.tenantId } }),
    );
    expect(audit.map((a) => a.action)).toContain('BOOKING_CONFIRMED');
  });

  it('splits between wallet and card when credit is partial', async () => {
    await giveCredit(1000);

    const { body } = await checkout(player, { useWallet: true });
    const d = (body as Body).data;

    expect(d.walletAppliedCents).toBe(1000);
    expect(d.cardDueCents).toBe(TOTAL - 1000);
    expect(d.clientSecret).toBeTruthy();
    expect(d.confirmed).toBe(false);
  });

  it('does not spend credit unless asked', async () => {
    // Omitting the field must not silently spend someone's balance — that is
    // their decision, not a default.
    await giveCredit(TOTAL);

    const { body } = await checkout(player, {});

    expect((body as Body).data.walletAppliedCents).toBe(0);
    expect((body as Body).data.cardDueCents).toBe(TOTAL);
  });

  it('404s on somebody else’s booking — no staff escape hatch', async () => {
    // Cancel has one, because the desk taking a phone call is real. Paying
    // does not: nobody else may charge this player's card.
    const { res } = await checkout(otherPlayer);

    expect(res.status).toBe(404);
  });

  it('409s on a booking that is already confirmed', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.booking.updateMany({ where: { id: bookingId }, data: { status: 'CONFIRMED' } }),
    );

    const { res } = await checkout(player);

    expect(res.status).toBe(409);
  });

  it('409s on a cancelled booking', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.booking.updateMany({ where: { id: bookingId }, data: { status: 'CANCELLED' } }),
    );

    expect((await checkout(player)).res.status).toBe(409);
  });

  it('401s without a token', async () => {
    const res = await checkoutRoute(
      new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings/${bookingId}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      { params: Promise.resolve({ slug: tenant.tenantSlug, id: bookingId }) },
    );

    expect(res.status).toBe(401);
  });

  it('409s when the club cannot receive money yet', async () => {
    // A venue without Connect onboarding has no stripeAccountId, and charging
    // for it would put the money in the platform's balance with no way to pay
    // the club.
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({
        where: { id: tenant.tenantId },
        data: { payoutsEnabled: false },
      }),
    );

    const { res, body } = await checkout(player);

    expect(res.status).toBe(409);
    expect((body as { error: { code: string } }).error.code).toBe('PAYOUTS_NOT_ENABLED');
  });

  it('a SECOND checkout resumes the first — it does not mint a second intent', async () => {
    // The failure this closes, in full: tap 1 spent 1000 credit and created an
    // intent for 1400. Tap 2 found the wallet already drained, so cardDue was
    // 2400 — a DIFFERENT idempotency key, a second PaymentIntent, and
    // `stripePaymentIntentId` overwritten to point at it.
    //
    // The player then paid the sheet they were first shown. The webhook looks
    // a booking up by that column, found nothing for the intent that was
    // actually charged, and returned `no-payment-intent-link` BEFORE writing a
    // Payment row or an audit entry. Card captured, booking left PENDING,
    // swept 15 minutes later, money nowhere in the database.
    await giveCredit(1000);

    const first = await checkout(player, { useWallet: true });
    const second = await checkout(player, { useWallet: true });

    const a = (first.body as Body).data;
    const b = (second.body as Body).data;

    // Same intent, same split — the second call resumed rather than restarted.
    expect(b.cardDueCents).toBe(a.cardDueCents);
    expect(b.walletAppliedCents).toBe(a.walletAppliedCents);
    expect(b.clientSecret).toBeTruthy();

    // And the wallet was spent ONCE.
    const spends = await asAppSuperuser(db, (tx) =>
      tx.creditLedgerEntry.findMany({
        where: { refType: 'booking', refId: bookingId, reason: 'SPEND' },
      }),
    );
    expect(spends).toHaveLength(1);

    // The booking still points at the intent the player was shown.
    const booking = await asAppSuperuser(db, (tx) =>
      tx.booking.findFirstOrThrow({ where: { id: bookingId } }),
    );
    expect(booking.stripePaymentIntentId).toBeTruthy();
  });

  it('does not spend more credit when a retry flips useWallet', async () => {
    // Once an intent exists the split is fixed. A retry that changes its mind
    // about the wallet must not drain more of it — the safe direction is the
    // original split, not a second charge.
    await giveCredit(1000);

    await checkout(player, { useWallet: true });
    const retry = await checkout(player, {});

    expect((retry.body as Body).data.walletAppliedCents).toBe(1000);

    const spends = await asAppSuperuser(db, (tx) =>
      tx.creditLedgerEntry.findMany({
        where: { refType: 'booking', refId: bookingId, reason: 'SPEND' },
      }),
    );
    expect(spends).toHaveLength(1);
  });

  it('sends an idempotency key that does not vary with the amount', async () => {
    // The old key was `booking:<id>:card:<cardDueCents>` — keyed on the ONE
    // input a retry alters. Belt and braces behind the resume path.
    await checkout(player);

    const req = findRequest('/v1/payment_intents');
    expect(req!.headers['idempotency-key']).toBe(`booking:${bookingId}:checkout`);
  });
});
