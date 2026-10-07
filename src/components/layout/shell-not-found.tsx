'use client';

import { useTranslations } from 'next-intl';

import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/typography';

import { SIGNED_IN_HOME } from './nav-items';

/**
 * The app's 404, drawn INSIDE an admin or platform shell (#362, audit S01).
 *
 * A staff member who opened a page their role does not reach, by URL or an
 * old bookmark, got the page's `notFound()` caught by the root boundary: the
 * whole shell gave way to the public 404, so the way back into the admin was
 * gone with it. A `not-found.tsx` beside the shell's layout catches it there
 * instead, and the shell stays: the sidebar, the drawer and the bottom bar
 * still offer exactly the pages the role opens.
 *
 * The same words as the root 404 (`notFound.*`, src/app/not-found.tsx), and
 * the same vendored EmptyState. The way on is the shell's own front door,
 * which redirects to the first page the viewer may open, so it cannot lead to
 * a second 404. "Начало" is Играй, where `/` sends anybody signed in (#362).
 */
export function ShellNotFound({ home, homeLabel }: { home: string; homeLabel: string }) {
  const t = useTranslations('notFound');
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-10">
      {/* The page's heading, for the outline; EmptyState draws its title as text. */}
      <Heading level={1} className="sr-only">
        {t('title')}
      </Heading>
      <EmptyState
        variant="no-results"
        title={t('title')}
        description={t('body')}
        primaryAction={{ label: homeLabel, href: home }}
        secondaryAction={{ label: t('home'), href: SIGNED_IN_HOME }}
        data-testid="shell-not-found"
      />
    </div>
  );
}
