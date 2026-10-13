import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { ClubInfo } from '@/app-layer/usecases/club-info';
import { InfoBoard } from '@/app/(app)/t/[slug]/admin/photos/InfoBoard';

import bg from '../../messages/bg.json';
import { withIntl } from '../helpers/intl';

/**
 * «Информация» (#530, #536): the club's description and each venue's
 * description and phone, each saved on its own.
 */

const saveClubDescriptionAction = jest.fn();
const saveVenueInfoAction = jest.fn();
jest.mock('@/app/(app)/t/[slug]/admin/photos/actions', () => ({
  saveClubDescriptionAction: (...args: unknown[]) => saveClubDescriptionAction(...args),
  saveVenueInfoAction: (...args: unknown[]) => saveVenueInfoAction(...args),
}));

const t = bg.admin.photos.info;

const INFO: ClubInfo = {
  description: 'Клуб от 1998 г.',
  venues: [
    { id: 'v1', name: 'Лозенец', description: 'Четири корта', phone: '02 111 222' },
    { id: 'v2', name: 'Младост', description: null, phone: null },
  ],
};

const mount = (info: ClubInfo = INFO) =>
  render(withIntl(<InfoBoard slug="maleeva" info={info} maxDescription={1000} />));

const sent = (call: unknown[]) => Object.fromEntries((call.at(-1) as FormData).entries());

beforeEach(() => {
  saveClubDescriptionAction.mockReset().mockResolvedValue({ ok: true });
  saveVenueInfoAction.mockReset().mockResolvedValue({ ok: true });
});

describe('the club’s «Информация»', () => {
  it('shows what is stored: the club’s text, and each venue’s text and phone', () => {
    mount();
    expect(screen.getByRole('heading', { level: 2, name: t.title })).toBeInTheDocument();
    expect(screen.getByLabelText(t.club.label)).toHaveValue('Клуб от 1998 г.');

    const first = screen.getByRole('heading', { level: 3, name: 'Лозенец' }).closest('form')!;
    expect(within(first).getByLabelText(t.venue.description)).toHaveValue('Четири корта');
    expect(within(first).getByLabelText(t.venue.phone)).toHaveValue('02 111 222');

    const second = screen.getByRole('heading', { level: 3, name: 'Младост' }).closest('form')!;
    expect(within(second).getByLabelText(t.venue.description)).toHaveValue('');
    expect(within(second).getByLabelText(t.venue.phone)).toHaveValue('');
  });

  it('says how long a text may be, and stops typing there', () => {
    mount();
    expect(screen.getByText(t.club.hint.replace('{max}', '1000'))).toBeInTheDocument();
    expect(screen.getByLabelText(t.club.label)).toHaveAttribute('maxlength', '1000');
  });

  it('saves the club’s description for this club, and says it is saved', async () => {
    mount();
    const field = screen.getByLabelText(t.club.label);
    await userEvent.clear(field);
    await userEvent.type(field, 'Нов текст');
    await userEvent.click(within(field.closest('form')!).getByRole('button', { name: t.save }));

    await waitFor(() => expect(saveClubDescriptionAction).toHaveBeenCalledTimes(1));
    const call = saveClubDescriptionAction.mock.calls[0]!;
    expect(call[0]).toBe('maleeva');
    expect(sent(call)).toEqual({ description: 'Нов текст' });
    expect(await screen.findByText(t.saved)).toBeInTheDocument();
    expect(saveVenueInfoAction).not.toHaveBeenCalled();
  });

  it('saves one venue’s description and phone, for that venue only', async () => {
    mount();
    const form = screen.getByRole('heading', { level: 3, name: 'Младост' }).closest('form')!;
    await userEvent.type(within(form).getByLabelText(t.venue.description), 'Два корта');
    await userEvent.type(within(form).getByLabelText(t.venue.phone), '02 333 444');
    await userEvent.click(within(form).getByRole('button', { name: t.save }));

    await waitFor(() => expect(saveVenueInfoAction).toHaveBeenCalledTimes(1));
    const call = saveVenueInfoAction.mock.calls[0]!;
    expect(call.slice(0, 2)).toEqual(['maleeva', 'v2']);
    expect(sent(call)).toEqual({ description: 'Два корта', phone: '02 333 444' });
    expect(await within(form).findByText(t.saved)).toBeInTheDocument();
    expect(saveClubDescriptionAction).not.toHaveBeenCalled();
  });

  it.each([
    ['PHONE_INVALID', t.error.PHONE_INVALID],
    ['TOO_LONG', t.error.TOO_LONG],
    ['VENUE_NOT_FOUND', t.error.VENUE_NOT_FOUND],
  ] as const)(
    'a refusal (%s) is said in words, beside the form it belongs to',
    async (code, text) => {
      saveVenueInfoAction.mockResolvedValue({ ok: false, error: code });
      mount();
      const form = screen.getByRole('heading', { level: 3, name: 'Лозенец' }).closest('form')!;
      await userEvent.click(within(form).getByRole('button', { name: t.save }));
      expect(await within(form).findByText(text)).toBeInTheDocument();
      expect(within(form).queryByText(t.saved)).toBeNull();
    },
  );

  it('a club with no venue yet still has its own description to write', () => {
    mount({ description: null, venues: [] });
    expect(screen.getByLabelText(t.club.label)).toHaveValue('');
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
  });
});
