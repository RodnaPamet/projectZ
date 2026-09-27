import { listBookingsForUserAcrossClubs } from '@/app-layer/repositories/booking';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

/**
 * A person's own bookings, at every club.
 *
 * ═══ WHY THIS BINDS SUPERUSER ═══
 *
 * `booking` carries a tenant-scoped RLS policy — `tenantId = app.tenant_id`
 * and nothing else — so there is no binding that means "mine, everywhere".
 * `asUser` binds `app.user_id`, which the booking policy does not mention, so
 * it returns ZERO ROWS: an empty page that reads as "you have no bookings"
 * rather than as a wrong binding. That failure mode is exactly what
 * `bind.ts` warns about.
 *
 * The scope is `bookedByUserId`, taken from a verified session and never from
 * the request, so there is no parameter to point somewhere else. One person's
 * own rows, by an indexed column.
 *
 * ═══ WHY NOT ONE BOUND QUERY PER CLUB ═══
 *
 * That was the alternative and it is worse in two ways. It is N transactions
 * to render one page. And the list of clubs would come from the token, whose
 * membership array is TRUNCATED at a cap — so a player with many clubs would
 * silently lose the tail of their own bookings, which is precisely the bug
 * `membershipsTruncated` exists to warn about.
 */
export async function listMyBookings(input: {
  userId: string;
  cursor?: string | null;
  limit?: number;
}) {
  return runAsSuperuser((db) => listBookingsForUserAcrossClubs(db, input));
}
