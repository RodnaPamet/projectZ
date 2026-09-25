import { assertLeastPrivilegeConnection } from '@/lib/db/assert-least-privilege';

/**
 * Node-runtime startup checks.
 *
 * Separate from `instrumentation.ts` so the Prisma client — and `pg` beneath it
 * — is never pulled into the edge bundle. `register()` awaits this, so the
 * server does not begin serving until it resolves, and a throw here prevents
 * startup entirely. That is the intent: see assert-least-privilege.ts for why
 * refusing to boot beats warning into a log nobody reads.
 */
await assertLeastPrivilegeConnection();
