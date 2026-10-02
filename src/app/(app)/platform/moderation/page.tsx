import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { requireSignedIn } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';

import { ModerationQueue } from './ModerationQueue';

export async function generateMetadata() {
  const t = await getTranslations('platform.moderation');
  return { title: t('metaTitle') };
}

/**
 * The review moderation queue, for platform moderators.
 *
 * ═══ THIS PAGE HOLDS NO AUTHORITY, ON PURPOSE ═══
 *
 * It reads nothing itself. Everything it shows comes from
 * `/api/v1/platform/moderation/**`, which checks a live grant carrying
 * REVIEW_MODERATE on every request and writes an audit row before it answers.
 * If the grant lapses while the page is open, the API's refusal is said
 * plainly — no case text ever reaches the browser.
 *
 * Since T19 the platform LAYOUT looks the grant up, to decide whether to show
 * the platform shell at all (a 404 otherwise). That decides what to show,
 * never what to do: the API above stays the only place a moderation read or
 * decision is authorised, and it audits each one.
 *
 * It does pass the queue WHO it was rendered for (ViewerScope): every queue
 * read and decision then carries `x-playerz-viewer`, and the API refuses with
 * 409 VIEWER_CHANGED if the browser has since signed in as somebody else —
 * so a moderator's tab never shows, or decides as, another account (#263).
 */
export default async function ModerationPage() {
  const userId = await requireSignedIn();
  if (!userId) redirect('/login?next=/platform/moderation');

  const t = await getTranslations('platform.moderation');

  return (
    // No <main> and no page chrome: the platform layout's shell (T19) owns
    // both, and a second <main> is an axe violation.
    <section>
      <header className="mb-6">
        <h1 className="text-content-emphasis text-3xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      <ViewerScope viewerId={userId}>
        <ModerationQueue />
      </ViewerScope>
    </section>
  );
}
