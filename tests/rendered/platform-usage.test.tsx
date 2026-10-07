import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

import { type UsageReport, UsageDashboard } from '@/app/(app)/platform/usage/UsageDashboard';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok, type FakeAnswer } from '../unit/data/fake-v1';

/**
 * `/platform/usage` (#371): nothing is read until a reason is given, every
 * read is one the person asked for, and the club table and funnel say what
 * the API answered — including when it answered "nothing yet" or "no".
 */

const t = (messages as unknown as { platform: { usage: Record<string, unknown> } }).platform
  .usage as {
  open: string;
  reason: { label: string };
  error: Record<string, string>;
  trend: Record<string, string>;
  clubs: { active: string; inactive: string; emptyTitle: string };
  funnel: { emptyTitle: string; days: string };
  event: Record<string, string>;
};

const REASON = 'weekly pilot review, Monday';

const counts = (online: number, desk: number) => ({
  online,
  desk,
  share: online + desk === 0 ? null : online / (online + desk),
});

const REPORT: UsageReport = {
  timeZone: 'Europe/Sofia',
  month: '2026-10',
  previousMonth: '2026-09',
  clubs: [
    {
      id: 'c1',
      slug: 'alpha',
      name: 'Club Alpha',
      status: 'ACTIVE',
      startedAt: '2026-08-01T09:00:00Z',
      weeksSinceStart: 10,
      active: true,
      lastBookingAt: '2026-10-14T09:00:00Z',
      thisMonth: counts(6, 4),
      lastMonth: counts(4, 6),
      trend: 'up',
      weeks: Array.from({ length: 8 }, (_, i) => ({ week: `2026-08-${10 + i}`, ...counts(i, 1) })),
    },
    {
      id: 'c2',
      slug: 'beta',
      name: 'Club Beta',
      status: 'ACTIVE',
      startedAt: '2026-09-20T09:00:00Z',
      weeksSinceStart: 3,
      active: false,
      lastBookingAt: null,
      thisMonth: counts(0, 0),
      lastMonth: counts(0, 0),
      trend: null,
      weeks: Array.from({ length: 8 }, (_, i) => ({ week: `2026-08-${10 + i}`, ...counts(0, 0) })),
    },
  ],
  funnel: {
    days: 30,
    from: '2026-09-16',
    to: '2026-10-15',
    site: {
      VENUES_VIEW: 200,
      VENUE_VIEW: 100,
      SLOTS_VIEW: 180,
      SLOT_PICKED: 40,
      SHEET_OPENED: 20,
      BOOKING_CREATED: 10,
    },
    venues: [
      {
        venueId: 'v1',
        venueName: 'Alpha Courts',
        clubId: 'c1',
        clubName: 'Club Alpha',
        counts: {
          VENUES_VIEW: 0,
          VENUE_VIEW: 50,
          SLOTS_VIEW: 90,
          SLOT_PICKED: 20,
          SHEET_OPENED: 10,
          BOOKING_CREATED: 5,
        },
      },
    ],
  },
};

const EMPTY: UsageReport = {
  ...REPORT,
  clubs: [],
  funnel: {
    ...REPORT.funnel,
    site: {
      VENUES_VIEW: 0,
      VENUE_VIEW: 0,
      SLOTS_VIEW: 0,
      SLOT_PICKED: 0,
      SHEET_OPENED: 0,
      BOOKING_CREATED: 0,
    },
    venues: [],
  },
};

function mount() {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <ViewerScope viewerId="usr_admin">
            <UsageDashboard />
          </ViewerScope>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

async function open() {
  await userEvent.type(screen.getByLabelText(t.reason.label), REASON);
  await userEvent.click(screen.getByRole('button', { name: t.open }));
}

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('the platform usage view', () => {
  it('reads nothing until a reason is given, then reads once, with it', async () => {
    const calls = installFakeFetch(() => ok(REPORT));
    mount();
    expect(calls).toHaveLength(0);

    await open();
    await screen.findByTestId('usage-clubs-table');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `/api/v1/platform/usage?days=30&reason=${encodeURIComponent(REASON).replace(/%20/g, '+')}`,
    );
  });

  it('shows each club’s share, trend and whether it is active', async () => {
    installFakeFetch(() => ok(REPORT));
    mount();
    await open();

    const table = await screen.findByTestId('usage-clubs-table');
    const alpha = within(table).getByText('Club Alpha').closest('tr, [role="row"], li')!;
    expect(within(alpha as HTMLElement).getByText(/60\s?%/)).toBeInTheDocument();
    expect(within(alpha as HTMLElement).getByText('6 от 10')).toBeInTheDocument();
    expect(within(alpha as HTMLElement).getByText(t.trend.up!)).toBeInTheDocument();
    expect(within(alpha as HTMLElement).getByText(t.clubs.active)).toBeInTheDocument();

    const beta = within(table).getByText('Club Beta').closest('tr, [role="row"], li')!;
    expect(within(beta as HTMLElement).getByText(t.clubs.inactive)).toBeInTheDocument();
    // No bookings either month: no share, so no trend badge.
    expect((beta as HTMLElement).querySelector('[data-trend]')).toBeNull();
  });

  it('draws the funnel with each step’s conversion from the one before', async () => {
    installFakeFetch(() => ok(REPORT));
    mount();
    await open();

    const site = await screen.findByTestId('usage-site-funnel');
    const steps = within(site).getAllByRole('listitem');
    const text = steps.map((s) => s.textContent!.replace(/\s/g, ' '));
    expect(text).toHaveLength(5);
    expect(text[0]).toBe(`${t.event.VENUES_VIEW}200`);
    expect(text[1]).toMatch(new RegExp(`^${t.event.VENUE_VIEW}100 · 50 ?% `));
    expect(text[2]).toMatch(new RegExp(`^${t.event.SLOT_PICKED}40 · 40 ?% `));
    expect(text[3]).toMatch(new RegExp(`^${t.event.SHEET_OPENED}20 · 50 ?% `));
    expect(text[4]).toMatch(new RegExp(`^${t.event.BOOKING_CREATED}10 · 50 ?% `));
    expect(
      within(await screen.findByTestId('usage-venues-table')).getByText('Alpha Courts'),
    ).toBeInTheDocument();
  });

  it('a new range is one more read, with the range in it', async () => {
    const calls = installFakeFetch(() => ok(REPORT));
    mount();
    await open();
    await screen.findByTestId('usage-clubs-table');

    await userEvent.click(screen.getByRole('radio', { name: '7 дни' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.url).toContain('days=7');
  });

  it('says plainly when there is nothing yet', async () => {
    installFakeFetch(() => ok(EMPTY));
    mount();
    await open();

    expect(await screen.findByText(t.clubs.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(t.funnel.emptyTitle)).toBeInTheDocument();
    expect(screen.queryByTestId('usage-clubs-table')).toBeNull();
  });

  it('says why when the grant does not open it, and shows no numbers', async () => {
    installFakeFetch((): FakeAnswer => fail(403, 'PLATFORM_CAPABILITY_REQUIRED'));
    mount();
    await open();

    expect(await screen.findByText(t.error.PLATFORM_CAPABILITY_REQUIRED!)).toBeInTheDocument();
    expect(screen.queryByTestId('usage-clubs-table')).toBeNull();
  });
});
