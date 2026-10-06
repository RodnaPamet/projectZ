import { globSync } from 'node:fs';
import path from 'node:path';

import { render, screen } from '@testing-library/react';

import { RouteSkeleton } from '@/components/loading/route-skeleton';

import { messages, withIntl } from '../helpers/intl';

/**
 * What a person, or a screen reader, gets in the moment after a tap (T12).
 *
 * tests/guardrails/loading-states.test.ts checks the SOURCE of every
 * loading.tsx; this renders each one, in Bulgarian, and checks what comes
 * out: one busy status region, named from the catalogue, with bars a screen
 * reader skips, and nothing the perf harness would take for the page itself.
 */

describe('RouteSkeleton', () => {
  it('is a busy status region named "loading" in Bulgarian', () => {
    render(
      withIntl(
        <RouteSkeleton>
          <div data-testid="bars" aria-hidden="true" />
        </RouteSkeleton>,
      ),
    );

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent(messages.common.loading);
    expect(screen.getByTestId('bars')).toBeInTheDocument();
  });

  it('keeps the label visually hidden, so the skeleton is all a sighted user sees', () => {
    render(withIntl(<RouteSkeleton>{null}</RouteSkeleton>));
    expect(screen.getByText(messages.common.loading)).toHaveClass('sr-only');
  });
});

const ROOT = path.resolve(__dirname, '../..');

/**
 * Skeletons that carry ONE real link, by design, and where it goes. The venue
 * page's skeleton renders its real back link to /venues (#403): it is usable
 * while the page loads, and it is the client reference that makes a card's
 * auto prefetch fetch the page's JS chunk (VenueBackLink.tsx). No READY
 * condition in the perf harness is a link to /venues, and the step that
 * clicks one runs only after the venue page is ready, so the harness cannot
 * mistake it for the page.
 */
const SKELETON_LINKS: Record<string, string> = {
  'src/app/(public)/venues/[slug]/loading.tsx': '/venues',
};
const LOADING = globSync('src/app/**/loading.tsx', { cwd: ROOT })
  .map((f) => f.toString())
  .sort();

describe.each(LOADING)('%s', (file) => {
  const { default: Loading } = require(path.join(ROOT, file)) as {
    default: () => React.ReactElement;
  };

  it('renders exactly one busy status region, labelled from the catalogue', () => {
    render(withIntl(<Loading />));
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent(messages.common.loading);
  });

  it('draws bars, and hides them from screen readers', () => {
    const { container } = render(withIntl(<Loading />));
    const bars = container.querySelectorAll('[aria-hidden="true"]');
    expect(bars.length).toBeGreaterThan(2);
  });

  it('has no heading, link or READY marker the harness could take for the page', () => {
    const { container } = render(withIntl(<Loading />));
    expect(screen.queryByRole('heading')).toBeNull();
    const allowed = SKELETON_LINKS[file];
    if (allowed) {
      expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([allowed]);
    } else {
      expect(screen.queryByRole('link')).toBeNull();
    }
    expect(container.querySelector('[data-perf-ready]')).toBeNull();
  });
});
