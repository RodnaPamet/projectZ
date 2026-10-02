import { render, screen, within } from '@testing-library/react';
import * as React from 'react';

import { createColumns, useTable } from '@/components/ui/table';
import { VirtualTable } from '@/components/ui/table/virtual-table-body';

import { messages, withIntl } from '../helpers/intl';

/**
 * THE STRUCTURE CHANGED, SO THE STRUCTURE IS WHAT THIS ASSERTS.
 *
 * react-window 1 let this component inject its sticky header through
 * `outerElementType`, which put the header INSIDE the scroll container with
 * the absolutely-positioned rows in an inner element below it.
 *
 * v2 deleted that prop and has no replacement: its `List` IS the scroller,
 * rows are positioned against it, and its `children` render as an overlay
 * ON TOP of row 0 rather than above it in flow. So the header had to move
 * out and become a flex sibling of the list.
 *
 * These are the assertions that make that layout checkable rather than
 * plausible: the header and the rows must both exist, must be siblings under
 * one horizontally-scrolling region, and must share a column template —
 * because "header and body columns drift apart" is the exact failure this
 * restructure could cause and the only one a screenshot would have caught.
 *
 * react-table v9 (T21): the harness builds its instance through the
 * platform's own `useTable` + `createColumns` rather than calling the library
 * directly. v9 dropped `useReactTable`/`getCoreRowModel` and made the feature
 * set the first type parameter of `ColumnDef`, so a bare-library harness
 * would need `dataTableFeatures` spelled out here — the platform hook is what
 * every real list builds on anyway, and it is how inflect's copy of this
 * suite does it.
 *
 * As in virtualized-list.test.tsx, the explicit `height` is mandatory: jsdom
 * measures every box as 0×0 and the ResizeObserver never fires, so a
 * windowing list left to measure itself sees a 0px viewport and renders only
 * its overscan. `<VirtualTable>` forwards the explicit height to
 * react-window's `defaultHeight`, so the row-count bounds below are tied to
 * the viewport rather than to zero.
 */

type Row = { id: string; name: string; city: string };

const ROW_HEIGHT = 44;
const VIEWPORT = 440;

const DATA: Row[] = Array.from({ length: 200 }, (_, i) => ({
  id: String(i),
  name: `Играч ${i}`,
  city: i % 2 === 0 ? 'София' : 'Пловдив',
}));

const COLUMNS = createColumns<Row>([
  { id: 'name', accessorKey: 'name', header: 'Име' },
  { id: 'city', accessorKey: 'city', header: 'Град' },
]);

function Harness({
  data = DATA,
  height = VIEWPORT,
  ...rest
}: { data?: Row[]; height?: number } & Partial<React.ComponentProps<typeof VirtualTable<Row>>>) {
  const { table } = useTable<Row>({
    data,
    columns: COLUMNS,
    getRowId: (r) => r.id,
    // The select column is default-on in the platform and would add a third
    // grid track. These tests read the column template, so the fixture opts
    // out at the INSTANCE: the column comes from `useTable`, and
    // `selectionEnabled` on `<VirtualTable>` alone only changes the click
    // semantics.
    selectionEnabled: false,
  });

  return (
    <VirtualTable<Row>
      table={table}
      height={height}
      selectionEnabled={false}
      data-testid="vt"
      {...rest}
    />
  );
}

const renderTable = (props: Partial<React.ComponentProps<typeof Harness>> = {}) =>
  render(withIntl(<Harness {...props} />));

const bodyRows = () => document.querySelectorAll('[data-virtual-row-index]');

describe('VirtualTable — windowing', () => {
  it('renders a window of rows, not all 200', () => {
    renderTable();

    const count = bodyRows().length;
    // 440px of viewport at 44px a row is 10 visible, plus overscan. The LOWER
    // bound is the load-bearing half: a list collapsed to a 0px viewport
    // still renders its overscan, so `> 0` would pass on exactly the failure
    // this pins.
    expect(count).toBeGreaterThanOrEqual(VIEWPORT / ROW_HEIGHT);
    expect(count).toBeLessThan(40);
  });

  it('renders cell content for the rows in the window', () => {
    // Guards against a correctly-sized but empty grid — the failure mode
    // where the list mounts and every row is blank.
    renderTable();

    expect(screen.getByText('Играч 0')).toBeInTheDocument();
    expect(screen.queryByText('Играч 199')).not.toBeInTheDocument();
  });

  it('renders no rows, and does not throw, for an empty table', () => {
    renderTable({ data: [] });

    expect(bodyRows()).toHaveLength(0);
    // The header still renders — an empty table must keep its columns.
    expect(screen.getByText('Име')).toBeInTheDocument();
  });
});

describe('VirtualTable — the header is a sibling of the list', () => {
  it('renders the header and the windowed rows as siblings of one region', () => {
    // Under v1 the header lived inside react-window's own scroll element; it
    // now sits beside the list in a flex column. If a future change puts it
    // back inside the List it would paint on top of row 0 — so "same parent,
    // header first" is the thing worth pinning, not the class names.
    renderTable();

    const region = screen.getByRole('region');
    const header = within(region).getByRole('rowgroup', { hidden: true });
    const list = within(region).getByRole('list');

    expect(header.parentElement).toBe(region);
    expect(list.parentElement).toBe(region);
    // Document order decides which paints above the other.
    expect(header.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('gives the header and every body row the SAME column template', () => {
    // Columns are aligned by nothing but this string being identical in both
    // places; header and body are two independent subtrees, so drift is
    // possible.
    renderTable();

    const header = screen.getByRole('rowgroup', { hidden: true });
    const headerTemplate = header.style.gridTemplateColumns;
    expect(headerTemplate).toBeTruthy();

    const rows = Array.from(bodyRows()) as HTMLElement[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.style.gridTemplateColumns).toBe(headerTemplate);
    }
  });

  it('renders the column headers as text', () => {
    renderTable();

    expect(screen.getByText('Име')).toBeInTheDocument();
    expect(screen.getByText('Град')).toBeInTheDocument();
  });
});

describe('VirtualTable — preserved contract', () => {
  it('keeps the scroll region keyboard reachable and labelled', () => {
    // The scroller is the focusable element, so a keyboard user can scroll
    // the body without a mouse. The restructure moved which element carries
    // this, which is exactly when it gets dropped by accident.
    renderTable();

    const region = screen.getByRole('region');
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveAccessibleName();
  });

  it('takes its accessible name from the common.table catalogue by default', () => {
    renderTable();

    expect(screen.getByRole('region')).toHaveAccessibleName(messages.common.table.tableContents);
  });

  it('forwards an explicit aria-label over the catalogue default', () => {
    renderTable({ 'aria-label': 'Играчи в прозорец' });

    expect(screen.getByRole('region')).toHaveAccessibleName('Играчи в прозорец');
  });

  it('forwards data-testid to the outer wrapper', () => {
    renderTable();

    expect(screen.getByTestId('vt')).toHaveAttribute('data-virtual-table', '');
  });
});
