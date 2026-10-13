import { reportDeadEmails } from '@/app-layer/usecases/dead-email-report';
import {
  setEmailProviderForTests,
  type EmailProvider,
  type OutgoingEmail,
} from '@/lib/email/provider';

import { seedAccount, prismaTestClient } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * The daily report of emails that died (#425): counted by kind and error,
 * emailed to ALERT_EMAIL, nothing on a quiet day, and never a recipient's
 * address or text.
 */
const db = prismaTestClient();
const HOUR = 3_600_000;
const sent: OutgoingEmail[] = [];
const fake: EmailProvider = {
  name: 'resend',
  send: async (m) => {
    sent.push(m);
    return { ok: true, messageId: 'm' };
  },
};

let userId: string;
const NOW = new Date();

async function dead(
  kind: 'BOOKING_CONFIRMED' | 'BOOKING_REMINDER',
  error: string,
  hoursAgo: number,
) {
  await asAppSuperuser(db, async (tx) => {
    const row = await tx.emailOutbox.create({
      data: {
        userId,
        kind,
        category: kind === 'BOOKING_REMINDER' ? 'reminder' : 'confirmation',
        dedupeKey: `dead:${Math.random()}`,
        locale: 'bg',
        subject: 'Резервация',
        text: 'Здравей, Иван, secret-body-text',
        status: 'DEAD',
        lastError: error,
      },
    });
    await tx.$executeRaw`UPDATE email_outbox SET "updatedAt" = ${new Date(NOW.getTime() - hoursAgo * HOUR)} WHERE id = ${row.id}`;
  });
}

beforeEach(async () => {
  sent.length = 0;
  setEmailProviderForTests(fake);
  process.env.ALERT_EMAIL = 'ops@playerz.test';
  userId = await seedAccount('PLAYER', db);
});

afterEach(() => {
  setEmailProviderForTests(null);
  delete process.env.ALERT_EMAIL;
});

describe('reportDeadEmails (#425)', () => {
  it('sends nothing on a day with no dead email', async () => {
    await expect(reportDeadEmails(NOW)).resolves.toMatchObject({ dead: 0, sent: false });
    expect(sent).toEqual([]);
  });

  it('counts the last 24 hours by kind and error, and emails ALERT_EMAIL once', async () => {
    await dead('BOOKING_CONFIRMED', 'validation_error', 2);
    await dead('BOOKING_CONFIRMED', 'validation_error', 5);
    await dead('BOOKING_REMINDER', 'rate_limit_exceeded', 1);
    await dead('BOOKING_REMINDER', 'validation_error', 30); // yesterday's: not counted

    const report = await reportDeadEmails(NOW);

    expect(report).toMatchObject({ dead: 3, sent: true, truncated: false });
    expect(report.byKind).toEqual([
      { kind: 'BOOKING_CONFIRMED', count: 2 },
      { kind: 'BOOKING_REMINDER', count: 1 },
    ]);
    expect(report.byError).toEqual([
      { error: 'validation_error', count: 2 },
      { error: 'rate_limit_exceeded', count: 1 },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('ops@playerz.test');
    expect(sent[0]!.subject).toContain('3 email(s)');
    // What failed and why, never to whom or what it said.
    const account = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }),
    );
    expect(sent[0]!.text).not.toContain(account.email);
    expect(sent[0]!.text).not.toContain('secret-body-text');
  });

  it('without ALERT_EMAIL it counts but sends nothing', async () => {
    delete process.env.ALERT_EMAIL;
    await dead('BOOKING_CONFIRMED', 'validation_error', 1);
    await expect(reportDeadEmails(NOW)).resolves.toMatchObject({ dead: 1, sent: false });
    expect(sent).toEqual([]);
  });
});
