import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DayGrid, type DayBooking } from '@/app/(app)/t/[slug]/admin/calendar/DayGrid';
import { ReviewForm } from '@/app/(app)/me/bookings/ReviewForm';

import { messages, withIntl } from '../helpers/intl';

/**
 * Two of the three screens venue reviews added, rendered against the REAL
 * Bulgarian catalogue (the third, the moderation queue, is in
 * moderation-queue.test.tsx).
 *
 * The server side of each is covered by integration tests. What those cannot
 * see is the component: a message key that exists in neither locale renders as
 * its bare key and passes every guardrail.
 *
 * The Server Actions are mocked: importing the real modules pulls Prisma into
 * jsdom, and what they do is proved against a database elsewhere.
 */

const markNoShowAction = jest.fn();
jest.mock('@/app/(app)/t/[slug]/admin/calendar/actions', () => ({
  markNoShowAction: (...args: unknown[]) => markNoShowAction(...args),
}));

const reviewBookingAction = jest.fn();
jest.mock('@/app/(app)/me/bookings/actions', () => ({
  reviewBookingAction: (...args: unknown[]) => reviewBookingAction(...args),
}));

const m = messages as unknown as {
  admin: { calendar: { noShow: Record<string, unknown> } };
  myBookings: { review: Record<string, unknown> };
};
const noShow = m.admin.calendar.noShow as { confirm: string; error: Record<string, string> };
const review = m.myBookings.review as {
  rate: string;
  submit: string;
  bodyLabel: string;
  error: Record<string, string>;
};

beforeEach(() => {
  markNoShowAction.mockReset();
  reviewBookingAction.mockReset();
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
          isoDay="2026-09-29"
          prevDay="2026-09-28"
          nextDay="2026-09-30"
          isToday
          dayLabel="Tuesday"
          courts={[{ id: 'r1', name: 'Court 1', venueName: null }]}
          bookings={bookings}
          firstHour={8}
          lastHour={22}
          renderedAt={Date.now()}
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

// ══ The review form ══════════════════════════════════════════════════

describe('ReviewForm', () => {
  it('is folded until asked for, then offers five ratings and optional text', async () => {
    render(withIntl(<ReviewForm slug="club" bookingId="b1" maxLength={2000} />));

    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: review.rate }));

    expect(screen.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByLabelText(review.bodyLabel)).toHaveAttribute('maxLength', '2000');
    expect(screen.getByRole('button', { name: review.submit })).toBeInTheDocument();
  });

  it('shows the server’s refusal in words, not a code', async () => {
    reviewBookingAction.mockResolvedValue({ ok: false, error: 'ALREADY_REVIEWED' });
    render(withIntl(<ReviewForm slug="club" bookingId="b1" maxLength={2000} />));

    await userEvent.click(screen.getByRole('button', { name: review.rate }));
    await userEvent.click(screen.getAllByRole('radio')[4]!);
    await userEvent.click(screen.getByRole('button', { name: review.submit }));

    expect(await screen.findByRole('alert')).toHaveTextContent(review.error.ALREADY_REVIEWED!);
    // Bound to the booking's own club and id, which is what the action authorises against.
    expect(reviewBookingAction.mock.calls[0]!.slice(0, 2)).toEqual(['club', 'b1']);
  });
});

// The moderation queue moved to moderation-queue.test.tsx when it moved onto
// the client data layer (src/lib/data): it needs a fresh SWR cache per test.
