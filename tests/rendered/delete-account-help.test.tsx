import { render, screen, within } from '@testing-library/react';

import DeleteAccountHelpPage, { generateMetadata } from '@/app/(public)/delete-account/page';

import { enMessages, messages, withIntl } from '../helpers/intl';
import { resolveServerTree } from '../helpers/server-tree';

/**
 * /delete-account (#370, #445): how to delete an account, in plain words, for
 * anyone, signed in or not. The Meta app's Data Deletion Instructions URL.
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

beforeEach(() => {
  locale = 'bg';
});

async function renderPage() {
  return render(withIntl(await resolveServerTree(await DeleteAccountHelpPage()), locale));
}

describe('/delete-account', () => {
  it('in Bulgarian: the title, then each question as its own section', async () => {
    const h = messages.deleteAccountHelp;
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(h.title);
    expect(screen.getAllByRole('heading', { level: 2 }).map((el) => el.textContent)).toEqual([
      h.where.title,
      h.upcoming.title,
      h.deleted.title,
      h.kept.title,
      h.club.title,
      h.export.title,
      h.after.title,
    ]);
  });

  it('says where the button is, and links the profile', async () => {
    await renderPage();
    const page = screen.getByTestId('delete-account-help');
    expect(within(page).getAllByRole('listitem')[0]).toHaveTextContent(
      messages.deleteAccountHelp.where.step1,
    );
    expect(screen.getByTestId('delete-account-help-profile')).toHaveAttribute(
      'href',
      '/me/profile',
    );
  });

  it('the word to type is the one the dialog asks for, in each language', async () => {
    expect(messages.deleteAccountHelp.where.step4).toContain(messages.profile.delete.dialog.word);
    expect(enMessages.deleteAccountHelp.where.step4).toContain(
      enMessages.profile.delete.dialog.word,
    );
  });

  it('says what deleting does not undo: the no-shows, carried; the credit, lost (#370 review)', async () => {
    await renderPage();
    expect(screen.getByTestId('delete-account-help-no-shows')).toHaveTextContent(
      messages.deleteAccountHelp.kept.noShows,
    );
    expect(screen.getByTestId('delete-account-help-credit')).toHaveTextContent(
      messages.deleteAccountHelp.kept.credit,
    );
    // The profile's own wording, so the two never disagree.
    expect(messages.profile.delete.noShowCarry).toContain('90 дни');
    expect(messages.deleteAccountHelp.kept.noShows).toContain('90 дни');
  });

  it('a club account is sent to the contact form', async () => {
    await renderPage();
    expect(screen.getByTestId('delete-account-help-contact')).toHaveAttribute('href', '/#clubs');
  });

  it('in English, for an English reader', async () => {
    locale = 'en';
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      enMessages.deleteAccountHelp.title,
    );
    expect(screen.getByTestId('delete-account-help')).toHaveTextContent(
      enMessages.deleteAccountHelp.export.body,
    );
  });

  it('its own title and a canonical address', async () => {
    expect(await generateMetadata()).toEqual({
      title: messages.deleteAccountHelp.metaTitle,
      description: messages.deleteAccountHelp.metaDescription,
      alternates: { canonical: '/delete-account' },
    });
  });
});
