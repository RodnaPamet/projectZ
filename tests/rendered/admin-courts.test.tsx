import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CourtForm } from '@/app/(app)/t/[slug]/admin/courts/CourtForm';
import { CourtsBoard, type CourtRow } from '@/app/(app)/t/[slug]/admin/courts/CourtsBoard';

import { messages as bg, withIntl } from '../helpers/intl';

/**
 * THE COURTS BOARD ON THE PRIMITIVES (T23).
 *
 * Two things a reader cannot see from the code alone:
 *
 *   - the form's three choices are Comboboxes that still POST the keys the
 *     actions read (`venueId`, `sport`, `surface`), labelled in Bulgarian
 *     rather than as Prisma enum names;
 *   - archive is optimistic: the card flips before the action answers, and a
 *     refusal or a throw puts it back AND says so.
 *
 * The actions are mocked; what they do on the server is
 * tests/integration/admin-courts-mutations.test.ts.
 */

const archiveCourtAction = jest.fn();
jest.mock('@/app/(app)/t/[slug]/admin/courts/actions', () => ({
  archiveCourtAction: (...args: unknown[]) => archiveCourtAction(...args),
  createCourtAction: jest.fn(),
  updateCourtAction: jest.fn(),
}));

const c = bg.admin.courts;

const court = (over: Partial<CourtRow> = {}): CourtRow => ({
  id: 'court-1',
  name: 'Корт 1',
  sport: 'PADEL',
  surface: 'ARTIFICIAL_GRASS',
  isIndoor: false,
  capacity: 4,
  basePriceCents: 2400,
  minBookingMinutes: 60,
  maxBookingMinutes: 180,
  slotStepMinutes: 30,
  status: 'ACTIVE',
  venueName: 'Main site',
  upcomingBookings: 0,
  ...over,
});

const VENUES = [
  { id: 'v1', name: 'Main site' },
  { id: 'v2', name: 'Second site' },
];

const board = (rows: CourtRow[]) =>
  render(withIntl(<CourtsBoard slug="club" courts={rows} venues={VENUES} />));

/** A promise the test settles by hand, so the in-between state can be asserted. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const hidden = (form: HTMLElement, name: string) =>
  form.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;

beforeEach(() => archiveCourtAction.mockReset());

describe('CourtForm', () => {
  it('has no native select, and labels every choice in Bulgarian', () => {
    const { container } = render(withIntl(<CourtForm slug="club" venues={VENUES} />));

    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector('input[type="checkbox"]:not([aria-hidden])')).toBeNull();

    // The trigger names the field and its value — not "ARTIFICIAL_GRASS".
    expect(
      screen.getByRole('combobox', { name: `${c.field.sport}, ${bg.sports.PADEL}` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', {
        name: `${c.field.surface}, ${c.surface.ARTIFICIAL_GRASS}`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: `${c.field.venue}, Main site` }),
    ).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: c.setting.indoor })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/ARTIFICIAL_GRASS|PADEL/);
  });

  it('posts the same keys the native selects did', () => {
    const { container } = render(withIntl(<CourtForm slug="club" venues={VENUES} />));
    const form = container.querySelector('form')!;

    expect(hidden(form, 'venueId')).toBe('v1');
    expect(hidden(form, 'sport')).toBe('PADEL');
    expect(hidden(form, 'surface')).toBe('ARTIFICIAL_GRASS');
  });

  it('a choice made in the combobox is what the form posts', async () => {
    const user = userEvent.setup();
    const { container } = render(
      withIntl(<CourtForm slug="club" court={court({ id: 'court-1' })} />),
    );

    await user.click(
      screen.getByRole('combobox', { name: `${c.field.surface}, ${c.surface.ARTIFICIAL_GRASS}` }),
    );
    await user.click(await screen.findByRole('option', { name: c.surface.CLAY }));

    expect(hidden(container.querySelector('form')!, 'surface')).toBe('CLAY');
    // Picking the current value again keeps it: a court always has a surface.
    await user.click(
      screen.getByRole('combobox', { name: `${c.field.surface}, ${c.surface.CLAY}` }),
    );
    await user.click(await screen.findByRole('option', { name: c.surface.CLAY }));
    expect(hidden(container.querySelector('form')!, 'surface')).toBe('CLAY');
  });

  it('keeps a sport outside the usual list instead of showing padel for it', () => {
    const { container } = render(
      withIntl(<CourtForm slug="club" court={court({ sport: 'FOOTBALL' })} />),
    );
    expect(hidden(container.querySelector('form')!, 'sport')).toBe('FOOTBALL');
    expect(
      screen.getByRole('combobox', { name: `${c.field.sport}, ${bg.sports.FOOTBALL}` }),
    ).toBeInTheDocument();
  });
});

describe('archive, optimistically', () => {
  const badge = (card: HTMLElement) => card.querySelector('[data-court-status]');

  it('THE POINT: flips at once, before the action answers', async () => {
    const pending = deferred<{ ok: true }>();
    archiveCourtAction.mockReturnValue(pending.promise);
    board([court()]);
    const card = screen.getByRole('listitem');

    fireEvent.click(within(card).getByRole('button', { name: c.action.archive }));

    await waitFor(() => expect(badge(card)).toHaveAttribute('data-court-status', 'CLOSED'));
    expect(badge(card)).toHaveTextContent(c.status.CLOSED);
    expect(within(card).getByRole('button', { name: c.action.reopen })).toBeInTheDocument();
    expect(archiveCourtAction).toHaveBeenCalledWith('club', 'court-1', false);

    await act(async () => pending.resolve({ ok: true }));
  });

  it('rolls back, and says so, when the action refuses', async () => {
    const pending = deferred<{ ok: false; error: string }>();
    archiveCourtAction.mockReturnValue(pending.promise);
    board([court()]);
    const card = screen.getByRole('listitem');

    fireEvent.click(within(card).getByRole('button', { name: c.action.archive }));
    await waitFor(() => expect(badge(card)).toHaveAttribute('data-court-status', 'CLOSED'));

    await act(async () => pending.resolve({ ok: false, error: 'nope' }));

    await waitFor(() => expect(badge(card)).toHaveAttribute('data-court-status', 'ACTIVE'));
    expect(within(card).getByRole('alert')).toHaveTextContent(c.archive.failed);
    expect(within(card).getByRole('button', { name: c.action.archive })).toBeEnabled();
  });

  it('rolls back when the action throws, too', async () => {
    archiveCourtAction.mockRejectedValue(new Error('network'));
    board([court({ status: 'CLOSED' })]);
    const card = screen.getByRole('listitem');

    fireEvent.click(within(card).getByRole('button', { name: c.action.reopen }));

    await waitFor(() => expect(within(card).getByRole('alert')).toBeInTheDocument());
    expect(badge(card)).toHaveAttribute('data-court-status', 'CLOSED');
    expect(archiveCourtAction).toHaveBeenCalledWith('club', 'court-1', true);
  });

  it('asks first when bookings are ahead, in a dialog that says they survive', async () => {
    archiveCourtAction.mockResolvedValue({ ok: true });
    board([court({ upcomingBookings: 3 })]);
    const card = screen.getByRole('listitem');

    fireEvent.click(within(card).getByRole('button', { name: c.action.archive }));

    const dialog = await screen.findByRole('dialog', { name: c.archive.title });
    expect(dialog).toHaveTextContent('3');
    expect(archiveCourtAction).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: c.action.archive }));
    await waitFor(() => expect(archiveCourtAction).toHaveBeenCalledWith('club', 'court-1', false));
  });

  it('cancelling the dialog archives nothing', async () => {
    board([court({ upcomingBookings: 1 })]);
    const card = screen.getByRole('listitem');

    fireEvent.click(within(card).getByRole('button', { name: c.action.archive }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: c.action.cancel }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(archiveCourtAction).not.toHaveBeenCalled();
    expect(badge(card)).toHaveAttribute('data-court-status', 'ACTIVE');
  });
});
