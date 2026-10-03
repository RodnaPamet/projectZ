import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

import { SecurityPanel } from '@/app/(app)/platform/security/SecurityPanel';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok, type FakeHandler } from '../unit/data/fake-v1';

/**
 * Two-step verification for a platform admin (#262), against the REAL
 * Bulgarian catalogue and a fake v1.
 *
 * The property that matters: the secret and the recovery codes are shown
 * ONCE, from the POST that produced them, and never fetched again — the server
 * keeps the secret encrypted and the codes hashed, so there is nothing to
 * fetch. Each test counts what was requested.
 */

const sec = (messages as unknown as { platform: { security: Record<string, unknown> } }).platform
  .security as {
  status: { on: string; off: string };
  notEligible: string;
  enrol: {
    start: string;
    codeLabel: string;
    confirm: string;
    reauth: string;
    openApp: string;
    qrAlt: string;
  };
  recovery: { title: string; done: string };
  error: Record<string, string>;
};

// A made-up fixture key; nothing anywhere is enrolled with it.
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // pragma: allowlist secret
const URI = `otpauth://totp/x?secret=${SECRET}`;
// What the server sends for that URI: the QR's geometry, drawn server-side (#342).
const QR = { size: 29, path: 'M4 4h7v1h-7zM12 4h1v1h-1z' };
const CODES = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-DDD${'ABCDEFGHIJ'[i]}`);

let status = {
  eligible: true,
  enrolled: false,
  pending: false,
  stepUpExpiresAt: null as string | null,
  recoveryCodesRemaining: 0,
};

function v1(post: FakeHandler = () => ok({})) {
  return installFakeFetch((c) => (c.method === 'POST' ? post(c) : ok(status)));
}

function mount() {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <ViewerScope viewerId="usr_mod">
            <SecurityPanel />
          </ViewerScope>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
  status = {
    eligible: true,
    enrolled: false,
    pending: false,
    stepUpExpiresAt: null,
    recoveryCodesRemaining: 0,
  };
});

it('enrols: shows the key, confirms a code, and shows the recovery codes ONCE', async () => {
  const calls = v1((c) => {
    if (c.url.endsWith('/me/mfa/enrolment')) {
      return ok({ secret: SECRET, otpauthUri: URI, qr: QR });
    }
    if (c.url.endsWith('/me/mfa/enrolment/confirm')) {
      status = { ...status, enrolled: true, recoveryCodesRemaining: 10 };
      return ok({ recoveryCodes: CODES, stepUpExpiresAt: '2099-01-01T00:00:00Z' });
    }
    return fail(404, 'NOT_FOUND');
  });
  mount();

  await userEvent.click(await screen.findByRole('button', { name: sec.enrol.start }));
  // Grouped in fours so it can be typed by hand.
  expect(await screen.findByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
  // The QR, as the server drew it, named by its fallback; the phone's deep link beside it.
  const qr = screen.getByRole('img', { name: sec.enrol.qrAlt });
  expect(qr.tagName.toLowerCase()).toBe('svg');
  expect(qr.getAttribute('viewBox')).toBe('0 0 29 29');
  expect(qr.querySelector('path')!.getAttribute('d')).toBe(QR.path);
  expect(screen.getByRole('link', { name: sec.enrol.openApp })).toHaveAttribute('href', URI);
  // Nothing went anywhere but our own API: no QR service ever sees the key.
  expect(calls.map((c) => new URL(c.url, 'http://localhost').pathname)).toEqual(
    calls.map(() => expect.stringMatching(/^\/api\/v1\//)),
  );

  await userEvent.type(screen.getByLabelText(sec.enrol.codeLabel), '123456');
  await userEvent.click(screen.getByRole('button', { name: sec.enrol.confirm }));

  expect(await screen.findByRole('heading', { name: sec.recovery.title })).toBeInTheDocument();
  for (const c of CODES) expect(screen.getByText(c)).toBeInTheDocument();
  expect(calls.find((c) => c.url.endsWith('/confirm'))!.body).toEqual({ code: '123456' });

  await userEvent.click(screen.getByRole('button', { name: sec.recovery.done }));
  // Gone for good: nothing re-fetches them, because nothing can.
  expect(screen.queryByText(CODES[0]!)).toBeNull();
  expect(await screen.findByText(sec.status.on)).toBeInTheDocument();
});

it('a stale sign-in is told to sign in again', async () => {
  v1(() => fail(403, 'MFA_REAUTH_REQUIRED'));
  mount();

  await userEvent.click(await screen.findByRole('button', { name: sec.enrol.start }));

  expect(await screen.findByText(sec.enrol.reauth)).toBeInTheDocument();
});

it('offers nothing to enrol to an account without a grant', async () => {
  status = { ...status, eligible: false };
  v1();
  mount();

  expect(await screen.findByText(sec.notEligible)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: sec.enrol.start })).toBeNull();
});
