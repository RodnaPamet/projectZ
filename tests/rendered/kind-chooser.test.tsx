import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { afterChoosing, KindChooser, kindErrorKey } from '@/app/(app)/start/kind/KindChooser';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { ApiClientError } from '@/lib/data/errors';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok } from '../unit/data/fake-v1';

const replace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/start/kind',
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * #360: "Играч или треньор?" against the REAL Bulgarian catalogue and a fake
 * v1. Nothing is chosen for the person; the choice is posted once; a player
 * lands on Играй, a coach on the player UI, and anybody with somewhere to go
 * back to (an invite link) goes back there.
 */
const k = messages.onboarding.kind;

function mount(next: string | null = null) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <ViewerScope viewerId="usr_new">
            <KindChooser next={next} />
          </ViewerScope>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

beforeEach(() => {
  replace.mockReset();
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('the kind chooser', () => {
  it('offers Играч and Треньор, nothing chosen, and no Club', () => {
    installFakeFetch(() => ok({}));
    mount();
    expect(screen.getByText(k.player.label)).toBeInTheDocument();
    expect(screen.getByText(k.coach.label)).toBeInTheDocument();
    expect(screen.getByText(k.coach.description)).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByTestId('kind-continue')).toBeDisabled();
  });

  it('posts PLAYER and lands on Играй', async () => {
    const calls = installFakeFetch(() => ok({ accountKind: 'PLAYER' }));
    mount();
    fireEvent.click(screen.getByTestId('kind-PLAYER'));
    fireEvent.click(screen.getByTestId('kind-continue'));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/venues'));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/v1/me/account-kind');
    expect(post.body).toEqual({ kind: 'PLAYER' });
  });

  it('goes back to where it was sent from', async () => {
    installFakeFetch(() => ok({ accountKind: 'PLAYER' }));
    mount('/invite/booking/abc');
    fireEvent.click(screen.getByTestId('kind-PLAYER'));
    fireEvent.click(screen.getByTestId('kind-continue'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/invite/booking/abc'));
  });

  it('says why when the server refuses', async () => {
    installFakeFetch(() => fail(409, 'ACCOUNT_KIND_NOT_ALLOWED'));
    mount();
    fireEvent.click(screen.getByTestId('kind-COACH'));
    fireEvent.click(screen.getByTestId('kind-continue'));
    expect(await screen.findByTestId('kind-error')).toHaveTextContent(k.error.NOT_ALLOWED);
    expect(replace).not.toHaveBeenCalled();
  });

  it('chosen already in another tab: carries on rather than showing an error', async () => {
    installFakeFetch(() => fail(409, 'ACCOUNT_KIND_ALREADY_SET'));
    mount();
    fireEvent.click(screen.getByTestId('kind-COACH'));
    fireEvent.click(screen.getByTestId('kind-continue'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/me/bookings'));
  });
});

describe('afterChoosing and kindErrorKey', () => {
  it('a player to Играй, a coach to the player UI, unless there is somewhere to go back to', () => {
    expect(afterChoosing('PLAYER', null)).toBe('/venues');
    expect(afterChoosing('COACH', null)).toBe('/me/bookings');
    expect(afterChoosing('COACH', '/invite/booking/x')).toBe('/invite/booking/x');
  });
  it('maps the refusals', () => {
    const e = (code: string) => new ApiClientError({ status: 409, code, message: code });
    expect(kindErrorKey(e('ACCOUNT_KIND_ALREADY_SET'))).toBe('ALREADY_SET');
    expect(kindErrorKey(e('ACCOUNT_KIND_NOT_ALLOWED'))).toBe('NOT_ALLOWED');
    expect(kindErrorKey(new Error('x'))).toBe('FAILED');
  });
});
