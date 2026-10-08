import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import {
  DeleteAccountSection,
  type DeletionStandingView,
} from '@/components/profile/DeleteAccountSection';
import { deleteErrorKey } from '@/components/profile/DeleteAccountDialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { ApiClientError } from '@/lib/data/errors';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch } from '../unit/data/fake-v1';

/**
 * "Изтриване на профила" on /me/profile (#370), against the real Bulgarian
 * catalogue and a fake v1: a club account told to write in, a player with
 * upcoming bookings told what to do with each, and a player who may delete,
 * through the typed confirmation to the sign-out.
 */
const signOut = jest.fn();
jest.mock('next-auth/react', () => ({ signOut: (...a: unknown[]) => signOut(...a) }));

const t = messages.profile.delete;

function wrap(standing: DeletionStandingView) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <TooltipProvider>
            <ViewerScope viewerId="usr_ivo">
              <DeleteAccountSection standing={standing} />
            </ViewerScope>
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

const upcoming = (
  over: Partial<Extract<DeletionStandingView, { kind: 'blocked' }>['bookings'][number]>,
) => ({
  bookingId: 'bk1',
  venueName: 'Алфа Кортове',
  courtName: 'Корт 1',
  timezone: 'Europe/Sofia',
  startTs: '2026-10-20T16:00:00.000Z',
  endTs: '2026-10-20T17:00:00.000Z',
  role: 'BOOKER' as const,
  cure: 'cancel' as const,
  cancellableUntil: '2026-10-19T16:00:00.000Z',
  deletableFrom: '2026-10-20T17:00:00.000Z',
  ...over,
});

beforeEach(() => {
  signOut.mockReset();
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('a club account', () => {
  it('cannot delete itself: it is told to write in, with a link to the contact form', () => {
    installFakeFetch(() => ({ status: 200, body: { data: {} } }));
    wrap({ kind: 'club' });
    const box = screen.getByTestId('profile-delete-club');
    expect(box).toHaveTextContent(t.club.title);
    expect(box).toHaveTextContent(t.club.body);
    expect(within(box).getByRole('link', { name: t.club.contact })).toHaveAttribute(
      'href',
      '/#clubs',
    );
    expect(screen.queryByTestId('profile-delete-button')).toBeNull();
  });
});

describe('upcoming bookings first', () => {
  it('lists each, linked to its page, says what to do, and holds the button back', () => {
    installFakeFetch(() => ({ status: 200, body: { data: {} } }));
    wrap({
      kind: 'blocked',
      total: 4,
      credit: [],
      bookings: [
        upcoming({}),
        upcoming({ bookingId: 'bk2', role: 'PARTICIPANT', cure: 'leave' }),
        upcoming({ bookingId: 'bk3', cure: 'wait' }),
      ],
    });

    expect(screen.getByTestId('profile-delete-blocked')).toHaveTextContent(t.blocked.title);
    const links = screen.getAllByTestId('profile-delete-booking');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/me/bookings/bk1',
      '/me/bookings/bk2',
      '/me/bookings/bk3',
    ]);
    expect(links[0]).toHaveTextContent('Алфа Кортове');
    // Each says its own cure: cancel until the cutoff, leave, or wait until it ends.
    expect(links[0]).toHaveTextContent('Можете да я отмените до');
    expect(links[1]).toHaveTextContent(t.blocked.leave);
    expect(links[2]).toHaveTextContent('Профилът ще може да се изтрие след');
    expect(links[2]).toHaveTextContent('20:00');
    // Four in all, three listed.
    expect(screen.getByTestId('profile-delete-blocked')).toHaveTextContent('И още 1 резервация.');

    expect(screen.getByTestId('profile-delete-button')).toBeDisabled();
    // No credit, no word about it.
    expect(screen.queryByTestId('profile-delete-credit')).toBeNull();
  });

  it('credit at a club is said to be lost here too, before the bookings are dealt with', () => {
    installFakeFetch(() => ({ status: 200, body: { data: {} } }));
    wrap({
      kind: 'blocked',
      total: 1,
      bookings: [upcoming({})],
      credit: [{ club: 'Клуб Алфа', balanceCents: 1250 }],
    });
    expect(screen.getByTestId('profile-delete-credit')).toHaveTextContent(t.credit.title);
    expect(screen.getByTestId('profile-delete-credit-club')).toHaveTextContent('Клуб Алфа: 12,50');
  });
});

describe('a player who may delete', () => {
  it('says what goes and what stays, then asks for the word before the button works', async () => {
    const calls = installFakeFetch(() => ({ status: 204 }));
    wrap({ kind: 'allowed', credit: [] });
    expect(screen.getByTestId('profile-delete-allowed')).toHaveTextContent('Изтрит потребител');

    fireEvent.click(screen.getByTestId('profile-delete-button'));
    const input = await screen.findByTestId('delete-account-confirm-input');
    const confirm = screen.getByTestId('delete-account-confirm');
    expect(screen.getByTestId('delete-account-dialog')).toHaveTextContent(t.dialog.body);
    expect(confirm).toBeDisabled();

    fireEvent.change(input, { target: { value: 'изтри' } });
    expect(confirm).toBeDisabled();
    // A Latin keyboard: the English word works in the Bulgarian page.
    fireEvent.change(input, { target: { value: ' delete ' } });
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    await waitFor(() => expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/?account=deleted' }));
    expect(calls.map((c) => [c.method, c.url])).toEqual([['DELETE', '/api/v1/me']]);
    // The page's own account, as every write sends it.
    expect(calls[0]!.headers['x-playerz-viewer']).toBe('usr_ivo');
  });

  it('a refusal keeps the dialog open, says why, and does not sign out', async () => {
    installFakeFetch(() => fail(409, 'UPCOMING_BOOKINGS'));
    wrap({ kind: 'allowed', credit: [] });
    fireEvent.click(screen.getByTestId('profile-delete-button'));
    fireEvent.change(await screen.findByTestId('delete-account-confirm-input'), {
      target: { value: 'ИЗТРИЙ' },
    });
    fireEvent.click(screen.getByTestId('delete-account-confirm'));

    expect(await screen.findByTestId('delete-account-error')).toHaveTextContent(
      t.error.UPCOMING_BOOKINGS,
    );
    expect(signOut).not.toHaveBeenCalled();
    expect(screen.getByTestId('delete-account-dialog')).toBeInTheDocument();
  });

  it('unused credit: listed as lost, club by club, in the section and again in the dialog; the button still works', async () => {
    const calls = installFakeFetch(() => ({ status: 204 }));
    wrap({
      kind: 'allowed',
      credit: [
        { club: 'Клуб Алфа', balanceCents: 1250 },
        { club: 'Клуб Бета', balanceCents: 300 },
      ],
    });
    const section = screen.getByTestId('profile-delete-allowed');
    const notice = within(section).getByTestId('profile-delete-credit');
    expect(notice).toHaveTextContent(t.credit.title);
    expect(notice).toHaveTextContent(t.credit.body);
    expect(
      within(notice)
        .getAllByTestId('profile-delete-credit-club')
        .map((l) => l.textContent),
    ).toEqual([
      expect.stringMatching(/^Клуб Алфа: 12,50\s€$/),
      expect.stringMatching(/^Клуб Бета: 3,00\s€$/),
    ]);
    // Warn, then allow (owner): the button is not held back.
    expect(screen.getByTestId('profile-delete-button')).toBeEnabled();

    fireEvent.click(screen.getByTestId('profile-delete-button'));
    const dialog = await screen.findByTestId('delete-account-dialog');
    expect(within(dialog).getByTestId('profile-delete-credit')).toHaveTextContent(
      'Клуб Бета: 3,00',
    );
    fireEvent.change(screen.getByTestId('delete-account-confirm-input'), {
      target: { value: 'ИЗТРИЙ' },
    });
    fireEvent.click(screen.getByTestId('delete-account-confirm'));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(calls.map((c) => c.method)).toEqual(['DELETE']);
  });
});

describe('deleteErrorKey', () => {
  const e = (status: number, code: string) => new ApiClientError({ status, code, message: code });

  it.each([
    [e(409, 'UPCOMING_BOOKINGS'), 'UPCOMING_BOOKINGS'],
    [e(403, 'CLUB_ACCOUNT_DELETION_BY_REQUEST'), 'CLUB'],
    [e(429, 'RATE_LIMITED'), 'RATE_LIMITED'],
    [e(500, 'INTERNAL'), 'FAILED'],
    [new Error('offline'), 'FAILED'],
  ])('%#: maps to %s', (err, key) => expect(deleteErrorKey(err)).toBe(key));
});
