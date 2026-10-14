# Payments: tournament entry fees online (#581)

How a club's tournament fee is paid online, and what the platform owner sets up once.
Decisions 41, 42 and 64–67 are on #378 and #581.

## The flow

1. **The club connects its own Stripe account.** On «Отчети и такса» (`/t/{slug}/admin/reports`),
   an owner or manager presses «Свържи Stripe». That creates an Express connected account under
   playerz's platform account and opens Stripe's hosted onboarding. Stripe sends them back to the
   same page. The club can take payments once Stripe's `account.updated` webhook sets
   `venue_org.payoutsEnabled`, which can be a while after the form is finished.
2. **The club offers an online fee.** In the tournament form, «Плащане на таксата» → «Онлайн».
   This is refused (409 `TOURNAMENT_ONLINE_FEE_UNAVAILABLE`) until the club's account pays out.
3. **The player pays on sign-up (64).** Entering creates the entry with a payment deadline
   (31 minutes). The page sends the player to Stripe's hosted checkout
   (`POST /me/tournament-entries/{id}/checkout`).
   - The charge is a destination charge to the club's account, with **no application fee**: the
     whole fee is the club's (41).
   - Until it is paid, the club does not see the entry and it holds no place.
4. **Paid.** `checkout.session.completed` records the payment. The entry becomes an ordinary
   pending one: the club's desk and the partner are told. playerz's cut is written as a CHARGE line
   in `tournament_fee_line`.
5. **Never paid.** The entry lapses at its deadline: `checkout.session.expired`, or the minute
   sweep. A payment arriving after that is recorded and refunded.
6. **Refunds (64, 65).** The whole fee comes back from the club's account (`reverse_transfer`)
   when:
   - the club declines the entry;
   - the entry does not get a place at the draw;
   - the club cancels the tournament;
   - the player withdraws before entries close (or before the start, when no close is set).

   A withdrawal after that gets nothing back. A refund is marked owed in the same transaction as
   the change, made right after it, and retried by the minute sweep (`/api/cron/send-booking-reminders`)
   until Stripe has it. Each one adds a REVERSAL line.

## playerz's cut (42, 66, 67)

- A percentage per club, set on `/platform/fees` beside the booking fee («Такса турнири, %»).
- It is 0% until set, and the booking fee's free period does not apply.
- It applies to fees paid online only.
- It is invoiced on the club's monthly statement, in its own «Турнири» block (and the CSV). Stripe
  does not take it at the charge.
- Each line keeps the rate it was charged at, as booking fee lines do.

## What the platform owner sets up once

The keys come **through the clipboard, never in a chat**. They are written to the server's env
file without being displayed. Do staging (test mode) first, then production (live mode).

1. **Stripe account settings → Connect:** enable Express accounts, with Bulgaria and EUR.
2. **Developers → API keys:** the secret key goes to `STRIPE_SECRET_KEY` in `/opt/playerz/.env.staging`
   (test) or `/opt/playerz/.env` (live). The app needs no publishable key: checkout and onboarding
   are hosted by Stripe.
3. **Developers → Webhooks: two endpoints, both with the same URL**, `https://staging.playerz.bg/api/webhooks/stripe`
   (or `https://playerz.bg/...`). Stripe sends a connected account's events only to an endpoint
   that listens on connected accounts, and the platform's own only to one that does not.
   - **Your account:** events `checkout.session.completed`, `checkout.session.expired` and
     `payment_intent.succeeded`. Its signing secret goes to `STRIPE_WEBHOOK_SECRET`.
   - **Connected accounts:** event `account.updated`, which is what lets a club take payments.
     Its signing secret goes to `STRIPE_CONNECT_WEBHOOK_SECRET`.
   - The route accepts a payload signed with either secret, and nothing else.
4. Recreate the app container from `/opt/playerz` and check `printenv STRIPE_SECRET_KEY` inside it
   is set, without printing the value.
5. **Test on staging:** connect a test club with Stripe's test data, make a tournament with an online
   fee, enter it and pay with the test card `4242 4242 4242 4242`. Then check:
   - the entry turns up for the club;
   - a fee line appears on the statement;
   - declining the entry refunds it.
