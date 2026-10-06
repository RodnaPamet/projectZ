import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { buttonVariants } from '@/components/ui/button-variants';
import { ArrowLeft } from '@/components/ui/icons/nucleo';
import { cn } from '@/lib/cn';

/**
 * The venue page's way back to the index, on its cover band: the page's own
 * link, not navigation chrome (#362 owns that).
 *
 * ═══ WHY loading.tsx RENDERS IT TOO (#403) ═══
 *
 * It is the one client component in the skeleton, and that is on purpose.
 * Turbopack maps every client reference in this route to the page's whole
 * chunk list, so when a venue card's auto prefetch decodes the skeleton, the
 * browser also fetches the page's JS chunk (about 12 KB gzip, immutable, one
 * fetch for every card). Without it the chunk was requested only when the
 * tap's RSC answer arrived, and on the phone profile it landed about 175 ms
 * later, after the reveal throttle had already released: the chunk, not the
 * throttle, held the page back. The owner approved that fetch on 6 October
 * 2026 (#403); docs/perf/navigation-policy.md records it.
 *
 * A server component (next-intl's `useTranslations` works in both), so the
 * skeleton keeps the `export default function` shape the loading guard wants.
 */
export function VenueBackLink() {
  const t = useTranslations('venue');
  return (
    <Link
      href="/venues"
      aria-label={t('back')}
      className={cn(
        buttonVariants({ variant: 'secondary', size: 'icon' }),
        'absolute top-3 left-4 md:left-3',
      )}
    >
      <ArrowLeft aria-hidden="true" />
    </Link>
  );
}
