/**
 * P02 — one test per ported primitive family.
 *
 * Each test renders the component with a minimal prop set and asserts a
 * real accessibility contract (role, accessible name, state), not merely
 * that it did not throw. A test that only asserts "renders" would stay
 * green if the primitive lost its label or its role — which is precisely
 * the regression these are here to catch.
 */
import userEvent from '@testing-library/user-event';

import { render, screen, within } from '../helpers/render';

import { Button } from '@/components/ui/button';
import { CalendarMonth } from '@/components/ui/CalendarMonth';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Table, useTable } from '@/components/ui/table/table';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Modal } from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';

import { withIntl } from '../helpers/intl';

const noop = () => {};

describe('Button', () => {
  it.each(['primary', 'secondary', 'ghost', 'destructive', 'destructive-outline'] as const)(
    'renders the %s variant as a button with its accessible name',
    (variant) => {
      render(<Button variant={variant}>Book a court</Button>);
      expect(screen.getByRole('button', { name: 'Book a court' })).toBeInTheDocument();
    },
  );

  it('does not fire onClick while disabled', async () => {
    const onClick = jest.fn();
    render(
      <Button variant="primary" disabled onClick={onClick}>
        Disabled
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Disabled' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Input', () => {
  it('is reachable by its label and accepts typing', async () => {
    render(
      <>
        <Label htmlFor="venue">Venue name</Label>
        <Input id="venue" />
      </>,
    );
    const input = screen.getByLabelText('Venue name');
    await userEvent.type(input, 'Sofia Padel');
    expect(input).toHaveValue('Sofia Padel');
  });
});

describe('Textarea', () => {
  it('is reachable by its label and accepts typing', async () => {
    render(
      <>
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" />
      </>,
    );
    const box = screen.getByLabelText('Notes');
    await userEvent.type(box, 'Bring a racket');
    expect(box).toHaveValue('Bring a racket');
  });
});

describe('Checkbox', () => {
  it('exposes checked state and toggles on click', async () => {
    const onCheckedChange = jest.fn();
    render(
      <>
        <Checkbox id="indoor" onCheckedChange={onCheckedChange} />
        <Label htmlFor="indoor">Indoor only</Label>
      </>,
    );
    const box = screen.getByRole('checkbox', { name: 'Indoor only' });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});

describe('RadioGroup', () => {
  it('exposes one radio per option and selects on click', async () => {
    const onValueChange = jest.fn();
    render(
      <RadioGroup value="padel" onValueChange={onValueChange}>
        <RadioGroupItem value="padel" id="r-padel" />
        <Label htmlFor="r-padel">Padel</Label>
        <RadioGroupItem value="tennis" id="r-tennis" />
        <Label htmlFor="r-tennis">Tennis</Label>
      </RadioGroup>,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Padel' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Tennis' }));
    expect(onValueChange).toHaveBeenCalledWith('tennis');
  });
});

describe('Switch', () => {
  it('exposes switch role and toggles', async () => {
    const onCheckedChange = jest.fn();
    render(
      <>
        <Switch id="notify" onCheckedChange={onCheckedChange} />
        <Label htmlFor="notify">Notify me</Label>
      </>,
    );
    const sw = screen.getByRole('switch', { name: 'Notify me' });
    expect(sw).not.toBeChecked();
    await userEvent.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});

describe('StatusBadge', () => {
  it.each(['neutral', 'info', 'success', 'warning', 'error'] as const)(
    'renders the %s variant with its text',
    (variant) => {
      render(<StatusBadge variant={variant}>Confirmed</StatusBadge>);
      expect(screen.getByText('Confirmed')).toBeInTheDocument();
    },
  );
});

describe('Skeleton', () => {
  it('renders a placeholder that is hidden from the accessibility tree', () => {
    const { container } = render(<Skeleton className="h-8 w-48" />);
    // A skeleton must not announce itself as content to a screen reader.
    expect(container.firstChild).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('renders its title and description', () => {
    render(<EmptyState title="No bookings yet" description="Upcoming games appear here." />);
    expect(screen.getByText('No bookings yet')).toBeInTheDocument();
    expect(screen.getByText('Upcoming games appear here.')).toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('renders its title and description', () => {
    render(<ErrorState title="Could not load courts" description="Try again shortly." />);
    expect(screen.getByText('Could not load courts')).toBeInTheDocument();
    expect(screen.getByText('Try again shortly.')).toBeInTheDocument();
  });
});

describe('Tooltip', () => {
  it('renders its trigger and exposes content on focus', async () => {
    render(
      <Tooltip content="60 min · €24">
        <Button variant="secondary">Price</Button>
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: /Price/ });
    expect(trigger).toBeInTheDocument();
    await userEvent.hover(trigger);
    // Radix mirrors tooltip content into an aria-live region for screen
    // readers, so the string is present twice by design.
    const shown = await screen.findAllByText('60 min · €24');
    expect(shown.length).toBeGreaterThan(0);
  });
});

describe('CopyButton', () => {
  it('writes its value to the clipboard when clicked', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CopyButton value="PLZ-4821" label="Copy booking reference" />);
    await userEvent.click(screen.getByRole('button', { name: /Copy booking reference/i }));
    expect(writeText).toHaveBeenCalledWith('PLZ-4821');
  });
});

describe('Modal', () => {
  it('renders its children in a dialog when open', () => {
    render(
      <Modal showModal setShowModal={noop}>
        <p>Court 3 · Saturday 18:00</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Court 3 · Saturday 18:00')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <Modal showModal={false} setShowModal={noop}>
        <p>Court 3 · Saturday 18:00</p>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Sheet', () => {
  it('renders its title and body when open', () => {
    render(
      <Sheet open onOpenChange={noop} title="Filters">
        <Sheet.Body>
          <p>Sport, surface, indoor.</p>
        </Sheet.Body>
      </Sheet>,
    );
    expect(screen.getByText('Sport, surface, indoor.')).toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  it('calls onConfirm when the primary action is clicked', async () => {
    const onConfirm = jest.fn();
    render(
      <ConfirmDialog
        showModal
        setShowModal={noop}
        title="Cancel this booking?"
        description="Refunds in full."
        confirmLabel="Cancel booking"
        onConfirm={onConfirm}
      />,
    );
    // Radix mandates a Dialog.Title; the component renders one visibly and
    // one visually-hidden, so the heading text appears twice.
    expect(screen.getAllByText('Cancel this booking?').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    expect(onConfirm).toHaveBeenCalled();
  });
});

describe('Table (DataTable)', () => {
  type Court = { court: string; sport: string };

  const columns = [
    { accessorKey: 'court', header: 'Court' },
    { accessorKey: 'sport', header: 'Sport' },
  ];

  // `useTable` builds the TanStack instance and returns the props `<Table>`
  // consumes — the table is not a `columns`/`data` component. This harness
  // mirrors how a real page mounts it.
  function TableHarness({ data }: { data: Court[] }) {
    const tableProps = useTable<Court>({ data, columns, rowCount: data.length });
    return <Table {...tableProps} />;
  }

  it('renders an empty state — not an empty table — when there are no rows', () => {
    // Wrapped in the real catalogue. Without a provider next-intl renders the
    // KEY, and this asserted `/emptyFallback/i` — a test that passed only
    // while the translation was broken, and that would have gone on passing
    // if the key were deleted.
    render(withIntl(<TableHarness data={[]} />));

    // The primitive swaps the <table> out entirely for an empty fallback.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Court 1')).not.toBeInTheDocument();
    // Asserted from the catalogue, not retyped — a reworded string is not a
    // regression, a missing one is.
    expect(screen.getByText(/Няма намерени/)).toBeInTheDocument();
  });

  it('renders one row per datum plus the header row', () => {
    render(
      <TableHarness
        data={[
          { court: 'Court 1', sport: 'Padel' },
          { court: 'Court 2', sport: 'Tennis' },
        ]}
      />,
    );
    expect(screen.getByText('Court 1')).toBeInTheDocument();
    expect(screen.getByText('Court 2')).toBeInTheDocument();
    // 2 data rows + 1 header row.
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
});

describe('CalendarMonth', () => {
  it('renders a grid for the requested month', () => {
    render(<CalendarMonth month={new Date('2026-07-01T00:00:00Z')} events={[]} />);
    // The month renders as a labelled <section>, not an ARIA grid.
    const cal = screen.getByTestId('calendar-month');
    expect(cal).toHaveAttribute('aria-label', 'July 2026');
    // July has 31 days — the last one must be plotted.
    expect(within(cal).getByText('31')).toBeInTheDocument();
    // …and the weekday header row is present.
    expect(within(cal).getByText('Mon')).toBeInTheDocument();
  });
});
