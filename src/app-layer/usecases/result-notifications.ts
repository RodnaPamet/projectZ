import type { Role } from '@prisma/client';

import { deliver } from '@/app-layer/usecases/notification-outbox';
import { runAsUserOnly, runInTenantContext } from '@/lib/db/rls-middleware';
import { dedupeKey } from '@/lib/notifications/dedupe';
import {
  formatScore,
  resultDecidedCopy,
  resultDisputedCopy,
  resultReportedCopy,
  type ResultFacts,
} from '@/lib/notifications/result-copy';
import { logger } from '@/lib/observability/logger';
import { roleHasPermission } from '@/lib/permissions';
import { absoluteUrl } from '@/lib/seo/site-url';

/**
 * A result, told to the people it waits for (#575).
 *
 *   event                       who hears                     kind
 *   ──────────────────────────────────────────────────────────────────────────
 *   a player reported it        the other side's players      RESULT_REPORTED
 *   the other side rejected it  the club's desk (who decides) RESULT_DISPUTED
 *   the club decided or voided  every player on both sides    RESULT_DECIDED
 *
 * The bell always. A reported result and a dispute also go by email, because
 * each is something only that person can act on and it has a clock: the
 * other side's under the booking emails' switch (`confirmation`), the club's
 * as a notice about its own work (`account`). The club's decision rings the
 * phone under the booking switch and sends no email.
 *
 * All of it runs after the change committed, and none of it throws.
 */

const ZONE = 'Europe/Sofia';

/** Who decides a disputed result: whoever works the club's desk. */
const DESK_ROLES: Role[] = (
  ['OWNER', 'MANAGER', 'COACH', 'STAFF', 'PLAYER'] as const satisfies readonly Role[]
).filter((r) => roleHasPermission(r, 'bookings.view_all'));
const DESK_MAX = 50;

function warn(event: string, err: unknown): void {
  logger.warn('result notification failed', {
    component: 'results',
    event,
    error: err instanceof Error ? err.message : String(err),
  });
}

async function readerOf(
  userId: string,
): Promise<{ locale: 'bg' | 'en'; name: string | null } | null> {
  const user = await runAsUserOnly(userId, (db) =>
    db.user.findUnique({
      where: { id: userId },
      select: { locale: true, name: true, deletedAt: true },
    }),
  );
  if (!user || user.deletedAt) return null;
  return { locale: user.locale, name: user.name };
}

const day = (locale: 'bg' | 'en', at: Date) =>
  new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'bg-BG', {
    day: 'numeric',
    month: 'short',
    timeZone: ZONE,
  }).format(at);

const dayAndTime = (locale: 'bg' | 'en', at: Date) =>
  new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'bg-BG', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: ZONE,
  }).format(at);

async function reportFacts(tenantId: string, reportId: string) {
  return runInTenantContext(tenantId, async (db) => {
    const r = await db.matchReport.findFirst({
      where: { id: reportId, tenantId },
      select: {
        bookingId: true,
        status: true,
        sidesJson: true,
        scoreJson: true,
        reportedByUserId: true,
        autoConfirmAt: true,
        booking: {
          select: { startTs: true, resource: { select: { venue: { select: { name: true } } } } },
        },
      },
    });
    if (!r) return null;
    const tenant = await db.venueOrg.findUnique({
      where: { id: tenantId },
      select: { slug: true },
    });
    const sides = Array.isArray(r.sidesJson)
      ? (r.sidesJson as unknown[]).map((s) => (Array.isArray(s) ? (s as string[]) : []))
      : [];
    return {
      ...r,
      sides,
      venue: r.booking.resource.venue.name,
      startTs: r.booking.startTs,
      score: Array.isArray(r.scoreJson) ? formatScore(r.scoreJson as number[][]) : '',
      slug: tenant?.slug ?? null,
    };
  });
}

const bookingHref = (bookingId: string) => `/me/bookings/${encodeURIComponent(bookingId)}`;

export async function notifyResultReported(input: {
  tenantId: string;
  reportId: string;
}): Promise<void> {
  try {
    const f = await reportFacts(input.tenantId, input.reportId);
    if (!f || f.status !== 'REPORTED') return;
    const reporterSide = f.sides.findIndex((s) => s.includes(f.reportedByUserId));
    const reporter = await readerOf(f.reportedByUserId);
    const others = f.sides.filter((_, i) => i !== reporterSide).flat();
    const href = bookingHref(f.bookingId);
    for (const userId of others) {
      try {
        const reader = await readerOf(userId);
        if (!reader) continue;
        const facts: ResultFacts & { reporter: string; deadline: string } = {
          venue: f.venue,
          day: day(reader.locale, f.startTs),
          score: f.score,
          reporter: reporter?.name ?? '—',
          deadline: f.autoConfirmAt ? dayAndTime(reader.locale, f.autoConfirmAt) : '',
        };
        const copy = await resultReportedCopy(reader.locale, facts, absoluteUrl(href));
        await deliver({
          userId,
          tenantId: input.tenantId,
          kind: 'RESULT_REPORTED',
          dedupeKey: dedupeKey('result', input.reportId, 'reported'),
          title: copy.title,
          body: copy.body,
          href,
          refType: 'booking',
          refId: f.bookingId,
          email: {
            category: 'confirmation',
            locale: reader.locale,
            subject: copy.subject,
            text: copy.text,
          },
        });
      } catch (err) {
        warn('reported', err);
      }
    }
  } catch (err) {
    warn('reported', err);
  }
}

export async function notifyResultDisputed(input: {
  tenantId: string;
  reportId: string;
}): Promise<void> {
  try {
    const f = await reportFacts(input.tenantId, input.reportId);
    if (!f || f.status !== 'REJECTED' || !f.slug) return;
    const desk = await runInTenantContext(input.tenantId, (db) =>
      db.tenantMembership.findMany({
        where: { tenantId: input.tenantId, status: 'ACTIVE', role: { in: DESK_ROLES } },
        select: { userId: true },
        orderBy: { createdAt: 'asc' },
        take: DESK_MAX,
      }),
    );
    const href = `/t/${encodeURIComponent(f.slug)}/admin/results`;
    for (const { userId } of desk) {
      try {
        const reader = await readerOf(userId);
        if (!reader) continue;
        const facts: ResultFacts = {
          venue: f.venue,
          day: day(reader.locale, f.startTs),
          score: f.score,
        };
        const copy = await resultDisputedCopy(reader.locale, facts, absoluteUrl(href));
        await deliver({
          userId,
          tenantId: input.tenantId,
          kind: 'RESULT_DISPUTED',
          dedupeKey: dedupeKey('result', input.reportId, 'disputed'),
          title: copy.title,
          body: copy.body,
          href,
          refType: 'match_report',
          refId: input.reportId,
          email: {
            category: 'account',
            locale: reader.locale,
            subject: copy.subject,
            text: copy.text,
          },
        });
      } catch (err) {
        warn('disputed', err);
      }
    }
  } catch (err) {
    warn('disputed', err);
  }
}

export async function notifyResultDecided(input: {
  tenantId: string;
  reportId: string;
}): Promise<void> {
  try {
    const f = await reportFacts(input.tenantId, input.reportId);
    if (!f || (f.status !== 'DECIDED' && f.status !== 'VOIDED')) return;
    const href = bookingHref(f.bookingId);
    for (const userId of f.sides.flat()) {
      try {
        const reader = await readerOf(userId);
        if (!reader) continue;
        const facts: ResultFacts = {
          venue: f.venue,
          day: day(reader.locale, f.startTs),
          score: f.score,
        };
        const copy = await resultDecidedCopy(reader.locale, facts, f.status === 'VOIDED');
        await deliver({
          userId,
          tenantId: input.tenantId,
          kind: 'RESULT_DECIDED',
          dedupeKey: dedupeKey('result', input.reportId, 'decided'),
          title: copy.title,
          body: copy.body,
          href,
          refType: 'booking',
          refId: f.bookingId,
          email: null,
          push: 'confirmation',
        });
      } catch (err) {
        warn('decided', err);
      }
    }
  } catch (err) {
    warn('decided', err);
  }
}
