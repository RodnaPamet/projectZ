import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

import { loadClubStatement } from '@/app-layer/usecases/club-fees';
import { sweepTournamentPayments } from '@/app-layer/usecases/tournament-payments';
import { statementMonthOf } from '@/lib/billing/club-fee';
import { POST as checkoutRoute } from '@/app/api/v1/me/tournament-entries/[id]/checkout/route';
import { DELETE as withdrawRoute } from '@/app/api/v1/me/tournament-entries/[id]/route';
import { POST as declineRoute } from '@/app/api/v1/t/[slug]/admin/tournament-entries/[id]/decline/route';
import { POST as cancelRoute } from '@/app/api/v1/t/[slug]/admin/tournaments/[id]/cancel/route';
import { POST as openRoute } from '@/app/api/v1/t/[slug]/admin/tournaments/[id]/open/route';
import { GET as clubOneRoute } from '@/app/api/v1/t/[slug]/admin/tournaments/[id]/route';
import { POST as createRoute } from '@/app/api/v1/t/[slug]/admin/tournaments/route';
import { POST as enterRoute } from '@/app/api/v1/tournaments/[id]/entries/route';
import { POST as webhook } from '@/app/api/webhooks/stripe/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import {
  prismaTestClient,
  seedAccount,
  seedTenant,
  seedVenue,
  type SeededTenant,
} from '../helpers/db';
import { findRequest, recorded, useMswServer } from '../helpers/msw';
import { asAppSuperuser } from '../helpers/rls';
import { signStripeWebhook, TEST_WEBHOOK_SECRET } from '../helpers/stripe-webhook';

/**
 * A TOURNAMENT'S ENTRY FEE, PAID ONLINE (#581; decisions 41, 42, 64–67).
 *
 * Through the routes, with Stripe answered by MSW and its webhooks signed with
 * the test secret and verified for real: the fee is paid on sign-up through
 * hosted checkout, the entry is the club's once paid, playerz's cut lands on
 * the statement, and the fee comes back when the club declines or cancels, or
 * the player withdraws before entries close. An entry never paid lapses.
 */
const DAY = 86_400_000;
const MINUTE = 60_000;

describe('an entry fee paid online', () => {
  useMswServer();
  const db: PrismaClient = prismaTestClient();
  let club: SeededTenant;
  let venueId: string;
  let desk: TestIdentity;
  let ana: TestIdentity;
  let boris: TestIdentity;

  beforeEach(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    club = await seedTenant({}, db);
    ({ venueId } = await seedVenue(club.tenantId, {}, db));
    // Connected and paying out, with a 5% cut on tournament fees (67).
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({
        where: { id: club.tenantId },
        data: { stripeAccountId: 'acct_test_club', payoutsEnabled: true, tournamentFeePercent: 5 },
      }),
    );
    const deskId = await seedAccount('CLUB', db);
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: club.tenantId, userId: deskId, role: 'STAFF', status: 'ACTIVE' },
      }),
    );
    desk = await signInAs(db, {
      userId: deskId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'STAFF' }],
    });
    const playerIn = async (label: string) =>
      signInAs(db, {
        userId: await seedPlayer(db, club.tenantId, label),
        memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
      });
    [ana, boris] = await Promise.all([playerIn('ana'), playerIn('boris')]);
  });

  const call = async (
    route: unknown,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    who: TestIdentity | null,
    params: Record<string, string> = {},
    body?: unknown,
  ) => {
    const res = await (
      route as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>
    )(
      new NextRequest(`http://t${url}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(who ? { authorization: `Bearer ${who.bearer}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve(params) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  const slug = () => club.tenantSlug;

  async function onlineTournament(over: Record<string, unknown> = {}): Promise<string> {
    const made = await call(
      createRoute,
      'POST',
      `/api/v1/t/${slug()}/admin/tournaments`,
      desk,
      { slug: slug() },
      {
        name: 'Есенна купа',
        sport: 'PADEL',
        format: 'SINGLE_ELIMINATION',
        teamSize: 1,
        venueId,
        startsAt: new Date(Date.now() + 14 * DAY).toISOString(),
        drawSize: 4,
        entryFeeCents: 2000,
        feePayment: 'ONLINE',
        ...over,
      },
    );
    expect(made.status).toBe(201);
    const id = made.body.data.id as string;
    await call(openRoute, 'POST', `/api/v1/t/${slug()}/admin/tournaments/${id}/open`, desk, {
      slug: slug(),
      id,
    });
    return id;
  }

  const enter = (who: TestIdentity, id: string) =>
    call(enterRoute, 'POST', `/api/v1/tournaments/${id}/entries`, who, { id }, {});
  const checkout = (who: TestIdentity, entryId: string) =>
    call(checkoutRoute, 'POST', `/api/v1/me/tournament-entries/${entryId}/checkout`, who, {
      id: entryId,
    });
  const entryRow = (entryId: string) =>
    asAppSuperuser(db, (tx) => tx.tournamentEntry.findUniqueOrThrow({ where: { id: entryId } }));
  const feeLines = (entryId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.tournamentFeeLine.findMany({ where: { entryId }, orderBy: { createdAt: 'asc' } }),
    );
  const clubEntries = async (id: string) =>
    (
      await call(clubOneRoute, 'GET', `/api/v1/t/${slug()}/admin/tournaments/${id}`, desk, {
        slug: slug(),
        id,
      })
    ).body.data.entries as Array<{ id: string; payment: { state: string } | null }>;

  /** Stripe telling us the hosted page was paid (or closed): signed, verified for real. */
  async function stripeSays(
    type: 'checkout.session.completed' | 'checkout.session.expired',
    entryId: string,
    over: Record<string, unknown> = {},
    eventId = `evt_${Math.random().toString(36).slice(2)}`,
  ) {
    const row = await entryRow(entryId);
    const signed = signStripeWebhook({
      id: eventId,
      type,
      data: {
        object: {
          id: row.stripeCheckoutSessionId,
          object: 'checkout.session',
          mode: 'payment',
          payment_status: type === 'checkout.session.completed' ? 'paid' : 'unpaid',
          amount_total: 2000,
          currency: 'eur',
          payment_intent: `pi_test_${entryId}`,
          metadata: { tournamentEntryId: entryId },
          ...over,
        },
      },
    });
    const res = await webhook(
      new NextRequest('http://t/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': signed.header, 'content-type': 'application/json' },
        body: signed.payload,
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function enterAndPay(who: TestIdentity, id: string): Promise<string> {
    const entered = await enter(who, id);
    expect(entered.status).toBe(201);
    const entryId = entered.body.data.myEntry.id as string;
    expect((await checkout(who, entryId)).status).toBe(201);
    expect((await stripeSays('checkout.session.completed', entryId)).status).toBe(200);
    return entryId;
  }

  it('is paid on sign-up through hosted checkout to the club, and the cut goes on the statement', async () => {
    const id = await onlineTournament();
    const entered = await enter(ana, id);
    expect(entered.status).toBe(201);
    const mine = entered.body.data.myEntry;
    expect(mine.payment).toMatchObject({ state: 'DUE' });
    // Not the club's until paid: it holds no place.
    expect(await clubEntries(id)).toEqual([]);
    expect(entered.body.data.pending).toBe(0);

    const page = await checkout(ana, mine.id);
    expect(page.status).toBe(201);
    expect(page.body.data.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    // A destination charge to the club's account, for the fee, with no application fee (42).
    const sent = findRequest('/v1/checkout/sessions')!.body as Record<string, string>;
    expect(sent['payment_intent_data[transfer_data][destination]']).toBe('acct_test_club');
    expect(sent['line_items[0][price_data][unit_amount]']).toBe('2000');
    expect(sent['metadata[tournamentEntryId]']).toBe(mine.id);
    expect(Object.keys(sent).some((k) => k.includes('application_fee'))).toBe(false);
    // Somebody else cannot pay it.
    expect((await checkout(boris, mine.id)).status).toBe(404);

    const paid = await stripeSays('checkout.session.completed', mine.id, {}, 'evt_paid_once');
    expect(paid.status).toBe(200);
    expect(
      (await stripeSays('checkout.session.completed', mine.id, {}, 'evt_paid_once')).body,
    ).toMatchObject({
      duplicate: true,
    });
    const row = await entryRow(mine.id);
    expect(row).toMatchObject({ paidCents: 2000, paymentDueBy: null, status: 'PENDING' });
    expect(row.paidAt).not.toBeNull();
    // The club sees it now, paid; and its desk is told.
    expect(await clubEntries(id)).toEqual([
      expect.objectContaining({ id: mine.id, payment: expect.objectContaining({ state: 'PAID' }) }),
    ]);
    expect(
      await asAppSuperuser(db, (tx) =>
        tx.notification.count({
          where: { userId: desk.userId, kind: 'TOURNAMENT_ENTRY_RECEIVED' },
        }),
      ),
    ).toBe(1);
    // 5% of 20.00 (66, 67).
    expect(await feeLines(mine.id)).toEqual([
      expect.objectContaining({ kind: 'CHARGE', priceCents: 2000, feeBps: 500, feeCents: 100 }),
    ]);
    const statement = await asAppSuperuser(db, (tx) =>
      loadClubStatement(tx as never, club.tenantId, statementMonthOf(new Date())),
    );
    expect(statement!.tournaments.totals).toMatchObject({
      entriesPaid: 1,
      revenueCents: 2000,
      feeCents: 100,
    });
    expect(statement!.terms.tournamentFeePercent).toBe('5.00');
  });

  it('comes back in full when the club declines, and the cut is reversed', async () => {
    const id = await onlineTournament();
    const entryId = await enterAndPay(ana, id);
    recorded.length = 0;
    const declined = await call(
      declineRoute,
      'POST',
      `/api/v1/t/${slug()}/admin/tournament-entries/${entryId}/decline`,
      desk,
      { slug: slug(), id: entryId },
    );
    expect(declined.status).toBe(200);
    // Taken back from the club's account, not out of playerz's balance.
    const refund = findRequest('/v1/refunds')!.body as Record<string, string>;
    expect(refund).toMatchObject({
      payment_intent: `pi_test_${entryId}`,
      amount: '2000',
      reverse_transfer: 'true',
    });
    const row = await entryRow(entryId);
    expect(row.refundedCents).toBe(2000);
    expect(row.refundedAt).not.toBeNull();
    expect((await feeLines(entryId)).map((l) => [l.kind, l.feeCents])).toEqual([
      ['CHARGE', 100],
      ['REVERSAL', -100],
    ]);
    // Nothing left on the statement for it.
    const statement = await asAppSuperuser(db, (tx) =>
      loadClubStatement(tx as never, club.tenantId, statementMonthOf(new Date())),
    );
    expect(statement!.tournaments.totals).toMatchObject({
      entriesPaid: 0,
      revenueCents: 0,
      feeCents: 0,
      lineCount: 2,
    });
  });

  it('comes back on a withdrawal before entries close, and not after (65)', async () => {
    const id = await onlineTournament();
    const early = await enterAndPay(ana, id);
    expect(
      (
        await call(withdrawRoute, 'DELETE', `/api/v1/me/tournament-entries/${early}`, ana, {
          id: early,
        })
      ).status,
    ).toBe(200);
    expect((await entryRow(early)).refundedCents).toBe(2000);

    const late = await enterAndPay(boris, id);
    // Entries closed since.
    await asAppSuperuser(db, (tx) =>
      tx.tournament.update({
        where: { id },
        data: { entriesCloseAt: new Date(Date.now() - MINUTE) },
      }),
    );
    expect(
      (
        await call(withdrawRoute, 'DELETE', `/api/v1/me/tournament-entries/${late}`, boris, {
          id: late,
        })
      ).status,
    ).toBe(200);
    const row = await entryRow(late);
    expect(row.status).toBe('WITHDRAWN');
    expect(row.refundDueAt).toBeNull();
  });

  it('comes back for everyone paid when the club cancels', async () => {
    const id = await onlineTournament();
    const a = await enterAndPay(ana, id);
    const b = await enterAndPay(boris, id);
    expect(
      (
        await call(
          cancelRoute,
          'POST',
          `/api/v1/t/${slug()}/admin/tournaments/${id}/cancel`,
          desk,
          { slug: slug(), id },
        )
      ).status,
    ).toBe(200);
    expect((await entryRow(a)).refundedCents).toBe(2000);
    expect((await entryRow(b)).refundedCents).toBe(2000);
  });

  it('lapses when never paid; a payment arriving after that is refunded', async () => {
    const id = await onlineTournament();
    const entered = await enter(ana, id);
    const entryId = entered.body.data.myEntry.id as string;
    await checkout(ana, entryId);
    const swept = await sweepTournamentPayments(new Date(Date.now() + 40 * MINUTE));
    expect(swept.lapsed).toBe(1);
    expect((await entryRow(entryId)).status).toBe('WITHDRAWN');

    // The player paid on the page just as it lapsed.
    await stripeSays('checkout.session.completed', entryId);
    const row = await entryRow(entryId);
    expect(row.paidCents).toBe(2000);
    expect(row.refundedCents).toBe(2000);
    // And it can be entered again, afresh.
    const again = await enter(ana, id);
    expect(again.status).toBe(201);
    expect(again.body.data.myEntry.payment).toMatchObject({ state: 'DUE' });
  });

  it('is refused at a club that has not connected Stripe', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: club.tenantId }, data: { payoutsEnabled: false } }),
    );
    const made = await call(
      createRoute,
      'POST',
      `/api/v1/t/${slug()}/admin/tournaments`,
      desk,
      { slug: slug() },
      {
        name: 'Купа',
        sport: 'PADEL',
        format: 'SINGLE_ELIMINATION',
        teamSize: 1,
        venueId,
        startsAt: new Date(Date.now() + 14 * DAY).toISOString(),
        drawSize: 4,
        entryFeeCents: 2000,
        feePayment: 'ONLINE',
      },
    );
    expect(made.status).toBe(409);
    expect(made.body.error.code).toBe('TOURNAMENT_ONLINE_FEE_UNAVAILABLE');
  });
});
