import Link from 'next/link';

import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { Caption } from '@/components/ui/typography';
import { coachPath } from '@/lib/coaches/hrefs';

/**
 * One coach in a list (#547): the picture, the name, what they teach, and a
 * line under it (the price from, or the price at this venue). The whole card
 * is the link to the coach's page.
 *
 * Plain markup with the copy handed in, so the list page and the venue page,
 * both Server Components, render it without shipping anything to the browser.
 */
export function CoachCard({
  slug,
  name,
  avatarUrl,
  sports,
  line,
  places,
}: {
  slug: string;
  name: string;
  avatarUrl: string | null;
  /** Sport names, already in the page's language. */
  sports: string[];
  line: string | null;
  /** Where they teach, when the list is not already about one venue. */
  places?: string | null;
}) {
  return (
    <Link
      href={coachPath(slug)}
      className="border-border-subtle bg-bg-default hover:bg-bg-muted flex min-h-14 items-center gap-3 rounded-lg border p-3 transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
      data-testid="coach-card"
      data-coach={slug}
    >
      <InitialsAvatar value={name} size="md" imageUrl={avatarUrl} />
      <span className="min-w-0 flex-1">
        <span className="text-content-emphasis block truncate text-sm font-medium">{name}</span>
        {sports.length > 0 ? (
          <Caption className="block truncate">{sports.join(' · ')}</Caption>
        ) : null}
        {places ? <Caption className="block truncate">{places}</Caption> : null}
      </span>
      {line ? (
        <span className="text-content-default shrink-0 text-sm" data-testid="coach-card-price">
          {line}
        </span>
      ) : null}
    </Link>
  );
}
