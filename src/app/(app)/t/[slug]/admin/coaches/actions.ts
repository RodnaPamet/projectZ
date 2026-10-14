'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { notifyCoachLinkAnswered } from '@/app-layer/usecases/coach-link-notifications';
import {
  answerCoachRequest,
  endCoachLink,
  type LinkChange,
} from '@/app-layer/usecases/coach-links';
import { createInvite } from '@/app-layer/usecases/invites';
import { env } from '@/env';
import { requireTenantAction } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { sendMail } from '@/lib/email/mailer';

/**
 * The club's side of its coaches (#546): answer a request, end a link, invite
 * a coach by email. `admin.staff_manage`, which the owner and the manager
 * hold and the desk does not: who works at the club is theirs to decide.
 *
 * Every action re-reads who is asking and for which club (`requireTenantAction`)
 * and runs bound to that club, so a link id from another club finds nothing.
 */

export type CoachActionError =
  'NOT_FOUND' | 'ALREADY_DECIDED' | 'SUSPENDED' | 'BAD_EMAIL' | 'ALREADY_INVITED' | 'MAIL_FAILED';
type ActionResult = { ok: true } | { ok: false; error: CoachActionError };

function mapError(err: unknown): ActionResult {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'CoachLinkNotFoundError':
      return { ok: false, error: 'NOT_FOUND' };
    // Somebody answered or ended it first, or the coach took it back.
    case 'CoachLinkStateError':
      return { ok: false, error: 'ALREADY_DECIDED' };
    case 'CoachSuspendedAtClubError':
      return { ok: false, error: 'SUSPENDED' };
    default:
      throw err;
  }
}

export async function answerCoachRequestAction(
  slug: string,
  linkId: string,
  accept: boolean,
): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.staff_manage');
  let change: LinkChange;
  try {
    change = await runInTenantContext(ctx.tenantId, (db) =>
      answerCoachRequest(db, { tenantId: ctx.tenantId, actorUserId: ctx.userId }, linkId, accept),
    );
  } catch (err) {
    const mapped = mapError(err);
    // It has left the list of requests either way: show the list as it is.
    revalidatePath(`/t/${slug}/admin/coaches`);
    return mapped;
  }
  // The coach hears the answer (#550), once it committed.
  await notifyCoachLinkAnswered({ tenantId: ctx.tenantId, linkId, ...change });
  revalidatePath(`/t/${slug}/admin/coaches`);
  return { ok: true };
}

export async function endCoachLinkAction(slug: string, linkId: string): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.staff_manage');
  let change: LinkChange;
  try {
    change = await runInTenantContext(ctx.tenantId, (db) =>
      endCoachLink(db, { tenantId: ctx.tenantId, actorUserId: ctx.userId }, linkId),
    );
  } catch (err) {
    const mapped = mapError(err);
    revalidatePath(`/t/${slug}/admin/coaches`);
    return mapped;
  }
  await notifyCoachLinkAnswered({ tenantId: ctx.tenantId, linkId, ...change });
  revalidatePath(`/t/${slug}/admin/coaches`);
  return { ok: true };
}

/**
 * Invite a coach by email, with the invitation the club sends its staff, at
 * the role COACH. Accepting it makes the coach teach at every venue the club
 * runs (`linkInvitedCoach`). Whoever accepts needs a coach account, or a new
 * one, which becomes a coach's; the platform approves the coach separately,
 * and players see them only then.
 *
 * The token exists once, here. If the email cannot be sent the invitation is
 * still open and is listed on the staff page, where it can be withdrawn.
 */
export async function inviteCoachAction(
  slug: string,
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.staff_manage');
  const email = String(form.get('email') ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'BAD_EMAIL' };

  let token: string;
  let inviteId: string;
  try {
    const invite = await runInTenantContext(ctx.tenantId, (db) =>
      createInvite(db, ctx.tenantId, ctx.userId, { email, role: 'COACH' }),
    );
    token = invite.token;
    inviteId = invite.inviteId;
  } catch (err) {
    if (err instanceof Error && err.name === 'AlreadyInvitedError') {
      return { ok: false, error: 'ALREADY_INVITED' };
    }
    throw err;
  }

  const link = `${env.NEXTAUTH_URL}/invite/${token}`;
  try {
    // In the inviting admin's language: the invitee has no account to read one from.
    const t = await getTranslations('admin.coaches.inviteEmail');
    await sendMail({
      to: email,
      subject: t('subject', { club: ctx.tenantName }),
      text: t('text', { club: ctx.tenantName, link }),
      idempotencyKey: `coach-invite:${inviteId}`,
    });
  } catch {
    revalidatePath(`/t/${slug}/admin/staff`);
    return { ok: false, error: 'MAIL_FAILED' };
  }
  revalidatePath(`/t/${slug}/admin/staff`);
  return { ok: true };
}
