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
const ALL_ON = {
  email: {
    confirmation: true,
    reminder: true,
    clubChanges: true,
    messages: true,
    openPlay: true,
    lessonsTaught: true,
  },
  push: {
    confirmation: true,
    reminder: true,
    clubChanges: true,
    messages: true,
    openPlay: true,
    lessonsTaught: true,
  },
  pushDevices: 0,
};

function mount(coach = false) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), revalidateOnMount: false }}>
          <TooltipProvider>
            <ViewerScope viewerId="usr_player">
              <NotificationSettingsRow seed={ALL_ON} coach={coach} />
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
      stored = { ...stored, email: { ...stored.email, ...body.email } };
    }
    return ok(stored);
  });
  mount();
  expect(screen.getByTestId('profile-notifications-summary')).toHaveTextContent(
    t.summary.replace('{on}', '5').replace('{total}', '5'),
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
    t.summary.replace('{on}', '4').replace('{total}', '5'),
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

describe('«Уроци, които водя»: the sixth switch (#550, decision 22)', () => {
  it('a player is not shown it, and is not told they have five of six', async () => {
    installFakeFetch(() => ok(ALL_ON));
    mount();
    expect(screen.getByTestId('profile-notifications-summary')).toHaveTextContent(
      t.summary.replace('{on}', '5').replace('{total}', '5'),
    );
    fireEvent.click(screen.getByRole('button', { name: t.editLabel }));
    expect(await screen.findByText(t.sheetDescription)).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(5);
    expect(screen.queryByRole('switch', { name: t.lessonsTaught })).toBeNull();
  });

  it('a coach has it, counted with the rest, and turning it off PATCHes just that', async () => {
    let stored = ALL_ON;
    const calls = installFakeFetch((c) => {
      if (c.method === 'PATCH') {
        const body = c.body as { email: Partial<typeof ALL_ON.email> };
        stored = { ...stored, email: { ...stored.email, ...body.email } };
      }
      return ok(stored);
    });
    mount(true);
    expect(screen.getByTestId('profile-notifications-summary')).toHaveTextContent(
      t.summary.replace('{on}', '6').replace('{total}', '6'),
    );
    fireEvent.click(screen.getByRole('button', { name: t.editLabel }));
    const lessons = await screen.findByRole('switch', { name: t.lessonsTaught });
    expect(screen.getAllByRole('switch')).toHaveLength(6);
    expect(lessons).toBeChecked();
    fireEvent.click(lessons);
    await waitFor(() => expect(lessons).not.toBeChecked());
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      email: { lessonsTaught: false },
    });
    expect(screen.getByTestId('profile-notifications-summary')).toHaveTextContent(
      t.summary.replace('{on}', '5').replace('{total}', '6'),
    );
  });

  it('the cancellation switch says it covers a coach’s cancel too (decision 23)', () => {
    expect(t.clubChanges).toBe('Отмяна от клуба или треньора');
  });
});
