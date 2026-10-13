import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

import { CoachQueue } from '@/app/(app)/platform/coaches/CoachQueue';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import {
  fail,
  fakeResponse,
  installFakeFetch as installRawFakeFetch,
  ok,
  tick,
  type FakeAnswer,
  type FakeCall,
  type FakeHandler,
} from '../unit/data/fake-v1';

/**
 * The coaches' queue (#545) on the client data layer, against the real
 * Bulgarian catalogue and a fake v1.
 *
 * As for the moderation queue, what matters most is what is NOT requested:
 * every page the server serves, and every certificate it opens, writes an
 * audit row in the admin's name. So each test counts requests.
 */

const coaches = (messages as unknown as { platform: { coaches: unknown } }).platform.coaches as {
  open: string;
  refresh: string;
  more: string;
  approve: string;
  decline: string;
  remove: string;
  decidedElsewhere: string;
  done: Record<string, string>;
  status: Record<string, string>;
  error: Record<string, string>;
  empty: { title: string };
  reason: { label: string };
  note: { label: string };
  certificate: { open: string; none: string };
};

const REASON = 'approving the pilot coaches, 14 October';

type MfaState = { enrolled: boolean; stepUpExpiresAt: string | null };
const STEPPED_UP: MfaState = { enrolled: true, stepUpExpiresAt: '2099-01-01T00:00:00Z' };
let mfaState: MfaState = STEPPED_UP;

/** The certificate route answers a file, not JSON: recorded apart, with what it was asked. */
let certificateCalls: Array<{ url: string; headers: Record<string, string> }> = [];
let certificateAnswer: () => { ok: boolean; status: number; json?: unknown } = () => ({
  ok: true,
  status: 200,
});
const saved: Array<{ download: string; href: string }> = [];

/**
 * `GET /me/mfa` and the certificate are answered beside the queue's fake and
 * NOT recorded in its calls: the counts below are of the audited list reads
 * and the decisions.
 */
function installFakeFetch(handler: FakeHandler): FakeCall[] {
  const calls = installRawFakeFetch(handler);
  const queueFetch = globalThis.fetch;
  globalThis.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/me/mfa')) return fakeResponse(ok(mfaState));
    if (url.endsWith('/me/mfa/step-up')) {
      mfaState = STEPPED_UP;
      return fakeResponse(ok({ stepUpExpiresAt: STEPPED_UP.stepUpExpiresAt, method: 'totp' }));
    }
    if (url.includes('/certificate?')) {
      certificateCalls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
      const a = certificateAnswer();
      return {
        ok: a.ok,
        status: a.status,
        json: async () => a.json,
        blob: async () => new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
      };
    }
    return (queueFetch as unknown as (i: unknown, n?: RequestInit) => Promise<unknown>)(
      input,
      init,
    );
  }) as unknown as typeof fetch;
  return calls;
}

const coach = (userId: string, name: string, over: Record<string, unknown> = {}) => ({
  userId,
  name,
  slug: userId,
  status: 'SUBMITTED',
  submittedAt: '2026-10-14T08:00:00Z',
  decidedAt: null,
  sports: [
    { sport: 'TENNIS', levelMin: 1, levelMax: 5 },
    { sport: 'PADEL', levelMin: 4, levelMax: 4 },
  ],
  bio: `Представяне на ${name}.\nВтори ред.`,
  qualifications: 'Лиценз ББФТ, ниво 2',
  decisionNote: null,
  certificate: {
    fileName: 'Лиценз.pdf',
    mimeType: 'application/pdf',
    byteSize: 1_572_864,
    uploadedAt: '2026-10-13T09:00:00Z',
  },
  ...over,
});

const PAGE_1 = {
  items: [coach('u1', 'Иван Петров'), coach('u2', 'Мария Илиева')],
  nextCursor: 'u2',
};
const PAGE_2 = { items: [coach('u3', 'Георги Тодоров')], nextCursor: null };

function queue(decide: FakeHandler = () => ok({ userId: 'x', status: 'APPROVED' })) {
  return installFakeFetch((c) => {
    if (c.method === 'POST') return decide(c);
    if (c.url.includes('status=APPROVED')) {
      return ok({
        items: [
          coach('u9', 'Одобрен Треньор', { status: 'APPROVED', decidedAt: '2026-10-10T08:00:00Z' }),
        ],
        nextCursor: null,
      });
    }
    if (c.url.includes('status=DECLINED')) {
      return ok({
        items: [
          coach('u8', 'Отказан Треньор', {
            status: 'DECLINED',
            decidedAt: '2026-10-11T08:00:00Z',
            decisionNote: 'Сертификатът не се чете.',
            certificate: null,
          }),
        ],
        nextCursor: null,
      });
    }
    return ok(c.url.includes('cursor=u2') ? PAGE_2 : PAGE_1);
  });
}

function mount() {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <ViewerScope viewerId="usr_owner">
            <CoachQueue />
          </ViewerScope>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

async function openQueue(first = 'Иван Петров') {
  await userEvent.type(screen.getByLabelText(coaches.reason.label), REASON);
  await userEvent.click(screen.getByRole('button', { name: coaches.open }));
  await screen.findByText(first);
}

const card = (name: string) => screen.getByText(name).closest('li')! as HTMLElement;

async function decide(name: string, note: string, button: string) {
  const c = card(name);
  await userEvent.type(within(c).getByLabelText(coaches.note.label), note);
  await userEvent.click(within(c).getByRole('button', { name: button }));
}

const gets = (calls: FakeCall[]) => calls.filter((c) => c.method === 'GET');
const refuse = (status: number, code: string, details?: unknown): FakeAnswer => ({
  status,
  body: { error: { code, message: code, requestId: 'r', ...(details ? { details } : {}) } },
});

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
  mfaState = STEPPED_UP;
  certificateCalls = [];
  certificateAnswer = () => ({ ok: true, status: 200 });
  saved.length = 0;
  // jsdom has neither: record what would have been saved to disk.
  URL.createObjectURL = jest.fn(() => 'blob:certificate');
  URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ download: this.download, href: this.href });
  });
});
afterEach(() => jest.restoreAllMocks());

describe('opening the list', () => {
  it('reads nothing without a reason long enough to record', async () => {
    const calls = queue();
    mount();
    await userEvent.type(screen.getByLabelText(coaches.reason.label), 'short');
    expect(screen.getByRole('button', { name: coaches.open })).toBeDisabled();
    await act(tick);
    expect(calls).toHaveLength(0);
    expect(certificateCalls).toHaveLength(0);
  });

  it('reads ONE page of the waiting profiles, and shows all the owner needs to decide', async () => {
    const calls = queue();
    mount();
    await openQueue();

    expect(gets(calls)).toHaveLength(1);
    expect(calls[0]!.url).toContain('/api/v1/platform/coaches?');
    expect(calls[0]!.url).toContain('reason=approving+the+pilot+coaches');
    expect(calls[0]!.url).toContain('status=SUBMITTED');
    expect(calls[0]!.headers['x-playerz-viewer']).toBe('usr_owner');

    const c = card('Иван Петров');
    expect(c).toHaveTextContent('Тенис: нива 1–5');
    expect(c).toHaveTextContent('Падел: ниво 4');
    expect(c).toHaveTextContent('Представяне на Иван Петров.');
    expect(c).toHaveTextContent('Лиценз ББФТ, ниво 2');
    expect(c).toHaveTextContent('Лиценз.pdf · 1,5 MB');
    // A waiting profile can be approved or declined, not removed.
    expect(within(c).getByRole('button', { name: coaches.approve })).toBeDisabled();
    expect(within(c).getByRole('button', { name: coaches.decline })).toBeDisabled();
    expect(within(c).queryByRole('button', { name: coaches.remove })).toBeNull();
    // Listing opened no certificate.
    expect(certificateCalls).toHaveLength(0);
  });

  it('a focus or a reconnect issues no read', async () => {
    const calls = queue();
    mount();
    await openQueue();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(gets(calls)).toHaveLength(1);
  });

  it('"show more" reads exactly the next page', async () => {
    const calls = queue();
    mount();
    await openQueue();
    await userEvent.click(screen.getByRole('button', { name: coaches.more }));
    await screen.findByText('Георги Тодоров');
    expect(gets(calls).map((c) => c.url.includes('cursor=u2'))).toEqual([false, true]);
    expect(screen.queryByRole('button', { name: coaches.more })).toBeNull();
  });

  it('the approved list offers removal only; the declined one is read-only', async () => {
    const calls = queue();
    mount();
    await userEvent.type(screen.getByLabelText(coaches.reason.label), REASON);
    await userEvent.click(screen.getByRole('radio', { name: coaches.status.APPROVED }));
    await userEvent.click(screen.getByRole('button', { name: coaches.open }));
    const approved = (await screen.findByText('Одобрен Треньор')).closest('li')! as HTMLElement;
    expect(within(approved).getByRole('button', { name: coaches.remove })).toBeInTheDocument();
    expect(within(approved).queryByRole('button', { name: coaches.approve })).toBeNull();

    await userEvent.click(screen.getByRole('radio', { name: coaches.status.DECLINED }));
    await userEvent.click(screen.getByRole('button', { name: coaches.refresh }));
    const declined = (await screen.findByText('Отказан Треньор')).closest('li')! as HTMLElement;
    expect(declined).toHaveTextContent('Сертификатът не се чете.');
    expect(declined).toHaveTextContent(coaches.certificate.none);
    expect(within(declined).queryByRole('button')).toBeNull();
    expect(within(declined).queryByLabelText(coaches.note.label)).toBeNull();
    // One read per list asked for.
    expect(gets(calls)).toHaveLength(2);
  });

  it('says plainly when the grant lacks the capability', async () => {
    installFakeFetch(() => fail(403, 'PLATFORM_CAPABILITY_REQUIRED'));
    mount();
    await userEvent.type(screen.getByLabelText(coaches.reason.label), REASON);
    await userEvent.click(screen.getByRole('button', { name: coaches.open }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      coaches.error.PLATFORM_CAPABILITY_REQUIRED!,
    );
  });

  it('an account with no second factor is sent to set one up, and is offered no form', async () => {
    mfaState = { enrolled: false, stepUpExpiresAt: null };
    const calls = queue();
    mount();
    expect(
      await screen.findByText(coaches.error.MFA_ENROLMENT_REQUIRED!, { exact: false }),
    ).toBeVisible();
    expect(screen.queryByLabelText(coaches.reason.label)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('the certificate', () => {
  it('is fetched only when asked for, under the list’s reason, and handed over as a file', async () => {
    const calls = queue();
    mount();
    await openQueue();
    await userEvent.click(
      within(card('Иван Петров')).getByRole('button', { name: coaches.certificate.open }),
    );
    await waitFor(() => expect(saved).toHaveLength(1));

    expect(certificateCalls).toHaveLength(1);
    expect(certificateCalls[0]!.url).toContain('/api/v1/platform/coaches/u1/certificate?');
    expect(certificateCalls[0]!.url).toContain('reason=approving+the+pilot+coaches');
    expect(certificateCalls[0]!.headers['x-playerz-viewer']).toBe('usr_owner');
    // Saved under its own name; nothing of it is drawn on the page.
    expect(saved[0]).toEqual({ download: 'Лиценз.pdf', href: 'blob:certificate' });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:certificate');
    expect(document.querySelector('iframe, embed, object, img')).toBeNull();
    // Opening one certificate did not re-read the list.
    expect(gets(calls)).toHaveLength(1);
  });

  it('a refusal is said on the card, and nothing is saved', async () => {
    queue();
    certificateAnswer = () => ({
      ok: false,
      status: 403,
      json: { error: { code: 'STEP_UP_REQUIRED' } },
    });
    mount();
    await openQueue();
    await userEvent.click(
      within(card('Иван Петров')).getByRole('button', { name: coaches.certificate.open }),
    );
    expect(await within(card('Иван Петров')).findByRole('alert')).toHaveTextContent(
      coaches.error.STEP_UP_REQUIRED!,
    );
    expect(saved).toHaveLength(0);
    // The other card says nothing.
    expect(within(card('Мария Илиева')).queryByRole('alert')).toBeNull();
  });
});

describe('deciding', () => {
  it('needs a note, sends the decision once, removes the card and does not re-read the list', async () => {
    const calls = queue();
    mount();
    await openQueue();
    await decide('Иван Петров', 'Лицензът е проверен в регистъра.', coaches.approve);

    await waitFor(() => expect(screen.queryByText('Иван Петров')).toBeNull());
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('/api/v1/platform/coaches/u1/decision');
    expect(posts[0]!.body).toEqual({
      decision: 'APPROVE',
      note: 'Лицензът е проверен в регистъра.',
    });
    expect(screen.getByTestId('coaches-notice')).toHaveTextContent(coaches.done.APPROVE!);
    expect(screen.getByText('Мария Илиева')).toBeVisible();
    expect(gets(calls)).toHaveLength(1);
  });

  it('a decline carries the note written to the coach', async () => {
    const calls = queue();
    mount();
    await openQueue();
    await decide(
      'Мария Илиева',
      'Сертификатът не се чете, качете по-ясна снимка.',
      coaches.decline,
    );
    await waitFor(() => expect(screen.queryByText('Мария Илиева')).toBeNull());
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      decision: 'DECLINE',
      note: 'Сертификатът не се чете, качете по-ясна снимка.',
    });
    expect(screen.getByTestId('coaches-notice')).toHaveTextContent(coaches.done.DECLINE!);
  });

  it('decided by somebody else first: the card goes, and it is said', async () => {
    queue(() => refuse(409, 'COACH_APPLICATION_STATE', { status: 'APPROVED' }));
    mount();
    await openQueue();
    await decide('Иван Петров', 'Лицензът е проверен в регистъра.', coaches.approve);
    expect(await screen.findByTestId('coaches-notice')).toHaveTextContent(coaches.decidedElsewhere);
    expect(screen.queryByText('Иван Петров')).toBeNull();
  });

  it('a refusal puts the card back with its note and says why', async () => {
    const calls = installFakeFetch((c) => {
      if (c.method === 'POST') {
        return refuse(409, 'COACH_HAS_UPCOMING_LESSONS', { lessons: 2 });
      }
      return ok({
        items: [
          coach('u9', 'Одобрен Треньор', { status: 'APPROVED', decidedAt: '2026-10-10T08:00:00Z' }),
        ],
        nextCursor: null,
      });
    });
    mount();
    await userEvent.type(screen.getByLabelText(coaches.reason.label), REASON);
    await userEvent.click(screen.getByRole('radio', { name: coaches.status.APPROVED }));
    await userEvent.click(screen.getByRole('button', { name: coaches.open }));
    await screen.findByText('Одобрен Треньор');
    await decide('Одобрен Треньор', 'Спираме профила след оплакване.', coaches.remove);

    const back = await screen.findByText('Одобрен Треньор');
    const c = back.closest('li')! as HTMLElement;
    expect(await within(c).findByRole('alert')).toHaveTextContent(
      coaches.error.COACH_HAS_UPCOMING_LESSONS!,
    );
    expect(within(c).getByLabelText(coaches.note.label)).toHaveValue(
      'Спираме профила след оплакване.',
    );
    expect(calls.filter((x) => x.method === 'POST')[0]!.body).toMatchObject({ decision: 'REMOVE' });
    expect(gets(calls)).toHaveLength(1);
  });
});
