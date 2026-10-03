import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  PricingBoard,
  type CourtOption,
  type PricingRuleView,
} from '@/app/(app)/t/[slug]/admin/pricing/PricingBoard';
import RuleForm from '@/app/(app)/t/[slug]/admin/pricing/RuleForm';

import { messages as bg, withIntl } from '../helpers/intl';

/**
 * THE PRICING BOARD ON THE PRIMITIVES (T24).
 *
 * Two things a reader cannot see from the code alone:
 *
 *   - the court, the preview day and the rule's effect are Comboboxes and the
 *     weekdays a toggle row, and the form still POSTS the keys the actions
 *     read (`mode`, one `dayOfWeek` per day);
 *   - delete is optimistic: the rule leaves the list before the action
 *     answers, and a refusal or a throw puts it back AND says so — while the
 *     price preview never moves on the optimistic list.
 *
 * The actions are mocked; what they do on the server is
 * tests/integration/admin-pricing-rules.test.ts.
 */

const deletePricingRuleAction = jest.fn();
jest.mock('@/app/(app)/t/[slug]/admin/pricing/actions', () => ({
  deletePricingRuleAction: (...args: unknown[]) => deletePricingRuleAction(...args),
  createPricingRuleAction: jest.fn(),
  updatePricingRuleAction: jest.fn(),
}));

const p = bg.admin.pricing;
const day = bg.common.calendar.weekdayShort;

const COURTS: CourtOption[] = [
  { id: 'c1', name: 'Корт 1', basePriceCents: 2400, minBookingMinutes: 60 },
  { id: 'c2', name: 'Корт 2', basePriceCents: 3000, minBookingMinutes: 60 },
];

const PEAK: PricingRuleView = {
  id: 'r1',
  name: 'Вечерен пик',
  priority: 200,
  multiplier: 1.5,
  fixedPriceCents: null,
  // Thursday 19:00 is the preview's default, so this rule decides it.
  conditions: { dayOfWeek: [4], timeRange: { from: '18:00', to: '22:00' } },
};
const WEEKEND: PricingRuleView = {
  id: 'r2',
  name: 'Уикенд',
  priority: 100,
  multiplier: null,
  fixedPriceCents: 4000,
  conditions: { dayOfWeek: [6, 0] },
};

const board = (rules: Record<string, PricingRuleView[]> = { c1: [PEAK, WEEKEND] }) =>
  render(withIntl(<PricingBoard slug="club" courts={COURTS} rulesByCourt={rules} />));

/** A promise the test settles by hand, so the in-between state can be asserted. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const posted = (form: HTMLFormElement, name: string) => new FormData(form).getAll(name);

beforeEach(() => deletePricingRuleAction.mockReset());

describe('PricingBoard', () => {
  it('has no native select, and names each choice with its value', () => {
    const { container } = board();

    expect(container.querySelector('select')).toBeNull();
    expect(screen.getByRole('combobox', { name: `${p.field.court}, Корт 1` })).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: `${p.preview.day}, ${day['4']}` }),
    ).toBeInTheDocument();
    // The preview prices Thursday 19:00 through the peak rule: 24 € × 1.5.
    expect(container.textContent).toContain(p.preview.via.replace('{name}', PEAK.name));
  });

  it('a weekend-only rule does not price Thursday 19:00; on Saturday it does (#350)', async () => {
    // The preview handed its views to the engine by cast, and the engine read
    // `conditionsJson`, which a view does not have: every rule matched every
    // day, so the default Thursday 19:00 answered 36,00 € "by Weekend peak".
    const user = userEvent.setup();
    const weekendPeak: PricingRuleView = {
      id: 'r3',
      name: 'Weekend peak',
      priority: 100,
      multiplier: 1.5,
      fixedPriceCents: null,
      conditions: { dayOfWeek: [0, 6], timeRange: { from: '18:00', to: '22:00' } },
    };
    const { container } = board({ c1: [weekendPeak] });
    const via = p.preview.via.replace('{name}', weekendPeak.name);
    // The preview's figure is the only element whose whole text is a price.
    const price = (amount: string) => screen.queryByText(new RegExp(`^${amount}\\s€$`));

    // Thursday: the base price, and no rule named.
    expect(price('24,00')).toBeInTheDocument();
    expect(screen.getByText(p.preview.base)).toBeInTheDocument();
    expect(container.textContent).not.toContain(via);

    await user.click(screen.getByRole('combobox', { name: `${p.preview.day}, ${day['4']}` }));
    await user.click(await screen.findByRole('option', { name: day['6'] }));

    expect(price('36,00')).toBeInTheDocument();
    expect(price('24,00')).toBeNull();
    expect(container.textContent).toContain(via);
  });

  it('switching court shows that court’s rules', async () => {
    const user = userEvent.setup();
    board({ c1: [PEAK], c2: [WEEKEND] });

    expect(screen.getByText(PEAK.name)).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: `${p.field.court}, Корт 1` }));
    await user.click(await screen.findByRole('option', { name: 'Корт 2' }));

    expect(screen.queryByText(PEAK.name)).toBeNull();
    expect(screen.getByText(WEEKEND.name)).toBeInTheDocument();
  });
});

describe('RuleForm', () => {
  it('posts the same keys the select and the checkboxes did', async () => {
    const user = userEvent.setup();
    const { container } = render(
      withIntl(<RuleForm slug="club" courtId="c1" rule={WEEKEND} onDone={() => {}} />),
    );
    const form = container.querySelector('form')!;

    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(posted(form, 'mode')).toEqual(['fixed']);
    expect(posted(form, 'resourceId')).toEqual(['c1']);
    expect(posted(form, 'dayOfWeek').map(Number).sort()).toEqual([0, 6]);

    // The row is a labelled group of toggle buttons, Monday first.
    const group = screen.getByRole('group', { name: p.field.days });
    const toggles = within(group).getAllByRole('button');
    expect(toggles.map((b) => b.textContent)).toEqual(
      ['1', '2', '3', '4', '5', '6', '0'].map((d) => day[d as keyof typeof day]),
    );
    expect(within(group).getByRole('button', { name: day['6'] })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(within(group).getByRole('button', { name: day['1'] }));
    await user.click(within(group).getByRole('button', { name: day['0'] }));
    expect(posted(form, 'dayOfWeek')).toEqual(['1', '6']);
  });

  it('a choice made in the effect combobox is what the form posts', async () => {
    const user = userEvent.setup();
    const { container } = render(withIntl(<RuleForm slug="club" courtId="c1" onDone={() => {}} />));
    const form = container.querySelector('form')!;

    expect(posted(form, 'mode')).toEqual(['multiplier']);
    expect(screen.getByLabelText(p.field.multiplier)).toHaveValue(1.25);

    await user.click(
      screen.getByRole('combobox', { name: `${p.field.effect}, ${p.effect.multiplier}` }),
    );
    await user.click(await screen.findByRole('option', { name: p.effect.fixed }));
    expect(posted(form, 'mode')).toEqual(['fixed']);
    // The amount resets to a price rather than keeping "1.25" as euros.
    expect(screen.getByLabelText(p.field.fixedPrice)).toHaveValue(0);

    // Picking the current value again keeps it: a rule always has an effect.
    await user.click(
      screen.getByRole('combobox', { name: `${p.field.effect}, ${p.effect.fixed}` }),
    );
    await user.click(await screen.findByRole('option', { name: p.effect.fixed }));
    expect(posted(form, 'mode')).toEqual(['fixed']);
  });
});

describe('delete, optimistically', () => {
  const ruleCard = (id: string) => document.querySelector(`[data-rule-id="${id}"]`);

  async function confirmDelete(name: string) {
    const card = screen.getByText(name).closest('li')!;
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: p.action.delete }));
    const dialog = await screen.findByRole('dialog', { name: p.delete.title });
    expect(dialog).toHaveTextContent(name);
    fireEvent.click(within(dialog).getByRole('button', { name: p.action.delete }));
  }

  it('THE POINT: the rule leaves at once, but the price waits for the server', async () => {
    const pending = deferred<{ ok: true }>();
    deletePricingRuleAction.mockReturnValue(pending.promise);
    const { container } = board();

    await confirmDelete(PEAK.name);

    await waitFor(() => expect(ruleCard('r1')).toBeNull());
    expect(ruleCard('r2')).not.toBeNull();
    expect(deletePricingRuleAction).toHaveBeenCalledWith('club', 'r1');
    // Money is never optimistic: the preview still prices the server's rules.
    expect(container.textContent).toContain(p.preview.via.replace('{name}', PEAK.name));

    await act(async () => pending.resolve({ ok: true }));
  });

  it('rolls back, and says so, when the action refuses', async () => {
    const pending = deferred<{ ok: false; error: string }>();
    deletePricingRuleAction.mockReturnValue(pending.promise);
    board();

    await confirmDelete(PEAK.name);
    await waitFor(() => expect(ruleCard('r1')).toBeNull());

    await act(async () => pending.resolve({ ok: false, error: 'nope' }));

    await waitFor(() => expect(ruleCard('r1')).not.toBeNull());
    expect(screen.getByRole('alert')).toHaveTextContent(PEAK.name);
  });

  it('rolls back when the action throws, too', async () => {
    deletePricingRuleAction.mockRejectedValue(new Error('network'));
    board();

    await confirmDelete(WEEKEND.name);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(WEEKEND.name));
    expect(ruleCard('r2')).not.toBeNull();
  });

  it('cancelling the dialog deletes nothing', async () => {
    board();
    const card = screen.getByText(PEAK.name).closest('li')!;
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: p.action.delete }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: p.action.cancel }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deletePricingRuleAction).not.toHaveBeenCalled();
    expect(ruleCard('r1')).not.toBeNull();
  });
});
