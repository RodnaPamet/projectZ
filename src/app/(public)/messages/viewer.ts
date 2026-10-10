import { redirect } from 'next/navigation';

import { playerChrome } from '@/components/layout/player-chrome-data';
import { KIND_CHOOSER_PATH } from '@/lib/auth/landing';
import { requireSignedIn } from '@/lib/auth/page-context';

/**
 * Who a /messages page is for (#375): a signed-in PLAYER, or a coach, who is
 * told coach conversations come with the coach module (#377). Anybody else is
 * sent where they belong: signed out to sign-in (and back here after), a CLUB
 * account to its club's shared inbox (or its landing, with no live club), and
 * an account that has not chosen its kind to the chooser.
 */
export async function messagesViewer(next: string): Promise<{ userId: string; coach: boolean }> {
  const userId = await requireSignedIn();
  if (!userId) redirect(`/login?next=${encodeURIComponent(next)}`);

  const { kind, landing } = await playerChrome();
  if (kind === 'club' && landing) {
    redirect(landing.club ? `/t/${landing.club.tenantSlug}/admin/messages` : landing.href);
  }
  if (landing?.href === KIND_CHOOSER_PATH) redirect(KIND_CHOOSER_PATH);
  return { userId, coach: landing?.reason === 'coach' };
}
