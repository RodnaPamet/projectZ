'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DataTable, createColumns } from '@/components/ui/table/data-table';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
  'Modal',
  'Sheet',
  'ConfirmDialog',
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
    venue: 'Падел клуб София',
    court: 'Корт 3',
    sport: 'Падел',
    starts: 'Сб 10:00',
    player: 'Иван Петров',
    status: 'Потвърдена',
    price: '24.00 EUR',
  },
  {
    id: 'bk_2',
    venue: 'Тенис център Пловдив',
    court: 'Корт 1',
    sport: 'Тенис',
    starts: 'Нд 18:30',
    player: 'Мария Димитрова',
    status: 'Чакаща',
    price: '18.00 EUR',
  },
];

const BOOKING_COLUMNS = createColumns<DemoBooking>([
  { accessorKey: 'venue', header: 'Обект' },
  { accessorKey: 'court', header: 'Корт' },
  { accessorKey: 'sport', header: 'Спорт' },
  { accessorKey: 'starts', header: 'Начало' },
  { accessorKey: 'player', header: 'Играч' },
  { accessorKey: 'status', header: 'Статус' },
  { accessorKey: 'price', header: 'Цена' },
]);

/**
 * The Still Surface button, every state side by side (T18).
 *
 * The vendored material is motionless: every state switches on the pointer
 * frame and nothing animates between them, so a state can be shown as a
 * static swatch. Hover, press and focus cannot be forced on a real element,
 * so those columns pass the state's own classes (copied from
 * button-variants.ts) through `className`, which `cn` merges over the rest
 * classes. Rest, loading and disabled are the real props. The rest buttons
 * still answer a real pointer, so the copies can be checked against them.
 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive';

// `!` because tailwind-merge reads the tile's `shadow-[var(--btn-still-lift),…]`
// as a shadow COLOUR and this as a shadow SIZE, keeps both, and the lift wins
// on stylesheet order. The real `focus-visible:` class has a variant and wins.
const FOCUS = 'shadow-[0_0_0_2px_var(--bg-default),0_0_0_4px_var(--brand-default)]!';

const FORCED: Record<Variant, { hover: string; press: string }> = {
  primary: {
    hover:
      'border-[var(--brand-secondary-default)] bg-[var(--brand-muted)] bg-[image:linear-gradient(to_bottom,var(--btn-still-top),transparent_46%),linear-gradient(to_bottom,var(--brand-muted),var(--brand-default))]',
    press:
      'border-[var(--brand-secondary-default)] bg-[image:linear-gradient(to_bottom,var(--brand-emphasis),var(--brand-emphasis))] shadow-[var(--btn-still-press)]',
  },
  secondary: {
    hover: 'border-[var(--brand-default)] text-content-brand',
    press:
      'border-[var(--brand-default)] bg-[image:linear-gradient(to_bottom,var(--bg-muted),var(--bg-muted))] shadow-[var(--btn-still-press)]',
  },
  ghost: {
    hover: 'bg-bg-muted text-content-emphasis',
    press: 'bg-bg-muted shadow-[var(--btn-still-press)]',
  },
  destructive: {
    hover:
      'bg-[var(--btn-still-danger-lift)] bg-[image:linear-gradient(to_bottom,var(--btn-still-top),transparent_46%),linear-gradient(to_bottom,var(--btn-still-danger-lift),var(--btn-still-danger))]',
    press:
      'bg-[image:linear-gradient(to_bottom,var(--btn-still-danger-deep),var(--btn-still-danger-deep))] shadow-[var(--btn-still-press)]',
  },
};

const STATES = ['rest', 'hover', 'press', 'focus', 'loading', 'disabled'] as const;

function forcedState(variant: Variant, state: (typeof STATES)[number]): string | undefined {
  if (state === 'hover') return FORCED[variant].hover;
  if (state === 'press') return FORCED[variant].press;
  if (state === 'focus') return FOCUS;
  return undefined;
}

const noop = () => {};

function ButtonStates() {
  return (
    <div className="w-full space-y-4" data-testid="ds-button-states">
      {(Object.keys(FORCED) as Variant[]).map((variant) => (
        <div key={variant} className="flex flex-wrap items-end gap-3">
          <span className="text-content-muted w-24 font-mono text-xs">{variant}</span>
          {STATES.map((state) => (
            <div key={state} className="flex flex-col items-start gap-1">
              <span className="text-content-subtle font-mono text-xs">{state}</span>
              <Button
                variant={variant}
                onClick={noop}
                loading={state === 'loading'}
                disabled={state === 'disabled'}
                className={forcedState(variant, state)}
              >
                {variant === 'destructive' ? 'Cancel booking' : 'Book a court'}
              </Button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The T18 colour PROPOSALS, flagged for owner approval. Each chip paints the
 * live token, so it follows the theme toggle. The ratios are the ones
 * tests/guardrails/contrast.test.ts pins per theme, so a hex that moves
 * without its number fails the build.
 */
const PROPOSALS: ReadonlyArray<{ token: string; role: string; dark: string; light: string }> = [
  {
    token: '--brand-secondary-default',
    role: 'PROPOSED complementary hover edge: orchid, hue 321° dark / 323° light (was teal, 173°)',
    dark: '#f080c8 · 7.82:1 page · 7.37:1 card · ΔE 119.6 from the rest edge (teal 40.8)',
    light: '#b0247a · 5.55:1 page · 5.76:1 card · ΔE 96.6 from the rest edge (teal 35.3)',
  },
  {
    token: '--brand-secondary-subtle',
    role: 'PROPOSED sidebar active wash',
    dark: 'orchid @ 18% · heading text on it 11.92:1',
    light: 'orchid @ 9% · heading text on it 14.03:1',
  },
  {
    token: '--brand-default',
    role: 'Primary top stop and focus halo',
    dark: '#22c55e · label 8.41:1 · halo 8.35:1 page, 7.88:1 card',
    light: 'PROPOSED #166534 (was #16a34a) · label 6.78:1 (was 3.13) · halo 6.37 / 6.61:1',
  },
  {
    token: '--brand-emphasis',
    role: 'Primary bottom stop and rest edge',
    dark: '#16a34a · label 5.81:1',
    light: 'PROPOSED #14532d (was #15803d) · label 8.66:1 (was 4.77)',
  },
  {
    token: '--brand-muted',
    role: 'Primary hover top stop',
    dark: '#4ade80 · label 11.00:1',
    light: 'PROPOSED #15803d (was #22c55e) · label 4.77:1 (was 2.17)',
  },
  {
    token: '--btn-still-danger',
    role: 'Destructive top stop, under a white label',
    dark: '#b91c1c · 6.47:1 · hover #dc2626 4.83:1',
    light: '#991616 · 8.46:1 · hover #b01b1b 6.96:1',
  },
];

function ProposedSwatches() {
  return (
    <div className="w-full" data-testid="ds-button-proposals">
      <h3 className="text-content-emphasis mb-1 text-sm font-semibold">
        Proposed for owner approval (T18)
      </h3>
      <p className="text-content-muted mb-3 text-xs">
        Buttons are 28px on a fine pointer and 44px on touch. Ratios are WCAG 2.x, measured from
        tokens.css and pinned in contrast.test.ts.
      </p>
      <ul className="grid w-full gap-3 sm:grid-cols-2">
        {PROPOSALS.map((p) => (
          <li key={p.token} className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden
              className="border-border-default size-10 shrink-0 rounded-md border"
              style={{ background: `var(${p.token})` }}
            />
            <span className="min-w-0 text-xs">
              <span className="text-content-emphasis block font-mono break-words">{p.token}</span>
              <span className="text-content-default block">{p.role}</span>
              <span className="text-content-muted block">dark: {p.dark}</span>
              <span className="text-content-muted block">light: {p.light}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
          <ButtonStates />
          <ProposedSwatches />
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

        {/*
         * DataTable was ABSENT from this page — which mattered more than it
         * sounds. /design-system is the component-library drift canary that the
         * mobile drift ratchet relies on (P1), and it was missing the single most
         * drift-prone primitive in the library: a wide table.
         *
         * Below md this collapses to tappable cards automatically. That is what
         * stops an eight-column table pushing the whole page sideways at 390px,
         * and it is now actually exercised rather than merely asserted. The
         * cards are buttons when the table has a row action (onRowClick), so
         * they take Tab and Enter/Space like the desktop rows (react-table v9,
         * inflect's table as of T21). The rows are Bulgarian, as a player sees
         * them; getRowId keys selection by booking id rather than array index.
         */}
        <Section title="DataTable">
          <DataTable<DemoBooking>
            data={DEMO_BOOKINGS}
            columns={BOOKING_COLUMNS}
            getRowId={(row) => row.id}
            resourceName={(plural) => (plural ? 'резервации' : 'резервация')}
            onRowClick={() => {}}
          />
        </Section>
      </main>
    </TooltipProvider>
  );
}
