import type { AuditActorType, Prisma, PrismaClient } from '@prisma/client';

import { getRequestId } from '@/lib/observability/context';

/**
 * Writing down who changed what.
 *
 * ═══ IT TAKES YOUR `db`, AND THAT IS THE WHOLE DESIGN ═══
 *
 * The obvious signature is `appendAuditEntry(input)`, reaching for a shared
 * client internally. It is also wrong, and wrong in a way that only shows up
 * when something else goes wrong:
 *
 *   - A write on its own connection can COMMIT while the change it describes
 *     ROLLS BACK. The log then asserts something happened that did not, which
 *     is worse than no log: an investigation trusts it.
 *   - Or the change commits and the audit write fails, leaving a privileged
 *     action with no record — the exact case the table exists for.
 *
 * Taking the caller's handle means the row joins their transaction. The change
 * and its record commit together or not at all. That is not achievable from
 * inside a helper that owns its own connection, which is why the parameter is
 * mandatory rather than optional-with-a-fallback.
 *
 * ═══ IT THROWS ═══
 *
 * Deliberately not `.catch(() => {})`. A swallowed failure means the audit log
 * is silently incomplete and nothing anywhere says so — the same shape as a
 * check that reports success by not looking. A caller that genuinely wants
 * best-effort has to write the catch itself, and in writing it, decide.
 *
 * For a privileged change the right answer is usually to let it throw: an
 * unauditable privilege change should not happen.
 *
 * ═══ RLS ═══
 *
 * `audit_entry` is tenant-isolated with a symmetric WITH CHECK, so a handle
 * bound to tenant A physically cannot write a row stamped tenant B. Calls from
 * a superuser path must therefore pass the right `tenantId` themselves — the
 * binding is not there to catch them.
 */

/**
 * The verbs. A constant rather than a bare string at the call site, so a typo
 * is a compile error instead of a row nobody will ever find again — `action`
 * is a String column precisely so this set can grow without a migration, and
 * that freedom is what makes the typo possible.
 */
export const AUDIT_ACTIONS = {
  MEMBER_ROLE_CHANGED: 'MEMBER_ROLE_CHANGED',
  MEMBER_REMOVED: 'MEMBER_REMOVED',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  /// A PENDING booking whose checkout window elapsed. Nobody decided it.
  BOOKING_EXPIRED: 'BOOKING_EXPIRED',
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED',
  /// Money arrived that could not be applied to its booking. Always needs a human.
  PAYMENT_UNAPPLIED: 'PAYMENT_UNAPPLIED',
  SESSIONS_REVOKED: 'SESSIONS_REVOKED',
  CONNECT_ACCOUNT_CREATED: 'CONNECT_ACCOUNT_CREATED',
  BILLING_CUSTOMER_CREATED: 'BILLING_CUSTOMER_CREATED',
  SSO_GROUP_MAPPING_CREATED: 'SSO_GROUP_MAPPING_CREATED',
  SSO_GROUP_MAPPING_UPDATED: 'SSO_GROUP_MAPPING_UPDATED',
  SSO_GROUP_MAPPING_DELETED: 'SSO_GROUP_MAPPING_DELETED',
  COURT_CREATED: 'COURT_CREATED',
  COURT_UPDATED: 'COURT_UPDATED',
  /// Status moved to CLOSED. Deliberately not DELETED: the row stays, because
  /// bookings, payments and ledger entries still point at it.
  COURT_ARCHIVED: 'COURT_ARCHIVED',
  COURT_REOPENED: 'COURT_REOPENED',
  PRICING_RULE_CREATED: 'PRICING_RULE_CREATED',
  PRICING_RULE_UPDATED: 'PRICING_RULE_UPDATED',
  /// Pricing rules CAN be deleted — unlike a court, nothing references one.
  /// A booking stores the price it was charged, not the rule that produced it.
  PRICING_RULE_DELETED: 'PRICING_RULE_DELETED',
  PLAYER_TAGS_CHANGED: 'PLAYER_TAGS_CHANGED',
  /// A staff member moved a player's credit by hand. The ledger row is the
  /// record of the money; this is the record of the decision.
  PLAYER_CREDIT_ADJUSTED: 'PLAYER_CREDIT_ADJUSTED',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditInput {
  tenantId: string;
  /** NULL when nothing human acted. Not the same as "we did not record it". */
  actorUserId?: string | null;
  actorType?: AuditActorType;
  /** Prisma model name of the thing acted upon. */
  entity: string;
  entityId: string;
  action: AuditAction;
  details?: string | null;
  detailsJson?: Prisma.InputJsonValue;
  /**
   * Defaults to the current request's id, so an audit row can be lined up
   * against the log lines for the same request. `getRequestId()` returns
   * 'unknown' outside a request context; that is stored as NULL rather than
   * the literal string, because a column full of 'unknown' reads like a value.
   */
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function appendAuditEntry(db: PrismaClient, input: AuditInput): Promise<void> {
  const resolvedRequestId = input.requestId ?? getRequestId();

  await db.auditEntry.create({
    data: {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorType ?? 'USER',
      entity: input.entity,
      entityId: input.entityId,
      action: input.action,
      details: input.details ?? null,
      detailsJson: input.detailsJson ?? {},
      requestId: resolvedRequestId === 'unknown' ? null : resolvedRequestId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}
