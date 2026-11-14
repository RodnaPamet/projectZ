import { type NextRequest } from 'next/server';
import { z } from 'zod';

import { assertAssistantEnabled } from '@/app-layer/ai/assistant/config';
import { editRememberedPoint, forgetRememberedPoint } from '@/app-layer/usecases/assistant-memory';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { noContent, ok } from '@/app/api/v1/_lib/envelope';
import { REMEMBERED_POINT_MAX_CHARS } from '@/lib/assistant/memory-limits';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * One remembered point (owner 2026-11-14, #704).
 *
 * PATCH `{ text }` → the point, corrected: it is the person's now, and the
 *        assistant never rewrites it (memory rule 6).
 * DELETE → 204: forgotten, and never learned again (rule 5).
 *
 * 404 `MEMORY_POINT_NOT_FOUND` for an id that is not the caller's live point.
 */
const EditSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(REMEMBERED_POINT_MAX_CHARS * 2),
  })
  .strict();

async function caller(req: NextRequest): Promise<string> {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  assertAssistantEnabled();
  return ctx.userId;
}

async function edit(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await caller(req);
  const { id } = await params;
  const body = await parseJsonBody(req, EditSchema, 'point');
  return ok(await editRememberedPoint(userId, id, body.text));
}

async function forget(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await caller(req);
  const { id } = await params;
  await forgetRememberedPoint(userId, id);
  return noContent();
}

export const PATCH = defineV1Route(edit);
export const DELETE = defineV1Route(forget);
