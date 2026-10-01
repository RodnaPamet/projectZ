'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { CalendarMonth } from '@/components/ui/CalendarMonth';
import { Checkbox } from '@/components/ui/checkbox';
import { DataTable, createColumns } from '@/components/ui/table/data-table';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { FieldGroup } from '@/components/ui/field-group';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Modal } from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

/**
 * The design-system gallery. Every ported primitive renders here so a
 * human — and the Playwright + axe smoke specs — can see the whole
 * platform in one page, in both themes.
 *
 * Each family is an <h2>; `design-system-smoke.spec.ts` asserts every
 * section heading renders, so a primitive added without one is not
 * covered.
 */

const SECTIONS = [
  'Button',
  'Input',
  'Textarea',
  'Checkbox',
  'RadioGroup',
  'Switch',
  'ToggleGroup',
  'FieldGroup',
  'StatusBadge',
  'InlineNotice',
  'Skeleton',
  'EmptyState',
  'ErrorState',
  'Tooltip',
  'CopyButton',
  'Modal',
  'Sheet',
  'ConfirmDialog',
  'CalendarMonth',
] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    // The testid gives the visual-regression specs a stable, unambiguous
    // target — `page.locator('section')` matches every family on the page.
    <section data-testid={`ds-section-${title}`} className="border-border-subtle border-t py-8">
      <h2 className="text-content-emphasis mb-4 font-mono text-lg font-semibold">{title}</h2>
      <div className="flex flex-wrap items-start gap-4">{children}</div>
    </section>
  );
}

interface DemoBooking {
  id: string;
  venue: string;
  court: string;
  sport: string;
  starts: string;
  player: string;
  status: string;
  price: string;
}

/** Eight columns — deliberately. A narrow table would not prove anything. */
const DEMO_BOOKINGS: DemoBooking[] = [
  {
    id: 'bk_1',
    venue: 'Sofia Padel Club',
    court: 'Court 3',
    sport: 'Padel',
    starts: 'Sat 10:00',
    player: 'Ivan Petrov',
    status: 'Confirmed',
    price: '24.00 EUR',
  },
  {
    id: 'bk_2',
    venue: 'Plovdiv Tennis Center',
    court: 'Court 1',
    sport: 'Tennis',
    starts: 'Sun 18:30',
    player: 'Maria Dimitrova',
    status: 'Pending',
    price: '18.00 EUR',
  },
];

const BOOKING_COLUMNS = createColumns<DemoBooking>([
  { accessorKey: 'venue', header: 'Venue' },
  { accessorKey: 'court', header: 'Court' },
  { accessorKey: 'sport', header: 'Sport' },
  { accessorKey: 'starts', header: 'Starts' },
  { accessorKey: 'player', header: 'Player' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'price', header: 'Price' },
]);

export default function DesignSystemPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [leftSheetOpen, setLeftSheetOpen] = useState(false);
  const [range, setRange] = useState('day');
  const [noticeShown, setNoticeShown] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [switched, setSwitched] = useState(false);
  const [radio, setRadio] = useState('padel');

  return (
    <TooltipProvider>
      <main className="bg-bg-page text-content-default min-h-screen px-8 py-10">
        <header className="flex items-baseline justify-between pb-6">
          <div>
            <h1 className="text-content-emphasis font-mono text-3xl font-semibold">
              playerz.bg — design system
            </h1>
            <p className="text-content-muted mt-1 text-sm">
              {SECTIONS.length} primitive families ported in P02, shown in both themes.
            </p>
          </div>
          <ThemeToggle />
        </header>

        <Section title="Button">
          <Button variant="primary">Book a court</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Cancel booking</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
        </Section>

        <Section title="Input">
          <div className="w-64">
            <Label htmlFor="ds-input">Venue name</Label>
            <Input id="ds-input" placeholder="Sofia Padel Club" />
          </div>
        </Section>

        <Section title="Textarea">
          <div className="w-64">
            <Label htmlFor="ds-textarea">Notes</Label>
            <Textarea id="ds-textarea" placeholder="Bring your own racket…" />
          </div>
        </Section>

        <Section title="Checkbox">
          <div className="flex items-center gap-2">
            <Checkbox
              id="ds-checkbox"
              checked={checked}
              onCheckedChange={(v) => setChecked(v === true)}
            />
            <Label htmlFor="ds-checkbox">Indoor courts only</Label>
          </div>
        </Section>

        <Section title="RadioGroup">
          <RadioGroup value={radio} onValueChange={setRadio}>
            {['padel', 'tennis', 'badminton'].map((sport) => (
              <div key={sport} className="flex items-center gap-2">
                <RadioGroupItem value={sport} id={`ds-radio-${sport}`} />
                <Label htmlFor={`ds-radio-${sport}`}>{sport}</Label>
              </div>
            ))}
          </RadioGroup>
        </Section>

        <Section title="Switch">
          <div className="flex items-center gap-2">
            <Switch id="ds-switch" checked={switched} onCheckedChange={setSwitched} />
            <Label htmlFor="ds-switch">Notify me about open play</Label>
          </div>
        </Section>

        <Section title="ToggleGroup">
          <ToggleGroup
            ariaLabel="Calendar range"
            selected={range}
            selectAction={setRange}
            options={[
              { value: 'day', label: 'Day' },
              { value: 'week', label: 'Week' },
              { value: 'month', label: 'Month', disabled: true },
            ]}
          />
        </Section>

        <Section title="FieldGroup">
          <FieldGroup
            title="Contact"
            description="How the club reaches you about a booking."
            columns={2}
            className="max-w-xl"
          >
            <div>
              <Label htmlFor="ds-fg-name">Name</Label>
              <Input id="ds-fg-name" placeholder="Ivan Petrov" />
            </div>
            <div>
              <Label htmlFor="ds-fg-phone">Phone</Label>
              <Input id="ds-fg-phone" type="tel" placeholder="+359 88 123 4567" />
            </div>
          </FieldGroup>
        </Section>

        <Section title="StatusBadge">
          <StatusBadge variant="success">Confirmed</StatusBadge>
          <StatusBadge variant="warning">Pending</StatusBadge>
          <StatusBadge variant="error">Cancelled</StatusBadge>
          <StatusBadge variant="neutral">Draft</StatusBadge>
          <StatusBadge variant="info">Open play</StatusBadge>
        </Section>

        <Section title="InlineNotice">
          <div className="flex w-full max-w-xl flex-col gap-3">
            <InlineNotice variant="info">
              Court 2 is closed for resurfacing until Friday.
            </InlineNotice>
            <InlineNotice variant="success" title="Booked">
              Court 3 · Saturday 18:00–19:00.
            </InlineNotice>
            <InlineNotice variant="warning">
              Less than 24h out: cancelling is not refunded.
            </InlineNotice>
            {noticeShown ? (
              <InlineNotice
                variant="error"
                onDismiss={() => setNoticeShown(false)}
                dismissLabel="Hide this notice"
              >
                That slot was taken while you were choosing.
              </InlineNotice>
            ) : null}
          </div>
        </Section>

        <Section title="Skeleton">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-8 w-32" />
        </Section>

        <Section title="EmptyState">
          <EmptyState title="No bookings yet" description="Your upcoming games appear here." />
        </Section>

        <Section title="ErrorState">
          <ErrorState title="Could not load courts" description="Try again in a moment." />
        </Section>

        <Section title="Tooltip">
          <Tooltip content="60 min · €24">
            <Button variant="secondary">Hover for price</Button>
          </Tooltip>
        </Section>

        <Section title="CopyButton">
          <CopyButton value="PLZ-4821" label="Copy booking reference" />
        </Section>

        <Section title="Modal">
          <Button variant="secondary" onClick={() => setModalOpen(true)}>
            Open modal
          </Button>
          <Modal showModal={modalOpen} setShowModal={setModalOpen}>
            <div className="p-6">
              <h3 className="text-content-emphasis mb-2 font-semibold">Confirm your slot</h3>
              <p className="text-content-muted text-sm">Court 3 · Saturday 18:00–19:00</p>
            </div>
          </Modal>
        </Section>

        <Section title="Sheet">
          <Button variant="secondary" onClick={() => setSheetOpen(true)}>
            Open sheet
          </Button>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen} title="Filters">
            <Sheet.Body>
              <p className="text-content-muted text-sm">Sport, surface, indoor/outdoor.</p>
            </Sheet.Body>
          </Sheet>
          {/* `direction="left"`: a navigation drawer slides in from
              the edge the nav lives on, at every width. */}
          <Button variant="secondary" onClick={() => setLeftSheetOpen(true)}>
            Open left sheet
          </Button>
          <Sheet open={leftSheetOpen} onOpenChange={setLeftSheetOpen} title="Menu" direction="left">
            <Sheet.Body>
              <p className="text-content-muted text-sm">Venues, my bookings, settings.</p>
            </Sheet.Body>
          </Sheet>
        </Section>

        <Section title="ConfirmDialog">
          <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
            Cancel booking
          </Button>
          <ConfirmDialog
            showModal={confirmOpen}
            setShowModal={setConfirmOpen}
            title="Cancel this booking?"
            description="You are more than 24h out, so this refunds in full."
            confirmLabel="Cancel booking"
            onConfirm={() => setConfirmOpen(false)}
          />
        </Section>

        <Section title="CalendarMonth">
          <CalendarMonth month={new Date('2026-07-01T00:00:00Z')} events={[]} />
        </Section>

        {/*
         * DataTable was ABSENT from this page — which mattered more than it
         * sounds. /design-system is the component-library drift canary that the
         * mobile drift ratchet relies on (P1), and it was missing the single most
         * drift-prone primitive in the library: a wide table.
         *
         * Below md this collapses to tappable cards automatically. That is what
         * stops an eight-column table pushing the whole page sideways at 390px,
         * and it is now actually exercised rather than merely asserted.
         */}
        <Section title="DataTable">
          <DataTable<DemoBooking>
            data={DEMO_BOOKINGS}
            columns={BOOKING_COLUMNS}
            resourceName={(plural) => (plural ? 'bookings' : 'booking')}
            onRowClick={() => {}}
          />
        </Section>
      </main>
    </TooltipProvider>
  );
}
