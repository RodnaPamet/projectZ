import { emailProvider, isDeliverableAddress } from '@/lib/email/provider';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

/**
 * The daily report of emails that died (#425; owner decision 2026-10-13: "a
 * daily email to you").
 *
 * An outbox row is DEAD after `EMAIL_MAX_ATTEMPTS` failed sends, or at once
 * when the provider refuses it for good. Until now that was visible only in
 * the database. Once a day this counts the rows that died in the last 24
 * hours, by kind and by the provider's error, and emails the operator at
 * ALERT_EMAIL (the disk alert's address, #440). A day with none sends nothing.
 *
 * It never names a recipient: the report says what failed and why, not to
 * whom. The rows hold the rest for anyone who needs to look.
 */

export const DEAD_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Far beyond a bad day; a ceiling, so the read is bounded. */
const SCAN_CAP = 5_000;

export interface DeadEmailReport {
  dead: number;
  byKind: Array<{ kind: string; count: number }>;
  byError: Array<{ error: string; count: number }>;
  truncated: boolean;
  sent: boolean;
}

function tally(values: string[]): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export async function reportDeadEmails(now: Date = new Date()): Promise<DeadEmailReport> {
  // guardrail-allow: cross-tenant — the platform's own outbox, counted for its
  // operator; no person's or club's data leaves this function.
  const rows = await runAsSuperuser((db) =>
    db.emailOutbox.findMany({
      where: {
        status: 'DEAD',
        updatedAt: { gt: new Date(now.getTime() - DEAD_WINDOW_MS), lte: now },
      },
      select: { kind: true, lastError: true },
      orderBy: { updatedAt: 'desc' },
      take: SCAN_CAP + 1,
    }),
  );
  const truncated = rows.length > SCAN_CAP;
  const counted = rows.slice(0, SCAN_CAP);
  const byKind = tally(counted.map((r) => r.kind)).map(({ key, count }) => ({ kind: key, count }));
  const byError = tally(counted.map((r) => r.lastError ?? 'unknown')).map(({ key, count }) => ({
    error: key,
    count,
  }));
  const report = { dead: counted.length, byKind, byError, truncated, sent: false };
  if (report.dead === 0) return report;

  const to = process.env.ALERT_EMAIL?.trim();
  if (!to || !isDeliverableAddress(to)) {
    logger.error('dead emails, and ALERT_EMAIL is not set: nobody was told', {
      component: 'email',
      dead: report.dead,
    });
    return report;
  }

  const lines = [
    `${report.dead}${truncated ? '+' : ''} email(s) could not be delivered in the 24 hours to ${now.toISOString()}.`,
    '',
    'By kind:',
    ...byKind.map((k) => `  ${k.kind}: ${k.count}`),
    '',
    'By the provider’s last error:',
    ...byError.map((e) => `  ${e.error}: ${e.count}`),
    '',
    'The rows are in email_outbox with status DEAD. What the errors mean and what to do:',
    'docs/deploy-gcp.md, "Notification email".',
  ];
  const outcome = await emailProvider().send({
    to,
    subject: `[playerz] ${report.dead}${truncated ? '+' : ''} email(s) could not be delivered`,
    text: lines.join('\n'),
    idempotencyKey: `dead-email-report:${now.toISOString().slice(0, 10)}`,
    ref: 'dead-email-report',
  });
  if (!outcome.ok) {
    logger.error('dead-email report not sent', { component: 'email', error: outcome.error });
    return report;
  }
  logger.info('dead-email report sent', { component: 'email', dead: report.dead });
  return { ...report, sent: true };
}
