import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import {
  PlanEditor,
  type EditorCourt,
} from '@/app/(app)/t/[slug]/admin/courts/plan/[venueId]/PlanEditor';
import type { PlanPoint } from '@/lib/venues/plan';

import { messages, withIntl } from '../helpers/intl';

/**
 * The club's plan editor (#626), everything that is not the canvas: drawing a
 * court, the numbers and the moves that are the keyboard's way to edit it,
 * undo, and one save of only what changed. Dragging on the canvas is a
 * browser's: tests/e2e/plan-editor.spec.ts.
 */

const saveVenuePlanAction = jest.fn();
jest.mock('@/app/(app)/t/[slug]/admin/courts/actions', () => ({
  saveVenuePlanAction: (...args: unknown[]) => saveVenuePlanAction(...args),
}));

const p = messages.admin.courts.plan;

const RECT: PlanPoint[] = [
  [0, 0],
  [20, 0],
  [20, 10],
  [0, 10],
];

const COURTS: EditorCourt[] = [
  { resourceId: 'c1', name: 'Корт 1', sport: 'PADEL', outline: RECT, source: 'OSM' },
  { resourceId: 'c2', name: 'Корт 2', sport: 'TENNIS', outline: null, source: null },
];

function mount(courts = COURTS) {
  return render(withIntl(<PlanEditor slug="alpha" venueId="v1" courts={courts} features={[]} />));
}

const row = (name: string) => screen.getByRole('button', { name }).closest('li')!;
const saveButton = () => screen.getByRole('button', { name: p.save });

beforeEach(() => {
  saveVenuePlanAction.mockReset();
  saveVenuePlanAction.mockResolvedValue({ ok: true });
});

describe('the plan editor', () => {
  it('lists every court, on the plan or not, and credits OpenStreetMap', () => {
    mount();
    expect(within(row('Корт 1')).getByText(p.fromOsm)).toBeInTheDocument();
    expect(within(row('Корт 2')).getByText(p.notOnPlan)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: p.credit })).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('draws a court at its sport’s size, then saves only that court as drawn', async () => {
    mount();
    fireEvent.click(within(row('Корт 2')).getByRole('button', { name: p.draw }));

    expect(within(row('Корт 2')).getByText(p.onPlan)).toBeInTheDocument();
    expect(screen.getByText('1 незапазена промяна')).toBeInTheDocument();
    // Selected, with its numbers: a tennis court, 23.77 × 10.97 m.
    const panel = screen.getByRole('region', { name: 'Корт 2' });
    expect(within(panel).getByLabelText(p.length)).toHaveValue(23.8);
    expect(within(panel).getByLabelText(p.width)).toHaveValue(11);

    fireEvent.click(saveButton());
    await screen.findByText(p.saved);
    expect(saveVenuePlanAction).toHaveBeenCalledTimes(1);
    const [slug, venueId, changes] = saveVenuePlanAction.mock.calls[0]!;
    expect([slug, venueId]).toEqual(['alpha', 'v1']);
    expect(changes).toHaveLength(1);
    expect(changes[0].resourceId).toBe('c2');
    // Two metres east of Корт 1, level with its south side.
    const xs = (changes[0].outline as PlanPoint[]).map((pt) => pt[0]);
    const ys = (changes[0].outline as PlanPoint[]).map((pt) => pt[1]);
    expect(Math.min(...xs)).toBeCloseTo(22);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(23.77);
    expect(Math.min(...ys)).toBeCloseTo(0);
    // «Запазено» can show while the save's transition is still settling, and
    // the button reads «Запазване…» until it does (flaky on CI, #649).
    expect(await screen.findByRole('button', { name: p.save })).toBeDisabled();
  });

  it('edits by numbers and by the metre, and undoes one step at a time', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Корт 1' }));
    const panel = screen.getByRole('region', { name: 'Корт 1' });

    const length = within(panel).getByLabelText(p.length);
    fireEvent.change(length, { target: { value: '24' } });
    fireEvent.blur(length);
    expect(within(panel).getByLabelText(p.length)).toHaveValue(24);
    // Changed by the club: no longer OpenStreetMap's.
    expect(within(row('Корт 1')).getByText(p.onPlan)).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: p.east }));
    expect(screen.getByText('1 незапазена промяна')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: p.undo }));
    fireEvent.click(screen.getByRole('button', { name: p.undo }));
    expect(within(panel).getByLabelText(p.length)).toHaveValue(20);
    expect(within(row('Корт 1')).getByText(p.fromOsm)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: p.undo })).toBeDisabled();
    expect(saveButton()).toBeDisabled();
  });

  it('takes a court off the plan, and saves that as no outline', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Корт 1' }));
    fireEvent.click(screen.getByRole('button', { name: p.remove }));
    expect(within(row('Корт 1')).getByText(p.notOnPlan)).toBeInTheDocument();
    expect(screen.getByText(p.empty)).toBeInTheDocument();

    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(saveVenuePlanAction).toHaveBeenCalledWith('alpha', 'v1', [
        { resourceId: 'c1', outline: null },
      ]),
    );
  });

  it('says when the save failed, and keeps the changes', async () => {
    saveVenuePlanAction.mockResolvedValue({ ok: false, error: 'invalid' });
    mount();
    fireEvent.click(within(row('Корт 2')).getByRole('button', { name: p.draw }));
    fireEvent.click(saveButton());
    await screen.findByText(p.failed);
    expect(await screen.findByRole('button', { name: p.save })).toBeEnabled();
  });
});
