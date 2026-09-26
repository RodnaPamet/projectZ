import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { mintProviderToken, resetProviderTokenCache } from '../src/lib/push/apns';

/**
 * Prove the APNs CREDENTIALS work, without a device and without an iOS app.
 *
 * ═══ WHY THIS CAN EXIST AT ALL ═══
 *
 * #166 says the APNs path has never run against Apple, and names two untested
 * assumptions: `dsaEncoding: 'ieee-p1363'` and the `\n`-unescaping of the
 * PKCS#8 key. Both are ABOUT AUTHENTICATION. Neither has anything to do with a
 * device.
 *
 * Apple evaluates a push request in order: first the provider token, then the
 * topic, then the device token. So sending a deliberately INVALID device token
 * with valid credentials gets past the two checks we care about and fails on
 * the third — and the reason string tells us exactly how far we got:
 *
 *   400 BadDeviceToken        ← SUCCESS. The JWT and the topic were accepted.
 *   403 InvalidProviderToken  ← the JWT is malformed. DER instead of raw r‖s,
 *                               or the key did not parse. The #166 assumption
 *                               is wrong, and this is what we were testing for.
 *   403 ExpiredProviderToken  ← the JWT parsed and verified, but `iat` is out
 *                               of range. Almost always host clock skew.
 *   400 MissingTopic /
 *   400 BadTopic /
 *   400 TopicDisallowed       ← the JWT was fine; the bundle id is wrong, is
 *                               not an App ID under this team, or is not
 *                               enabled for Push Notifications.
 *   404                       ← wrong path. Our bug, not a credential problem.
 *
 * So a `BadDeviceToken` is the GOAL of this script, not a failure. That is the
 * whole point: everything the owner can verify without hardware, verified
 * before anyone buys a device or ships an app.
 *
 * What this does NOT prove: that a real notification arrives on a real phone,
 * with the right payload, in the right environment. That still needs #167 and
 * a real device token, and it is the only part that does.
 *
 * ═══ THE KEY IS NEVER PRINTED, AND PREFERABLY NEVER IN AN ENV VAR ═══
 *
 * `--key-file` reads the .p8 straight off disk, which is how Apple gives it to
 * you and the form least likely to be mangled. `*.p8` is gitignored. The env
 * var path (APNS_PRIVATE_KEY) exists because that is what production uses, and
 * testing the same parsing production does is the point — but for a local
 * preflight, prefer the file.
 *
 * Nothing here logs the key, the JWT, or any part of either.
 *
 *   npx tsx scripts/apns-preflight.ts \
 *     --key-file ~/AuthKey_ABC1234567.p8 \
 *     --key-id ABC1234567 --team-id 9423GKWL67 \
 *     --bundle-id bg.playerz.app --env sandbox
 */

const HOSTS = {
  sandbox: 'api.sandbox.push.apple.com',
  production: 'api.push.apple.com',
} as const;

/**
 * 64 hex characters — the right SHAPE, guaranteed not to be a real token.
 *
 * Shape matters: a malformed token can be rejected before the topic is even
 * looked at, which would hide a topic problem behind a device-token error.
 */
const DEAD_TOKEN = 'f'.repeat(64);

interface Outcome {
  status: number;
  reason?: string;
  apnsId?: string;
}

async function send(host: string, jwt: string, topic: string): Promise<Outcome> {
  // Imported lazily so the module is only touched when we actually send.
  const { connect, constants } = await import('node:http2');
  const session = connect(`https://${host}`);

  try {
    return await new Promise<Outcome>((resolve, reject) => {
      // A connection-level failure (DNS, TLS, refused) emits on the SESSION,
      // not the stream. Without this listener Node treats it as an unhandled
      // 'error' event and kills the process.
      session.on('error', reject);

      const stream = session.request({
        ':method': 'POST',
        ':path': `/3/device/${DEAD_TOKEN}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': 10,
        'content-type': 'application/json',
      });

      const timer = setTimeout(() => {
        stream.close(constants.NGHTTP2_CANCEL);
        reject(new Error(`timed out after 10s talking to ${host}`));
      }, 10_000);

      let status = 0;
      let apnsId: string | undefined;
      let raw = '';

      stream.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
        apnsId = typeof h['apns-id'] === 'string' ? h['apns-id'] : undefined;
      });
      stream.on('data', (c: Buffer) => {
        raw += c.toString('utf8');
      });
      stream.on('end', () => {
        clearTimeout(timer);
        let reason: string | undefined;
        try {
          reason = (JSON.parse(raw) as { reason?: string }).reason;
        } catch {
          // 200 has an empty body; only failures carry JSON.
        }
        resolve({ status, reason, apnsId });
      });
      stream.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });

      stream.end(JSON.stringify({ aps: { alert: { title: 'preflight', body: 'preflight' } } }));
    });
  } finally {
    session.close();
  }
}

/** What each outcome MEANS, which is the entire value of this script. */
function verdict(o: Outcome): { ok: boolean; headline: string; detail: string } {
  const r = o.reason ?? '';

  if (o.status === 400 && r === 'BadDeviceToken') {
    return {
      ok: true,
      headline: 'CREDENTIALS WORK.',
      detail:
        'Apple accepted the provider token AND the topic, then rejected the ' +
        'deliberately-dead device token — which is exactly how far this can get ' +
        'without a real device.\n\n' +
        "  • ES256 with dsaEncoding 'ieee-p1363' is correct — a DER signature\n" +
        '    would have returned InvalidProviderToken here.\n' +
        '  • The .p8 parsed correctly out of the form it was supplied in.\n' +
        '  • The bundle id is a real App ID under this team, enabled for push.\n\n' +
        'Remaining for #166: one real device token, which needs the iOS client (#167).',
    };
  }

  if (o.status === 403 && r === 'InvalidProviderToken') {
    return {
      ok: false,
      headline: 'THE JWT IS MALFORMED — this is the #166 assumption failing.',
      detail:
        'Apple parsed the request and rejected the signature itself. Causes, most likely first:\n' +
        '  • the key id (--key-id) does not match the .p8 that signed this\n' +
        '  • the team id is wrong\n' +
        "  • the signature is DER rather than raw r‖s (dsaEncoding: 'ieee-p1363')\n" +
        '  • the .p8 was mangled in transit — re-run with --key-file to rule that out\n' +
        '  • the key was revoked in the Apple Developer portal',
    };
  }

  if (o.status === 403 && r === 'ExpiredProviderToken') {
    return {
      ok: false,
      headline: 'The JWT verified, but Apple considers it expired.',
      detail:
        'The signature and the key are RIGHT — this is a clock problem, not a\n' +
        "credential problem. Check this host's time against NTP. `iat` is minted\n" +
        'from Date.now(), so a skew of more than an hour in either direction does this.',
    };
  }

  if (o.status === 400 && (r === 'BadTopic' || r === 'TopicDisallowed' || r === 'MissingTopic')) {
    return {
      ok: false,
      headline: `The credentials are fine. The topic is not (${r}).`,
      detail:
        'Apple accepted the provider token — so the .p8, the key id and the team id\n' +
        'are all correct, and the ieee-p1363 question is answered. What failed is\n' +
        '--bundle-id: it must be an App ID registered under this team WITH the Push\n' +
        'Notifications capability enabled, and it must match the app exactly.',
    };
  }

  if (o.status === 403 && r === 'BadEnvironmentKeyInToken') {
    return {
      ok: false,
      headline: 'The key is VALID but not for this environment.',
      detail:
        'Apple verified the signature — so the .p8, the key id, the team id and\n' +
        'the ieee-p1363 encoding are all correct. What is wrong is which APNs\n' +
        'environment this key is enabled for.\n\n' +
        'This matters more than it looks. A DEVELOPMENT build of the iOS app\n' +
        'registers against SANDBOX; TestFlight and the App Store register against\n' +
        'PRODUCTION. A key that only works for one of them fails silently on the\n' +
        'other, and the device row looks perfectly healthy while it does.\n\n' +
        'Fix in the portal: Keys → the APNs key → make sure both environments are\n' +
        'enabled, or issue a key that covers the one you are missing.',
    };
  }

  if (o.status === 404) {
    return {
      ok: false,
      headline: 'Apple returned 404 — a request-shape bug, not a credential problem.',
      detail:
        'The :path or :method is wrong. That is our code, and this script would be the place to fix it.',
    };
  }

  return {
    ok: false,
    headline: `Unexpected: HTTP ${o.status}${r ? ` ${r}` : ''}`,
    detail:
      'Not a documented preflight outcome. Record it on #166 verbatim —\n' +
      'an undocumented response is itself worth knowing before a real send.',
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'key-file': { type: 'string' },
      'key-id': { type: 'string' },
      'team-id': { type: 'string' },
      'bundle-id': { type: 'string' },
      env: { type: 'string', default: 'sandbox' },
    },
  });

  const keyId = values['key-id'] ?? process.env.APNS_KEY_ID;
  const teamId = values['team-id'] ?? process.env.APNS_TEAM_ID;
  const bundleId = values['bundle-id'] ?? process.env.APNS_BUNDLE_ID;
  const environment = values.env === 'production' ? 'production' : 'sandbox';

  const missing = [
    !keyId && '--key-id (or APNS_KEY_ID)',
    !teamId && '--team-id (or APNS_TEAM_ID)',
    !bundleId && '--bundle-id (or APNS_BUNDLE_ID)',
  ].filter(Boolean);

  if (missing.length) {
    console.error(`Missing: ${missing.join(', ')}`);
    console.error('\nAlso needs the signing key, either:');
    console.error('  --key-file ~/AuthKey_XXXXXXXXXX.p8      (preferred)');
    console.error('  APNS_PRIVATE_KEY=<PEM>                  (what production uses)');
    process.exitCode = 1;
    return;
  }

  // Read the .p8 off disk when given, so nothing has to survive a shell or a
  // dotenv file. Assigned into the env var because mintProviderToken reads
  // there — deliberately, so this exercises the SAME parsing production uses
  // rather than a parallel implementation that could differ.
  const keyFile = values['key-file'];
  if (keyFile) {
    process.env.APNS_PRIVATE_KEY = readFileSync(
      keyFile.replace(/^~/, process.env.HOME ?? '~'),
      'utf8',
    );
  }
  if (!process.env.APNS_PRIVATE_KEY) {
    console.error('No signing key. Pass --key-file, or set APNS_PRIVATE_KEY.');
    process.exitCode = 1;
    return;
  }

  process.env.APNS_KEY_ID = keyId;
  process.env.APNS_TEAM_ID = teamId;
  // Both slots, so --key-id applies whichever environment is being probed.
  process.env.APNS_KEY_ID_SANDBOX = keyId;
  process.env.APNS_PRIVATE_KEY_SANDBOX = process.env.APNS_PRIVATE_KEY;
  resetProviderTokenCache();

  // Mint for the environment being probed — the keys are scoped to one.
  const jwt = mintProviderToken(Date.now(), environment === 'sandbox' ? 'SANDBOX' : 'PRODUCTION');
  if (!jwt) {
    console.error('mintProviderToken returned null with all three present — that is itself a bug.');
    process.exitCode = 1;
    return;
  }

  const host = HOSTS[environment];
  console.log(`→ ${host}  topic=${bundleId}  key=${keyId}  team=${teamId}`);
  console.log(`  (sending to a deliberately dead device token; BadDeviceToken is the goal)\n`);

  let outcome: Outcome;
  try {
    outcome = await send(host, jwt, bundleId!);
  } catch (err) {
    console.error(`✗ Could not complete the request: ${(err as Error).message}`);
    console.error(
      '  A connection failure, not an Apple verdict. Check network and egress to :443.',
    );
    process.exitCode = 1;
    return;
  }

  const v = verdict(outcome);
  console.log(
    `HTTP ${outcome.status}${outcome.reason ? `  ${outcome.reason}` : ''}${outcome.apnsId ? `  apns-id=${outcome.apnsId}` : ''}`,
  );
  console.log(`\n${v.ok ? '✓' : '✗'} ${v.headline}\n`);
  console.log(v.detail);
  if (!v.ok) process.exitCode = 1;
}

void main();
