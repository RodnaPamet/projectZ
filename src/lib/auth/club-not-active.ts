import type { TenantStatus } from '@prisma/client';

/**
 * A write at a club the platform has suspended or closed (#254). Its staff
 * keep read-only access; nothing they do may change it. Thrown by
 * `requireTenantAction` (Server Actions) and `contextFromRequest` (v1 writes),
 * answered as 403 CLUB_NOT_ACTIVE. Its own module, so a test that mocks
 * page-context still has the class.
 */
export class ClubNotActiveError extends Error {
  constructor(readonly status: TenantStatus) {
    super(`This club is ${status.toLowerCase()}: its admin is read-only.`);
    this.name = 'ClubNotActiveError';
  }
}
