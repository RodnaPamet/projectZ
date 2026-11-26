import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import type { MyCalendarDto } from '@/app/api/v1/_lib/dto';
import { GoogleCalendarRow } from '@/components/profile/GoogleCalendarRow';
import { GOOGLE_CALENDAR_DISCLOSURE_VERSION } from '@/lib/google-calendar/disclosure';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * «Синхронизирай с Google Календар» on the profile (owner 2026-11-14): one
 * switch; under it, while connected, the account, the last sync and
 * «Синхронизирай сега»; off disconnects; a revoked connection says so. On
 * asks first (#713): the disclosure, with «Свържи» and «Отказ».
 */
const c = messages.profile.calendar;

const disclosure: MyCalendarDto['disclosure'] = {
  version: GOOGLE_CALENDAR_DISCLOSURE_VERSION,
  title: c.disclosure.title,
  points: [],
  connect: c.disclosure.connect,
  cancel: c.disclosure.cancel,
};
const off: MyCalendarDto = {
  google: {
    connected: false,
    email: null,
    lastSyncAt: null,
    lastResult: null,
    error: null,
    disclosureVersion: null,
  },
  disclosure,
};
const on: MyCalendarDto = {
  disclosure,
  google: {
    disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE_VERSION,
    connected: true,
    email: 'ivan@gmail.test',
    lastSyncAt: '2026-11-14T10:00:00.000Z',
    lastResult: {
      created: 2,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      skippedEdited: 0,
      partial: false,
    },
    error: null,
  },
};

function mount(seed: MyCalendarDto, result: string | null = null) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <ViewerScope viewerId="usr_player">
            <GoogleCalendarRow seed={seed} result={result} privacyHref="/privacy" />
          </ViewerScope>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

it('off: the switch alone, no account and no sync button', () => {
  installFakeFetch(() => ok(off));
  mount(off);
  expect(screen.getByRole('switch', { name: c.switch })).not.toBeChecked();
  expect(screen.queryByRole('button', { name: c.syncNow })).toBeNull();
});

it('on: the Google account, the last sync, and «Синхронизирай сега» posts a sync', async () => {
  const calls = installFakeFetch((call) =>
    ok(call.method === 'POST' ? { ...on.google.lastResult, created: 0, unchanged: 2 } : on),
  );
  mount(on);
  expect(screen.getByRole('switch', { name: c.switch })).toBeChecked();
  expect(screen.getByText(c.connectedAs.replace('{email}', 'ivan@gmail.test'))).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: c.syncNow }));
  await screen.findByText(c.done);
  expect(calls.some((x) => x.method === 'POST' && x.url.endsWith('/me/calendar/google/sync'))).toBe(
    true,
  );
});

it('switching off sends DELETE and hides the connected rows', async () => {
  const calls = installFakeFetch((call) => (call.method === 'DELETE' ? ok(undefined) : ok(off)));
  mount(on);
  fireEvent.click(screen.getByRole('switch', { name: c.switch }));
  await waitFor(() => expect(calls.some((x) => x.method === 'DELETE')).toBe(true));
  await waitFor(() => expect(screen.queryByRole('button', { name: c.syncNow })).toBeNull());
});

it('a revoked connection asks to connect again; the way back from Google says how it went', () => {
  const revoked: MyCalendarDto = { ...off, google: { ...off.google, error: 'GOOGLE_REVOKED' } };
  installFakeFetch(() => ok(revoked));
  mount(revoked, 'access_denied');
  expect(screen.getByText(c.error.GOOGLE_REVOKED)).toBeInTheDocument();
  expect(screen.getByText(c.result.access_denied)).toBeInTheDocument();
});

it('switching on shows the disclosure first; «Отказ» leaves it off and asks Google nothing', async () => {
  const calls = installFakeFetch(() => ok(off));
  mount(off);
  fireEvent.click(screen.getByRole('switch', { name: c.switch }));
  const dialog = await screen.findByTestId('profile-google-calendar-disclosure');
  for (const point of ['created', 'freeBusy', 'coPlayers', 'assistant', 'off'] as const) {
    expect(dialog).toHaveTextContent(c.disclosure[point]);
  }
  expect(screen.getByRole('link', { name: messages.profile.legal.privacy })).toHaveAttribute(
    'href',
    '/privacy',
  );
  fireEvent.click(screen.getByRole('button', { name: c.disclosure.cancel }));
  await waitFor(() =>
    expect(screen.queryByTestId('profile-google-calendar-disclosure')).toBeNull(),
  );
  expect(screen.getByRole('switch', { name: c.switch })).not.toBeChecked();
  expect(calls.some((x) => x.method === 'POST')).toBe(false);
});

it('«Свържи» starts the consent and names the disclosure the person agreed to', async () => {
  const calls = installFakeFetch((call) =>
    call.method === 'POST' ? ok({ authorizeUrl: 'about:blank#consent' }) : ok(off),
  );
  mount(off);
  fireEvent.click(screen.getByRole('switch', { name: c.switch }));
  fireEvent.click(await screen.findByRole('button', { name: c.disclosure.connect }));
  await waitFor(() =>
    expect(calls.find((x) => x.method === 'POST')?.body).toEqual({
      client: 'web',
      disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE_VERSION,
    }),
  );
});
