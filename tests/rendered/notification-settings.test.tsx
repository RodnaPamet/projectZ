import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { NotificationSettingsRow } from '@/components/profile/NotificationSettingsRow';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok } from '../unit/data/fake-v1';

/** "Известия" on /me/profile (#367): one switch per email category. */

const t = messages.profile.notifications;
const ALL_ON = { email: { confirmation: true, reminder: true, clubChanges: true } };

function mount() {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), revalidateOnMount: false }}>
          <TooltipProvider>
            <ViewerScope viewerId="usr_player">
              <NotificationSettingsRow seed={ALL_ON} />
            </ViewerScope>
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

it('says how many emails are on, and turning the reminder off PATCHes just that', async () => {
  // The server as it is: a GET after the PATCH reads what the PATCH stored.
  let stored = ALL_ON;
  const calls = installFakeFetch((c) => {
    if (c.method === 'PATCH') {
      const body = c.body as { email: Partial<typeof ALL_ON.email> };
      stored = { email: { ...stored.email, ...body.email } };
    }
    return ok(stored);
  });
  mount();
  expect(screen.getByTestId('profile-notifications-summary')).toHaveTextContent(
    t.summary.replace('{on}', '3').replace('{total}', '3'),
  );

  fireEvent.click(screen.getByRole('button', { name: t.editLabel }));
  expect(await screen.findByText(t.sheetDescription)).toBeInTheDocument();
  const reminder = screen.getByRole('switch', { name: t.reminder });
  expect(reminder).toBeChecked();
  fireEvent.click(reminder);

  await waitFor(() => expect(reminder).not.toBeChecked());
  const patch = calls.find((c) => c.method === 'PATCH')!;
  expect(patch.url).toBe('/api/v1/me/notification-settings');
  expect(patch.body).toEqual({ email: { reminder: false } });
  expect(screen.getByTestId('profile-notifications-summary')).toHaveTextContent(
    t.summary.replace('{on}', '2').replace('{total}', '3'),
  );
});

it('a refused save puts the switch back and says so', async () => {
  installFakeFetch((c) => (c.method === 'PATCH' ? fail(500, 'INTERNAL') : ok(ALL_ON)));
  mount();
  fireEvent.click(screen.getByRole('button', { name: t.editLabel }));
  const club = await screen.findByRole('switch', { name: t.clubChanges });
  fireEvent.click(club);

  expect(await screen.findByTestId('profile-notifications-failed')).toHaveTextContent(t.saveFailed);
  await waitFor(() => expect(club).toBeChecked());
});
