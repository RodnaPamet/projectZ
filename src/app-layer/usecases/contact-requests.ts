import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { contactInboxAddress } from '@/lib/email/contact-inbox';
import { headerSafe } from '@/lib/email/provider';
import { resolveLocale, type Locale } from '@/lib/i18n/locales';
import { translateFor } from '@/lib/i18n/server-messages';
import { logger } from '@/lib/observability/logger';
import { hashForLookup } from '@/lib/security/encryption';
import { checkRateLimit, type RateLimitConfig } from '@/lib/security/rate-limit';
import { absoluteUrl } from '@/lib/seo/site-url';

import { EMAIL_SUBJECT_MAX } from './notification-outbox';

/**
 * The landing page's "For clubs" enquiries (#369, Q45/Q49).
 *
 * A club that wants to join fills in a short form on `/`. The enquiry is
 * STORED (`contact_request`, listed on /platform/contact-requests) and, when
 * `CONTACT_INBOX_EMAIL` is set, an email to the operator is QUEUED in the
 * notification outbox (#367) in the same transaction: both exist or neither.
 * With no inbox configured the row is still stored and no email is queued.
 *
 * ═══ WHAT KEEPS IT FROM BEING A SPAM CANNON ═══
 *
 *   - zod, server-side, on every field, and CHECKs in the table behind it;
 *   - a HONEYPOT: a field people never see or fill. A filled one is answered
 *     exactly like a success, so a bot learns nothing, and nothing is written;
 *   - a RATE LIMIT per client IP: {@link CONTACT_RATE_LIMIT}. The IP is never
 *     stored. The limiter's key is `hashForLookup(ip)`, a keyed HMAC, and it
 *     lives in Redis for the window only;
 *   - the email goes to ONE fixed address the operator configured, never to an
 *     address the visitor typed, so the form cannot mail anybody else.
 *
 * ═══ WHY BYPASSRLS ═══
 *
 * The visitor is anonymous: there is no user and no club to bind, and the
 * table denies `app_user` outright (P50). The write names one new row by the
 * id it just created; it reads nothing back. The platform READS the table only
 * through `asPlatformAdmin` (CONTACT_READ, audited).
 */

/** Five enquiries an hour from one address: a club writes once, a bot does not stop. */
export const CONTACT_RATE_LIMIT: RateLimitConfig = { maxAttempts: 5, windowMs: 60 * 60 * 1000 };

export const CONTACT_LIMITS = {
  name: 120,
  clubName: 160,
  phone: 40,
  email: 254,
  message: 2000,
} as const;

/** The honeypot's field name: plausible to a bot, never shown to a person. */
export const CONTACT_HONEYPOT = 'website';

/** Empty or whitespace is absent, so "phone OR email" means a real one. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/**
 * What the form sends. Field errors are CODES, not copy: the form shows them
 * through the catalogue (`landing.clubs.form.errors.*`), in the visitor's
 * language.
 */
export const contactRequestSchema = z
  .object({
    name: z.string().trim().min(1, 'required').max(CONTACT_LIMITS.name, 'tooLong'),
    clubName: z.string().trim().min(1, 'required').max(CONTACT_LIMITS.clubName, 'tooLong'),
    phone: optionalText(CONTACT_LIMITS.phone).refine(
      // Digits with the usual separators, 6 to 20 digits: +359 88 123 4567.
      (v) => v === undefined || (/^\+?[\d\s()./-]+$/.test(v) && /^(?:\D*\d){6,20}\D*$/.test(v)),
      'phone',
    ),
    email: optionalText(CONTACT_LIMITS.email).refine(
      (v) => v === undefined || z.email().safeParse(v).success,
      'email',
    ),
    message: z.string().trim().min(1, 'required').max(CONTACT_LIMITS.message, 'tooLong'),
    [CONTACT_HONEYPOT]: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.phone && !v.email) {
      ctx.addIssue({ code: 'custom', path: ['phone'], message: 'reachable' });
    }
  });

export type ContactField = 'name' | 'clubName' | 'phone' | 'email' | 'message';

export type ContactErrorCode = 'required' | 'tooLong' | 'phone' | 'email' | 'reachable';

export type ContactResult =
  | { ok: true }
  | { ok: false; code: 'invalid'; fieldErrors: Partial<Record<ContactField, ContactErrorCode>> }
  | { ok: false; code: 'rateLimited' }
  | { ok: false; code: 'failed' };

const FIELDS: readonly ContactField[] = ['name', 'clubName', 'phone', 'email', 'message'];
const CODES: readonly ContactErrorCode[] = ['required', 'tooLong', 'phone', 'email', 'reachable'];

function fieldErrorsOf(error: z.ZodError): Partial<Record<ContactField, ContactErrorCode>> {
  const out: Partial<Record<ContactField, ContactErrorCode>> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field !== 'string' || !(FIELDS as readonly string[]).includes(field)) continue;
    const f = field as ContactField;
    if (out[f]) continue;
    // A type mismatch (a missing field arrives as undefined) reads as "required".
    out[f] = (CODES as readonly string[]).includes(issue.message)
      ? (issue.message as ContactErrorCode)
      : 'required';
  }
  return out;
}

/** The outbox's dedupe key for an enquiry's email: one per enquiry. */
export const contactDedupeKey = (id: string) => `contact:${id}`;

/**
 * Validate, rate-limit, store, and queue the operator's email.
 *
 * `clientIp` is used for the limiter's key and nothing else. Never throws: a
 * failed write is `{ ok: false, code: 'failed' }`, logged without the copy.
 */
export async function submitContactRequest(
  input: Record<string, unknown>,
  opts: { clientIp: string; locale: unknown },
): Promise<ContactResult> {
  const parsed = contactRequestSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, code: 'invalid', fieldErrors: fieldErrorsOf(parsed.error) };

  // The honeypot, AFTER validation so a bot that fills everything still gets
  // the same answer a person would. Nothing is written and nothing is counted.
  if (parsed.data[CONTACT_HONEYPOT]?.trim()) {
    logger.info('contact form honeypot tripped', { component: 'contact' });
    return { ok: true };
  }

  const limit = await checkRateLimit(`contact:${hashForLookup(opts.clientIp)}`, CONTACT_RATE_LIMIT);
  if (!limit.allowed) return { ok: false, code: 'rateLimited' };

  const data = parsed.data;
  const locale = resolveLocale(opts.locale);
  const inbox = contactInboxAddress();

  try {
    // Rendered before the transaction: the copy is catalogue reads, not data.
    const email = inbox ? await operatorEmail(data) : null;

    // guardrail-allow: cross-tenant — an anonymous visitor's enquiry belongs to
    // no user and no club; `contact_request` denies app_user (P50). One new row,
    // and its email by the id just created.
    await runAsSuperuser(async (db) => {
      const row = await db.contactRequest.create({
        data: {
          name: data.name,
          clubName: data.clubName,
          phone: data.phone ?? null,
          email: data.email ?? null,
          message: data.message,
          locale,
        },
        select: { id: true },
      });

      if (email) {
        await db.emailOutbox.createMany({
          data: [
            {
              userId: null,
              kind: 'CONTACT_REQUEST',
              category: 'contact',
              dedupeKey: contactDedupeKey(row.id),
              // The operator reads Bulgarian; the enquiry's own language is
              // on the row and in the text.
              locale: 'bg',
              subject: email.subject,
              text: `${email.text}\n${absoluteUrl('/platform/contact-requests')}\n`,
              refType: 'contact_request',
              refId: row.id,
            },
          ],
          skipDuplicates: true,
        });
      }
    });
    return { ok: true };
  } catch (err) {
    logger.error('contact request not stored', {
      component: 'contact',
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: 'failed' };
  }
}

/** One line: a name cannot add a header or a line to the email's labels. */
const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();

async function operatorEmail(d: {
  name: string;
  clubName: string;
  phone?: string;
  email?: string;
  message: string;
}): Promise<{ subject: string; text: string }> {
  const L: Locale = 'bg';
  const [subject, intro, lName, lClub, lPhone, lEmail, lMessage, lLink] = await Promise.all([
    translateFor(L, 'emails.contactRequest.subject', { club: oneLine(d.clubName) }),
    translateFor(L, 'emails.contactRequest.intro'),
    translateFor(L, 'emails.contactRequest.name'),
    translateFor(L, 'emails.contactRequest.club'),
    translateFor(L, 'emails.contactRequest.phone'),
    translateFor(L, 'emails.contactRequest.email'),
    translateFor(L, 'emails.contactRequest.message'),
    translateFor(L, 'emails.contactRequest.link'),
  ]);
  const lines = [
    intro,
    '',
    `${lName}: ${oneLine(d.name)}`,
    `${lClub}: ${oneLine(d.clubName)}`,
    ...(d.phone ? [`${lPhone}: ${oneLine(d.phone)}`] : []),
    ...(d.email ? [`${lEmail}: ${oneLine(d.email)}`] : []),
    '',
    `${lMessage}:`,
    // The message keeps its own line breaks: it is plain text, never HTML.
    d.message,
    '',
    `${lLink}:`,
  ];
  return {
    subject: headerSafe(subject).slice(0, EMAIL_SUBJECT_MAX),
    text: lines.join('\n'),
  };
}

// ─── The platform's list ────────────────────────────────────────────────

export const CONTACT_PAGE_SIZE = 50;

export interface ContactRequestItem {
  id: string;
  name: string;
  clubName: string;
  phone: string | null;
  email: string | null;
  message: string;
  locale: Locale;
  createdAt: Date;
}

/**
 * Newest first, keyset on (createdAt, id). The caller binds the transaction:
 * `asPlatformAdmin` under CONTACT_READ, which audits the read.
 */
export async function listContactRequests(
  db: PrismaClient,
  opts: { limit?: number; after?: { id: string; createdAt: Date } } = {},
): Promise<{ items: ContactRequestItem[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(opts.limit ?? CONTACT_PAGE_SIZE, CONTACT_PAGE_SIZE));
  const after = opts.after;
  const rows = await db.contactRequest.findMany({
    where: after
      ? {
          OR: [
            { createdAt: { lt: after.createdAt } },
            { createdAt: after.createdAt, id: { lt: after.id } },
          ],
        }
      : undefined,
    select: {
      id: true,
      name: true,
      clubName: true,
      phone: true,
      email: true,
      message: true,
      locale: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: Prisma.SortOrder.desc }, { id: Prisma.SortOrder.desc }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}
