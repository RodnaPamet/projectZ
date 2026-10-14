import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

import {
  CoachProfileEditor,
  coachErrorKey,
  picksToCoachSports,
  type CoachProfileView,
} from '@/components/coach/CoachProfileEditor';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { ApiClientError } from '@/lib/data/errors';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { installFakeFetch, ok, type FakeAnswer } from '../unit/data/fake-v1';

/**
 * «Профил на треньор» (#545), against the real Bulgarian catalogue and a fake
 * v1: what each state shows and lets the coach change, and what each button
 * sends.
 */

const t = (messages as unknown as { coachProfile: Record<string, never> })
  .coachProfile as unknown as {
  save: string;
  saved: string;
  submit: string;
  submitted: string;
  withdraw: string;
  withdrawn: string;
  state: Record<string, { title: string }>;
  error: Record<string, string>;
  certificate: Record<string, string>;
  about: { bio: string; qualifications: string };
};

const BIO = 'Треньор по тенис от 2010 г. Работя с начинаещи и с напреднали играчи.';

const profile = (over: Partial<CoachProfileView> = {}): CoachProfileView => ({
  state: 'NONE',
  slug: null,
  bio: null,
  qualifications: null,
  sports: [],
  certificate: null,
  submittedAt: null,
  decidedAt: null,
  decisionNote: null,
  missing: ['bio', 'sports', 'certificate'],
  canEdit: { text: true, certificate: true },
  ...over,
});

const COMPLETE = profile({
  state: 'DRAFT',
  slug: 'ivan-petrov',
  bio: BIO,
  sports: [{ sport: 'TENNIS', levelMin: 1, levelMax: 5 }],
  certificate: {
    fileName: 'Лиценз.pdf',
    mimeType: 'application/pdf',
    byteSize: 1_572_864,
    uploadedAt: '2026-10-14T09:00:00Z',
  },
  missing: [],
});

const refuse = (status: number, code: string, details?: unknown): FakeAnswer => ({
  status,
  body: { error: { code, message: code, requestId: 'r', ...(details ? { details } : {}) } },
});

function mount(seed: CoachProfileView) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <TooltipProvider>
            <ViewerScope viewerId="usr_coach">
              <CoachProfileEditor seed={seed} />
            </ViewerScope>
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

const state = () => screen.getByTestId('coach-profile').getAttribute('data-state');

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('a coach who has not started', () => {
  it('sees an empty form, what the profile needs, and nothing to save yet', () => {
    installFakeFetch(() => ok(profile()));
    mount(profile());
    expect(state()).toBe('NONE');
    expect(screen.getByTestId('coach-profile-state')).toHaveTextContent(t.state.NONE!.title);
    const missing = screen.getByTestId('coach-profile-missing');
    expect(missing).toHaveTextContent('представяне от поне 40 знака');
    expect(missing).toHaveTextContent('поне един спорт');
    expect(missing).toHaveTextContent('сертификат');
    expect(screen.getByTestId('coach-profile-certificate-file')).toHaveTextContent(
      t.certificate.none!,
    );
    // Nothing typed, nothing to save.
    expect(screen.getByTestId('coach-profile-save')).toBeDisabled();
    expect(screen.getByTestId('coach-profile-submit')).toBeEnabled();
  });

  it('saves the text and the chosen sports with their levels, and shows what the server kept', async () => {
    const saved = profile({
      state: 'DRAFT',
      slug: 'ivan-petrov',
      bio: BIO,
      sports: [{ sport: 'TENNIS', levelMin: 2, levelMax: 7 }],
      missing: ['certificate'],
    });
    const calls = installFakeFetch(() => ok(saved));
    mount(profile());

    fireEvent.change(screen.getByTestId('coach-profile-bio'), { target: { value: `  ${BIO}  ` } });
    await userEvent.click(within(screen.getByTestId('coach-sport-TENNIS')).getByRole('checkbox'));
    // A newly ticked sport starts at every level.
    expect(screen.getByTestId('coach-sport-TENNIS-range')).toHaveTextContent('нива 1–7');
    const from = within(screen.getByTestId('coach-sport-TENNIS')).getByRole('radiogroup', {
      name: 'Тенис: от ниво',
    });
    await userEvent.click(within(from).getByRole('radio', { name: '2' }));
    expect(screen.getByTestId('coach-sport-TENNIS-range')).toHaveTextContent('нива 2–7');

    await userEvent.click(screen.getByTestId('coach-profile-save'));
    await waitFor(() =>
      expect(screen.getByTestId('coach-profile-done')).toHaveTextContent(t.saved),
    );

    expect(calls.map((c) => [c.method, c.url])).toEqual([['PUT', '/api/v1/me/coach-profile']]);
    expect(calls[0]!.body).toEqual({
      bio: `  ${BIO}  `,
      qualifications: '',
      sports: [{ sport: 'TENNIS', levelMin: 2, levelMax: 7 }],
    });
    expect(calls[0]!.headers['x-playerz-viewer']).toBe('usr_coach');
    // The form follows the answer: the text as stored, and only what is still missing.
    expect(state()).toBe('DRAFT');
    expect(screen.getByTestId('coach-profile-bio')).toHaveValue(BIO);
    expect(screen.getByTestId('coach-profile-missing')).not.toHaveTextContent('спорт');
    expect(screen.getByTestId('coach-profile-save')).toBeDisabled();
  });

  it('moving the bottom level above the top takes the top with it, and the other way round', async () => {
    installFakeFetch(() => ok(profile()));
    mount(profile({ state: 'DRAFT', sports: [{ sport: 'TENNIS', levelMin: 2, levelMax: 4 }] }));
    const row = within(screen.getByTestId('coach-sport-TENNIS'));
    await userEvent.click(
      within(row.getByRole('radiogroup', { name: 'Тенис: от ниво' })).getByRole('radio', {
        name: '6',
      }),
    );
    expect(screen.getByTestId('coach-sport-TENNIS-range')).toHaveTextContent('ниво 6');
    await userEvent.click(
      within(row.getByRole('radiogroup', { name: 'Тенис: до ниво' })).getByRole('radio', {
        name: '3',
      }),
    );
    expect(screen.getByTestId('coach-sport-TENNIS-range')).toHaveTextContent('ниво 3');
  });
});

describe('the certificate', () => {
  it('is sent as a file, and the answer shows what was kept', async () => {
    const calls = installFakeFetch(() => ok(COMPLETE));
    mount(profile({ state: 'DRAFT', bio: BIO, sports: COMPLETE.sports, missing: ['certificate'] }));

    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'Лиценз.pdf', {
      type: 'application/pdf',
    });
    await userEvent.upload(screen.getByTestId('coach-profile-certificate-input'), file);
    await userEvent.click(screen.getByTestId('coach-profile-certificate-upload'));

    await waitFor(() =>
      expect(screen.getByTestId('coach-profile-certificate-file')).toHaveTextContent('Лиценз.pdf'),
    );
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PUT', '/api/v1/me/coach-profile/certificate'],
    ]);
    // A form with the file, and no JSON content type: the browser writes the boundary.
    expect(calls[0]!.form?.get('file')).toBeInstanceOf(File);
    expect((calls[0]!.form!.get('file') as File).name).toBe('Лиценз.pdf');
    expect(calls[0]!.headers['content-type']).toBeUndefined();
    expect(screen.getByTestId('coach-profile-certificate-file')).toHaveTextContent('1,5 MB');
    expect(screen.queryByTestId('coach-profile-missing')).toBeNull();
  });

  it('uploading does not wipe what was typed and not yet saved', async () => {
    // The answer to an upload is the profile as last SAVED: no text, no sport.
    const calls = installFakeFetch((c) =>
      c.url.endsWith('/certificate')
        ? ok(
            profile({
              state: 'DRAFT',
              certificate: COMPLETE.certificate,
              missing: ['bio', 'sports'],
            }),
          )
        : ok(COMPLETE),
    );
    mount(profile());
    fireEvent.change(screen.getByTestId('coach-profile-bio'), { target: { value: BIO } });
    fireEvent.change(screen.getByTestId('coach-profile-qualifications'), {
      target: { value: 'Лиценз ББФТ' },
    });
    await userEvent.click(within(screen.getByTestId('coach-sport-TENNIS')).getByRole('checkbox'));

    await userEvent.upload(
      screen.getByTestId('coach-profile-certificate-input'),
      new File(['%PDF-'], 'Лиценз.pdf', { type: 'application/pdf' }),
    );
    await userEvent.click(screen.getByTestId('coach-profile-certificate-upload'));
    await waitFor(() =>
      expect(screen.getByTestId('coach-profile-certificate-file')).toHaveTextContent('Лиценз.pdf'),
    );

    // Everything typed is still there, and still reads as unsaved.
    expect(screen.getByTestId('coach-profile-bio')).toHaveValue(BIO);
    // Nothing is "missing" that is on screen, saved or not: the server's
    // answer said bio and sports, and the page knows better.
    expect(screen.queryByTestId('coach-profile-missing')).toBeNull();
    expect(screen.getByTestId('coach-profile-qualifications')).toHaveValue('Лиценз ББФТ');
    expect(screen.getByTestId('coach-sport-TENNIS-range')).toHaveTextContent('нива 1–7');
    expect(screen.getByTestId('coach-profile-save')).toBeEnabled();

    // And "send" then saves it first: what is sent is what is on screen.
    await userEvent.click(screen.getByTestId('coach-profile-submit'));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PUT', '/api/v1/me/coach-profile/certificate'],
      ['PUT', '/api/v1/me/coach-profile'],
      ['POST', '/api/v1/me/coach-profile/submit'],
    ]);
    expect(calls[1]!.body).toMatchObject({ bio: BIO, qualifications: 'Лиценз ББФТ' });
  });

  it('removing it does not wipe unsaved text either', async () => {
    installFakeFetch(() => ok({ ...COMPLETE, certificate: null, missing: ['certificate'] }));
    mount(COMPLETE);
    fireEvent.change(screen.getByTestId('coach-profile-bio'), {
      target: { value: `${BIO} И за деца.` },
    });
    await userEvent.click(screen.getByTestId('coach-profile-certificate-remove'));
    await waitFor(() =>
      expect(screen.getByTestId('coach-profile-certificate-file')).toHaveTextContent(
        t.certificate.none!,
      ),
    );
    expect(screen.getByTestId('coach-profile-bio')).toHaveValue(`${BIO} И за деца.`);
  });

  it('a file over 5 MB is refused here, without a request', async () => {
    const calls = installFakeFetch(() => ok(COMPLETE));
    mount(profile());
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.pdf', {
      type: 'application/pdf',
    });
    await userEvent.upload(screen.getByTestId('coach-profile-certificate-input'), big);
    await userEvent.click(screen.getByTestId('coach-profile-certificate-upload'));
    expect(screen.getByTestId('coach-profile-error')).toHaveTextContent(
      'Файлът е по-голям от 5 MB.',
    );
    expect(calls).toHaveLength(0);
  });

  it('what the server refuses is said in words', async () => {
    installFakeFetch(() => refuse(400, 'CERTIFICATE_REFUSED', { reason: 'NOT_A_CERTIFICATE' }));
    mount(profile());
    await userEvent.upload(
      screen.getByTestId('coach-profile-certificate-input'),
      new File(['MZ'], 'licence.pdf', { type: 'application/pdf' }),
    );
    await userEvent.click(screen.getByTestId('coach-profile-certificate-upload'));
    expect(await screen.findByTestId('coach-profile-error')).toHaveTextContent(
      t.error.NOT_A_CERTIFICATE!,
    );
  });

  it('can be removed while the profile is still the coach’s to change', async () => {
    const calls = installFakeFetch(() =>
      ok({ ...COMPLETE, certificate: null, missing: ['certificate'] }),
    );
    mount(COMPLETE);
    await userEvent.click(screen.getByTestId('coach-profile-certificate-remove'));
    await waitFor(() =>
      expect(screen.getByTestId('coach-profile-certificate-file')).toHaveTextContent(
        t.certificate.none!,
      ),
    );
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['DELETE', '/api/v1/me/coach-profile/certificate'],
    ]);
  });
});

describe('sending it', () => {
  it('a complete, unchanged profile is sent with one request', async () => {
    const calls = installFakeFetch(() =>
      ok({
        ...COMPLETE,
        state: 'SUBMITTED',
        submittedAt: '2026-10-14T10:00:00Z',
        canEdit: { text: false, certificate: false },
      }),
    );
    mount(COMPLETE);
    await userEvent.click(screen.getByTestId('coach-profile-submit'));

    await waitFor(() => expect(state()).toBe('SUBMITTED'));
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', '/api/v1/me/coach-profile/submit'],
    ]);
    expect(screen.getByTestId('coach-profile-done')).toHaveTextContent(t.submitted);
    expect(screen.getByTestId('coach-profile-state')).toHaveTextContent(
      'Изпратихте го на 14 октомври 2026 г. и докато го преглеждаме',
    );
    // Waiting: nothing can be changed, and it can be taken back.
    expect(screen.getByTestId('coach-profile-bio')).toBeDisabled();
    expect(screen.queryByTestId('coach-profile-save')).toBeNull();
    expect(screen.queryByTestId('coach-profile-submit')).toBeNull();
    expect(screen.queryByTestId('coach-profile-certificate-input')).toBeNull();
    expect(screen.getByTestId('coach-profile-certificate-locked')).toHaveTextContent(
      t.certificate.lockedSubmitted!,
    );
    expect(screen.getByTestId('coach-profile-withdraw')).toBeEnabled();
  });

  it('a changed text is saved first, so what is sent is what is on screen', async () => {
    const calls = installFakeFetch((c) =>
      c.method === 'PUT'
        ? ok({ ...COMPLETE, bio: `${BIO} И за деца.` })
        : ok({
            ...COMPLETE,
            bio: `${BIO} И за деца.`,
            state: 'SUBMITTED',
            canEdit: { text: false, certificate: false },
          }),
    );
    mount(COMPLETE);
    fireEvent.change(screen.getByTestId('coach-profile-bio'), {
      target: { value: `${BIO} И за деца.` },
    });
    await userEvent.click(screen.getByTestId('coach-profile-submit'));
    await waitFor(() => expect(state()).toBe('SUBMITTED'));
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PUT', '/api/v1/me/coach-profile'],
      ['POST', '/api/v1/me/coach-profile/submit'],
    ]);
  });

  it('when the save is refused nothing is sent', async () => {
    const calls = installFakeFetch(() => refuse(400, 'VALIDATION_ERROR', { field: 'bio' }));
    mount(COMPLETE);
    fireEvent.change(screen.getByTestId('coach-profile-bio'), { target: { value: 'ново' } });
    await userEvent.click(screen.getByTestId('coach-profile-submit'));
    expect(await screen.findByTestId('coach-profile-error')).toHaveTextContent(
      t.error.VALIDATION_ERROR!,
    );
    expect(calls.map((c) => c.method)).toEqual(['PUT']);
    expect(state()).toBe('DRAFT');
    // What was typed is still there.
    expect(screen.getByTestId('coach-profile-bio')).toHaveValue('ново');
  });

  it('an incomplete profile is told so, and it stays the coach’s', async () => {
    installFakeFetch(() => refuse(409, 'COACH_PROFILE_INCOMPLETE', { missing: ['certificate'] }));
    mount(profile({ state: 'DRAFT', bio: BIO, sports: COMPLETE.sports, missing: ['certificate'] }));
    await userEvent.click(screen.getByTestId('coach-profile-submit'));
    expect(await screen.findByTestId('coach-profile-error')).toHaveTextContent(
      t.error.COACH_PROFILE_INCOMPLETE!,
    );
    expect(state()).toBe('DRAFT');
  });

  it('a waiting profile is taken back with one request', async () => {
    const calls = installFakeFetch(() => ok(COMPLETE));
    mount({
      ...COMPLETE,
      state: 'SUBMITTED',
      submittedAt: '2026-10-14T10:00:00Z',
      canEdit: { text: false, certificate: false },
    });
    await userEvent.click(screen.getByTestId('coach-profile-withdraw'));
    await waitFor(() => expect(state()).toBe('DRAFT'));
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', '/api/v1/me/coach-profile/withdraw'],
    ]);
    expect(screen.getByTestId('coach-profile-done')).toHaveTextContent(t.withdrawn);
    expect(screen.getByTestId('coach-profile-bio')).toBeEnabled();
  });
});

describe('after the decision', () => {
  it('declined: the note is shown as written, and the profile can be corrected and sent again', () => {
    installFakeFetch(() => ok(COMPLETE));
    mount({
      ...COMPLETE,
      state: 'DECLINED',
      decidedAt: '2026-10-14T12:00:00Z',
      decisionNote: 'Сертификатът не се чете.\nКачете по-ясна снимка.',
    });
    expect(screen.getByTestId('coach-profile-state')).toHaveTextContent(t.state.DECLINED!.title);
    const note = screen.getByTestId('coach-profile-note');
    expect(note).toHaveTextContent('Сертификатът не се чете.');
    expect(note).toHaveTextContent('Качете по-ясна снимка.');
    expect(screen.getByTestId('coach-profile-bio')).toBeEnabled();
    expect(screen.getByTestId('coach-profile-certificate-input')).toBeInTheDocument();
    expect(screen.getByTestId('coach-profile-submit')).toBeEnabled();
  });

  it('approved: the text is the coach’s to edit, the certificate is not, and there is nothing to send', () => {
    installFakeFetch(() => ok(COMPLETE));
    mount({
      ...COMPLETE,
      state: 'APPROVED',
      decidedAt: '2026-10-14T12:00:00Z',
      canEdit: { text: true, certificate: false },
    });
    expect(screen.getByTestId('coach-profile-state')).toHaveTextContent(t.state.APPROVED!.title);
    expect(screen.getByTestId('coach-profile-bio')).toBeEnabled();
    expect(screen.queryByTestId('coach-profile-certificate-input')).toBeNull();
    expect(screen.queryByTestId('coach-profile-certificate-remove')).toBeNull();
    expect(screen.getByTestId('coach-profile-certificate-locked')).toHaveTextContent(
      t.certificate.lockedApproved!,
    );
    expect(screen.queryByTestId('coach-profile-submit')).toBeNull();
    expect(screen.queryByTestId('coach-profile-missing')).toBeNull();
    expect(screen.getByTestId('coach-profile-save')).toBeDisabled();
  });
});

describe('what is still missing follows the form', () => {
  it('ticking a sport and typing enough text clears each line as it is done', async () => {
    installFakeFetch(() => ok(profile()));
    mount(profile());
    const missing = () => screen.queryByTestId('coach-profile-missing');
    expect(missing()).toHaveTextContent('представяне');
    expect(missing()).toHaveTextContent('спорт');

    fireEvent.change(screen.getByTestId('coach-profile-bio'), { target: { value: 'Кратко.' } });
    expect(missing()).toHaveTextContent('представяне от поне 40 знака');
    fireEvent.change(screen.getByTestId('coach-profile-bio'), { target: { value: BIO } });
    expect(missing()).not.toHaveTextContent('представяне');

    await userEvent.click(within(screen.getByTestId('coach-sport-TENNIS')).getByRole('checkbox'));
    expect(missing()).not.toHaveTextContent('спорт');
    // Only the certificate is left, and only the server can say it is there.
    expect(missing()).toHaveTextContent('сертификат');

    await userEvent.click(within(screen.getByTestId('coach-sport-TENNIS')).getByRole('checkbox'));
    expect(missing()).toHaveTextContent('поне един спорт');
  });

  it('a small file is told in kilobytes, never as 0,0 MB', () => {
    installFakeFetch(() => ok(COMPLETE));
    mount({ ...COMPLETE, certificate: { ...COMPLETE.certificate!, byteSize: 54_321 } });
    expect(screen.getByTestId('coach-profile-certificate-file')).toHaveTextContent(
      'Лиценз.pdf · 53 KB ·',
    );
  });
});

describe('the small rules', () => {
  it('picks go out in the catalogue order', () => {
    expect(
      picksToCoachSports({
        PADEL: { levelMin: 3, levelMax: 7 },
        TENNIS: { levelMin: 1, levelMax: 2 },
      }).map((s) => s.sport),
    ).toEqual(['TENNIS', 'PADEL']);
  });

  const e = (status: number, code: string, details?: unknown) =>
    new ApiClientError({ status, code, message: code, details });
  it.each([
    [e(400, 'CERTIFICATE_REFUSED', { reason: 'TOO_LARGE' }), 'TOO_LARGE'],
    [e(400, 'CERTIFICATE_REFUSED', { reason: 'EMPTY' }), 'EMPTY'],
    [e(400, 'CERTIFICATE_REFUSED', { reason: 'SOMETHING_NEW' }), 'NOT_A_CERTIFICATE'],
    [e(400, 'CERTIFICATE_REFUSED'), 'NOT_A_CERTIFICATE'],
    [e(409, 'COACH_PROFILE_LOCKED'), 'COACH_PROFILE_LOCKED'],
    [e(429, 'RATE_LIMITED'), 'RATE_LIMITED'],
    [e(500, 'INTERNAL'), 'UNKNOWN'],
    [new Error('offline'), 'UNKNOWN'],
  ])('%#: an error maps to a sentence the catalogue has (%s)', (err, key) => {
    expect(coachErrorKey(err)).toBe(key);
    expect(t.error[key]).toEqual(expect.any(String));
  });
});

describe('what the page puts around the profile', () => {
  it('`lead` comes after the status and before the profile’s own fields; `children` after them', () => {
    installFakeFetch(() => ok({}));
    const seed = profile();
    render(
      withIntl(
        <DataProvider>
          <SWRConfig value={{ provider: () => new Map() }}>
            <TooltipProvider>
              <ViewerScope viewerId="usr_coach">
                <CoachProfileEditor seed={seed} lead={<div data-testid="slot-lead" />}>
                  <div data-testid="slot-after" />
                </CoachProfileEditor>
              </ViewerScope>
            </TooltipProvider>
          </SWRConfig>
        </DataProvider>,
      ),
    );
    const order = (a: HTMLElement, b: HTMLElement) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    const state = screen.getByTestId('coach-profile-state');
    const lead = screen.getByTestId('slot-lead');
    const about = screen.getByTestId('coach-profile-about');
    const after = screen.getByTestId('slot-after');
    expect(order(state, lead)).toBeTruthy();
    expect(order(lead, about)).toBeTruthy();
    expect(order(about, after)).toBeTruthy();
  });
});
