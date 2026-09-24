import { render, screen } from '@testing-library/react';

import { EngineAttribution } from '@/components/chess/EngineAttribution';
import { ENGINE_SOURCE_URL } from '@/lib/chess/engine';

import { withIntl } from '../helpers/intl';

/**
 * The attribution is a GPL-3 CONDITION, not a credit.
 *
 * The licence requires that recipients can obtain the source. A link that does
 * not render, or renders without an href, satisfies nothing — so this asserts on
 * what a USER actually sees.
 */
describe('the Stockfish attribution', () => {
  it('renders a working link to the SOURCE', () => {
    render(withIntl(<EngineAttribution />));

    const source = screen.getByRole('link', { name: /stockfish/i });
    expect(source).toHaveAttribute('href', ENGINE_SOURCE_URL);
  });

  it('renders a link to the LICENCE text', () => {
    render(withIntl(<EngineAttribution />));

    const licence = screen.getByRole('link', { name: /gpl/i });
    expect(licence).toHaveAttribute('href', '/engine/LICENSE');
  });

  it('names the engine and says it is unmodified', () => {
    render(withIntl(<EngineAttribution />));

    // Bulgarian: "използван без промени" — the licence NAME stays Latin.
    expect(screen.getByText(/без промени/)).toBeInTheDocument();
  });
});
