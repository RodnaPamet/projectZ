import { fireEvent, render, screen } from '@testing-library/react';
import { signOut } from 'next-auth/react';
import { NextIntlClientProvider } from 'next-intl';

import { InviteRefusal } from '@/app/(public)/invite/[token]/InviteRefusal';
import type { AccountKindRefusal } from '@/lib/auth/account-kind';

import bg from '../../messages/bg.json';
import en from '../../messages/en.json';

jest.mock('next-auth/react', () => ({ signOut: jest.fn() }));

/**
 * "ACCEPT THIS WITH A SEPARATE ACCOUNT" — IN WORDS SOMEBODY CAN ACT ON (#263).
 *
 * An invitation opened with the wrong kind of account is refused before the
 * Accept button, with what to do about it. These assert the words, in BOTH
 * catalogues — a refusal whose key is missing renders `invite.refusal.X.title`,
 * which is the one message nobody can act on — and that the way out keeps the
 * invitation: sign out, straight back to sign-in with this link as `next`.
 */

const REFUSALS: AccountKindRefusal[] = [
  'SEPARATE_ACCOUNT_REQUIRED',
  'CLUB_ACCOUNT_TAKEN',
  'PLAYER_ACCOUNT_REQUIRED',
  'COACH_ACCOUNT_REQUIRED',
  'ACCOUNT_KIND_UNDECIDED',
];

const catalogues = { bg, en } as const;

function renderIn(locale: 'bg' | 'en', refusal: AccountKindRefusal) {
  return render(
    <NextIntlClientProvider locale={locale} messages={catalogues[locale]}>
      <InviteRefusal refusal={refusal} invitePath="/invite/tok_abc" />
    </NextIntlClientProvider>,
  );
}

describe('InviteRefusal', () => {
  describe.each(['bg', 'en'] as const)('in %s', (locale) => {
    const copy = catalogues[locale].invite.refusal;

    it.each(REFUSALS)('explains %s in words, not a key', (refusal) => {
      renderIn(locale, refusal);

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(copy[refusal].title);
      expect(alert).toHaveTextContent(copy[refusal].description);
      expect(alert.textContent).not.toMatch(/invite\.refusal/);
    });
  });

  it('says "a separate account" to a player offered a staff role — in Bulgarian first', () => {
    renderIn('bg', 'SEPARATE_ACCOUNT_REQUIRED');

    expect(screen.getByRole('heading', { name: 'Приемете с отделен профил' })).toBeInTheDocument();
  });

  it('signs out back to sign-in, carrying the invitation, so switching accounts does not lose it', () => {
    renderIn('bg', 'SEPARATE_ACCOUNT_REQUIRED');

    fireEvent.click(screen.getByRole('button', { name: bg.invite.signOutToSwitch }));

    expect(signOut).toHaveBeenCalledWith({
      callbackUrl: `/login?next=${encodeURIComponent('/invite/tok_abc')}`,
    });
  });
});
