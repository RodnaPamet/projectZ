import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

import { ModerationQueue } from '@/app/(app)/platform/moderation/ModerationQueue';
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
  type FakeCall,
  type FakeHandler,
} from '../unit/data/fake-v1';

/**
 * The moderation queue on the client data layer, against the REAL Bulgarian
 * catalogue and a fake v1.
 *
 * What matters most here is what is NOT requested. Every page of the queue the
 * server serves writes a PLATFORM_MODERATION_QUEUE_READ audit row in the
 * moderator's name, so a read SWR starts on its own — focus, reconnect, a
 * retry, the first page re-checked on "show more", a re-read after a decision —
 * is a record of something nobody did. Each test counts GETs.
 *
 * (Moved here from venue-reviews-ui.test.tsx, whose fetch stubs had no `text()`
 * and shared one SWR cache across tests; the cases it covered are all below.)
 */

const moderation = (messages as unknown as { platform: { moderation: Record<string, unknown> } })
  .platform.moderation as {
  open: string;
  refresh: string;
  more: string;
  approve: string;
  resolvedElsewhere: string;
  error: Record<string, string>;
  empty: { title: string };
  reason: { label: string };
  note: { label: string };
};

const REASON = 'review moderation shift 2026-09-29';

/**
 * `GET /me/mfa` (#262), answered beside the queue's fake and NOT recorded in
 * its calls: every count below is of audited queue reads, and the status read
 * is neither audited nor a queue read. Defaults to a session that has stepped
 * up, so the queue behaves as it did before the second factor existed.
 */
type MfaState = { enrolled: boolean; stepUpExpiresAt: string | null };
const STEPPED_UP: MfaState = { enrolled: true, stepUpExpiresAt: '2099-01-01T00:00:00Z' };
let mfaState: MfaState = STEPPED_UP;
let stepUpCalls: FakeCall[] = [];

function installFakeFetch(handler: FakeHandler): FakeCall[] {
  const calls = installRawFakeFetch(handler);
  const queueFetch = globalThis.fetch;
  globalThis.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/me/mfa')) return fakeResponse(ok(mfaState));
    if (url.endsWith('/me/mfa/step-up')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      stepUpCalls.push({ url, method: init?.method ?? 'GET', headers: {}, body });
      if ((body as { code?: string }).code !== '123456') {
        return fakeResponse(fail(403, 'MFA_CODE_REJECTED'));
      }
      mfaState = STEPPED_UP;
      return fakeResponse(ok({ stepUpExpiresAt: STEPPED_UP.stepUpExpiresAt, method: 'totp' }));
    }
    return (queueFetch as unknown as (i: unknown, n?: RequestInit) => Promise<unknown>)(
      input,
      init,
    );
  }) as unknown as typeof fetch;
  return calls;
}

const item = (caseId: string, body: string) => ({
  caseId,
  reason: 'harassment',
  openedAt: '2026-09-29T10:00:00Z',
  scores: { harassment: 0.72, spam: 0.05 },
  review: {
    id: `r-${caseId}`,
    rating: 1,
    body,
    status: 'PENDING_REVIEW',
    createdAt: '2026-09-29T10:00:00Z',
  },
  venue: { id: 'v1', name: 'Alpha Courts' },
  club: { id: 't1', slug: 'alpha', name: 'Club Alpha' },
});

const PAGE_1 = {
  items: [item('c1', 'the owner is a thief'), item('c2', 'rude desk staff')],
  nextCursor: 'c2',
};
const PAGE_2 = { items: [item('c3', 'dirty showers')], nextCursor: null };

function queue(resolve: FakeHandler = () => ok({ caseId: 'x', status: 'RESOLVED' })) {
  return installFakeFetch((c) => {
    if (c.method === 'POST') return resolve(c);
    return ok(c.url.includes('cursor=c2') ? PAGE_2 : PAGE_1);
  });
}

function mount() {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <ViewerScope viewerId="usr_mod">
            <ModerationQueue />
          </ViewerScope>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

async function openQueue() {
  await userEvent.type(screen.getByLabelText(moderation.reason.label), REASON);
  await userEvent.click(screen.getByRole('button', { name: moderation.open }));
  await screen.findByText('the owner is a thief');
}

async function decide(body: string, note: string, button: string) {
  const card = screen.getByText(body).closest('li')!;
  await userEvent.type(within(card).getByLabelText(moderation.note.label), note);
  await userEvent.click(within(card).getByRole('button', { name: button }));
}

const gets = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method === 'GET');

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
  mfaState = STEPPED_UP;
  stepUpCalls = [];
});

describe('opening the queue', () => {
  it('reads nothing without a reason long enough to record', async () => {
    const calls = queue();
    mount();
    await userEvent.type(screen.getByLabelText(moderation.reason.label), 'short');

    expect(screen.getByRole('button', { name: moderation.open })).toBeDisabled();
    await act(tick);
    expect(calls).toHaveLength(0);
  });

  it('reads ONE page, with the reason and the viewer, and shows the case', async () => {
    const calls = queue();
    mount();
    await openQueue();

    expect(gets(calls)).toHaveLength(1);
    expect(calls[0]!.url).toContain('reason=review+moderation+shift');
    expect(calls[0]!.headers['x-playerz-viewer']).toBe('usr_mod');
    expect(screen.getAllByText('Alpha Courts')).toHaveLength(2);
    expect(screen.getAllByText('72%')).toHaveLength(2);
  });

  it('says plainly when the grant lacks the capability', async () => {
    installFakeFetch(() => fail(403, 'PLATFORM_CAPABILITY_REQUIRED'));
    mount();
    await userEvent.type(screen.getByLabelText(moderation.reason.label), REASON);
    await userEvent.click(screen.getByRole('button', { name: moderation.open }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      moderation.error.PLATFORM_CAPABILITY_REQUIRED!,
    );
  });
});

describe('nothing reads on its own', () => {
  it('a focus or a reconnect issues no GET', async () => {
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

  it('a failed read is not retried', async () => {
    const calls = installFakeFetch(() => fail(503, 'MODERATION_UNAVAILABLE'));
    mount();
    await userEvent.type(screen.getByLabelText(moderation.reason.label), REASON);
    await userEvent.click(screen.getByRole('button', { name: moderation.open }));
    await screen.findByRole('alert');

    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(gets(calls)).toHaveLength(1);
  });

  it('"show more" issues exactly one GET — the next page, not page one again', async () => {
    const calls = queue();
    mount();
    await openQueue();

    await userEvent.click(screen.getByRole('button', { name: moderation.more }));
    await screen.findByText('dirty showers');

    expect(gets(calls).map((c) => c.url)).toEqual([
      expect.not.stringContaining('cursor='),
      expect.stringContaining('cursor=c2'),
    ]);
    expect(screen.queryByRole('button', { name: moderation.more })).not.toBeInTheDocument();
  });

  it('"refresh" goes back to page one with exactly one GET', async () => {
    const calls = queue();
    mount();
    await openQueue();
    await userEvent.click(screen.getByRole('button', { name: moderation.more }));
    await screen.findByText('dirty showers');

    await userEvent.click(screen.getByRole('button', { name: moderation.refresh }));
    await waitFor(() => expect(gets(calls)).toHaveLength(3));
    await act(tick);

    expect(gets(calls)).toHaveLength(3);
    expect(gets(calls)[2]!.url).not.toContain('cursor=');
  });
});

describe('deciding', () => {
  it('approving removes the card at once and re-reads nothing', async () => {
    const calls = queue();
    mount();
    await openQueue();

    expect(screen.getAllByRole('button', { name: moderation.approve })[0]).toBeDisabled();
    await decide('the owner is a thief', 'honest criticism, not abuse', moderation.approve);

    await waitFor(() => expect(screen.queryByText('the owner is a thief')).not.toBeInTheDocument());
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/v1/platform/moderation/cases/c1/resolve');
    expect(post.body).toEqual({ decision: 'APPROVE', note: 'honest criticism, not abuse' });
    expect(post.headers['x-playerz-viewer']).toBe('usr_mod');

    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(gets(calls)).toHaveLength(1);
    expect(screen.getByText('rude desk staff')).toBeInTheDocument();
  });

  it('after a decision, "show more" still reads only the next page, and the case stays gone', async () => {
    const calls = queue();
    mount();
    await openQueue();
    await decide('the owner is a thief', 'honest criticism, not abuse', moderation.approve);
    await waitFor(() => expect(screen.queryByText('the owner is a thief')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: moderation.more }));
    await screen.findByText('dirty showers');

    expect(gets(calls)).toHaveLength(2);
    expect(screen.queryByText('the owner is a thief')).not.toBeInTheDocument();
  });

  it('CASE_ALREADY_RESOLVED: the card stays gone, and the queue says why', async () => {
    const calls = queue(() => fail(409, 'CASE_ALREADY_RESOLVED'));
    mount();
    await openQueue();
    await decide('the owner is a thief', 'posted by a rival club', moderation.approve);

    expect(await screen.findByRole('status')).toHaveTextContent(moderation.resolvedElsewhere);
    expect(screen.queryByText('the owner is a thief')).not.toBeInTheDocument();
    expect(gets(calls)).toHaveLength(1);
  });

  it('any other failure puts the card back, says why on it, and keeps the note', async () => {
    const calls = queue(() => fail(404, 'CASE_NOT_FOUND'));
    mount();
    await openQueue();
    await decide('the owner is a thief', 'posted by a rival club', moderation.approve);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(moderation.error.CASE_NOT_FOUND!);
    const card = screen.getByText('the owner is a thief').closest('li')!;
    expect(within(card).getByRole('alert')).toBe(alert);
    expect(within(card).getByLabelText(moderation.note.label)).toHaveValue(
      'posted by a rival club',
    );
    expect(gets(calls)).toHaveLength(1);
  });

  it('a 409 that is NOT "already resolved" rolls back too', async () => {
    queue(() => fail(409, 'IDEMPOTENCY_RACE'));
    mount();
    await openQueue();
    await decide('the owner is a thief', 'posted by a rival club', moderation.approve);

    expect(await screen.findByRole('alert')).toHaveTextContent(moderation.error.UNKNOWN!);
    expect(screen.getByText('the owner is a thief')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('the second factor (#262)', () => {
  const stepUp = (messages as unknown as { platform: { stepUp: Record<string, string> } }).platform
    .stepUp as { codeLabel: string; submit: string };

  it('asks for a code up front when this session has not stepped up', async () => {
    mfaState = { enrolled: true, stepUpExpiresAt: null };
    const calls = queue();
    mount();

    expect(await screen.findByLabelText(stepUp.codeLabel)).toBeInTheDocument();
    // Asking reads nothing from the queue.
    expect(gets(calls)).toHaveLength(0);
  });

  it('tells a moderator who has not enrolled where to go', async () => {
    mfaState = { enrolled: false, stepUpExpiresAt: null };
    queue();
    mount();

    const link = await screen.findByRole('link', {
      name: (messages as unknown as { platform: { stepUp: { enrolLink: string } } }).platform.stepUp
        .enrolLink,
    });
    expect(link).toHaveAttribute('href', '/platform/security');
  });

  it('a read refused with STEP_UP_REQUIRED asks for a code, then reads again once — and only then', async () => {
    let stepped = false;
    const calls = installFakeFetch((c) => {
      if (c.method === 'POST') return ok({});
      return stepped ? ok(PAGE_1) : fail(403, 'STEP_UP_REQUIRED');
    });
    mount();
    await userEvent.type(screen.getByLabelText(moderation.reason.label), REASON);
    await userEvent.click(screen.getByRole('button', { name: moderation.open }));

    const field = await screen.findByLabelText(stepUp.codeLabel);
    expect(gets(calls)).toHaveLength(1);

    stepped = true;
    await userEvent.type(field, '123456');
    await userEvent.click(screen.getByRole('button', { name: stepUp.submit }));

    await screen.findByText('the owner is a thief');
    expect(stepUpCalls).toHaveLength(1);
    expect(stepUpCalls[0]!.body).toEqual({ code: '123456' });
    expect(gets(calls)).toHaveLength(2);
  });

  it('a decision refused with STEP_UP_REQUIRED keeps its card and its note', async () => {
    queue(() => fail(403, 'STEP_UP_REQUIRED'));
    mount();
    await openQueue();

    await decide('the owner is a thief', 'abusive and unfounded', moderation.approve);

    expect(await screen.findByLabelText(stepUp.codeLabel)).toBeInTheDocument();
    const card = screen.getByText('the owner is a thief').closest('li')!;
    expect(within(card).getByLabelText(moderation.note.label)).toHaveValue('abusive and unfounded');
    expect(within(card).getByRole('alert')).toHaveTextContent(moderation.error.STEP_UP_REQUIRED!);
  });
});
