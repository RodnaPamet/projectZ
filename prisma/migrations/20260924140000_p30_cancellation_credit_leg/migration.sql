-- The wallet leg of a cancellation refund.
--
-- `refundAmountCents` has always been the TOTAL owed back, computed from the
-- venue's policy against the booking total. It said nothing about HOW that
-- total was paid, and until now nothing returned the wallet part at all:
-- `cancelBooking` wrote a receipt quoting up to a full refund while the
-- credit the player had spent stayed spent. `REFUND_CREDIT` existed in the
-- ledger enum and was written by nothing in src/.
--
-- Recorded as its own column rather than derived, because the two legs settle
-- through different systems — the card through Stripe, the wallet through an
-- append-only ledger entry — and a receipt carrying only the total cannot be
-- reconciled against either.
--
-- Defaults to 0, which is correct for every existing row: none of them
-- refunded any credit, because nothing could.
ALTER TABLE "cancellation"
  ADD COLUMN "refundCreditCents" INTEGER NOT NULL DEFAULT 0;
