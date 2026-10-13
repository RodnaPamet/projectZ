import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import EmailUnsubscribePage from '@/app/(public)/email/unsubscribe/[token]/page';

import bg from '../../messages/bg.json';
import en from '../../messages/en.json';
import { withIntl } from '../helpers/intl';
import { resolveServerTree } from '../helpers/server-tree';

/**
 * "Спиране на имейли" (#528): the page behind an email's footer link. It asks
 * before it does anything, names the one kind of email it is about, and reads
 * the same for every link that is not ours.
 */

let locale: 'bg' | 'en' = 'bg';
jest.mock('next-intl/server', () => {
  const { createTranslator } = jest.requireActual('next-intl');
  return {
    getLocale: async () => locale,
    getTranslations: async (namespace: string) =>
      createTranslator({
        locale,
        messages:
          locale === 'en' ? require('../../messages/en.json') : require('../../messages/bg.json'),
        namespace,
      }),
  };
});

const unsubscribeStanding = jest.fn();
jest.mock('@/app-layer/usecases/email-unsubscribe', () => ({
  unsubscribeStanding: (...args: unknown[]) => unsubscribeStanding(...args),
}));

const stopEmailsAction = jest.fn();
jest.mock('@/app/(public)/email/unsubscribe/[token]/actions', () => ({
  stopEmailsAction: (...args: unknown[]) => stopEmailsAction(...args),
}));

async function open(token = 'tok.en') {
  const tree = await EmailUnsubscribePage({ params: Promise.resolve({ token }) });
  return render(withIntl(await resolveServerTree(tree), locale));
}

beforeEach(() => {
  locale = 'bg';
  unsubscribeStanding.mockReset();
  stopEmailsAction.mockReset().mockResolvedValue(undefined);
});

describe('the unsubscribe page', () => {
  const t = bg.emailUnsubscribe;

  it('names the kind of email and asks; opening the page switches nothing off', async () => {
    unsubscribeStanding.mockResolvedValue({ category: 'reminder', on: true });
    await open();

    expect(unsubscribeStanding).toHaveBeenCalledWith('tok.en');
    expect(screen.getByRole('heading', { level: 1, name: t.title })).toBeInTheDocument();
    expect(screen.getByTestId('unsubscribe-ask')).toHaveTextContent(
      bg.profile.notifications.reminder,
    );
    expect(screen.getByText(t.bell)).toBeInTheDocument();
    expect(stopEmailsAction).not.toHaveBeenCalled();
  });

  it('the button stops that kind, with the link’s own token', async () => {
    unsubscribeStanding.mockResolvedValue({ category: 'messages', on: true });
    await open('abc.def');
    fireEvent.click(screen.getByRole('button', { name: t.submit }));
    await waitFor(() => expect(stopEmailsAction).toHaveBeenCalledTimes(1));
    expect(stopEmailsAction.mock.calls[0]![0]).toBe('abc.def');
  });

  it('once it is off, the page says so and offers no button', async () => {
    unsubscribeStanding.mockResolvedValue({ category: 'openPlay', on: false });
    await open();
    expect(screen.getByTestId('unsubscribe-done')).toHaveTextContent(
      bg.profile.notifications.openPlay,
    );
    expect(screen.queryByRole('button', { name: t.submit })).toBeNull();
  });

  it('a link that is not ours: one message, and the way to the same switches', async () => {
    unsubscribeStanding.mockResolvedValue(null);
    await open('garbage');
    expect(screen.getByTestId('unsubscribe-invalid')).toHaveTextContent(t.invalid.title);
    expect(screen.queryByRole('button', { name: t.submit })).toBeNull();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/me/profile');
  });

  it('every state points at Профил → Известия for the rest', async () => {
    unsubscribeStanding.mockResolvedValue({ category: 'confirmation', on: true });
    await open();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/me/profile');
  });

  it('in English for an English reader', async () => {
    locale = 'en';
    unsubscribeStanding.mockResolvedValue({ category: 'clubChanges', on: true });
    await open();
    expect(
      screen.getByRole('heading', { level: 1, name: en.emailUnsubscribe.title }),
    ).toBeVisible();
    expect(screen.getByTestId('unsubscribe-ask')).toHaveTextContent(
      en.profile.notifications.clubChanges,
    );
    expect(screen.getByRole('button', { name: en.emailUnsubscribe.submit })).toBeInTheDocument();
  });
});
