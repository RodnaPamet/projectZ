import type { Role } from '@prisma/client';

import { coachCards } from '@/app-layer/usecases/coach-directory';
import { deliver } from '@/app-layer/usecases/notification-outbox';
import { COACH_PROFILE_HREF } from '@/lib/coaches/hrefs';
import { runAsUserOnly, runInTenantContext } from '@/lib/db/rls-middleware';
import {
  coachLinkBellCopy,
  coachLinkEmail,
  type CoachLinkEvent,
} from '@/lib/notifications/coach-copy';
import { dedupeKey } from '@/lib/notifications/dedupe';
import { logger } from '@/lib/observability/logger';
import { roleHasPermission } from '@/lib/permissions';
import { absoluteUrl } from '@/lib/seo/site-url';

/**
 * A coach and a club, telling each other (#550).
 *
 *   event                              who hears                  kind
 *   ─────────────────────────────────────────────────────────────────────────
 *   a coach asked to teach at a venue  the club's owners and      COACH_LINK_REQUESTED
 *                                      managers
 *   the club accepted the request      the coach                  COACH_LINK_ACCEPTED
 *   the club declined it               the coach                  COACH_LINK_DECLINED
 *   the club ended a running link      the coach                  COACH_LINK_ENDED
 *
 * Bell always, and an email no setting turns off (`account`): each is the
 * answer to something the person asked for, or a thing only they can act on.
 * An invitation by email is its own message (`inviteCoachAction`); it has no
 * bell, because the address it goes to need not have an account.
 *
 * All of it runs after the change committed, and none of it throws: a notice
 * that could not be written never undoes the decision it is about.
 */

/** Who answers a coach's request: whoever may manage the club's people. */
const ANSWERING_ROLES: Role[] = (
  ['OWNER', 'MANAGER', 'COACH', 'STAFF', 'PLAYER'] as const satisfies readonly Role[]
).filter((r) => roleHasPermission(r, 'admin.staff_manage'));

/** A club is told of the same request at most once a day per person. */
export const LINK_REQUEST_EMAIL_EVERY_MS = 24 * 3_600_000;

/** No club has this many people who answer for it; the read is bounded all the same. */
const MANAGERS_MAX = 50;

async function localeOf(userId: string): Promise<'bg' | 'en' | null> {
  const user = await runAsUserOnly(userId, (db) =>
    db.user.findUnique({ where: { id: userId }, select: { locale: true, deletedAt: true } }),
  );
  if (!user || user.deletedAt) return null;
  return user.locale;
}

async function linkFacts(tenantId: string, linkId: string) {
  return runInTenantContext(tenantId, async (db) => {
    const [link, tenant] = await Promise.all([
      db.coach.findFirst({
        where: { id: linkId, tenantId },
        select: { id: true, userId: true, status: true, venue: { select: { name: true } } },
      }),
      db.venueOrg.findUnique({ where: { id: tenantId }, select: { slug: true } }),
    ]);
    return link && tenant ? { link, slug: tenant.slug } : null;
  });
}

function warn(event: string, err: unknown): void {
  logger.warn('coach link not announced', {
    component: 'notifications',
    event,
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Tell the coach what the club did with them: accepted or declined a request,
 * or ended a link that was running. Says nothing if the link has moved on
 * since (asked again, accepted after all) before this ran.
 */
export async function notifyCoachLinkAnswered(input: {
  tenantId: string;
  linkId: string;
  event: Exclude<CoachLinkEvent, 'linkRequested'>;
  /** The moment of the decision: a second decline, later, is news again. */
  at: Date;
}): Promise<void> {
  try {
    const facts = await linkFacts(input.tenantId, input.linkId);
    if (!facts) return;
    const expected = input.event === 'linkAccepted' ? 'ACTIVE' : null;
    if (expected ? facts.link.status !== expected : facts.link.status === 'ACTIVE') return;
    const locale = await localeOf(facts.link.userId);
    if (!locale) return;

    const values = { venue: facts.link.venue.name, coach: null };
    const [copy, email] = await Promise.all([
      coachLinkBellCopy(locale, input.event, values),
      coachLinkEmail(locale, input.event, values, absoluteUrl(COACH_PROFILE_HREF)),
    ]);
    await deliver({
      userId: facts.link.userId,
      tenantId: input.tenantId,
      kind:
        input.event === 'linkAccepted'
          ? 'COACH_LINK_ACCEPTED'
          : input.event === 'linkDeclined'
            ? 'COACH_LINK_DECLINED'
            : 'COACH_LINK_ENDED',
      dedupeKey: dedupeKey('coach-link', input.linkId, input.event, input.at.getTime()),
      title: copy.title,
      body: copy.body,
      href: COACH_PROFILE_HREF,
      refType: 'coach_link',
      refId: input.linkId,
      email: { category: 'account', locale, ...email },
    });
  } catch (err) {
    warn(input.event, err);
  }
}

/**
 * Tell the club's owners and managers that a coach asked to teach at one of
 * their venues. The bell is one row per request; the email is at most one a
 * day per person about the same coach and venue, so a request taken back and
 * made again does not fill an inbox.
 */
export async function notifyCoachLinkRequested(input: {
  tenantId: string;
  linkId: string;
  at: Date;
}): Promise<void> {
  try {
    const facts = await linkFacts(input.tenantId, input.linkId);
    if (!facts || facts.link.status !== 'REQUESTED') return;
    const coach = (await coachCards([facts.link.userId])).get(facts.link.userId);
    // An account that is gone asks for nothing.
    if (!coach) return;

    const managers = await runInTenantContext(input.tenantId, (db) =>
      db.tenantMembership.findMany({
        where: {
          tenantId: input.tenantId,
          status: 'ACTIVE',
          role: { in: ANSWERING_ROLES },
        },
        select: { userId: true },
        orderBy: { createdAt: 'asc' },
        take: MANAGERS_MAX,
      }),
    );
    const href = `/t/${encodeURIComponent(facts.slug)}/admin/coaches`;
    const values = { venue: facts.link.venue.name, coach: coach.name };
    for (const { userId } of managers) {
      try {
        const locale = await localeOf(userId);
        if (!locale) continue;
        const [copy, email] = await Promise.all([
          coachLinkBellCopy(locale, 'linkRequested', values),
          coachLinkEmail(locale, 'linkRequested', values, absoluteUrl(href)),
        ]);
        await deliver({
          userId,
          tenantId: input.tenantId,
          kind: 'COACH_LINK_REQUESTED',
          dedupeKey: dedupeKey('coach-link', input.linkId, 'requested', input.at.getTime()),
          title: copy.title,
          body: copy.body,
          href,
          refType: 'coach_link',
          refId: input.linkId,
          email: {
            category: 'account',
            locale,
            ...email,
            atMostOncePer: LINK_REQUEST_EMAIL_EVERY_MS,
          },
        });
      } catch (err) {
        warn('linkRequested', err);
      }
    }
  } catch (err) {
    warn('linkRequested', err);
  }
}
