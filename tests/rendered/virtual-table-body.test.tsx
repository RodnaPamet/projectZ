import { render, screen, within } from '@testing-library/react';
import { useReactTable, getCoreRowModel, type ColumnDef } from '@tanstack/react-table';
import * as React from 'react';

import { VirtualTable } from '@/components/ui/table/virtual-table-body';

import { withIntl } from '../helpers/intl';

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
 * That is a layout rewrite of the one component in the table stack that had
 * no tests whatsoever. These are the assertions that make the rewrite
 * checkable rather than plausible: the header and the rows must both exist,
 * must be siblings under one horizontally-scrolling region, and must share
 * a column template — because "header and body columns drift apart" is the
 * exact failure this restructure could cause and the only one a screenshot
 * would have caught.
 *
 * As in virtualized-list.test.tsx, the explicit `height` is mandatory: jsdom
 * measures every box as 0×0, and a windowing list with a 0px viewport
 * correctly renders no rows at all.
 */

type Row = { id: string; name: string; city: string };

const DATA: Row[] = Array.from({ length: 200 }, (_, i) => ({
  id: String(i),
  name: `Играч ${i}`,
  city: i % 2 === 0 ? 'София' : 'Пловдив',
}));

const COLUMNS: ColumnDef<Row>[] = [
  { id: 'name', accessorKey: 'name', header: 'Име' },
  { id: 'city', accessorKey: 'city', header: 'Град' },
];

function Harness({ height = 200, ...rest }: { height?: number } & Record<string, unknown>) {
  const table = useReactTable({
    data: DATA,
    columns: COLUMNS,
    getCoreRowModel: getCoreRowModel(),
  });

  return <VirtualTable table={table} height={height} data-testid="vt" {...rest} />;
}

const renderTable = (props: Record<string, unknown> = {}) =>
  render(withIntl(<Harness {...props} />));

const bodyRows = () => document.querySelectorAll('[data-virtual-row-index]');

describe('VirtualTable', () => {
  it('renders a window of rows, not all 200', () => {
    renderTable();

    const count = bodyRows().length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(40);
  });

  it('renders the header and the windowed rows as siblings of one region', () => {
    // The heart of the restructure. Under v1 the header lived inside
    // react-window's own scroll element; it now sits beside the list in a
    // flex column. If a future change puts it back inside the List it would
    // paint on top of row 0 — so "same parent, header first" is the thing
    // worth pinning, not the class names.
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
    // places. v1 guaranteed it by construction (one `gridTemplate` const
    // consumed by a component pair mounted together); after the restructure
    // they are two independent subtrees, so drift became possible.
    renderTable();

    const header = screen.getByRole('rowgroup', { hidden: true });
    const firstRow = bodyRows()[0] as HTMLElement;

    const headerTemplate = header.style.gridTemplateColumns;
    expect(headerTemplate).toBeTruthy();
    expect(firstRow.style.gridTemplateColumns).toBe(headerTemplate);
  });

  it('keeps the scroll region keyboard reachable and labelled', () => {
    // Preserved-from-`<Table>` contract: the scroller is the focusable
    // element, so a keyboard user can scroll the body without a mouse. The
    // restructure moved which element carries this, which is exactly when
    // it gets dropped by accident.
    renderTable();

    const region = screen.getByRole('region');
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveAccessibleName();
  });

  it('renders the column headers as text', () => {
    renderTable();

    expect(screen.getByText('Име')).toBeInTheDocument();
    expect(screen.getByText('Град')).toBeInTheDocument();
  });

  it('renders cell content for the rows in the window', () => {
    // Guards against the restructure rendering a correctly-sized but empty
    // grid — the failure mode where the list mounts and every row is blank.
    renderTable();

    expect(screen.getByText('Играч 0')).toBeInTheDocument();
    expect(screen.queryByText('Играч 199')).not.toBeInTheDocument();
  });

  it('renders no rows, and does not throw, for an empty table', () => {
    function EmptyHarness() {
      const table = useReactTable({
        data: [] as Row[],
        columns: COLUMNS,
        getCoreRowModel: getCoreRowModel(),
      });
      return <VirtualTable table={table} height={200} />;
    }

    render(withIntl(<EmptyHarness />));

    expect(bodyRows()).toHaveLength(0);
    // The header still renders — an empty table must keep its columns.
    expect(screen.getByText('Име')).toBeInTheDocument();
  });
});
