import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { FavouriteButton } from '@/components/venues/FavouriteButton';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { installFakeFetch, ok } from '../unit/data/fake-v1';

/** The heart on a venue (#672): none signed out; on and off, saved behind it. */
const f = messages.venues.favourite;

function mount(viewerId: string | null) {
  const button = <FavouriteButton venueId="v1" />;
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          {viewerId ? <ViewerScope viewerId={viewerId}>{button}</ViewerScope> : button}
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

it('is not there signed out', () => {
  installFakeFetch(() => ok({ ids: [], items: [] }));
  mount(null);
  expect(screen.queryByRole('button')).toBeNull();
});

it('hearts with PUT and unhearts with DELETE, pressed state following', async () => {
  let ids: string[] = [];
  const calls = installFakeFetch((c) => {
    if (c.method === 'PUT') ids = ['v1'];
    if (c.method === 'DELETE') ids = [];
    return ok(c.method === 'GET' ? { ids, items: [] } : { favourite: ids.length > 0 });
  });
  mount('usr_player');

  const add = await screen.findByRole('button', { name: f.add });
  expect(add).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(add);
  const remove = await screen.findByRole('button', { name: f.remove });
  expect(remove).toHaveAttribute('aria-pressed', 'true');
  await waitFor(() =>
    expect(
      calls.some((c) => c.method === 'PUT' && c.url.endsWith('/me/favourites/venues/v1')),
    ).toBe(true),
  );

  fireEvent.click(remove);
  await screen.findByRole('button', { name: f.add });
  await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
});
