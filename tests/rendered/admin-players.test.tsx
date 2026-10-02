import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { PlayersBoard, type PlayerRow } from '@/app/(app)/t/[slug]/admin/players/PlayersBoard';
import { TooltipProvider } from '@/components/ui/tooltip';

import { messages as bg, withIntl } from '../helpers/intl';

/**
 * THE PLAYERS BOARD ON THE PRIMITIVES (T25).
 *
 * What a reader cannot see from the code alone:
 *
 *   - the list is the vendored DataTable with the admin.players.field.*
 *     headers, and a row opens the player in a Sheet (the name is the row's
 *     keyboard path from md);
 *   - a tag save is optimistic: the row shows the new tags before the action
 *     answers, and a refusal or a throw rolls it back AND says so;
 *   - credit is NOT optimistic, and its direction is a ToggleGroup posting
 *     `direction` under the name the action reads.
 *
 * The actions are mocked; what they do on the server is
 * tests/integration/admin-players.test.ts.
 */

const setPlayerTagsAction = jest.fn();
const adjustCreditAction = jest.fn();
jest.mock('@/app/(app)/t/[slug]/admin/players/actions', () => ({
  setPlayerTagsAction: (...args: unknown[]) => setPlayerTagsAction(...args),
  adjustCreditAction: (...args: unknown[]) => adjustCreditAction(...args),
}));

const p = bg.admin.players;

const IVAN: PlayerRow = {
  playerUserId: 'u1',
  name: 'Иван Петров',
  email: 'ivan@example.bg',
  tags: ['вип'],
  noShowCount: 2,
  lastPlayedAt: null,
  membershipLevel: null,
  creditCents: 1500,
};
const MARIA: PlayerRow = {
  playerUserId: 'u2',
  name: null,
  email: 'maria@example.bg',
  tags: [],
  noShowCount: 0,
  lastPlayedAt: null,
  membershipLevel: 'Злато',
  creditCents: 0,
};

const board = (players: PlayerRow[] = [IVAN, MARIA], canAdjustCredit = true) =>
  render(
    // The app root provides the TooltipProvider the Sheet's close button needs.
    withIntl(
      <TooltipProvider>
        <PlayersBoard slug="club" players={players} canAdjustCredit={canAdjustCredit} />
      </TooltipProvider>,
    ),
  );

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** The table row whose name button reads `name` (rows carry no id attribute). */
const row = (name: string) =>
  screen.getByRole('button', { name, hidden: true }).closest('tr') as HTMLElement;

async function openPlayer(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  setPlayerTagsAction.mockReset();
  adjustCreditAction.mockReset();
});

describe('PlayersBoard', () => {
  it('is a DataTable with the field headers, and no native select', () => {
    const { container } = board();

    expect(container.querySelector('select')).toBeNull();
    const table = screen.getByRole('table');
    for (const header of [
      p.field.name,
      p.field.email,
      p.field.tags,
      p.field.credit,
      p.field.noShows,
    ]) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    // The READY marker sits on the table's wrapper.
    expect(container.querySelector('[data-perf-ready] table')).not.toBeNull();
    expect(within(table).getByText('вип')).toBeInTheDocument();
    expect(within(table).getByText('Злато')).toBeInTheDocument();
  });

  it('search narrows the rows, and no match is an EmptyState', () => {
    board();
    const search = screen.getByLabelText(p.search);

    fireEvent.change(search, { target: { value: 'maria' } });
    expect(screen.queryByRole('button', { name: IVAN.name! })).toBeNull();
    expect(screen.getByRole('button', { name: MARIA.email })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'nobody' } });
    expect(screen.getByText(p.noMatch.title)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('no players at all is the empty state, still READY', () => {
    const { container } = board([]);
    expect(screen.getByText(p.empty.title)).toBeInTheDocument();
    expect(container.querySelector('[data-perf-ready]')).not.toBeNull();
  });
});

describe('tags, optimistically', () => {
  async function saveTags(name: string, value: string) {
    const sheet = await openPlayer(name);
    fireEvent.change(within(sheet).getByLabelText(p.field.tags), { target: { value } });
    fireEvent.click(within(sheet).getByRole('button', { name: p.action.saveTags }));
  }

  it('THE POINT: the row shows the new tags before the action answers', async () => {
    const pending = deferred<{ ok: true }>();
    setPlayerTagsAction.mockReturnValue(pending.promise);
    board();

    await saveTags(IVAN.name!, ' треньор, вип,треньор ');

    // Cleaned as the use case cleans: trimmed, deduplicated, sorted.
    await waitFor(() => expect(within(row(IVAN.name!)).getByText('треньор')).toBeVisible());
    expect(setPlayerTagsAction).toHaveBeenCalledWith('club', 'u1', null, expect.any(FormData));
    const form = setPlayerTagsAction.mock.calls[0][3] as FormData;
    expect(form.get('tags')).toBe(' треньор, вип,треньор ');

    await act(async () => pending.resolve({ ok: true }));
  });

  it('rolls back, and says so, when the action throws', async () => {
    let reject!: (e: Error) => void;
    setPlayerTagsAction.mockReturnValue(
      new Promise((_, rej) => {
        reject = rej;
      }),
    );
    board();

    await saveTags(IVAN.name!, 'нов');
    await waitFor(() => expect(within(row(IVAN.name!)).getByText('нов')).toBeVisible());

    await act(async () => reject(new Error('network')));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(IVAN.name!));
    expect(within(row(IVAN.name!)).queryByText('нов')).toBeNull();
    expect(within(row(IVAN.name!)).getByText('вип')).toBeInTheDocument();
  });
});

describe('credit, NOT optimistically', () => {
  it('the direction is a ToggleGroup posting `direction`; debit is off at a zero balance', async () => {
    board();
    const sheet = await openPlayer(MARIA.email);

    const group = within(sheet).getByRole('radiogroup', { name: p.field.direction });
    expect(within(group).getByRole('radio', { name: p.direction.debit })).toBeDisabled();
    const hidden = sheet.querySelector('input[name="direction"]') as HTMLInputElement;
    expect(hidden.value).toBe('credit');
  });

  it('a debit posts `debit`, and the balance waits for the server', async () => {
    const pending = deferred<{ ok: true }>();
    adjustCreditAction.mockReturnValue(pending.promise);
    board();
    const sheet = await openPlayer(IVAN.name!);

    fireEvent.click(within(sheet).getByRole('radio', { name: p.direction.debit }));
    expect((sheet.querySelector('input[name="direction"]') as HTMLInputElement).value).toBe(
      'debit',
    );
    fireEvent.change(within(sheet).getByLabelText(p.field.amount), { target: { value: '5' } });
    fireEvent.change(within(sheet).getByLabelText(p.field.note), {
      target: { value: 'Двойно таксуване' },
    });
    fireEvent.submit(sheet.querySelector('input[name="amount"]')!.closest('form')!);

    await waitFor(() => expect(adjustCreditAction).toHaveBeenCalled());
    const form = adjustCreditAction.mock.calls[0][3] as FormData;
    expect(form.get('direction')).toBe('debit');
    expect(form.get('amount')).toBe('5');
    // Money is never optimistic: the row still shows the server's balance.
    expect(row(IVAN.name!)).toHaveTextContent('15,00');

    await act(async () => pending.resolve({ ok: true }));
  });

  it('a COACH (no players.credit_adjust) gets no credit form', async () => {
    board([IVAN], false);
    const sheet = await openPlayer(IVAN.name!);
    expect(within(sheet).queryByRole('radiogroup')).toBeNull();
    expect(within(sheet).getByLabelText(p.field.tags)).toBeInTheDocument();
  });
});
