import { render, screen } from '@testing-library/react';

import type { ClubOnlineShare } from '@/app-layer/usecases/usage-report';
import { OnlineShareCard } from '@/components/reports/online-share-card';

import { enMessages, messages, withIntl } from '../helpers/intl';

/**
 * "Онлайн резервации" (#371), the card #372's reports page mounts: this
 * month's share, the trend against last month, and six months of bars.
 */

const t = (messages as unknown as { admin: { onlineShare: Record<string, unknown> } }).admin
  .onlineShare as { title: string; empty: string; trend: Record<string, string> };

const month = (m: string, online: number, desk: number) => ({
  month: m,
  online,
  desk,
  share: online + desk === 0 ? null : online / (online + desk),
});

const RISING: ClubOnlineShare = {
  months: [
    month('2026-05', 0, 0),
    month('2026-06', 1, 9),
    month('2026-07', 2, 8),
    month('2026-08', 3, 7),
    month('2026-09', 4, 6),
    month('2026-10', 6, 4),
  ],
};

describe('OnlineShareCard', () => {
  it('shows this month’s share, the counts behind it, and that it went up', () => {
    render(withIntl(<OnlineShareCard data={RISING} />));

    expect(screen.getByRole('heading', { level: 2, name: t.title })).toBeInTheDocument();
    expect(screen.getByText(/60\s?%/)).toBeInTheDocument();
    expect(
      screen.getByText('6 от 10 резервации този месец са направени онлайн'),
    ).toBeInTheDocument();
    expect(screen.getByText(t.trend.up!)).toBeInTheDocument();
  });

  it('draws one bar per month, says them in words, and leaves a month with no bookings empty', () => {
    const { container } = render(withIntl(<OnlineShareCard data={RISING} />));

    const chart = screen.getByRole('img');
    // The accessible name carries every month's value, May's as "no bookings".
    expect(chart).toHaveAccessibleName(/май 2026 г\.: няма резервации/);
    expect(chart).toHaveAccessibleName(/октомври 2026 г\.: 60\s?%/);
    // Six tracks, five fills: May had nothing to fill.
    expect(container.querySelectorAll('[data-share-bar]')).toHaveLength(5);
  });

  it('says so when this month has no bookings yet, with no trend', () => {
    const quiet: ClubOnlineShare = {
      months: [...RISING.months.slice(0, 5), month('2026-10', 0, 0)],
    };
    render(withIntl(<OnlineShareCard data={quiet} />));

    expect(screen.getByText(t.empty)).toBeInTheDocument();
    expect(document.querySelector('[data-trend]')).toBeNull();
  });

  it('a fall is a warning, and the English catalogue has the card too', () => {
    const falling: ClubOnlineShare = {
      months: [...RISING.months.slice(0, 4), month('2026-09', 8, 2), month('2026-10', 1, 1)],
    };
    render(withIntl(<OnlineShareCard data={falling} />, 'en'));

    const en = (enMessages as unknown as { admin: { onlineShare: { title: string } } }).admin
      .onlineShare;
    expect(screen.getByRole('heading', { name: en.title })).toBeInTheDocument();
    expect(document.querySelector('[data-trend]')).toHaveAttribute('data-trend', 'down');
    expect(screen.getByText('1 of 2 bookings this month were made online')).toBeInTheDocument();
  });
});
