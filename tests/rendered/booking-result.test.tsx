import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { BookingResult } from '@/app/(public)/me/bookings/[id]/BookingResult';
import type { BookingResultDto, ResultViewDto } from '@/components/results/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * #575: «Резултат» on a player's booking, against the REAL Bulgarian catalogue
 * and a fake v1. Reporting (sides and sets), waiting, answering (confirm, or
 * dispute with a note for the club), a refusal, and nothing at all for a
 * booking that cannot have a result.
 */
const r = messages.myBookings.result;
const results = messages.results;

const PLAYERS = [
  { userId: 'u_ana', name: 'Ана' },
  { userId: 'u_boris', name: 'Борис' },
  { userId: 'u_cveta', name: 'Цвета' },
  { userId: 'u_dimo', name: 'Димо' },
];

const state = (over: Partial<BookingResultDto> = {}): BookingResultDto => ({
  result: null,
  canReport: true,
  reportableUntil: '2026-10-21T17:00:00Z',
  format: 'PERIODS',
  players: PLAYERS,
  ...over,
});

const reported = (over: Partial<ResultViewDto> = {}): ResultViewDto => ({
  id: 'rp1',
  status: 'REPORTED',
  sides: [PLAYERS.slice(0, 2), PLAYERS.slice(2)],
  score: [
    [6, 4],
    [6, 3],
  ],
  winnerSide: 0,
  reportedByMe: false,
  reportedAt: '2026-10-14T18:00:00Z',
  autoConfirmAt: '2026-10-16T18:00:00Z',
  canAnswer: true,
  ...over,
});

function wrap(node: React.ReactNode) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), revalidateOnMount: false }}>
          <TooltipProvider>
            <ViewerScope viewerId="u_ana">{node}</ViewerScope>
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('a booking result', () => {
  it('nothing at all for a booking that cannot have one', () => {
    installFakeFetch(() => ok({}));
    wrap(<BookingResult bookingId="bk1" seed={state({ canReport: false })} />);
    expect(screen.queryByTestId('booking-result')).toBeNull();
  });

  it('reports the sides and the sets: the first half starts on side 1', async () => {
    const calls = installFakeFetch((c) =>
      c.method === 'POST'
        ? ok(
            state({
              canReport: false,
              reportableUntil: null,
              result: reported({ reportedByMe: true, canAnswer: false }),
            }),
            201,
          )
        : ok(state()),
    );
    wrap(<BookingResult bookingId="bk1" seed={state()} />);

    expect(screen.getByTestId('booking-result')).toHaveTextContent(r.report);
    fireEvent.click(screen.getByTestId('booking-result-report'));

    const rows = screen.getAllByTestId('result-editor-player');
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByRole('radio', { checked: true })).toHaveTextContent('Отбор 1');
    expect(within(rows[3]!).getByRole('radio', { checked: true })).toHaveTextContent('Отбор 2');

    for (const [cell, v] of [
      ['0-0', '6'],
      ['0-1', '4'],
      ['1-0', '6'],
      ['1-1', '3'],
    ] as const) {
      fireEvent.change(screen.getByTestId(`result-editor-cell-${cell}`), { target: { value: v } });
    }
    fireEvent.click(screen.getByTestId('result-editor-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('booking-result-status')).toHaveTextContent(
        results.status.REPORTED,
      ),
    );
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toMatch(/\/api\/v1\/me\/bookings\/bk1\/result$/);
    expect(post.body).toEqual({
      sides: [
        ['u_ana', 'u_boris'],
        ['u_cveta', 'u_dimo'],
      ],
      score: [
        [6, 4],
        [6, 3],
      ],
    });
    // The reporter waits; there is nothing for them to answer.
    expect(screen.queryByTestId('booking-result-confirm')).toBeNull();
  });

  it('an empty box is stopped before anything is sent', () => {
    const calls = installFakeFetch(() => ok(state()));
    wrap(<BookingResult bookingId="bk1" seed={state()} />);
    fireEvent.click(screen.getByTestId('booking-result-report'));
    fireEvent.change(screen.getByTestId('result-editor-cell-0-0'), { target: { value: '6' } });
    fireEvent.click(screen.getByTestId('result-editor-submit'));
    expect(screen.getByTestId('result-editor-problem')).toHaveTextContent(
      results.editor.problemScore,
    );
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it("the server's refusal is said in words", async () => {
    installFakeFetch((c) => (c.method === 'POST' ? fail(400, 'INVALID_SCORE') : ok(state())));
    wrap(<BookingResult bookingId="bk1" seed={state()} />);
    fireEvent.click(screen.getByTestId('booking-result-report'));
    for (const cell of ['0-0', '0-1', '1-0', '1-1']) {
      fireEvent.change(screen.getByTestId(`result-editor-cell-${cell}`), {
        target: { value: '6' },
      });
    }
    fireEvent.click(screen.getByTestId('result-editor-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('booking-result-error')).toHaveTextContent(
        results.error.INVALID_SCORE,
      ),
    );
  });

  it('the other side confirms it', async () => {
    const calls = installFakeFetch((c) =>
      c.method === 'POST'
        ? ok({ status: 'CONFIRMED' })
        : ok(
            state({
              canReport: false,
              result: reported({ status: 'CONFIRMED', canAnswer: false }),
            }),
          ),
    );
    wrap(<BookingResult bookingId="bk1" seed={state({ canReport: false, result: reported() })} />);

    expect(screen.getByTestId('result-summary')).toHaveTextContent('Ана и Борис');
    fireEvent.click(screen.getByTestId('booking-result-confirm'));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && /\/me\/results\/rp1\/confirm$/.test(c.url)),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByTestId('booking-result-status')).toHaveTextContent(
        results.status.CONFIRMED,
      ),
    );
  });

  it('…or disputes it, with a note for the club', async () => {
    const calls = installFakeFetch((c) =>
      c.method === 'POST'
        ? ok({ status: 'REJECTED' })
        : ok(
            state({ canReport: false, result: reported({ status: 'REJECTED', canAnswer: false }) }),
          ),
    );
    wrap(<BookingResult bookingId="bk1" seed={state({ canReport: false, result: reported() })} />);

    fireEvent.click(screen.getByTestId('booking-result-reject'));
    fireEvent.change(screen.getByLabelText(r.rejectNote), {
      target: { value: 'Вторият сет беше 4:6' },
    });
    fireEvent.click(screen.getByTestId('booking-result-reject-send'));

    await waitFor(() => expect(screen.getByText(r.withClub)).toBeInTheDocument());
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toMatch(/\/me\/results\/rp1\/reject$/);
    expect(post.body).toEqual({ note: 'Вторият сет беше 4:6' });
  });
});
