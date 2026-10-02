import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DayGrid, type DayBooking } from '@/app/(app)/t/[slug]/admin/calendar/DayGrid';

import { messages, withIntl } from '../helpers/intl';

/**
 * One of the three screens venue reviews added, the diary's no-show control,
 * rendered against the REAL Bulgarian catalogue. The other two are on the
 * client data layer and tested with a fake v1: the review form in
 * my-bookings.test.tsx, the moderation queue in moderation-queue.test.tsx.
 *
 * The server side of each is covered by integration tests. What those cannot
 * see is the component: a message key that exists in neither locale renders as
 * its bare key and passes every guardrail.
 *
 * The Server Action is mocked: importing the real module pulls Prisma into
 * jsdom, and what they do is proved against a database elsewhere.
 */

const markNoShowAction = jest.fn();
jest.mock('@/app/(app)/t/[slug]/admin/calendar/actions', () => ({
  markNoShowAction: (...args: unknown[]) => markNoShowAction(...args),
  refreshDiaryDayAction: jest.fn(),
}));

const m = messages as unknown as {
  admin: { calendar: { noShow: Record<string, unknown> } };
};
const noShow = m.admin.calendar.noShow as { confirm: string; error: Record<string, string> };

beforeEach(() => {
  markNoShowAction.mockReset();
});

// ══ The diary ════════════════════════════════════════════════════════

describe('DayGrid: marking a no-show', () => {
  const booking = (over: Partial<DayBooking>): DayBooking => ({
    id: 'b1',
    resourceId: 'r1',
    startLabel: '18:00',
    endLabel: '19:00',
    startOffsetMinutes: 600,
    durationMinutes: 60,
    status: 'CONFIRMED',
    who: 'Ivo',
    priceLabel: '€24.00',
    expiresLabel: null,
    canMarkNoShow: true,
    ...over,
  });

  const grid = (bookings: DayBooking[]) =>
    render(
      withIntl(
        <DayGrid
          slug="club"
          requestedDay={null}
          day={{
            isoDay: '2026-09-29',
            prevDay: '2026-09-28',
            nextDay: '2026-09-30',
            isToday: true,
            dayLabel: 'Tuesday',
            courts: [{ id: 'r1', name: 'Court 1', venueName: null }],
            bookings,
            firstHour: 8,
            lastHour: 22,
            renderedAt: Date.now(),
          }}
        />,
      ),
    );

  it('offers the control only on a booking that qualifies', () => {
    grid([
      booking({ id: 'started', who: 'Ivo' }),
      booking({ id: 'future', who: 'Maria', canMarkNoShow: false, startOffsetMinutes: 720 }),
    ]);

    expect(screen.getByRole('button', { name: /Ivo, 18:00–19:00/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Maria/ })).not.toBeInTheDocument();
    expect(screen.getByText('Maria')).toBeInTheDocument();
  });

  it('confirms, then calls the action for THAT booking and club', async () => {
    markNoShowAction.mockResolvedValue({ ok: true });
    grid([booking({ id: 'b-42' })]);

    await userEvent.click(screen.getByRole('button', { name: /Ivo/ }));
    await userEvent.click(screen.getByRole('button', { name: noShow.confirm }));

    expect(markNoShowAction).toHaveBeenCalledWith('club', 'b-42');
  });

  it('says why when the server refuses — here, because the player has reviewed it', async () => {
    markNoShowAction.mockResolvedValue({ ok: false, error: 'REVIEWED' });
    grid([booking({})]);

    await userEvent.click(screen.getByRole('button', { name: /Ivo/ }));
    await userEvent.click(screen.getByRole('button', { name: noShow.confirm }));

    expect(await screen.findByRole('alert')).toHaveTextContent(noShow.error.REVIEWED!);
  });
});

// The review form moved to my-bookings.test.tsx when /me/bookings moved onto
// the client data layer (T22): it now submits through the v1 route, against a
// fake fetch and a fresh SWR cache, not a mocked Server Action.

// The moderation queue moved to moderation-queue.test.tsx when it moved onto
// the client data layer (src/lib/data): it needs a fresh SWR cache per test.
