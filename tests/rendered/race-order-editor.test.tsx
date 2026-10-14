import { fireEvent, render, screen, within } from '@testing-library/react';

import { RaceOrderEditor } from '@/components/results/RaceOrderEditor';

import { messages, withIntl } from '../helpers/intl';

/**
 * #577: a karting session's finishing order, as the track enters it, against
 * the real Bulgarian catalogue. Drivers move up and down; one switched off
 * did not race; fewer than two is stopped before anything is sent.
 */
const race = messages.results.race;
const DRIVERS = [
  { userId: 'u_ana', name: 'Ана', deleted: false },
  { userId: 'u_boris', name: 'Борис', deleted: false },
  { userId: 'u_cveta', name: 'Цвета', deleted: false },
];

function mount(onSubmit: (order: string[]) => void) {
  return render(
    withIntl(
      <RaceOrderEditor
        drivers={DRIVERS}
        busy={false}
        submitLabel="Запази"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    ),
  );
}

describe('the finishing order', () => {
  it('moves a driver up, leaves one out, and sends the order first to last', () => {
    const onSubmit = jest.fn();
    mount(onSubmit);

    fireEvent.click(screen.getByRole('button', { name: race.up.replace('{name}', 'Цвета') }));
    fireEvent.click(screen.getByRole('switch', { name: race.raced.replace('{name}', 'Ана') }));

    const rows = screen.getAllByTestId('race-order-driver');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Ана'),
      expect.stringContaining('Цвета'),
      expect.stringContaining('Борис'),
    ]);
    // Ана is out: Цвета is first, Борис second.
    expect(within(rows[1]!).getByText('1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('race-order-submit'));
    expect(onSubmit).toHaveBeenCalledWith(['u_cveta', 'u_boris']);
  });

  it('two drivers at least', () => {
    const onSubmit = jest.fn();
    mount(onSubmit);
    for (const name of ['Ана', 'Борис']) {
      fireEvent.click(screen.getByRole('switch', { name: race.raced.replace('{name}', name) }));
    }
    fireEvent.click(screen.getByTestId('race-order-submit'));
    expect(screen.getByTestId('race-order-problem')).toHaveTextContent(race.problem);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
