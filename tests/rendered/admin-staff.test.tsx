import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import {
  StaffBoard,
  type OpenInviteRow,
  type StaffRow,
} from '@/app/(app)/t/[slug]/admin/staff/StaffBoard';
import { TooltipProvider } from '@/components/ui/tooltip';

import { NextIntlClientProvider } from 'next-intl';

import { messages as bg } from '../helpers/intl';

/**
 * THE STAFF BOARD ON THE PRIMITIVES (T25), and #278.
 *
 *   - the members are the vendored DataTable (name, email, role, status), and
 *     a row opens the member in a Sheet whose role is a RadioGroup;
 *   - the invite form offers MANAGER and STAFF only, and starts on STAFF:
 *     COACH was its default, and nothing could accept a COACH invite (#278);
 *   - suspend and revoke ask through a ConfirmDialog and are optimistic: the
 *     status flips (the invite leaves) before the action answers, and a
 *     refusal or a throw rolls it back AND says so.
 *
 * The actions are mocked; what they do on the server is
 * tests/integration/admin-staff.test.ts.
 */

const setSuspendedAction = jest.fn();
const revokeInviteAction = jest.fn();
const inviteStaffAction = jest.fn();
const changeRoleAction = jest.fn();
jest.mock('@/app/(app)/t/[slug]/admin/staff/actions', () => ({
  setSuspendedAction: (...args: unknown[]) => setSuspendedAction(...args),
  revokeInviteAction: (...args: unknown[]) => revokeInviteAction(...args),
  inviteStaffAction: (...args: unknown[]) => inviteStaffAction(...args),
  changeRoleAction: (...args: unknown[]) => changeRoleAction(...args),
}));

const s = bg.admin.staff;

const ME: StaffRow = {
  membershipId: 'm-me',
  userId: 'u-me',
  name: 'Ана Собственик',
  email: 'owner@example.bg',
  role: 'OWNER',
  status: 'ACTIVE',
};
const GEORGI: StaffRow = {
  membershipId: 'm-g',
  userId: 'u-g',
  name: 'Георги Мениджър',
  email: 'georgi@example.bg',
  role: 'MANAGER',
  status: 'ACTIVE',
};
const INVITE: OpenInviteRow = {
  id: 'i1',
  email: 'new@example.bg',
  role: 'STAFF',
  expiresAt: '2026-10-17T00:00:00.000Z',
};

const board = (members: StaffRow[] = [ME, GEORGI], invites: OpenInviteRow[] = [INVITE]) =>
  render(
    // withIntl's provider, plus the time zone the app's root sets: the invite
    // row formats its expiry date, and next-intl warns on every render without one.
    <NextIntlClientProvider locale="bg" messages={bg} timeZone="Europe/Sofia">
      {/* The app root provides the TooltipProvider the Sheet's close button needs. */}
      <TooltipProvider>
        <StaffBoard
          slug="club"
          members={members}
          invites={invites}
          viewerUserId={ME.userId}
          canManageOwners
          activeOwnerCount={1}
        />
      </TooltipProvider>
    </NextIntlClientProvider>,
  );

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A member's table row, found by their name button (rows carry no id attribute). */
const row = (name: string) =>
  screen.getByRole('button', { name, hidden: true }).closest('tr') as HTMLElement;
const statusOf = (name: string) =>
  row(name).querySelector('[data-member-status]')?.getAttribute('data-member-status');

beforeEach(() => {
  for (const fn of [setSuspendedAction, revokeInviteAction, inviteStaffAction, changeRoleAction])
    fn.mockReset();
});

describe('StaffBoard', () => {
  it('is a DataTable with the field headers, and no native select', () => {
    const { container } = board();

    expect(container.querySelector('select')).toBeNull();
    const table = screen.getByRole('table');
    for (const header of [s.field.name, s.field.email, s.field.role, s.field.status]) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    expect(container.querySelector('[data-perf-ready] table')).not.toBeNull();
    expect(within(row(ME.name!)).getByText(s.you)).toBeInTheDocument();
    expect(statusOf(GEORGI.name!)).toBe('ACTIVE');
  });

  it('#278: the invite offers MANAGER and STAFF only, and starts on STAFF', async () => {
    board();
    fireEvent.click(screen.getByRole('button', { name: s.action.invite }));

    const group = screen.getByRole('radiogroup', { name: s.field.role });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('value'))).toEqual(['MANAGER', 'STAFF']);
    expect(within(group).getByRole('radio', { name: s.role.STAFF })).toBeChecked();
    expect(within(group).queryByRole('radio', { name: s.role.COACH })).toBeNull();
    expect(within(group).queryByRole('radio', { name: s.role.PLAYER })).toBeNull();
    expect(within(group).queryByRole('radio', { name: s.role.OWNER })).toBeNull();
  });

  it('a locked member (yourself) opens to the reason and no controls', async () => {
    board();
    fireEvent.click(screen.getByRole('button', { name: ME.name! }));
    const sheet = await screen.findByRole('dialog');

    expect(sheet).toHaveTextContent(s.locked.self);
    expect(within(sheet).queryByRole('radiogroup')).toBeNull();
    expect(within(sheet).queryByRole('button', { name: s.action.suspend })).toBeNull();
  });

  it('the role is a RadioGroup, other kinds disabled, and posts `role`', async () => {
    changeRoleAction.mockResolvedValue({ ok: true });
    board();
    fireEvent.click(screen.getByRole('button', { name: GEORGI.name! }));
    const sheet = await screen.findByRole('dialog');

    const group = within(sheet).getByRole('radiogroup', { name: s.field.role });
    expect(within(group).getByRole('radio', { name: s.role.MANAGER })).toBeChecked();
    // A club account cannot become a coach or a player (#263).
    expect(
      within(group).getByRole('radio', { name: `${s.role.COACH} (${s.separateAccount})` }),
    ).toBeDisabled();
    expect(
      within(group).getByRole('radio', { name: `${s.role.PLAYER} (${s.separateAccount})` }),
    ).toBeDisabled();

    fireEvent.click(within(group).getByRole('radio', { name: s.role.STAFF }));
    fireEvent.click(within(sheet).getByRole('button', { name: s.action.save }));

    await waitFor(() => expect(changeRoleAction).toHaveBeenCalled());
    const [slug, membershipId, , form] = changeRoleAction.mock.calls[0];
    expect([slug, membershipId]).toEqual(['club', 'm-g']);
    expect((form as FormData).get('role')).toBe('STAFF');
  });
});

describe('suspend, optimistically', () => {
  async function confirmSuspend(name: string) {
    fireEvent.click(screen.getByRole('button', { name }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: s.action.suspend }));
    const dialog = await screen.findByRole('dialog', {
      name: s.suspend.title.replace('{name}', name),
    });
    expect(dialog).toHaveTextContent(s.suspend.confirm);
    fireEvent.click(within(dialog).getByRole('button', { name: s.action.suspend }));
  }

  it('THE POINT: the status flips before the action answers', async () => {
    const pending = deferred<{ ok: true }>();
    setSuspendedAction.mockReturnValue(pending.promise);
    board();

    await confirmSuspend(GEORGI.name!);

    await waitFor(() => expect(statusOf(GEORGI.name!)).toBe('SUSPENDED'));
    expect(setSuspendedAction).toHaveBeenCalledWith('club', 'm-g', true);

    await act(async () => pending.resolve({ ok: true }));
  });

  it('rolls back, and says why, when the action refuses', async () => {
    const pending = deferred<{ ok: false; error: string }>();
    setSuspendedAction.mockReturnValue(pending.promise);
    board();

    await confirmSuspend(GEORGI.name!);
    await waitFor(() => expect(statusOf(GEORGI.name!)).toBe('SUSPENDED'));

    await act(async () => pending.resolve({ ok: false, error: 'LAST_OWNER' }));

    await waitFor(() => expect(statusOf(GEORGI.name!)).toBe('ACTIVE'));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(GEORGI.name!);
    expect(alert).toHaveTextContent(s.error.LAST_OWNER);
  });

  it('cancelling the confirm suspends nobody', async () => {
    board();
    fireEvent.click(screen.getByRole('button', { name: GEORGI.name! }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: s.action.suspend }));
    const dialog = await screen.findByRole('dialog', {
      name: s.suspend.title.replace('{name}', GEORGI.name!),
    });
    fireEvent.click(within(dialog).getByRole('button', { name: s.action.cancel }));

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: s.suspend.title.replace('{name}', GEORGI.name!) }),
      ).toBeNull(),
    );
    expect(setSuspendedAction).not.toHaveBeenCalled();
    expect(statusOf(GEORGI.name!)).toBe('ACTIVE');
  });
});

describe('inviting more than once (#328)', () => {
  const email = () => screen.getByLabelText(s.field.email);

  async function send(address: string) {
    fireEvent.change(email(), { target: { value: address } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: s.action.send }));
    });
  }

  it('THE POINT: a second invite after a first success, without a reload', async () => {
    // `useActionState` keeps the first `{ ok: true }` for the life of the page.
    // The form closed on "state is ok", so every later opening closed at once.
    inviteStaffAction.mockImplementation(async () => ({ ok: true }));
    board();

    fireEvent.click(screen.getByRole('button', { name: s.action.invite }));
    await send('first@example.bg');
    await waitFor(() => expect(screen.queryByLabelText(s.field.email)).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: s.action.invite }));
    expect(email()).toBeInTheDocument();
    // Still open on the next render, and the next.
    await act(async () => {});
    expect(email()).toBeInTheDocument();

    await send('second@example.bg');
    expect(inviteStaffAction).toHaveBeenCalledTimes(2);
    expect((inviteStaffAction.mock.calls[1]![2] as FormData).get('email')).toBe(
      'second@example.bg',
    );
    await waitFor(() => expect(screen.queryByLabelText(s.field.email)).toBeNull());
  });

  it('an error stays with the attempt it answered, not the next opening of the form', async () => {
    inviteStaffAction.mockImplementation(async () => ({ ok: false, error: 'MAIL_FAILED' }));
    board();

    fireEvent.click(screen.getByRole('button', { name: s.action.invite }));
    await send('nope@example.bg');
    expect(await screen.findByText(s.error.MAIL_FAILED)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: s.action.cancel }));
    fireEvent.click(screen.getByRole('button', { name: s.action.invite }));
    expect(screen.queryByText(s.error.MAIL_FAILED)).toBeNull();

    // A new failure is a new answer, and is shown.
    await send('again@example.bg');
    expect(await screen.findByText(s.error.MAIL_FAILED)).toBeInTheDocument();
  });
});

describe('revoke, optimistically', () => {
  const inviteCard = () => document.querySelector('[data-invite-id="i1"]');

  async function confirmRevoke() {
    fireEvent.click(
      within(inviteCard() as HTMLElement).getByRole('button', { name: s.action.revoke }),
    );
    const dialog = await screen.findByRole('dialog', { name: s.invite.revokeTitle });
    expect(dialog).toHaveTextContent(INVITE.email);
    fireEvent.click(within(dialog).getByRole('button', { name: s.action.revoke }));
  }

  it('the invite leaves at once', async () => {
    const pending = deferred<{ ok: true }>();
    revokeInviteAction.mockReturnValue(pending.promise);
    board();

    await confirmRevoke();

    await waitFor(() => expect(inviteCard()).toBeNull());
    expect(revokeInviteAction).toHaveBeenCalledWith('club', 'i1');
    await act(async () => pending.resolve({ ok: true }));
  });

  it('comes back, and says so, when the action throws', async () => {
    revokeInviteAction.mockRejectedValue(new Error('network'));
    board();

    await confirmRevoke();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(INVITE.email));
    expect(inviteCard()).not.toBeNull();
  });
});
