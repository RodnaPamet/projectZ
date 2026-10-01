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
 * It renders for any signed-in person and reads nothing itself. Everything it
 * shows comes from `/api/v1/platform/moderation/**`, which checks a live grant
 * carrying REVIEW_MODERATE on every request and writes an audit row before it
 * answers. Without one, the frame renders and the API's refusal is said
 * plainly — no case text ever reaches the browser.
 *
 * It does not look the grant up to hide itself. Platform authority is resolved
 * only under the platform tree (`platform-route-discipline` asserts nothing
 * outside it asks), and a page that consulted the grant would be a second,
 * unaudited place deciding who is a moderator.
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
    <main className="bg-bg-page text-content-default safe-area-top safe-area-x min-h-screen px-6 py-10">
      <header className="mb-6">
        <h1 className="text-content-emphasis text-3xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      <ViewerScope viewerId={userId}>
        <ModerationQueue />
      </ViewerScope>
    </main>
  );
}
