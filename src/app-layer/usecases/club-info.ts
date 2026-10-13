import type { PrismaClient } from '@prisma/client';

import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { normalizePhone } from '@/lib/booking/phone';
import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * What a club says about itself and its venues on their public pages (#530).
 *
 * Until now only the operator could: the name, address, phone and a venue's
 * description were typed once at onboarding (scripts/onboard-club.ts), and a
 * club had no description at all. A club's OWNER and MANAGER now write:
 *
 *   the club       its description, shown on `/clubs/{slug}`
 *   each venue     its description and its phone, shown on
 *                  `/venues/{publicSlug}`
 *
 * The name and the address stay with the operator: they feed the public slug,
 * the map position and the search, and a typo there moves a pin.
 *
 * Plain text, sanitised BEFORE it is measured, so markup cannot smuggle a
 * longer text past the limit. Every change writes an audit row with the
 * before and the after.
 *
 * Called under the club's own binding (`runInTenantContext`): a venue id from
 * another club is not found, and the club's own row is the only `venue_org`
 * row there is.
 */

export const DESCRIPTION_MAX = 1000;

export type ClubInfoErrorCode = 'TOO_LONG' | 'PHONE_INVALID' | 'VENUE_NOT_FOUND';

export class ClubInfoError extends Error {
  constructor(readonly reason: ClubInfoErrorCode) {
    super(reason);
    this.name = 'ClubInfoError';
  }
}

interface Actor {
  tenantId: string;
  actorUserId: string;
}

export interface ClubInfo {
  description: string | null;
  venues: Array<{ id: string; name: string; description: string | null; phone: string | null }>;
}

/** Trimmed plain text, or null when nothing is left. Paragraph breaks are kept. */
function description(raw: unknown): string | null {
  const text = sanitizePlainText(typeof raw === 'string' ? raw : '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > DESCRIPTION_MAX) throw new ClubInfoError('TOO_LONG');
  return text === '' ? null : text;
}

/**
 * A phone as people write it ("02 123 4567"), kept as typed so the page shows
 * it the way the club does, or null for none. It must still be a number: what
 * `normalizePhone` cannot read is refused.
 */
function phone(raw: unknown): string | null {
  const typed = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (typed === '') return null;
  if (typed.length > 40 || normalizePhone(typed) === null) throw new ClubInfoError('PHONE_INVALID');
  return typed;
}

/** The screen's read: the club's description and its venues', oldest venue first. */
export async function loadClubInfo(db: PrismaClient, tenantId: string): Promise<ClubInfo> {
  const [club, venues] = await Promise.all([
    db.venueOrg.findUnique({ where: { id: tenantId }, select: { description: true } }),
    db.venue.findMany({
      where: { tenantId },
      select: { id: true, name: true, description: true, phone: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
    }),
  ]);
  return { description: club?.description ?? null, venues };
}

export async function updateClubDescription(
  db: PrismaClient,
  actor: Actor,
  raw: unknown,
): Promise<void> {
  const next = description(raw);
  const before = await db.venueOrg.findUniqueOrThrow({
    where: { id: actor.tenantId },
    select: { description: true },
  });
  if (before.description === next) return;

  await db.venueOrg.update({ where: { id: actor.tenantId }, data: { description: next } });
  await appendAuditEntry(db, {
    tenantId: actor.tenantId,
    actorUserId: actor.actorUserId,
    entity: 'VenueOrg',
    entityId: actor.tenantId,
    action: AUDIT_ACTIONS.CLUB_DESCRIPTION_CHANGED,
    details: 'The club description changed',
    detailsJson: {
      category: 'config',
      summary: 'Club description changed',
      before: { description: before.description },
      after: { description: next },
    },
  });
}

export async function updateVenueInfo(
  db: PrismaClient,
  actor: Actor,
  venueId: string,
  input: { description: unknown; phone: unknown },
): Promise<void> {
  const next = { description: description(input.description), phone: phone(input.phone) };
  const before = await db.venue.findFirst({
    where: { id: venueId, tenantId: actor.tenantId },
    select: { id: true, name: true, description: true, phone: true },
  });
  if (!before) throw new ClubInfoError('VENUE_NOT_FOUND');
  if (before.description === next.description && before.phone === next.phone) return;

  await db.venue.update({ where: { id: before.id }, data: next });
  await appendAuditEntry(db, {
    tenantId: actor.tenantId,
    actorUserId: actor.actorUserId,
    entity: 'Venue',
    entityId: before.id,
    action: AUDIT_ACTIONS.VENUE_INFO_CHANGED,
    details: `Description or phone changed at "${before.name}"`,
    detailsJson: {
      category: 'config',
      summary: 'Venue description or phone changed',
      before: { description: before.description, phone: before.phone },
      after: next,
    },
  });
}
