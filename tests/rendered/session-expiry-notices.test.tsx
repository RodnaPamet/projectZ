import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Providers } from '@/app/providers';
import { __resetSessionExpiryForTests, markSessionExpired } from '@/lib/auth/session-expiry';
import { __resetViewerForTests, noteViewerChanged } from '@/lib/data/viewer';
import { ViewerChangedNotice } from '@/lib/data/viewer-changed-notice';

import { messages, withIntl } from '../helpers/intl';

/**
 * The two app-wide "this page is out of date" notices, mounted once by
 * src/app/providers.tsx: inflect's session-expired notice (vendored) and
 * playerz's viewer-changed one (#263). Rendered through the real Providers, so
 * a notice that is not mounted, or mounted twice, fails here.
 */

const panels = (
  messages as unknown as {
    panels: Record<'sessionExpired' | 'viewerChanged', { body: string; action: string }>;
  }
).panels;

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

function mount() {
  return render(withIntl(<Providers>page</Providers>));
}

it('shows nothing while the session is live and the viewer unchanged', () => {
  mount();
  expect(screen.queryByText(panels.sessionExpired.body)).not.toBeInTheDocument();
  expect(screen.queryByText(panels.viewerChanged.body)).not.toBeInTheDocument();
});

it('one session-expired notice, offering /login rather than redirecting', () => {
  mount();
  act(() => markSessionExpired());

  expect(screen.getAllByText(panels.sessionExpired.body)).toHaveLength(1);
  expect(screen.getByRole('link', { name: panels.sessionExpired.action })).toHaveAttribute(
    'href',
    '/login',
  );
});

it('the session notice sits below the notch: its wrapper adds the safe-area inset', () => {
  mount();
  act(() => markSessionExpired());

  const notice = document.getElementById('session-expired-notice')!;
  // jsdom cannot compute env(); the class carrying it is what is checked.
  expect(notice.parentElement!.className).toContain(
    '[&>#session-expired-notice]:pt-[calc(0.75rem+env(safe-area-inset-top))]',
  );
  expect(notice.parentElement!.className).toContain('contents');
});

it('a viewer change shows its own notice, once', async () => {
  mount();
  act(() => noteViewerChanged());
  expect(screen.getAllByText(panels.viewerChanged.body)).toHaveLength(1);
  expect(screen.getByRole('button', { name: panels.viewerChanged.action })).toBeInTheDocument();
});

it('its action reloads the document (location.reload, not a router push)', async () => {
  const reload = jest.fn();
  render(withIntl(<ViewerChangedNotice reload={reload} />));
  act(() => noteViewerChanged());

  await userEvent.click(screen.getByRole('button', { name: panels.viewerChanged.action }));
  expect(reload).toHaveBeenCalledTimes(1);
});
