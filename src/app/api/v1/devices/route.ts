import { type NextRequest } from 'next/server';

import { asUser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { noContent, ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * Register (or re-register) this device for push.
 *
 * ═══ NO TENANT, AND asUser RATHER THAN inTenant ═══
 *
 * A device belongs to a PERSON. Your phone receives your notifications at
 * every club you belong to, so a registration scoped to one club would mean
 * re-registering on every switch and a device row per membership.
 *
 * `asUser` binds `app.user_id` and no tenant, which is exactly what
 * `device_token_owner_only` keys on. A tenant-bound handle would match no rows
 * at all — the policy does not mention tenants.
 *
 * ═══ UPSERT, BECAUSE iOS REISSUES TOKENS ═══
 *
 * A device token is not stable. iOS reissues it on reinstall, on restore from
 * backup, and sometimes for its own reasons, so a well-behaved client calls
 * this on EVERY launch. Inserting each time would accumulate dead rows and
 * send every notification several times to the same phone; the unique index on
 * (deviceToken, environment) plus an upsert is what makes repeat calls free.
 *
 * ═══ environment IS NOT A DETAIL ═══
 *
 * SANDBOX and PRODUCTION are different APNs hosts with different token
 * namespaces, and it is the CLIENT that knows which build it is. A debug build
 * that registers as PRODUCTION gets BadDeviceToken for ever, which presents as
 * "push is broken" rather than as a configuration mistake.
 */
interface RegisterBody {
  deviceToken?: unknown;
  bundleId?: unknown;
  environment?: unknown;
  deviceName?: unknown;
  osVersion?: unknown;
}

/** APNs tokens are hex. Anything else will never authenticate. */
const APNS_TOKEN = /^[a-f0-9]{64,200}$/i;

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ValidationError(`\`${field}\` is required`, { field });
  }
  return v.trim();
}

async function registerHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const body = (await req.json().catch(() => {
    throw new ValidationError('Body must be JSON');
  })) as RegisterBody;

  const deviceToken = requireString(body.deviceToken, 'deviceToken');
  if (!APNS_TOKEN.test(deviceToken)) {
    // Rejected here rather than stored and left to fail against Apple for
    // ever — a malformed token is a client bug worth surfacing now.
    throw new ValidationError('`deviceToken` must be an APNs hex token', {
      field: 'deviceToken',
    });
  }

  const bundleId = requireString(body.bundleId, 'bundleId');
  // ═══ VALIDATED, NOT DEFAULTED ═══
  //
  // This was `body.environment === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION'`, which
  // silently resolved a missing field, `"sandbox"` in the wrong case, and
  // `null` all to PRODUCTION.
  //
  // That is the default path for a DEBUG BUILD, which registers a SANDBOX
  // token. Stored as PRODUCTION, the push goes to api.push.apple.com, Apple
  // answers `400 BadDeviceToken`, and that IS a correct device verdict — so the
  // row is deleted. The app re-registers on next launch and it happens again:
  // push looks broken, the row keeps vanishing, and nothing reports a cause.
  //
  // A client that cannot say which environment its token came from is a client
  // bug, and the same one the `deviceToken` shape check above refuses to paper
  // over. Rejected here, where it is still attributable.
  if (body.environment !== 'SANDBOX' && body.environment !== 'PRODUCTION') {
    throw new ValidationError('`environment` must be exactly "SANDBOX" or "PRODUCTION"', {
      field: 'environment',
    });
  }
  const environment = body.environment;

  const device = await asUser(ctx, (db) =>
    db.deviceToken.upsert({
      where: {
        deviceToken_environment: { deviceToken, environment },
      },
      create: {
        userId: ctx.userId!,
        deviceToken,
        bundleId,
        environment,
        deviceName: typeof body.deviceName === 'string' ? body.deviceName : null,
        osVersion: typeof body.osVersion === 'string' ? body.osVersion : null,
      },
      update: {
        // A token that reappears is alive again: clear the failure count so a
        // device that was offline for a week is not one strike from deletion.
        userId: ctx.userId!,
        bundleId,
        failureCount: 0,
        deviceName: typeof body.deviceName === 'string' ? body.deviceName : undefined,
        osVersion: typeof body.osVersion === 'string' ? body.osVersion : undefined,
      },
      select: { id: true, environment: true, bundleId: true, createdAt: true },
    }),
  );

  return ok({
    id: device.id,
    environment: device.environment,
    bundleId: device.bundleId,
  });
}

async function unregisterHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const deviceToken = req.nextUrl.searchParams.get('deviceToken');
  if (!deviceToken)
    throw new ValidationError('`deviceToken` is required', { field: 'deviceToken' });

  // `deleteMany`, not `delete`: signing out twice, or from a device already
  // removed, must not be an error. And RLS means this can only ever reach the
  // caller's own rows — there is no way to spell somebody else's device here.
  await asUser(ctx, (db) => db.deviceToken.deleteMany({ where: { deviceToken } }));

  return noContent();
}

export const POST = defineV1Route(registerHandler);
export const DELETE = defineV1Route(unregisterHandler);
