import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { getTenantContext } from '@/lib/db/tenant-context';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { isWriteCapability, type PlatformCapability } from '@/lib/platform/capabilities';

/**
 * The only sanctioned way to read across clubs.
 *
 * ═══ THE AUDIT WRITE IS NOT OPTIONAL, AND NOT REMEMBERED ═══
 *
 * The audit row is INSERTed before `fn` runs, in the SAME transaction.
 *
 * ATOMICITY comes from the shared transaction, not from the ordering. Either
 * order gives "the row and the work succeed together or not at all", because a
 * rollback takes both — and it is worth being exact about that rather than
 * claiming the ordering buys something it does not. Writing the audit row
 * second would be equally atomic.
 *
 * What the ordering DOES buy is the case where `fn` has an effect the database
 * cannot roll back — an HTTP call, a queue push, a cache write. Audit-first
 * means the intent is recorded before any such effect fires. (If the
 * transaction then rolls back, the row goes and the side effect does not; that
 * is a reason to keep non-transactional effects out of `fn`, not a reason to
 * reorder.)
 *
 * The guarantee that genuinely cannot be skipped is the trigger, not the order:
 * `platform_audit_attribution_trg` refuses any insert unless
 * `app.platform_admin_id` is set on the transaction AND equals the row's
 * actorUserId. So a caller cannot write the row on someone else's behalf, and
 * code that reaches the table directly cannot write one at all.
 *
 * That matters more than usual here. `DATABASE_URL` connects as a role that is
 * `rolsuper=true, rolbypassrls=true` (measured), so nothing at the ROLE level
 * constrains cross-club access. Triggers fire for the owner and superuser
 * alike, which is why the accountability lives there rather than in a policy.
 *
 * ═══ WHY IT REFUSES TO RUN INSIDE A TENANT TRANSACTION ═══
 *
 * A platform read nested inside `runInTenantContext` would be an escalation
 * from one club's request into every club's data, and the audit row would
 * record it as a standalone platform action with no hint of the tenant request
 * that triggered it. It is also the shape a copy-paste produces: someone adds
 * "just one cross-tenant lookup" inside an existing tenant handler.
 *
 * Refusing is cheap and it is correct whichever way the SAVEPOINT question
 * resolves — `runAsSuperuser` nested inside a tenant transaction gets a
 * SAVEPOINT, so `SET LOCAL ROLE` would apply to the savepoint rather than
 * opening a clean transaction.
 */

export class AmbientPlatformEscalationError extends Error {
  constructor() {
    super(
      'runAsPlatformAdmin() was called inside a tenant-bound transaction. That is an ' +
        'escalation from one club’s request into every club’s data, and the audit row ' +
        'would not record which tenant request caused it. Platform work runs on its own ' +
        'request, from a route under /api/v1/platform, never nested in a tenant handler.',
    );
    this.name = 'AmbientPlatformEscalationError';
  }
}

export class PlatformWriteNotEnabledError extends Error {
  constructor(capability: PlatformCapability) {
    super(
      `${capability} is a WRITE capability and cross-club writes are not enabled. ` +
        'Stepping up to one should require a second factor, and there is none: ' +
        'User.mfaSecret is unencrypted and nothing writes it. The capability is declared ' +
        'so the shape is settled, and refused here so the power does not ship before the ' +
        'defence does.',
    );
    this.name = 'PlatformWriteNotEnabledError';
  }
}

export class PlatformReasonRequiredError extends Error {
  constructor() {
    super(
      'Every platform action needs a stated reason of at least 12 characters. It is ' +
        'written to platform_audit_entry, which is append-only: the reason is what makes ' +
        'the row answerable months later, and "looked at data" answers nothing.',
    );
    this.name = 'PlatformReasonRequiredError';
  }
}

/** The minimum a platform action must declare about itself. */
export interface PlatformAction {
  /** Who is acting. Must match the grant holder. */
  actorUserId: string;
  /** The grant that authorises it. */
  grantId: string;
  /** Which capability is being exercised. */
  capability: PlatformCapability;
  /** SCREAMING_SNAKE verb, from a constant. */
  action: string;
  /** Why — at least 12 characters, and it ends up in an append-only row. */
  reason: string;
  /** The club this is about, when it is about exactly one. */
  subjectTenantId?: string | null;
  entity?: string | null;
  entityId?: string | null;
  detailsJson?: Record<string, unknown>;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const MIN_REASON_LENGTH = 12;

/**
 * Run `fn` with cross-club reach, having first recorded that it happened.
 *
 * The ordering is the design: audit, then work, one transaction. Reversing it
 * would mean a privileged action that succeeded while its record rolled back.
 */
export async function runAsPlatformAdmin<T>(
  act: PlatformAction,
  fn: (db: PrismaClient) => Promise<T>,
): Promise<T> {
  // Guards BEFORE the transaction opens: a refused action should not have cost
  // a connection, and should leave no audit row claiming it was attempted.
  if (getTenantContext()) throw new AmbientPlatformEscalationError();
  if (isWriteCapability(act.capability)) throw new PlatformWriteNotEnabledError(act.capability);
  if (act.reason.trim().length < MIN_REASON_LENGTH) throw new PlatformReasonRequiredError();

  return runAsSuperuser(async (db) => {
    // Bound parameter, never interpolated. This GUC is what the attribution
    // trigger checks, so injecting into it would be injecting into the audit
    // trail itself.
    await db.$executeRawUnsafe(
      `SELECT set_config('app.platform_admin_id', $1, true)`,
      act.actorUserId,
    );

    // Before `fn`. If the trigger refuses this — no GUC set, or an actor that
    // does not match it — the whole transaction aborts and `fn` never runs.
    // (The reverse order would be just as atomic; see the docblock for what the
    // ordering is actually for.)
    await db.$executeRawUnsafe(
      `INSERT INTO platform_audit_entry
         (id, "actorUserId", "grantId", capability, action, "subjectTenantId",
          entity, "entityId", reason, "detailsJson", "requestId", "ipAddress", "userAgent")
       VALUES ($1, $2, $3, $4::"PlatformCapability", $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)`,
      randomUUID(),
      act.actorUserId,
      act.grantId,
      act.capability,
      act.action,
      act.subjectTenantId ?? null,
      act.entity ?? null,
      act.entityId ?? null,
      act.reason,
      JSON.stringify(act.detailsJson ?? {}),
      act.requestId ?? null,
      act.ipAddress ?? null,
      act.userAgent ?? null,
    );

    return fn(db);
  });
}
