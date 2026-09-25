import { render, screen } from '@testing-library/react';
import * as React from 'react';

import { VirtualizedList, type VirtualizedListHandle } from '@/components/ui/virtualized-list';

/**
 * THE PRIMITIVE HAD NO TESTS AT ALL BEFORE THE react-window 2.x MIGRATION.
 *
 * That is the only reason the migration was risky: react-window 2 deleted
 * every symbol the old implementation imported — `FixedSizeList`,
 * `VariableSizeList`, `ListChildComponentProps` — and replaced the
 * children-as-component contract, the sizing props, and the entire
 * imperative handle. A rewrite that large against zero assertions is not a
 * migration, it is a hope.
 *
 * So these tests describe the primitive's PUBLIC contract, which the
 * migration deliberately kept identical. They are written to pass on the
 * v1 implementation too — the point is that they cannot tell which engine
 * is underneath, only that the contract holds.
 *
 * ═══ WHY AN EXPLICIT `height` IS IN EVERY CASE ═══
 *
 * jsdom has no layout engine: every element measures 0×0, and a windowing
 * list told it has 0px of viewport correctly renders zero rows. react-window
 * reads a NUMERIC `style.height` directly and skips its ResizeObserver
 * entirely, which is what makes these deterministic rather than flaky.
 * Without the explicit height each assertion below would be vacuously true.
 */

const ROW_HEIGHT = 20;
const VIEWPORT = 100;

function renderList(props: Partial<React.ComponentProps<typeof VirtualizedList>> = {}) {
  return render(
    <VirtualizedList
      itemCount={1000}
      itemSize={ROW_HEIGHT}
      height={VIEWPORT}
      width={300}
      data-testid="list"
      renderItem={({ index, style }) => (
        <div style={style} data-testid={`row-${index}`}>
          item {index}
        </div>
      )}
      {...props}
    />,
  );
}

/** Row indices currently in the DOM, ascending. */
const renderedIndices = () =>
  Array.from(document.querySelectorAll('[data-testid^="row-"]'))
    .map((el) => Number(el.getAttribute('data-testid')!.replace('row-', '')))
    .sort((a, b) => a - b);

describe('VirtualizedList', () => {
  it('renders a window of rows, not all 1000 of them', () => {
    renderList();

    const indices = renderedIndices();

    // The whole point of the primitive. A naive list would mount 1000 rows;
    // 100px of viewport at 20px a row is 5 visible, plus overscan.
    //
    // The LOWER bound is the load-bearing half and it is deliberately tied to
    // the viewport: `> 0` looked fine and proved almost nothing, because
    // react-window still renders its overscan rows when it believes the
    // viewport is 0px tall. A list that had silently collapsed to zero height
    // — the exact failure mode of losing the explicit height passthrough —
    // rendered 3 rows and sailed through.
    expect(indices.length).toBeGreaterThanOrEqual(VIEWPORT / ROW_HEIGHT);
    expect(indices.length).toBeLessThan(30);

    // ...and it must be the rows at the TOP, not an arbitrary slice.
    expect(screen.getByTestId('row-0')).toBeInTheDocument();
    expect(screen.queryByTestId('row-999')).not.toBeInTheDocument();
  });

  it('gives every row the absolute-positioning style its contract promises', () => {
    // `renderItem` is documented as "spread `style` onto the outer element"
    // — if that style stopped carrying a position the rows would stack in
    // flow and the list would be 20,000px tall instead of 100px.
    renderList();

    const row = screen.getByTestId('row-3');
    expect(row).toHaveStyle({ position: 'absolute' });
  });

  it('renders the number of items it is told to, when that is fewer than a screenful', () => {
    // Guards the off-by-one at the other end: a list of 3 must not render
    // phantom rows 3..N because the viewport has room for them.
    renderList({ itemCount: 3 });

    expect(renderedIndices()).toEqual([0, 1, 2]);
  });

  it('renders nothing, and does not throw, for an empty list', () => {
    // The combobox hits this every time a filter matches no options.
    renderList({ itemCount: 0 });

    expect(renderedIndices()).toEqual([]);
  });

  it('accepts a per-index size function for variable-height rows', () => {
    // v1 routed this to a different COMPONENT (`VariableSizeList`); v2 takes
    // a function for `rowHeight` on the one `List`. Callers see neither.
    const itemSize = jest.fn((index: number) => (index % 2 === 0 ? 20 : 40));

    renderList({ itemSize, itemCount: 10 });

    expect(itemSize).toHaveBeenCalled();
    // Row 0 is 20px, row 1 is 40px — so row 1 sits at y=20 and row 2 at y=60.
    // Asserting the OFFSET proves the sizes were actually used for layout
    // rather than merely requested.
    expect(screen.getByTestId('row-2')).toHaveStyle({ transform: 'translateY(60px)' });
  });

  it('forwards aria-label and data-testid to the wrapper', () => {
    renderList({ 'aria-label': 'Опции' });

    expect(screen.getByTestId('list')).toHaveAttribute('aria-label', 'Опции');
  });

  it('exposes the scroller as a list by default', () => {
    // react-window 2 puts role="list" on its scroller; v1 set no role at
    // all. For a plain scrolling list that default is an improvement.
    renderList({ itemCount: 7 });

    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  it('lets a consumer erase that role when it owns its own semantics', () => {
    // This is not a preference, it is valid-ARIA plumbing. The combobox
    // renders this inside `role="listbox"` with `role="option"` rows; a
    // `list` in between is invalid and breaks the "N options" count screen
    // readers announce. v1 had no role to collide with, so the migration
    // introduced the hazard and has to hand consumers the way out.
    renderList({ itemCount: 7, role: 'presentation' });

    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('does NOT put react-window ARIA on the rows the consumer renders', () => {
    // `renderItem` owns the row element, so the row's semantics are the
    // consumer's to choose — the combobox needs `option`, not `listitem`.
    // If the wrapper ever started forwarding react-window's ariaAttributes,
    // every combobox option would announce as a plain list item.
    renderList({ itemCount: 7 });

    expect(screen.getByTestId('row-0')).not.toHaveAttribute('role');
    expect(screen.getByTestId('row-0')).not.toHaveAttribute('aria-posinset');
  });

  describe('the imperative handle', () => {
    /**
     * The handle's SHAPE is load-bearing: `virtualized-options.tsx` calls
     * all three methods, and react-window 2 renamed or deleted all three
     * underneath. These assert the wrapper still presents the v1 surface.
     */
    it('exposes scrollToItem, scrollTo and resetAfterIndex', () => {
      const ref = React.createRef<VirtualizedListHandle>();
      renderList({ ref } as never);

      expect(typeof ref.current?.scrollToItem).toBe('function');
      expect(typeof ref.current?.scrollTo).toBe('function');
      expect(typeof ref.current?.resetAfterIndex).toBe('function');
    });

    it('survives scrollToItem for an index outside the list', () => {
      // react-window 2 throws a RangeError rather than clamping, and the
      // combobox scrolls to its active index while the option list is being
      // filtered underneath it — so this fires in normal use. An exception
      // from that effect would take the whole panel down.
      const ref = React.createRef<VirtualizedListHandle>();
      renderList({ ref, itemCount: 5 } as never);

      expect(() => ref.current!.scrollToItem(99)).not.toThrow();
      expect(() => ref.current!.scrollToItem(-1)).not.toThrow();
    });

    it('re-measures rows after resetAfterIndex', () => {
      // v1 had `VariableSizeList.resetAfterIndex`, which dropped the cached
      // offsets. v2 has no imperative equivalent — it re-derives sizes when
      // `rowProps` identity changes — so the wrapper reimplements it by
      // bumping an epoch. If that wiring breaks, sizes silently stay stale
      // and rows overlap; this is the only thing that would notice.
      const ref = React.createRef<VirtualizedListHandle>();
      const itemSize = jest.fn(() => 20);

      renderList({ ref, itemSize, itemCount: 10 } as never);
      const before = itemSize.mock.calls.length;
      expect(before).toBeGreaterThan(0);

      React.act(() => {
        ref.current!.resetAfterIndex(0);
      });

      expect(itemSize.mock.calls.length).toBeGreaterThan(before);
    });
  });
});
