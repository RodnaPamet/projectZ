-- P34: the paging index P33 declined for platform_audit_entry, revisited at
-- ten times the row count.
--
-- ═══ WHY THIS REVERSES P33 ═══
--
-- P33 proposed this exact index, measured it at 50 000 rows, found the planner
-- kept the bare `createdAt` index with an Incremental Sort either way, and
-- declined it as a write cost buying nothing. That was right at that size. It
-- also said, in as many words, that a change in access pattern meant redoing
-- the measurement rather than inheriting the conclusion. This is that redo.
--
-- ═══ WHAT WAS MEASURED ═══
--
-- 500 000 rows, and deliberately BURSTY: 5 000 distinct timestamps with 100
-- rows sharing each. P33's fixture gave every row its own timestamp, which is
-- what hid the tie-break cost — a log written in batches does not look like
-- that. EXPLAIN (ANALYZE), medians of 7 warm runs:
--
--                          bare createdAt        with (createdAt, id)
--   page one         1.25 ms  Incremental Sort   0.22 ms  Index Only Scan
--   deep page        2.17 ms  Incremental Sort   0.29 ms  Index Only Scan
--
-- With both indexes present the planner picks the composite every time, and
-- dropping the bare one costs nothing measurable (0.20 → 0.22 ms). So the bare
-- index goes: it is a prefix of the composite, and an append-heavy audit table
-- is the worst place to carry an index that no plan chooses.
--
-- ═══ WHAT THIS DOES NOT FIX ═══
--
-- The query builder. End to end through Prisma, net of transaction overhead,
-- a deep page is 18.4 ms with this index and 23.5 ms without — better, but
-- still an order above the 0.29 ms the SQL itself now takes, because `cursor`
-- scans from the top of the index rather than seeking to a position. The
-- row-value seek that does is in platform-paging.ts and lands at 7.6 ms.
--
-- Correcting P33 on one more point while the numbers are fresh: it recorded
-- the Prisma `OR` form as WORSE than the cursor. With this index the two are
-- within noise of each other (17.4 ms against 18.4 ms). The reason to prefer
-- raw SQL is that neither Prisma form seeks, not that the OR form is slow.

DROP INDEX "platform_audit_entry_createdAt_idx";

CREATE INDEX "platform_audit_entry_createdAt_id_idx"
  ON "platform_audit_entry"("createdAt", "id");
