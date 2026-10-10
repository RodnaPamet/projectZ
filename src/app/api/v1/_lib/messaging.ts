import type { NextRequest } from 'next/server';

import { idempotencyKeySchema, messagingIdSchema } from '@/app-layer/schemas/messaging';
import { hasPermission, type RequestContext } from '@/app-layer/types';
import type {
  ConversationSummary,
  ConversationView,
  MessagingActor,
} from '@/app-layer/usecases/messaging';
import { AppError, UnauthorizedError, ValidationError } from '@/lib/errors/types';

/**
 * The messaging routes' shared edges (#375): who the actor is, the ids and
 * headers they take, and the wire shapes they answer with.
 */

/** A player acting as themselves. The use case checks the account is a player's. */
export function playerActor(ctx: RequestContext): Extract<MessagingActor, { kind: 'player' }> {
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  return { kind: 'player', userId: ctx.userId };
}

/**
 * A staff member acting for their club: an ACTIVE membership at the club in
 * the path (resolved from the database by `contextFromRequest`) whose role
 * holds `messages.club` — OWNER, MANAGER and STAFF. The P54 policy asks the
 * same of the database, so this is the first of two answers, not the only one.
 */
export function clubActor(ctx: RequestContext): Extract<MessagingActor, { kind: 'club' }> {
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  if (!ctx.tenantId || !hasPermission(ctx, 'messages.club')) {
    throw new AppError('Forbidden', 'FORBIDDEN', 403, true, {
      requiredPermission: 'messages.club',
    });
  }
  return { kind: 'club', userId: ctx.userId, tenantId: ctx.tenantId };
}

export function messagingId(raw: string, what: string): string {
  const parsed = messagingIdSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`Invalid ${what}`, { field: what });
  return parsed.data;
}

/** `Idempotency-Key`, optional on a send. */
export function idempotencyKey(req: NextRequest): string | null {
  const raw = req.headers.get('idempotency-key');
  if (raw === null) return null;
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('`Idempotency-Key` is 1 to 128 characters', {
      field: 'Idempotency-Key',
    });
  }
  return parsed.data;
}

/** A cursor query parameter: opaque, bounded. A stale one restarts the listing. */
export function cursorParam(req: NextRequest, name: string): string | null {
  const raw = req.nextUrl.searchParams.get(name);
  if (raw === null || raw === '') return null;
  if (raw.length > 200) throw new ValidationError(`\`${name}\` is not a cursor`, { field: name });
  return raw;
}

// ─── Wire shapes ────────────────────────────────────────────────────────

export type ConversationSummaryDto = Omit<ConversationSummary, 'lastMessageAt'> & {
  lastMessageAt: string;
};

export type MessageDto = Omit<ConversationView['messages'][number], 'createdAt'> & {
  createdAt: string;
};

export type ConversationDto = Omit<ConversationView, 'messages'> & { messages: MessageDto[] };

export function toSummaryDto(s: ConversationSummary): ConversationSummaryDto {
  return { ...s, lastMessageAt: s.lastMessageAt.toISOString() };
}

export function toConversationDto(v: ConversationView): ConversationDto {
  return {
    ...v,
    messages: v.messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
  };
}
