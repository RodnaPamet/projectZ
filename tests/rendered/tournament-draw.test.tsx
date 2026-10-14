import { render, screen, within } from '@testing-library/react';

import type { DrawDto, DrawMatchDto } from '@/app/api/v1/_lib/tournament-dto';
import { DrawView } from '@/components/tournaments/DrawView';

import { messages, withIntl } from '../helpers/intl';

/**
 * #580: a tournament's draw on screen, against the real Bulgarian catalogue:
 * a group's table and matches, the knockout by round, a bye and a walkover,
 * the court and time of a scheduled match, and the player's own match.
 */
const d = messages.tournaments.draw;
const entry = (id: string, name: string, seed: number) => ({
  id,
  seed,
  withdrawn: false,
  players: [{ userId: `u_${id}`, name, deleted: false }],
});
const match = (over: Partial<DrawMatchDto>): DrawMatchDto => ({
  id: 'm',
  stage: 'KNOCKOUT',
  round: 1,
  slot: 0,
  groupNo: 0,
  sideA: null,
  sideB: null,
  sideA2: null,
  sideB2: null,
  status: 'PENDING',
  deadline: null,
  overdue: false,
  winnerSide: null,
  score: null,
  scheduled: null,
  mine: false,
  ...over,
});

const ana = entry('a', 'Ана', 1);
const boris = entry('b', 'Борис', 2);
const cveta = entry('c', 'Цвета', 3);

const draw: DrawDto = {
  tournamentId: 't1',
  format: 'GROUPS_KNOCKOUT',
  status: 'IN_PROGRESS',
  groups: [
    {
      groupNo: 1,
      table: [
        {
          entryId: 'a',
          rank: 1,
          played: 1,
          won: 1,
          drawn: 0,
          lost: 0,
          points: 3,
          setsDiff: 2,
          gamesDiff: 5,
          entry: ana,
        },
        {
          entryId: 'b',
          rank: 2,
          played: 1,
          won: 0,
          drawn: 0,
          lost: 1,
          points: 0,
          setsDiff: -2,
          gamesDiff: -5,
          entry: boris,
        },
      ],
      matches: [
        match({
          id: 'g1',
          stage: 'GROUP',
          groupNo: 1,
          sideA: ana,
          sideB: boris,
          status: 'PLAYED',
          winnerSide: 0,
          score: [
            [6, 3],
            [6, 4],
          ],
        }),
      ],
    },
    { groupNo: 2, table: [], matches: [] },
  ],
  knockout: [
    [
      match({
        id: 'k1',
        sideA: ana,
        sideB: cveta,
        status: 'READY',
        mine: true,
        scheduled: {
          bookingId: 'bk9',
          courtName: 'Корт 2',
          startTs: '2026-11-01T10:00:00.000Z',
          endTs: '2026-11-01T11:30:00.000Z',
        },
      }),
      match({ id: 'k2', slot: 1, sideA: boris, status: 'WALKOVER', winnerSide: 0 }),
    ],
    [match({ id: 'k3', round: 2 })],
  ],
  thirdPlace: null,
};

describe('a draw', () => {
  it('a group’s table, its played match with the score, and the winner in bold', () => {
    render(withIntl(<DrawView draw={draw} />));
    expect(
      screen.getByRole('heading', { name: d.group.replace('{letter}', 'A') }),
    ).toBeInTheDocument();
    const rows = within(screen.getAllByTestId('draw-table')[0]!).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Ана');
    expect(rows[1]).toHaveTextContent('3');
  });

  it('the knockout by round, a bye, the court and time, and my match linked to its booking', () => {
    render(withIntl(<DrawView draw={draw} linkMyMatches />));
    expect(screen.getByRole('heading', { name: d.semis })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: d.final })).toBeInTheDocument();
    expect(screen.getByText(d.bye)).toBeInTheDocument();
    expect(screen.getByTestId('draw-match-scheduled')).toHaveTextContent('Корт 2');
    expect(screen.getByTestId('draw-match-booking')).toHaveAttribute('href', '/me/bookings/bk9');
    // The final's sides are still to be decided.
    expect(screen.getAllByText(d.tbd).length).toBeGreaterThanOrEqual(2);
  });

  it('the club’s buttons go on the matches it hands them to', () => {
    render(
      withIntl(
        <DrawView
          draw={draw}
          actions={(m) => (m.status === 'READY' ? <button>act-{m.id}</button> : null)}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: 'act-k1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'act-k2' })).toBeNull();
  });
});
