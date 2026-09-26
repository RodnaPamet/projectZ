import { pushChannels } from '@/lib/push/channels';

/**
 * "PUSH IS OFF" MUST BE AN OBSERVATION, NOT A DISCOVERY.
 *
 * APNs had never sent a notification to Apple (#166), and nothing anywhere said
 * so. `mintProviderToken` returns null when any of its three credentials is
 * missing — correct, because push must not throw into whatever was trying to
 * notify somebody — and the three variables were not even declared in
 * `src/env.ts`, unlike their VAPID counterparts. A deploy intending to have
 * native push on had no validation, no warning and no health signal to find out
 * it did not.
 *
 * The assertion that matters most below is the PARTIAL one: two of three
 * credentials must report `disabled`, because that is the state a half-finished
 * deploy is actually in, and reporting `configured` there would be a readiness
 * signal that lies.
 */

const APNS = [
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_PRIVATE_KEY',
  // The sandbox pair must be saved and cleared too, or the scoped-key test
  // below leaks a sandbox credential into every test after it and they start
  // reporting `configured` for reasons that have nothing to do with them.
  'APNS_KEY_ID_SANDBOX',
  'APNS_PRIVATE_KEY_SANDBOX',
] as const;
const VAPID = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const;

describe('pushChannels', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of [...APNS, ...VAPID]) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  it('reports both channels disabled when nothing is set', () => {
    expect(pushChannels()).toEqual({
      webPush: 'disabled',
      apns: { production: 'disabled', sandbox: 'disabled' },
    });
  });

  it('reports apns configured only when ALL THREE credentials are present', () => {
    // The load-bearing case. `mintProviderToken` needs all three and returns
    // null if any is absent, so anything short of three is a disabled channel —
    // and that is exactly the state a partially-configured deploy is in.
    process.env.APNS_KEY_ID = 'ABC123';
    expect(pushChannels().apns.production).toBe('disabled');

    process.env.APNS_TEAM_ID = 'TEAM456';
    expect(pushChannels().apns.production).toBe('disabled');

    // Deliberately NOT shaped like a PEM. `pushChannels` checks presence, not
    // parseability, so a realistic-looking key would buy nothing here and would
    // trip the secret scanner — which is working as intended when it does.
    process.env.APNS_PRIVATE_KEY = 'any-non-empty-value';
    expect(pushChannels().apns.production).toBe('configured');
    // Sandbox falls back to the production pair, matching `credentials()` in
    // apns.ts. A one-key deployment can genuinely reach both.
    expect(pushChannels().apns.sandbox).toBe('configured');
  });

  it('reports the two APNs environments independently when the keys are scoped', () => {
    // ═══ WHY THIS SHAPE EXISTS AT ALL ═══
    //
    // An APNs auth key can be scoped to ONE environment, and both of this
    // account's are — each is refused by the other with
    // BadEnvironmentKeyInToken, measured against Apple.
    //
    // A debug build registers against SANDBOX and TestFlight against
    // PRODUCTION. A single `apns: configured` therefore claimed push worked
    // while half the devices were unreachable, which is the readiness signal
    // that lies all over again.
    process.env.APNS_TEAM_ID = 'TEAM456';
    process.env.APNS_KEY_ID_SANDBOX = 'SANDBOXKEY';
    process.env.APNS_PRIVATE_KEY_SANDBOX = 'sandbox-key-value';

    expect(pushChannels().apns).toEqual({ production: 'disabled', sandbox: 'configured' });

    process.env.APNS_KEY_ID = 'PRODKEY';
    process.env.APNS_PRIVATE_KEY = 'prod-key-value';

    expect(pushChannels().apns).toEqual({ production: 'configured', sandbox: 'configured' });
  });

  it('reports web push configured only when all three VAPID values are present', () => {
    process.env.VAPID_PUBLIC_KEY = 'pub';
    process.env.VAPID_PRIVATE_KEY = 'priv';
    expect(pushChannels().webPush).toBe('disabled');

    process.env.VAPID_SUBJECT = 'mailto:ops@playerz.bg';
    expect(pushChannels().webPush).toBe('configured');
  });

  it('reports the two channels independently', () => {
    // A PWA-only deployment is a real configuration, and so is the reverse.
    // One channel being on must not imply anything about the other.
    process.env.VAPID_PUBLIC_KEY = 'pub';
    process.env.VAPID_PRIVATE_KEY = 'priv';
    process.env.VAPID_SUBJECT = 'mailto:ops@playerz.bg';

    expect(pushChannels()).toEqual({
      webPush: 'configured',
      apns: { production: 'disabled', sandbox: 'disabled' },
    });
  });

  it('treats an empty string as absent, not as a value', () => {
    // A `.env` line like `APNS_KEY_ID=` sets an empty string. Reporting that as
    // configured would be the most confusing possible answer: the sending code
    // checks truthiness, so it would disable itself while the health signal
    // claimed otherwise.
    process.env.APNS_KEY_ID = '';
    process.env.APNS_TEAM_ID = '';
    process.env.APNS_PRIVATE_KEY = '';

    expect(pushChannels().apns).toEqual({ production: 'disabled', sandbox: 'disabled' });
  });
});

describe('the APNs variables are on the documented config surface', () => {
  it('src/env.ts declares all three, as it does for VAPID', () => {
    // The original defect in #166 was not the missing .p8 — it was that these
    // three were read straight from process.env and never DECLARED, so APNs was
    // invisible to the config surface while VAPID was not. If a future edit
    // drops them again, the channel goes quiet in exactly the same way.
    //
    // A string scan rather than an import, because importing src/env.ts
    // validates the whole environment as a side effect.
    const src = require('node:fs').readFileSync('src/env.ts', 'utf8') as string;

    for (const key of APNS) {
      expect(src).toMatch(new RegExp(`${key}:\\s*z\\.string\\(\\)\\.optional\\(\\)`));
      // And plumbed into the runtime map, or the declaration validates nothing.
      expect(src).toContain(`${key}: process.env.${key}`);
    }
  });
});
