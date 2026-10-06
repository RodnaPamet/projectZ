import { type NextRequest } from 'next/server';

import { notificationSettingsPatchSchema } from '@/app-layer/schemas/notifications';
import {
  getMyNotificationSettings,
  updateMyNotificationSettings,
} from '@/app-layer/usecases/my-notifications';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/notification-settings — which emails the caller gets (#367,
 * Q22): `{ email: { confirmation, reminder, clubChanges } }`. The bell is
 * always on and has no switch.
 */
async function getHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const settings = await getMyNotificationSettings(ctx.userId);
  if (!settings) throw new UnauthorizedError('Authentication required');
  return ok(settings);
}

/**
 * PATCH /api/v1/me/notification-settings — turn email categories on or off.
 * `.strict()`: `{ email: { reminder: false } }` and nothing else; at least one
 * category. Answers the settings as stored.
 */
async function patchHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const body = await parseJsonBody(req, notificationSettingsPatchSchema, 'settings');
  const settings = await updateMyNotificationSettings(ctx.userId, body.email);
  if (!settings) throw new UnauthorizedError('Authentication required');
  return ok(settings);
}

export const GET = defineV1Route(getHandler);
export const PATCH = defineV1Route(patchHandler);
