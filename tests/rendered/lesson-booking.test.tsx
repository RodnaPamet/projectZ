import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { LessonBooking, type LessonVenue } from '@/app/(public)/coaches/[slug]/LessonBooking';
import type { LessonPick } from '@/app/(public)/coaches/[slug]/lesson-pick';
import type { LessonTimesDto } from '@/app/api/v1/_lib/coach-dto';
import type { BookingViewer } from '@/components/booking/booking-viewer';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KIND_CHOOSER_PATH, PHONE_STEP_PATH } from '@/lib/auth/landing';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok, type FakeAnswer, type FakeCall } from '../unit/data/fake-v1';

/**
 * «Запишете урок» on a coach's page and its confirmation sheet (#548),
 * against the REAL Bulgarian catalogue and a fake v1: what a player chooses,
 * what they are shown before confirming, and what they see for each answer
 * the lesson route can give.
 */

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));

const l = messages.coaches.lesson;
const v = messages.venue;

// 2036-07-14, Sofia is UTC+3: 09:00 local = 06:00Z.
const AT = (h: number, m = 0) =>
  `2036-07-14T${String(h - 3).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const DAYS = Array.from({ length: 14 }, (_, i) =>
  new Date(Date.UTC(2036, 6, 14 + i)).toISOString().slice(0, 10),
);

const alfa: LessonVenue = {
  linkId: 'l1',
  name: 'Алфа Кортове',
  club: 'Клуб Алфа',
  timezone: 'Europe/Sofia',
  sports: ['TENNIS', 'PADEL'],
  lessonMinutes: [60, 120],
  days: DAYS,
};
const beta: LessonVenue = {
  linkId: 'l2',
  name: 'Бета Арена',
  club: 'Клуб Бета',
  timezone: 'Europe/Sofia',
  sports: ['PADEL'],
  lessonMinutes: [90],
  days: DAYS,
};

const times = (over: Partial<LessonTimesDto> = {}): LessonTimesDto => ({
  linkId: 'l1',
  venue: { id: 'v1', name: 'Алфа Кортове', timezone: 'Europe/Sofia' },
  date: DAYS[0]!,
  minutes: 60,
  currency: 'EUR',
  coachFeeCents: 4000,
  groupFeeCents: 6000,
  cancelCutoffHours: 24,
  times: [9, 10, 18].map((h) => ({
    startTs: AT(h),
    endTs: AT(h + 1),
    sport: 'TENNIS',
    court: { id: 'c1', name: 'Корт 1' },
    courtPriceCents: 2400,
    totalCents: 6400,
  })),
  ...over,
});

const FIRST: LessonPick = {
  linkId: 'l1',
  sport: 'TENNIS',
  minutes: 60,
  day: DAYS[0]!,
  start: null,
  confirm: false,
};

function mount({
  viewer = 'player',
  pick = FIRST,
  venues = [alfa],
  own = false,
  seed = times(),
  renderedAt = '2036-07-13T12:00:00Z',
}: {
  viewer?: BookingViewer;
  pick?: LessonPick;
  venues?: LessonVenue[];
  own?: boolean;
  seed?: LessonTimesDto | null;
  renderedAt?: string;
} = {}) {
  const ui = (
    <LessonBooking
      coach={{ slug: 'ivan-petrov', name: 'Иван Петров' }}
      venues={venues}
      initialPick={pick}
      seed={seed}
      renderedAt={renderedAt}
      viewer={viewer}
      own={own}
    />
  );
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <TooltipProvider>
            {viewer === 'signed-out' ? ui : <ViewerScope viewerId="u1">{ui}</ViewerScope>}
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

/** A fake v1: the times answer by what was asked; the POST answers `booking()`. */
function api(
  booking: () => FakeAnswer | Promise<FakeAnswer> = () => ok({ id: 'bk1' }, 201),
  answer: (query: URLSearchParams) => LessonTimesDto = () => times(),
) {
  return installFakeFetch((call) => {
    if (call.method === 'POST') return booking();
    return ok(answer(new URL(call.url, 'http://t').searchParams));
  });
}
const posts = (calls: FakeCall[]) => calls.filter((c) => c.method === 'POST');
const reads = (calls: FakeCall[]) => calls.filter((c) => c.method === 'GET');

const pickTen = () => fireEvent.click(screen.getByRole('button', { name: /^10:00/ }));
const openSheet = async () => {
  pickTen();
  fireEvent.click(screen.getByTestId('lesson-book'));
  return screen.findByRole('dialog');
};
const confirmIn = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByTestId('lesson-sheet-confirm'));

beforeEach(() => {
  push.mockReset();
  __resetSessionExpiryForTests();
  __resetViewerForTests();
  window.history.replaceState(null, '', '/coaches/ivan-petrov');
});

describe('choosing a lesson', () => {
  it('the venue, the sport and length where there is a choice, 14 days, and the times with the whole price', () => {
    api();
    mount();

    expect(screen.getByRole('heading', { level: 2, name: l.title })).toBeVisible();
    expect(screen.getByTestId('lesson-venue')).toHaveTextContent('Алфа Кортове · Клуб Алфа');
    // One venue: nothing to choose between.
    expect(screen.queryByRole('radiogroup', { name: l.venueLabel })).toBeNull();
    expect(
      within(screen.getByRole('radiogroup', { name: l.sportLabel }))
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Тенис', 'Падел']);
    expect(
      within(screen.getByRole('radiogroup', { name: l.lengthLabel }))
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['60 мин', '120 мин']);
    expect(
      within(screen.getByRole('radiogroup', { name: v.day.label })).getAllByRole('radio'),
    ).toHaveLength(14);

    // Each time with the price for one player: the coach's 40 and the court's 24.
    expect(
      within(screen.getByRole('group', { name: l.timesLabel }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      expect.stringMatching(/^09:00 · 64\s€$/),
      expect.stringMatching(/^10:00 · 64\s€$/),
      expect.stringMatching(/^18:00 · 64\s€$/),
    ]);
    expect(screen.getByTestId('lesson-price-note')).toHaveTextContent(/40\s€ за треньора/);
    // Nothing picked: the button waits.
    expect(screen.getByTestId('lesson-book')).toBeDisabled();
    expect(screen.getByText(l.prompt)).toBeVisible();
  });

  it('a coach with one sport and one length there offers neither choice', () => {
    api();
    mount({
      venues: [beta],
      pick: { ...FIRST, linkId: 'l2', sport: 'PADEL', minutes: 90 },
      seed: times({ linkId: 'l2', minutes: 90 }),
    });
    expect(screen.queryByRole('radiogroup', { name: l.sportLabel })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: l.lengthLabel })).toBeNull();
  });

  it('each choice asks for its own times: the sport, the length, the day', async () => {
    const calls = api(undefined, (q) =>
      times({
        minutes: Number(q.get('minutes')),
        times: q.get('sport') === 'PADEL' ? [] : times().times,
      }),
    );
    mount();

    fireEvent.click(screen.getByRole('radio', { name: 'Падел' }));
    expect(await screen.findByTestId('lesson-times-none')).toHaveTextContent(l.none);
    fireEvent.click(screen.getByRole('radio', { name: 'Тенис' }));
    await screen.findByRole('group', { name: l.timesLabel });
    fireEvent.click(screen.getByRole('radio', { name: '120 мин' }));
    fireEvent.click(screen.getByRole('radio', { name: v.day.tomorrow }));

    await waitFor(() =>
      expect(
        reads(calls).some((c) => {
          const q = new URL(c.url, 'http://t').searchParams;
          return q.get('minutes') === '120' && q.get('date') === DAYS[1];
        }),
      ).toBe(true),
    );
    const asked = reads(calls).map((c) => {
      const q = new URL(c.url, 'http://t');
      return [q.pathname, q.searchParams.get('linkId'), q.searchParams.get('sport')];
    });
    expect(asked[0]).toEqual(['/api/v1/coaches/ivan-petrov/lesson-times', 'l1', 'PADEL']);
  });

  it('another venue keeps what it also offers and takes its own for the rest', async () => {
    const calls = api(undefined, (q) =>
      times({ linkId: q.get('linkId')!, minutes: Number(q.get('minutes')) }),
    );
    mount({ venues: [alfa, beta] });
    fireEvent.click(screen.getByRole('radio', { name: 'Падел' }));
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: l.venueLabel })).getByRole('radio', {
        name: 'Бета Арена',
      }),
    );

    expect(screen.getByTestId('lesson-venue')).toHaveTextContent('Бета Арена · Клуб Бета');
    await waitFor(() => {
      const last = new URL(reads(calls).at(-1)!.url, 'http://t').searchParams;
      // Padel is taught at both; Beta's only length is 90.
      expect([last.get('linkId'), last.get('sport'), last.get('minutes')]).toEqual([
        'l2',
        'PADEL',
        '90',
      ]);
    });
  });

  it('does not offer a time that has already started', () => {
    api();
    mount({ renderedAt: AT(9, 30) });
    expect(screen.queryByRole('button', { name: /^09:00/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^10:00/ })).toBeVisible();
  });

  it('keeps the choice and the pick in the URL, so a reload keeps them', () => {
    api();
    mount();
    expect(window.location.search).toBe(`?at=l1&day=${DAYS[0]}&min=60&sport=TENNIS`);
    pickTen();
    expect(window.location.search).toBe(
      `?at=l1&day=${DAYS[0]}&min=60&sport=TENNIS&start=${encodeURIComponent(AT(10))}`,
    );
    expect(screen.getByTestId('lesson-pick')).toHaveTextContent(/^Урок · пн, 14\.07, 10:00$/);
    expect(screen.getByTestId('lesson-book')).toBeEnabled();
  });
});

describe('who is looking', () => {
  it.each([
    ['signed-out', '/login'],
    ['undecided', KIND_CHOOSER_PATH],
    ['no-phone', PHONE_STEP_PATH],
  ] as const)(
    '%s: «Запиши урок» leads to %s and back to this time with the sheet open',
    (viewer, first) => {
      api();
      mount({ viewer });
      pickTen();
      fireEvent.click(screen.getByTestId('lesson-book'));
      const back = `/coaches/ivan-petrov?at=l1&day=${DAYS[0]}&min=60&sport=TENNIS&start=${encodeURIComponent(AT(10))}&confirm=1`;
      expect(push).toHaveBeenCalledWith(`${first}?next=${encodeURIComponent(back)}`);
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it('back from sign-in, the sheet is open on the time that was picked', async () => {
    api();
    mount({ pick: { ...FIRST, start: AT(10), confirm: true } });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/10:00–11:00/)).toBeVisible();
  });

  it('a club account is told it cannot book, and the button stays off', () => {
    api();
    mount({ viewer: 'club' });
    pickTen();
    expect(screen.getByText(l.clubAccount)).toBeVisible();
    expect(screen.getByTestId('lesson-book')).toBeDisabled();
  });

  it('the coach on their own page sees it as players do, and cannot book with themself', () => {
    api();
    mount({ own: true, pick: { ...FIRST, start: AT(10), confirm: true } });
    expect(screen.getByText(l.own)).toBeVisible();
    expect(screen.getByTestId('lesson-book')).toBeDisabled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the confirmation sheet', () => {
  it('says who, where, when, on which court, and the price in its two parts and in all', async () => {
    api();
    // Four days ahead, so the deadline is still to come.
    mount({ renderedAt: '2036-07-10T12:00:00Z' });
    const dialog = await openSheet();

    // The sheet names itself (once for assistive tech, once in its header).
    expect(within(dialog).getAllByRole('heading', { name: l.sheet.title }).length).toBeGreaterThan(
      0,
    );
    const text = dialog.textContent!;
    for (const part of [
      'Иван Петров',
      'Алфа Кортове',
      'Корт 1 · Тенис',
      'понеделник, 14 юли',
      '10:00–11:00',
      '60 мин',
    ]) {
      expect(text).toContain(part);
    }
    const price = within(dialog).getByTestId('lesson-sheet-price');
    expect(price).toHaveTextContent(/За треньора\s*40,00\s€/);
    expect(price).toHaveTextContent(/За корта\s*24,00\s€/);
    expect(within(dialog).getByTestId('lesson-sheet-total')).toHaveTextContent(/^64,00\s€$/);
    expect(within(dialog).getByText(l.sheet.payAtClub)).toBeVisible();
    // The deadline: 24 hours before the start, as the times said.
    expect(within(dialog).getByText(v.sheet.cancelUntilTitle)).toBeVisible();
    expect(text).toMatch(/до неделя, 13 юли.{0,6}10:00/);
  });

  it('a lesson inside the cutoff says it can only be cancelled through the club', async () => {
    // The coach asks for two days' notice; the club's day would not have been past.
    api(undefined, () => times({ cancelCutoffHours: 48 }));
    mount({ seed: times({ cancelCutoffHours: 48 }), renderedAt: '2036-07-12T15:00:00Z' });
    const dialog = await openSheet();
    // Rendered on the 12th at 18:00 there: the 14th at ten is 40 hours away.
    expect(within(dialog).getByText(v.sheet.noOnlineCancelTitle)).toBeVisible();
    expect(dialog.textContent).toContain('до 48 часа преди началото');
    expect(within(dialog).queryByText(v.sheet.cancelUntilTitle)).toBeNull();
  });

  it('one confirm is one POST, carrying the total that was shown, and leads to Резервации', async () => {
    const calls = api();
    mount();
    const dialog = await openSheet();
    confirmIn(dialog);
    confirmIn(dialog);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/me/bookings'));
    expect(posts(calls)).toHaveLength(1);
    const post = posts(calls)[0]!;
    expect(post.url).toBe('/api/v1/coaches/ivan-petrov/lessons');
    expect(post.body).toEqual({
      linkId: 'l1',
      startTs: AT(10),
      minutes: 60,
      sport: 'TENNIS',
      expectedTotalCents: 6400,
    });
    expect(post.headers['idempotency-key']).toMatch(/\S{8,}/);
    expect(post.headers['x-playerz-viewer']).toBe('u1');
  });

  it.each([
    ['COACH_TAKEN', 409, l.sheet.error.coachTakenTitle, l.sheet.error.coachTaken],
    ['SLOT_TAKEN', 409, l.sheet.error.noCourtTitle, l.sheet.error.noCourt],
    ['LESSON_TIME_NOT_OFFERED', 409, l.sheet.error.notOfferedTitle, l.sheet.error.notOffered],
    ['SLOT_NOT_BOOKABLE', 400, l.sheet.error.notOfferedTitle, l.sheet.error.notOffered],
  ])(
    '%s: says which went, refreshes the times, and offers to pick another',
    async (code, status, title, body) => {
      const calls = api(() => fail(status, code));
      mount();
      const dialog = await openSheet();
      const before = reads(calls).length;
      confirmIn(dialog);

      expect(await within(dialog).findByText(title)).toBeVisible();
      expect(within(dialog).getByText(body)).toBeVisible();
      await waitFor(() => expect(reads(calls).length).toBeGreaterThan(before));
      // No confirming the same thing again.
      expect(within(dialog).queryByTestId('lesson-sheet-confirm')).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: v.sheet.pickAnother }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByText(l.prompt)).toBeVisible();
      expect(push).not.toHaveBeenCalled();
    },
  );

  it('LESSON_PRICE_CHANGED: says the new price, and books nothing', async () => {
    api(() => ({
      status: 409,
      body: {
        error: {
          code: 'LESSON_PRICE_CHANGED',
          message: 'x',
          requestId: 'r',
          details: { totalCents: 7000 },
        },
      },
    }));
    mount();
    const dialog = await openSheet();
    confirmIn(dialog);
    expect(await within(dialog).findByText(l.sheet.error.priceChangedTitle)).toBeVisible();
    expect(dialog.textContent).toMatch(/урокът струва 70,00\s€/);
    expect(within(dialog).queryByTestId('lesson-sheet-confirm')).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it.each([
    ['COACH_NOT_BOOKABLE', 404, l.sheet.error.notBookable],
    ['OWN_LESSON', 400, l.sheet.error.ownLesson],
  ])('%s: final, with no way to confirm again', async (code, status, body) => {
    api(() => fail(status, code));
    mount();
    const dialog = await openSheet();
    confirmIn(dialog);
    expect(await within(dialog).findByText(body)).toBeVisible();
    expect(within(dialog).queryByTestId('lesson-sheet-confirm')).toBeNull();
    expect(within(dialog).getByRole('button', { name: v.sheet.back })).toBeVisible();
  });

  it('the cap and the no-show block read as they do for a court booking', async () => {
    api(() => ({
      status: 409,
      body: {
        error: {
          code: 'BOOKING_LIMIT_REACHED',
          message: 'x',
          requestId: 'r',
          details: { limit: 3, upcoming: 3 },
        },
      },
    }));
    mount();
    const dialog = await openSheet();
    confirmIn(dialog);
    expect(await within(dialog).findByText(v.sheet.error.limitTitle)).toBeVisible();
    expect(dialog.textContent).toContain('Имате 3 предстоящи резервации в този клуб (максимум 3)');
  });

  it('a dropped connection: confirming again re-sends the same key, so nothing is booked twice', async () => {
    let n = 0;
    const calls = api(() => (++n === 1 ? fail(500, 'INTERNAL') : ok({ id: 'bk1' }, 200)));
    mount();
    const dialog = await openSheet();
    confirmIn(dialog);
    expect(await within(dialog).findByText(l.sheet.error.failedTitle)).toBeVisible();
    confirmIn(dialog);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/me/bookings'));
    const keys = posts(calls).map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('a session that ended: sign in and come back to this lesson', async () => {
    api(() => fail(401, 'UNAUTHORIZED'));
    mount();
    const dialog = await openSheet();
    confirmIn(dialog);
    const link = await within(dialog).findByRole('link', { name: v.sheet.signIn });
    expect(link.getAttribute('href')).toBe(
      `/login?next=${encodeURIComponent(
        `/coaches/ivan-petrov?at=l1&day=${DAYS[0]}&min=60&sport=TENNIS&start=${encodeURIComponent(AT(10))}&confirm=1`,
      )}`,
    );
    expect(within(dialog).getByText(l.sheet.error.signedOut)).toBeVisible();
  });
});
