/**
 * Which push channels are actually configured.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Both push paths disable themselves silently when their credentials are
 * missing, and both are right to: `apns.ts` returns null from
 * `mintProviderToken` and `send.ts` skips Web Push, because push is an
 * enhancement and throwing into whatever was trying to notify somebody would be
 * worse than not notifying them.
 *
 * The problem was that nothing ever said so. APNs has never sent a notification
 * to Apple (#166), and a deploy intending to have native push on had no way to
 * find out it did not — no validation, no warning, no health signal. The code
 * reads as done, which is a more dangerous state than unbuilt.
 *
 * So this reports configuration, and the readiness probe surfaces it.
 *
 * ═══ WHY IT DOES NOT AFFECT READINESS ═══
 *
 * A missing optional credential must NOT take a pod out of rotation. The app
 * serves every request perfectly well without push, and a readiness probe that
 * fails on an enhancement is how a deploy gets blocked by something nobody
 * considered load-bearing.
 *
 * It is reported alongside the checks, and read by a human or a dashboard.
 *
 * ═══ WHAT "configured" DOES NOT MEAN ═══
 *
 * It means the credentials are PRESENT, not that they work. APNs in particular
 * has never been exercised against Apple: `dsaEncoding: 'ieee-p1363'` and the
 * `\n`-unescaping of the PKCS#8 key are both assumptions about what Apple
 * accepts, and both are the kind of thing accepted locally and rejected by the
 * provider. Nothing short of one real send to one real device settles that.
 */

export type ChannelState = 'configured' | 'disabled';

export interface PushChannels {
  /** Web Push (VAPID) — browsers and the PWA. */
  webPush: ChannelState;
  /** APNs — the native iOS client. */
  apns: ChannelState;
}

const state = (present: boolean): ChannelState => (present ? 'configured' : 'disabled');

/**
 * Read straight from `process.env`, matching how `send.ts` and `apns.ts` read
 * these same variables at use. Declaring them in `src/env.ts` is what puts them
 * on the documented surface; reading them here is what keeps this honest about
 * what the sending code will actually find.
 */
export function pushChannels(): PushChannels {
  return {
    webPush: state(
      Boolean(process.env.VAPID_PUBLIC_KEY) &&
        Boolean(process.env.VAPID_PRIVATE_KEY) &&
        Boolean(process.env.VAPID_SUBJECT),
    ),
    // All three, because mintProviderToken requires all three and returns null
    // if any is absent. Reporting "configured" on two of them would be a
    // readiness signal that lies.
    apns: state(
      Boolean(process.env.APNS_KEY_ID) &&
        Boolean(process.env.APNS_TEAM_ID) &&
        Boolean(process.env.APNS_PRIVATE_KEY),
    ),
  };
}
