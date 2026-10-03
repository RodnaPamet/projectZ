import { fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';

import { DataTable, createColumns } from '@/components/ui/table/data-table';

import { withIntl } from '../helpers/intl';

/**
 * Below md a DataTable is a list of cards, and a card with a row action is a
 * keyboard button (T21's acceptance: "DataTable shows keyboard-operable cards
 * below md").
 *
 * The guardrail datatable-mobile-fallback.test.ts reads the source for the
 * markers; this renders the real component and presses the keys, so it would
 * also catch a card that carries the markers but loses them on the way to the
 * DOM (the v9 port moved the activation into a spread of `buttonLikeKeys`).
 *
 * jsdom has no viewport and `useIsBelowMd` resolves false there, so the hook
 * is pinned to true: the branch under test is the phone one.
 */
jest.mock('@/components/ui/hooks/use-is-below-md', () => ({ useIsBelowMd: () => true }));

type Booking = { id: string; court: string; player: string };

const ROWS: Booking[] = [
  { id: 'b1', court: 'Корт 1', player: 'Иван Петров' },
  { id: 'b2', court: 'Корт 2', player: 'Мария Димитрова' },
];

const COLUMNS = createColumns<Booking>([
  { accessorKey: 'court', header: 'Корт' },
  { accessorKey: 'player', header: 'Играч' },
]);

function renderCards(onRowClick?: (id: string) => void) {
  return render(
    withIntl(
      <DataTable<Booking>
        data={ROWS}
        columns={COLUMNS}
        getRowId={(r) => r.id}
        selectionEnabled={false}
        onRowClick={onRowClick ? (row) => onRowClick(row.original.id) : undefined}
      />,
    ),
  );
}

describe('DataTable below md', () => {
  it('renders cards, not a <table>', () => {
    renderCards(() => {});

    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getByText('Иван Петров')).toBeInTheDocument();
  });

  it('makes each clickable card a focusable button', () => {
    renderCards(() => {});

    const cards = within(screen.getByRole('list')).getAllByRole('button');
    expect(cards).toHaveLength(ROWS.length);
    for (const card of cards) {
      expect(card).toHaveAttribute('tabindex', '0');
      card.focus();
      expect(card).toHaveFocus();
    }
  });

  it('opens the row on Enter and on Space, and Space does not scroll', () => {
    const onRowClick = jest.fn();
    renderCards(onRowClick);
    const [first, second] = within(screen.getByRole('list')).getAllByRole('button');

    fireEvent.keyDown(first, { key: 'Enter' });
    expect(onRowClick).toHaveBeenLastCalledWith('b1');

    // fireEvent returns false when the handler called preventDefault — the
    // page must not scroll instead of opening the row.
    const notPrevented = fireEvent.keyDown(second, { key: ' ' });
    expect(notPrevented).toBe(false);
    expect(onRowClick).toHaveBeenLastCalledWith('b2');
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it('keeps a read-only card out of the tab order', () => {
    renderCards();

    const list = screen.getByRole('list');
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
    expect(within(list).getAllByRole('listitem')).toHaveLength(ROWS.length);
  });
});
