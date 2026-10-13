import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

import {
  CoachVenuesSection,
  parseRate,
  rateText,
  venuesErrorKey,
  weekToHours,
  type CoachLinksView,
  type TimeOffItem,
} from '@/components/coach/CoachVenuesSection';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { ApiClientError } from '@/lib/data/errors';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { installFakeFetch, ok, type FakeAnswer } from '../unit/data/fake-v1';

/**
 * «Клубове» and «Почивни дни» on the coach's page (#546), against the real
 * Bulgarian catalogue and a fake v1: what each link shows and offers, and
 * what each button sends.
 */

const t = (messages as unknown as { coachVenues: unknown }).coachVenues as {
  none: string;
  needsApproval: string;
  missing: string;
  status: Record<string, string>;
  action: Record<string, string>;
  search: Record<string, string>;
  terms: Record<string, string>;
  timeOff: Record<string, string>;
  error: Record<string, string>;
};

type Link = CoachLinksView['links'][number];
const link = (over: Partial<Link> = {}): Link => ({
  id: 'l1',
  status: 'ACTIVE',
  startedBy: 'COACH',
  club: { name: 'Клуб Алфа', slug: 'alfa' },
  venue: { id: 'v1', name: 'Алфа Кортове', city: 'София', timezone: 'Europe/Sofia' },
  lengthOptions: [60, 90, 120],
  hourlyRateCents: null,
  groupRateCents: null,
  currency: 'EUR',
  lessonMinutes: [],
  cancelCutoffHours: 24,
  hours: [],
  missing: ['rate', 'lengths', 'hours'],
  createdAt: '2026-10-14T08:00:00Z',
  decidedAt: '2026-10-14T09:00:00Z',
  endedAt: null,
  ...over,
});
const view = (links: Link[], approved = true): CoachLinksView => ({ approved, links });

const refuse = (status: number, code: string, details?: unknown): FakeAnswer => ({
  status,
  body: { error: { code, message: code, requestId: 'r', ...(details ? { details } : {}) } },
});

function mount(seed: CoachLinksView, timeOff: TimeOffItem[] = []) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <TooltipProvider>
            <ViewerScope viewerId="usr_coach">
              <CoachVenuesSection seed={seed} timeOffSeed={timeOff} />
            </ViewerScope>
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

const rows = () => screen.queryAllByTestId('coach-venue');

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('the list', () => {
  it('a coach who is not approved yet is told why there is nothing to do', () => {
    installFakeFetch(() => ok(view([])));
    mount(view([], false));
    expect(screen.getByTestId('coach-venues')).toHaveTextContent(t.needsApproval);
    expect(screen.queryByTestId('coach-venue-add')).toBeNull();
  });

  it('an approved coach with none can add a venue', () => {
    installFakeFetch(() => ok(view([])));
    mount(view([]));
    expect(screen.getByTestId('coach-venues')).toHaveTextContent(t.none);
    expect(screen.getByTestId('coach-venue-add')).toBeEnabled();
  });

  it('what is going on first, what is over after; each with what it offers', () => {
    installFakeFetch(() => ok(view([])));
    mount(
      view([
        link({
          id: 'ended',
          status: 'ENDED',
          venue: { id: 'v3', name: 'Гама', city: 'Пловдив', timezone: 'Europe/Sofia' },
          missing: [],
        }),
        link({
          id: 'asked',
          status: 'REQUESTED',
          venue: { id: 'v2', name: 'Бета', city: 'София', timezone: 'Europe/Sofia' },
          missing: [],
        }),
        link({ id: 'active', hourlyRateCents: 4000, lessonMinutes: [60, 90], missing: ['hours'] }),
      ]),
    );
    expect(rows().map((r) => r.getAttribute('data-status'))).toEqual([
      'REQUESTED',
      'ACTIVE',
      'ENDED',
    ]);

    const [asked, active, ended] = rows();
    expect(asked).toHaveTextContent(t.status.REQUESTED!);
    expect(within(asked!).getByTestId('coach-venue-withdraw')).toBeEnabled();
    expect(within(asked!).queryByTestId('coach-venue-terms')).toBeNull();

    expect(active).toHaveTextContent('Клуб Алфа · София');
    expect(within(active!).getByTestId('coach-venue-summary')).toHaveTextContent(
      '40,00 € на час · 60, 90 мин',
    );
    expect(within(active!).getByTestId('coach-venue-missing')).toHaveTextContent(t.missing);
    expect(within(active!).getByTestId('coach-venue-terms')).toBeEnabled();

    expect(within(ended!).getByTestId('coach-venue-again')).toBeEnabled();
    expect(within(ended!).queryByTestId('coach-venue-end')).toBeNull();
  });

  it('taking a request back sends one DELETE and shows what the server answers', async () => {
    const calls = installFakeFetch(() =>
      ok(view([link({ id: 'asked', status: 'ENDED', missing: [] })])),
    );
    mount(view([link({ id: 'asked', status: 'REQUESTED', missing: [] })]));
    await userEvent.click(screen.getByTestId('coach-venue-withdraw'));
    await waitFor(() => expect(rows()[0]).toHaveAttribute('data-status', 'ENDED'));
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['DELETE', '/api/v1/me/coach-links/asked'],
    ]);
  });

  it('asking again sends the venue, and a refusal is said in words', async () => {
    const calls = installFakeFetch(() => refuse(403, 'COACH_SUSPENDED_AT_CLUB'));
    mount(view([link({ status: 'DECLINED', missing: [] })]));
    await userEvent.click(screen.getByTestId('coach-venue-again'));
    expect(await screen.findByTestId('coach-venues-error')).toHaveTextContent(
      t.error.COACH_SUSPENDED_AT_CLUB!,
    );
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/api/v1/me/coach-links', { venueId: 'v1' }],
    ]);
    expect(rows()[0]).toHaveAttribute('data-status', 'DECLINED');
  });
});

describe('asking a venue', () => {
  it('searches the public venue index, asks the one chosen, and closes on the answer', async () => {
    const calls = installFakeFetch((c) => {
      if (c.method === 'GET') {
        return ok({
          items: [
            { id: 'v1', name: 'Алфа Кортове', city: 'София' },
            { id: 'v9', name: 'Делта Падел', city: 'Варна' },
          ],
          nextCursor: null,
        });
      }
      return ok(
        view([
          link({
            id: 'new',
            status: 'REQUESTED',
            venue: { id: 'v9', name: 'Делта Падел', city: 'Варна', timezone: 'Europe/Sofia' },
            missing: [],
          }),
          link(),
        ]),
      );
    });
    mount(view([link()]));
    await userEvent.click(screen.getByTestId('coach-venue-add'));
    const results = await screen.findByTestId('coach-venue-results');
    await within(results).findByText('Делта Падел');
    // The venue the coach already teaches at is marked, not offered again.
    const mine = within(results).getByText('Алфа Кортове').closest('li')!;
    expect(within(mine).queryByTestId('coach-venue-ask')).toBeNull();

    await userEvent.type(screen.getByTestId('coach-venue-search'), 'делта');
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'GET' && c.url.includes('q=%D0%B4%D0%B5%D0%BB%D1%82%D0%B0')),
      ).toBe(true),
    );

    await userEvent.click(within(results).getByTestId('coach-venue-ask'));
    await waitFor(() => expect(screen.queryByTestId('coach-venue-results')).toBeNull());
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body])).toEqual([
      ['/api/v1/me/coach-links', { venueId: 'v9' }],
    ]);
    expect(rows().map((r) => r.getAttribute('data-venue'))).toEqual(['v9', 'v1']);
  });
});

describe('the terms at a venue', () => {
  const READY = link({
    hourlyRateCents: 4050,
    groupRateCents: 6000,
    lessonMinutes: [60],
    cancelCutoffHours: 12,
    hours: [{ dayOfWeek: 1, open: '09:00', close: '12:00' }],
    missing: [],
  });

  it('opens with what is set, and saves the terms and then the week', async () => {
    const calls = installFakeFetch(() => ok(view([{ ...READY, hourlyRateCents: 4500 }])));
    mount(view([READY]));
    await userEvent.click(screen.getByTestId('coach-venue-terms'));
    const sheet = await screen.findByTestId('coach-terms');
    expect(within(sheet).getByTestId('coach-terms-hourly')).toHaveValue('40.5');
    expect(within(sheet).getByTestId('coach-terms-group')).toHaveValue('60');
    expect(within(sheet).getByTestId('coach-terms-cutoff')).toHaveValue('12');
    expect(within(sheet).getByRole('checkbox', { name: '60 мин' })).toBeChecked();
    expect(within(sheet).getByRole('checkbox', { name: '90 мин' })).not.toBeChecked();
    expect(within(sheet).getByLabelText('Пн, интервал 1: от')).toHaveValue('09:00');

    fireEvent.change(within(sheet).getByTestId('coach-terms-hourly'), { target: { value: '45' } });
    fireEvent.change(within(sheet).getByTestId('coach-terms-group'), { target: { value: '' } });
    await userEvent.click(within(sheet).getByRole('checkbox', { name: '90 мин' }));
    // A second stretch on Monday, and one on Wednesday.
    await userEvent.click(within(sheet).getByTestId('coach-hours-add-1'));
    fireEvent.change(within(sheet).getByLabelText('Пн, интервал 2: от'), {
      target: { value: '17:00' },
    });
    fireEvent.change(within(sheet).getByLabelText('Пн, интервал 2: до'), {
      target: { value: '20:00' },
    });
    await userEvent.click(within(sheet).getByTestId('coach-hours-add-3'));

    await userEvent.click(within(sheet).getByTestId('coach-terms-save'));
    await waitFor(() => expect(screen.queryByTestId('coach-terms')).toBeNull());

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PUT', '/api/v1/me/coach-links/l1'],
      ['PUT', '/api/v1/me/coach-links/l1/hours'],
    ]);
    expect(calls[0]!.body).toEqual({
      hourlyRateCents: 4500,
      groupRateCents: null,
      lessonMinutes: [60, 90],
      cancelCutoffHours: 12,
    });
    expect(calls[1]!.body).toEqual({
      hours: [
        { dayOfWeek: 1, open: '09:00', close: '12:00' },
        { dayOfWeek: 1, open: '17:00', close: '20:00' },
        { dayOfWeek: 3, open: '09:00', close: '12:00' },
      ],
    });
    // The list shows the server's answer.
    expect(screen.getByTestId('coach-venue-summary')).toHaveTextContent('45,00 €');
  });

  it.each([
    ['a price that is not one', 'coach-terms-hourly', 'abc', 'hourlyRateCents'],
    ['a price that is a typo', 'coach-terms-hourly', '5000', 'hourlyRateCents'],
    ['a group price that is not one', 'coach-terms-group', '-3', 'groupRateCents'],
    ['a cutoff over a week', 'coach-terms-cutoff', '200', 'cancelCutoffHours'],
  ])('%s is said here, and nothing is sent', async (_l, field, value, key) => {
    const calls = installFakeFetch(() => ok(view([READY])));
    mount(view([READY]));
    await userEvent.click(screen.getByTestId('coach-venue-terms'));
    const sheet = await screen.findByTestId('coach-terms');
    fireEvent.change(within(sheet).getByTestId(field), { target: { value } });
    await userEvent.click(within(sheet).getByTestId('coach-terms-save'));
    expect(within(sheet).getByTestId('coach-terms-error')).toHaveTextContent(t.error[key]!);
    expect(calls).toHaveLength(0);
  });

  it('no length chosen is said here; what the server refuses about the hours is said too, and the sheet stays', async () => {
    const calls = installFakeFetch((c) =>
      c.url.endsWith('/hours')
        ? refuse(400, 'VALIDATION_ERROR', { field: 'hours', reason: 'OVERLAP' })
        : ok(view([READY])),
    );
    mount(view([READY]));
    await userEvent.click(screen.getByTestId('coach-venue-terms'));
    const sheet = await screen.findByTestId('coach-terms');
    await userEvent.click(within(sheet).getByRole('checkbox', { name: '60 мин' }));
    await userEvent.click(within(sheet).getByTestId('coach-terms-save'));
    expect(within(sheet).getByTestId('coach-terms-error')).toHaveTextContent(
      t.error.lessonMinutes!,
    );
    expect(calls).toHaveLength(0);

    await userEvent.click(within(sheet).getByRole('checkbox', { name: '60 мин' }));
    await userEvent.click(within(sheet).getByTestId('coach-terms-save'));
    expect(await within(sheet).findByTestId('coach-terms-error')).toHaveTextContent(t.error.hours!);
    expect(screen.getByTestId('coach-terms')).toBeInTheDocument();
  });

  it('a stretch can be removed, and a day with none reads as not working', async () => {
    installFakeFetch(() => ok(view([READY])));
    mount(view([READY]));
    await userEvent.click(screen.getByTestId('coach-venue-terms'));
    const monday = within(await screen.findByTestId('coach-hours-day-1'));
    expect(monday.queryByText(t.terms.dayOff!)).toBeNull();
    await userEvent.click(monday.getByRole('button', { name: t.terms.removeStretch! }));
    expect(monday.getByText(t.terms.dayOff!)).toBeVisible();
  });
});

describe('days off', () => {
  const OFF: TimeOffItem[] = [
    { id: 'o1', startDate: '2026-10-20', endDate: '2026-10-20', note: null },
    { id: 'o2', startDate: '2026-12-24', endDate: '2027-01-02', note: 'Коледа' },
  ];

  it('lists one day and a stretch, and takes one back', async () => {
    const calls = installFakeFetch(() => ok({ items: [OFF[1]] }));
    mount(view([]), OFF);
    const items = screen.getAllByTestId('coach-time-off-item');
    expect(items[0]).toHaveTextContent('20.10.2026 г.');
    expect(items[1]).toHaveTextContent('24.12.2026 г. – 2.01.2027 г.');
    expect(items[1]).toHaveTextContent('Коледа');

    await userEvent.click(within(items[0]!).getByTestId('coach-time-off-remove'));
    await waitFor(() => expect(screen.getAllByTestId('coach-time-off-item')).toHaveLength(1));
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['DELETE', '/api/v1/me/coach-time-off/o1'],
    ]);
  });

  it('adds a day with one date, a stretch with two, and clears the form', async () => {
    const calls = installFakeFetch(() => ok({ items: OFF }));
    mount(view([]));
    expect(screen.getByTestId('coach-time-off')).toHaveTextContent(t.timeOff.none!);
    expect(screen.getByTestId('coach-time-off-add')).toBeDisabled();

    fireEvent.change(screen.getByTestId('coach-time-off-start'), {
      target: { value: '2026-10-20' },
    });
    await userEvent.click(screen.getByTestId('coach-time-off-add'));
    await waitFor(() => expect(screen.getAllByTestId('coach-time-off-item')).toHaveLength(2));
    expect(calls[0]!.body).toEqual({ startDate: '2026-10-20' });
    expect(screen.getByTestId('coach-time-off-start')).toHaveValue('');

    fireEvent.change(screen.getByTestId('coach-time-off-start'), {
      target: { value: '2026-12-24' },
    });
    fireEvent.change(screen.getByTestId('coach-time-off-end'), { target: { value: '2027-01-02' } });
    await userEvent.click(screen.getByTestId('coach-time-off-add'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.body).toEqual({ startDate: '2026-12-24', endDate: '2027-01-02' });
  });

  it('a refusal names the field, and what was typed stays', async () => {
    installFakeFetch(() =>
      refuse(400, 'VALIDATION_ERROR', { field: 'endDate', reason: 'IN_THE_PAST' }),
    );
    mount(view([]));
    fireEvent.change(screen.getByTestId('coach-time-off-start'), {
      target: { value: '2026-10-01' },
    });
    await userEvent.click(screen.getByTestId('coach-time-off-add'));
    expect(await screen.findByTestId('coach-time-off-error')).toHaveTextContent(t.error.endDate!);
    expect(screen.getByTestId('coach-time-off-start')).toHaveValue('2026-10-01');
  });
});

describe('the small rules', () => {
  it.each([
    ['40', 4000],
    ['40,5', 4050],
    ['40.50', 4050],
    [' 0 ', 0],
    ['1000', 100000],
    ['1000.01', null],
    ['40.555', null],
    ['-1', null],
    ['abc', null],
    ['', null],
  ])('a price typed as %s is %s cents', (text, cents) => {
    expect(parseRate(text)).toBe(cents);
  });

  it('a price is shown back as it would be typed', () => {
    expect([null, 4000, 4050, 0].map(rateText)).toEqual(['', '40', '40.5', '0']);
  });

  it('the week goes out Monday first, with Sunday last', () => {
    expect(
      weekToHours({
        0: [{ open: '10:00', close: '12:00' }],
        1: [{ open: '09:00', close: '10:00' }],
      }).map((h) => h.dayOfWeek),
    ).toEqual([1, 0]);
  });

  const e = (status: number, code: string, details?: unknown) =>
    new ApiClientError({ status, code, message: code, details });
  it.each([
    [e(400, 'VALIDATION_ERROR', { field: 'hours', reason: 'OVERLAP' }), 'hours'],
    [e(400, 'VALIDATION_ERROR', { field: 'somethingNew' }), 'UNKNOWN'],
    [e(409, 'COACH_LINK_EXISTS'), 'COACH_LINK_EXISTS'],
    [e(404, 'VENUE_NOT_FOUND'), 'VENUE_NOT_FOUND'],
    [e(500, 'INTERNAL'), 'UNKNOWN'],
    [new Error('offline'), 'UNKNOWN'],
  ])('%#: an error maps to a sentence the catalogue has (%s)', (err, key) => {
    expect(venuesErrorKey(err)).toBe(key);
    expect(t.error[key]).toEqual(expect.any(String));
  });
});
