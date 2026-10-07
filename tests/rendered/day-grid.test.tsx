import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { DayGrid, type DayBooking } from '@/app/(app)/t/[slug]/admin/calendar/DayGrid';
import type { DiaryDay } from '@/app/(app)/t/[slug]/admin/calendar/diary-day';

import { messages as bg, withIntl } from '../helpers/intl';

/**
 * THE DIARY ON THE PRIMITIVES (T26).
 *
 * What a reader cannot see from the markup alone:
 *
 *   - the day links are still anchors to `?day=` (the perf harness and a
 *     middle-click both need that), dressed as Still Surface buttons;
 *   - every court is a Card the screen reader can name, so "Корт 2" is a
 *     landmark rather than a column of anonymous divs;
 *   - a refusal is an InlineNotice (role=alert) that can be dismissed;
 *   - focus goes somewhere on purpose: back to the day link after a day
 *     change (the grid remounts), and to the day's heading after a no-show
 *     whose block has left the grid.
 *
 * The stale-day refresh is tests/rendered/diary-fresh-day.test.tsx; the
 * server's day is tests/integration/admin-diary-day.test.ts.
 */

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: jest.fn(),
    push: (...args: unknown[]) => push(...args),
    replace: jest.fn(),
    prefetch: jest.fn(),
  }),
}));

const markNoShowAction = jest.fn();
jest.mock('@/app/(app)/t/[slug]/admin/calendar/actions', () => ({
  markNoShowAction: (...args: unknown[]) => markNoShowAction(...args),
  refreshDiaryDayAction: jest.fn(() => new Promise(() => {})),
}));

const c = bg.admin.calendar;

const booking = (over: Partial<DayBooking> = {}): DayBooking => ({
  id: 'b1',
  resourceId: 'r1',
  startLabel: '18:00',
  endLabel: '19:00',
  startOffsetMinutes: 600,
  durationMinutes: 60,
  status: 'CONFIRMED',
  who: 'Иван',
  priceLabel: '24,00 €',
  expiresLabel: null,
  canMarkNoShow: true,
  desk: false,
  seriesId: null,
  ...over,
});

/** What a court carries for the desk (#364). */
const DESK = { noun: 'court' as const, durations: [60, 120], slotStepMinutes: 60, bookable: true };

let stamp = Date.now();
const dayOf = (over: Partial<DiaryDay> = {}): DiaryDay => ({
  isoDay: '2026-09-29',
  prevDay: '2026-09-28',
  nextDay: '2026-09-30',
  isToday: false,
  dayLabel: 'вторник, 29 септември 2026 г.',
  courts: [
    { id: 'r1', name: 'Корт 1', venueName: null, ...DESK },
    { id: 'r2', name: 'Корт 2', venueName: null, ...DESK },
  ],
  bookings: [booking()],
  firstHour: 8,
  lastHour: 22,
  // Fresh, so the stale-day refresh never fires here.
  renderedAt: ++stamp,
  ...over,
});

/** Each test is its own club: the grid keeps module state per club, as in the app. */
let n = 0;
const nextClub = () => `club-${++n}`;

const grid = (slug: string, day: DiaryDay, requestedDay: string | null = day.isoDay) =>
  render(withIntl(<DayGrid slug={slug} requestedDay={requestedDay} day={day} />));

beforeEach(() => {
  markNoShowAction.mockReset();
  push.mockReset();
});

describe('DayGrid on the primitives', () => {
  it('day links are anchors to ?day=, dressed as buttons; "today" only off today', () => {
    const slug = nextClub();
    const { unmount } = grid(slug, dayOf());

    const prev = screen.getByRole('link', { name: c.nav.previous });
    const next = screen.getByRole('link', { name: c.nav.next });
    const today = screen.getByRole('link', { name: c.nav.today });
    expect(prev).toHaveAttribute('href', `/t/${slug}/admin/calendar?day=2026-09-28`);
    expect(next).toHaveAttribute('href', `/t/${slug}/admin/calendar?day=2026-09-30`);
    expect(today).toHaveAttribute('href', `/t/${slug}/admin/calendar`);
    // Still Surface: the pill and the 44 px touch floor come from buttonVariants.
    for (const link of [prev, next, today]) {
      expect(link.className).toMatch(/rounded-full/);
      expect(link.className).toMatch(/pointer-coarse:min-h-11/);
    }
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'вторник, 29 септември 2026 г.',
    );
    unmount();

    grid(nextClub(), dayOf({ isToday: true }), null);
    expect(screen.queryByRole('link', { name: c.nav.today })).toBeNull();
  });

  it('each court is a Card named by its heading, inside the perf marker', () => {
    const { container } = grid(nextClub(), dayOf());

    expect(screen.getAllByRole('region')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Корт 1' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Корт 2' })).toBeInTheDocument();
    expect(container.querySelector('[data-perf-ready]')).toHaveTextContent('Корт 1');
    // The booking sits on its own court's card.
    expect(
      within(screen.getByRole('region', { name: 'Корт 1' })).getByRole('button', {
        name: /Иван, 18:00–19:00/,
      }),
    ).toBeInTheDocument();
  });

  it('the legend and a pending block’s expiry are StatusBadges; the timezone badge stays', () => {
    const { container } = grid(
      nextClub(),
      dayOf({
        bookings: [
          booking({ id: 'p1', status: 'PENDING', expiresLabel: '17:45', canMarkNoShow: false }),
        ],
      }),
    );

    expect(screen.getByText(c.legend.confirmed)).toHaveClass(
      'bg-bg-success',
      'text-content-success',
    );
    expect(screen.getByText(c.legend.pending)).toHaveClass('border-dashed', 'border-border-strong');
    expect(screen.getByText(c.expiresAt.replace('{time}', '17:45'))).toHaveClass('rounded-full');
    expect(screen.getByText(c.tz.badge)).toHaveClass('rounded-full');
    // A pending block is not a control.
    expect(container.querySelector('[data-booking-status="PENDING"]')?.tagName).toBe('DIV');
  });

  it('a refusal is a dismissable InlineNotice, and the block stays', async () => {
    markNoShowAction.mockResolvedValue({ ok: false, error: 'REVIEWED' });
    grid(nextClub(), dayOf());

    fireEvent.click(screen.getByRole('button', { name: /Иван, 18:00–19:00/ }));
    const dialog = await screen.findByRole('dialog', { name: c.noShow.confirmTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: c.noShow.confirm }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(c.noShow.error.REVIEWED);
    expect(markNoShowAction).toHaveBeenCalledWith(expect.any(String), 'b1');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: /Иван, 18:00–19:00/ })).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole('button', { name: bg.common.ui.dismiss }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('after a no-show, focus goes to the day heading once the block has left', async () => {
    markNoShowAction.mockResolvedValue({ ok: true });
    const slug = nextClub();
    const day = dayOf();
    const { rerender } = grid(slug, day);

    fireEvent.click(screen.getByRole('button', { name: /Иван, 18:00–19:00/ }));
    const dialog = await screen.findByRole('dialog', { name: c.noShow.confirmTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: c.noShow.confirm }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // The revalidated payload: the booking is a NO_SHOW now, not a diary status.
    rerender(
      withIntl(
        <DayGrid
          slug={slug}
          requestedDay={day.isoDay}
          day={{ ...day, bookings: [], renderedAt: ++stamp }}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toHaveFocus());
  });

  it('a day change puts focus back on the link that was followed', async () => {
    const slug = nextClub();
    const { unmount } = grid(slug, dayOf());
    // The grid remounts on a ?day= change (a new page segment), so the
    // clicked link is gone. Following it records which one it was.
    fireEvent.click(screen.getByRole('link', { name: c.nav.next }));
    unmount();

    grid(
      slug,
      dayOf({ isoDay: '2026-09-30', prevDay: '2026-09-29', nextDay: '2026-10-01' }),
      '2026-09-30',
    );
    await act(async () => {});
    const next = screen.getByRole('link', { name: c.nav.next });
    expect(next).toHaveAttribute('href', `/t/${slug}/admin/calendar?day=2026-10-01`);
    expect(next).toHaveFocus();
  });

  it('"today" lands focus on the heading, where no "today" link is drawn', async () => {
    const slug = nextClub();
    const { unmount } = grid(slug, dayOf());
    fireEvent.click(screen.getByRole('link', { name: c.nav.today }));
    unmount();

    grid(slug, dayOf({ isToday: true }), null);
    await act(async () => {});
    expect(screen.getByRole('heading', { level: 2 })).toHaveFocus();
  });

  it('a visit to some other day does not steal focus', async () => {
    const slug = nextClub();
    const { unmount } = grid(slug, dayOf());
    fireEvent.click(screen.getByRole('link', { name: c.nav.next }));
    unmount();

    // Not the day that link pointed at.
    grid(slug, dayOf({ isoDay: '2026-12-01' }), '2026-12-01');
    await act(async () => {});
    expect(document.body).toHaveFocus();
  });
});

describe('getting around the diary (audit C07, C08)', () => {
  it('a date field jumps to any day, through ?day=', () => {
    const slug = nextClub();
    grid(slug, dayOf());

    const field = screen.getByLabelText(c.nav.pickDay);
    expect(field).toHaveAttribute('type', 'date');
    expect(field).toHaveValue('2026-09-29');

    // A year still being typed is not a day to go to.
    fireEvent.change(field, { target: { value: '0002-10-15' } });
    expect(push).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: '2026-10-15' } });
    expect(push).toHaveBeenCalledWith(`/t/${slug}/admin/calendar?day=2026-10-15`);
  });

  it('says nothing about scrolling while every court fits', () => {
    grid(nextClub(), dayOf());
    expect(screen.queryByRole('group', { name: c.scroll.jumpTo })).toBeNull();
  });

  describe('when the courts do not fit', () => {
    // jsdom lays nothing out, so the scroller's geometry is given: 664 px of
    // courts in a 361 px box, measured at 393 px in the audit.
    const proto = HTMLElement.prototype;
    const saved = {
      scrollWidth: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'),
      clientWidth: Object.getOwnPropertyDescriptor(proto, 'clientWidth'),
    };
    const scrollTo = jest.fn();

    beforeAll(() => {
      Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => 664 });
      Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 361 });
      proto.scrollTo = scrollTo as unknown as typeof proto.scrollTo;
    });
    afterAll(() => {
      for (const [k, d] of Object.entries(saved)) if (d) Object.defineProperty(proto, k, d);
    });

    const four = () =>
      dayOf({
        courts: ['1', '2', '3', '4'].map((i) => ({
          id: `r${i}`,
          name: `Корт ${i}`,
          venueName: null,
          ...DESK,
        })),
      });

    it('says how many courts there are, and fades the edge with courts behind it', () => {
      const { container } = grid(nextClub(), four());

      expect(screen.getByText(c.scroll.hint.replace('{count}', '4'))).toBeInTheDocument();
      expect(container.querySelector('[data-diary-fade="end"]')).not.toBeNull();
      // At the start: nothing is hidden to the left.
      expect(container.querySelector('[data-diary-fade="start"]')).toBeNull();
    });

    it('a chip per court scrolls that court into view', () => {
      grid(nextClub(), four());

      const chips = within(screen.getByRole('group', { name: c.scroll.jumpTo })).getAllByRole(
        'button',
      );
      expect(chips.map((b) => b.textContent)).toEqual(['Корт 1', 'Корт 2', 'Корт 3', 'Корт 4']);
      fireEvent.click(chips[3]!);
      expect(scrollTo).toHaveBeenCalled();
    });

    it('at a karting club the tracks are "писти", and at a mixed one both are named (P51)', () => {
      const tracks = four();
      tracks.courts = tracks.courts.map((court) => ({ ...court, noun: 'track' as const }));
      const { unmount } = grid(nextClub(), tracks);
      expect(
        screen.getByText('4 писти: превъртете настрани или изберете писта.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('group', { name: c.track.scroll.jumpTo })).toBeInTheDocument();
      unmount();

      const mixed = four();
      mixed.courts[3] = { ...mixed.courts[3]!, noun: 'track' };
      grid(nextClub(), mixed);
      expect(screen.getByText(c.mixed.scroll.hint.replace('{count}', '4'))).toBeInTheDocument();
    });
  });
});

describe('the desk in the diary (#364)', () => {
  const d = bg.admin.calendar.desk;

  it('every free hour of a bookable court is a button to book it; an archived court has none', () => {
    const day = dayOf({
      courts: [
        { id: 'r1', name: 'Корт 1', venueName: null, ...DESK },
        { id: 'r2', name: 'Корт 2', venueName: null, ...DESK, bookable: false },
      ],
      bookings: [],
    });
    grid(nextClub(), day);

    const one = within(screen.getByRole('region', { name: 'Корт 1' }));
    const at18 = d.newAt.replace('{court}', 'Корт 1').replace('{time}', '18:00');
    expect(one.getByRole('button', { name: at18 })).toBeInTheDocument();
    const two = within(screen.getByRole('region', { name: 'Корт 2' }));
    expect(two.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('button', { name: d.new })).toBeInTheDocument();
  });

  it('a desk booking is drawn in the info tokens, a series week is marked, and it opens its detail', () => {
    grid(
      nextClub(),
      dayOf({ bookings: [booking({ desk: true, seriesId: 's1', canMarkNoShow: false })] }),
    );
    const block = screen.getByRole('button', { name: /Иван, 18:00–19:00/ });
    expect(block.className).toMatch(/bg-bg-info/);
    expect(block).toHaveAttribute('data-booking-desk');
    expect(within(block).getByText(d.seriesMark)).toBeInTheDocument();
    expect(screen.getByText(bg.admin.calendar.legend.desk)).toBeInTheDocument();
  });
});
