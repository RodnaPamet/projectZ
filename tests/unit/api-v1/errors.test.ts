import { readFileSync, globSync } from 'node:fs';

import { DOMAIN_ERROR_MAP, toV1ErrorResponse } from '@/app/api/v1/_lib/errors';
import { InsufficientCreditError } from '@/app-layer/usecases/wallet';
import { NotFoundError, ValidationError } from '@/lib/errors/types';

describe('v1 domain error map', () => {
  it('maps a domain error to its status instead of a 500', () => {
    // The whole point. Without the map this is "an unexpected internal server
    // error occurred", and the client cannot tell a rule it broke from an
    // outage on our side.
    const { status, payload } = toV1ErrorResponse(new InsufficientCreditError(300, 1000));

    expect(status).toBe(402);
    expect(payload.error.code).toBe('INSUFFICIENT_CREDIT');
  });

  it('leaves AppError subclasses to the canonical mapper', () => {
    // They already carry status and expose. Re-mapping them here would create
    // two sources of truth for the same error.
    expect(toV1ErrorResponse(new NotFoundError()).status).toBe(404);
    expect(toV1ErrorResponse(new ValidationError('bad')).status).toBe(400);
  });

  it('an UNMAPPED error is a 500 with a generic message — it fails closed', () => {
    const { status, payload } = toV1ErrorResponse(new Error('connection string: postgres://u:p@h'));

    expect(status).toBe(500);
    // The message must NOT leak. An unclassified error is exactly the one whose
    // text nobody has checked.
    expect(payload.error.message).not.toContain('postgres://');
  });

  it('the tenancy programmer-errors are deliberately NOT mapped', () => {
    // They mean a caller wired something wrong, never that the request was bad.
    // A 4xx would invite a client to "fix" it; the detail would describe our
    // tenancy internals to whoever triggered it.
    for (const name of ['InvalidTenantIdError', 'InvalidUserIdError', 'NestedTenantContextError']) {
      expect(DOMAIN_ERROR_MAP[name]).toBeUndefined();
    }
  });

  it('the platform denials are 403, not the 500 they used to be', () => {
    // `MissingPlatformGrantError` says in its own message that "an expired or
    // revoked grant is an ordinary 403" — see src/app/api/v1/_lib/bind.ts.
    // Unmapped, it was a 500: the routine denial would page somebody, and a
    // probe would look like a bug.
    for (const name of [
      'MissingPlatformGrantError',
      'MissingPlatformCapabilityError',
      'PlatformWriteNotEnabledError',
    ]) {
      expect(DOMAIN_ERROR_MAP[name]?.status).toBe(403);
    }
  });

  it('the platform denials do NOT echo their own message to the client', () => {
    // Their messages are written for whoever is debugging the binding:
    // "asPlatformAdmin() was called without a live platform grant. Platform
    // authority is a row in platform_admin_grant with an expiry, re-read from
    // the database on every request."
    //
    // In a 403 body that is free reconnaissance for anyone probing
    // /api/v1/platform/*. Same reasoning as the 429 body omitting which limiter
    // bucket was exhausted.
    for (const name of [
      'MissingPlatformGrantError',
      'MissingPlatformCapabilityError',
      'PlatformWriteNotEnabledError',
    ]) {
      const m = DOMAIN_ERROR_MAP[name];
      expect(m?.clientMessage).toBeTruthy();
      // Nothing internal in what the caller receives.
      expect(m!.clientMessage).not.toMatch(/asPlatformAdmin|platform_admin_grant|Postgres|enum/i);
    }
  });

  it('the capability denial does not enumerate what the caller lacks', () => {
    // Telling them which capability they are missing maps the set that exists.
    // There is deliberately no self-service alternative either: the CLI's
    // `--list` prints every live grant, so it is not something a refused caller
    // is handed.
    const m = DOMAIN_ERROR_MAP.MissingPlatformCapabilityError;
    expect(m!.clientMessage).not.toMatch(/TENANT_READ|AUDIT_READ|USER_READ|TENANT_SUSPEND/);
  });

  it('the platform PROGRAMMER errors stay unmapped, like the tenancy ones', () => {
    // These mean the code wired something wrong, not that the request was bad,
    // so a 500 is the honest answer and somebody should be woken by it.
    //
    // `PlatformReasonRequiredError` needs the closer look, because the reason
    // DOES come from the caller now. It stays unmapped because the routes
    // refuse a short one themselves, with a 400 naming the parameter — see
    // src/app/api/v1/_lib/platform-reason.ts. Reaching this error therefore
    // still means a route hardcoded something useless, which is the case it was
    // written for. Mapping it to 400 would quietly make that programmer error
    // look like a client mistake.
    for (const name of ['AmbientPlatformEscalationError', 'PlatformReasonRequiredError']) {
      expect(DOMAIN_ERROR_MAP[name]).toBeUndefined();
    }
  });

  it('every mapped name is a class that actually exists', () => {
    // A renamed class silently downgrades its route to a 500. This is the only
    // thing standing between that and production.
    const declared = new Set<string>();
    for (const f of globSync('src/**/*.ts')) {
      const src = readFileSync(f.toString(), 'utf8');
      for (const m of src.matchAll(/export class ([A-Za-z]+Error) extends/g)) {
        declared.add(m[1]!);
      }
    }

    expect(declared.size).toBeGreaterThan(20); // the scan found the classes

    const orphans = Object.keys(DOMAIN_ERROR_MAP).filter((n) => !declared.has(n));
    expect(orphans).toEqual([]);
  });

  it('every status in the table is a real 4xx or 5xx', () => {
    for (const [name, m] of Object.entries(DOMAIN_ERROR_MAP)) {
      expect(m.status).toBeGreaterThanOrEqual(400);
      expect(m.status).toBeLessThan(600);
      // A code a client can switch on: SCREAMING_SNAKE, never prose.
      expect(m.code).toMatch(/^[A-Z][A-Z_0-9]*$/);
      expect(name).toMatch(/Error$/);
    }
  });
});
