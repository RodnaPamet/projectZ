import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import AppError from '@/app/(app)/error';
import PublicError from '@/app/(public)/error';

import { messages, withIntl } from '../helpers/intl';

/**
 * The route-group error boundaries. Before them a thrown render fell through to
 * Next's built-in English screen; now it is ErrorState, in Bulgarian, with a
 * retry that re-fetches the segment and the digest that finds the log line.
 */

const common = (
  messages as unknown as {
    common: { retry: string; error: { title: string; body: string; errorId: string } };
  }
).common;

describe.each([
  ['(app)', AppError],
  ['(public)', PublicError],
])('%s/error.tsx', (_group, Boundary) => {
  it('says what happened in the catalogue’s words and retries on demand', async () => {
    const retry = jest.fn();
    render(withIntl(<Boundary error={new Error('boom')} retry={retry} />));

    expect(screen.getByRole('alert')).toHaveTextContent(common.error.title);
    expect(screen.getByText(common.error.body)).toBeInTheDocument();
    // The old body pointed at "the sidebar" — inflect's, and playerz has none.
    expect(common.error.body).not.toMatch(/лента/);
    expect(screen.queryByText('boom')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: common.retry }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows the digest when the server gave one', () => {
    const error = Object.assign(new Error('x'), { digest: 'd1g3st' });
    render(withIntl(<Boundary error={error} retry={() => {}} />));
    expect(screen.getByText(common.error.errorId.replace('{id}', 'd1g3st'))).toBeInTheDocument();
  });
});
