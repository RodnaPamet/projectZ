import { render } from '@testing-library/react';
import * as React from 'react';

import {
  DataTable,
  VIRTUALIZE_DEFAULT_THRESHOLD,
  createColumns,
  decideVirtualization,
} from '@/components/ui/table';

import { withIntl } from '../helpers/intl';

/**
 * `onReachEnd` on the virtualised path, on react-table v9 (T21).
 *
 * `onReachEnd` used to reach only the non-virtualised `<Table>`, which drives
 * it with an `<InfiniteScrollSentinel>` in its scroll wrapper. Load-on-scroll
 * is exactly what carries a list ACROSS the virtualisation threshold — a
 * batch at a time until it passes VIRTUALIZE_DEFAULT_THRESHOLD and swaps to
 * `<VirtualTable>` mid-session — and at that moment loading silently stopped.
 * The sentinel cannot move across: react-window positions rows absolutely in
 * a sized inner element, so a sentinel appended to the scroller sits at the
 * TOP of the content and would fire forever. The virtual path reads
 * react-window's reported visible range instead (inflect #103, upstreamed with
 * playerz's react-window 2 port by T04).
 *
 * jsdom has no layout and the ResizeObserver never fires, so every render
 * passes `virtualHeight`: `<VirtualTable>` forwards it to react-window's
 * `defaultHeight`, the pre-measurement viewport. Without it the list thinks it
 * is 0px tall and renders only its overscan.
 */

type Booking = { id: string; court: string; player: string };

const ROW_HEIGHT = 44;

function makeRows(n: number): Booking[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `b${i}`,
    court: `Корт ${(i % 4) + 1}`,
    player: `Играч ${i}`,
  }));
}

const COLUMNS = createColumns<Booking>([
  { accessorKey: 'court', header: 'Корт' },
  { accessorKey: 'player', header: 'Играч' },
]);

type Props = Partial<React.ComponentProps<typeof DataTable<Booking>>>;

function table(props: Props = {}) {
  return withIntl(
    <DataTable<Booking>
      data={makeRows(150)}
      columns={COLUMNS}
      getRowId={(r) => r.id}
      virtualHeight={600}
      selectionEnabled={false}
      virtualize
      {...props}
    />,
  );
}

describe('decideVirtualization', () => {
  it('engages one row past the default threshold, not at it', () => {
    expect(decideVirtualization(undefined, VIRTUALIZE_DEFAULT_THRESHOLD)).toBe(false);
    expect(decideVirtualization(undefined, VIRTUALIZE_DEFAULT_THRESHOLD + 1)).toBe(true);
  });
});

describe('DataTable — onReachEnd on the virtualised path', () => {
  it('fires when the windowed viewport reaches the end of the data', () => {
    const onReachEnd = jest.fn();
    // 12 rows at 44px inside a 600px viewport: the whole list is within
    // VIRTUAL_REACH_END_ROW_MARGIN of the last row.
    render(table({ data: makeRows(12), onReachEnd }));
    expect(onReachEnd).toHaveBeenCalledTimes(1);
  });

  it('fires past the DEFAULT threshold, with no virtualize prop at all', () => {
    // The path a real list takes: auto-virtualised by row count, not forced.
    // Every other case here forces `virtualize`, so they would all keep
    // passing if the threshold arm of decideVirtualization broke. The
    // viewport holds all 1,001 rows, so the window genuinely reaches the last
    // row instead of a scroll being simulated.
    const onReachEnd = jest.fn();
    const n = VIRTUALIZE_DEFAULT_THRESHOLD + 1;
    const { container } = render(
      table({
        data: makeRows(n),
        virtualize: undefined,
        virtualHeight: n * ROW_HEIGHT,
        onReachEnd,
      }),
    );

    // It really did auto-virtualise — otherwise this would be the plain
    // <table> and the sentinel, a different mechanism.
    expect(container.querySelector('[data-virtual-table]')).toBeInTheDocument();
    expect(container.querySelector('table')).toBeNull();
    expect(onReachEnd).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire while the end is still far below the viewport', () => {
    const onReachEnd = jest.fn();
    // 150 rows, ~14 visible from the top: nowhere near the last row.
    render(table({ data: makeRows(150), onReachEnd }));
    expect(onReachEnd).not.toHaveBeenCalled();
  });

  it('fires at most once per row count, and re-arms when rows are appended', () => {
    const onReachEnd = jest.fn();
    const { rerender } = render(table({ data: makeRows(12), onReachEnd }));
    expect(onReachEnd).toHaveBeenCalledTimes(1);

    // react-window re-reports its range on every window change, so without
    // the row-count latch a user parked at the bottom would re-fire on each
    // nudge. The SAME rows again must not produce a second call.
    rerender(table({ data: makeRows(12), onReachEnd }));
    expect(onReachEnd).toHaveBeenCalledTimes(1);

    // A load that APPENDS changes the count and unlatches the guard —
    // otherwise loading would stop dead after one batch.
    rerender(table({ data: makeRows(14), onReachEnd }));
    expect(onReachEnd).toHaveBeenCalledTimes(2);
  });
});
