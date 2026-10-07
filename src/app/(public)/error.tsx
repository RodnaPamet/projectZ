'use client';

import { useTranslations } from 'next-intl';

import { ErrorState } from '@/components/ui/error-state';

/**
 * The public pages' error boundary — /venues, /login, /invite.
 *
 * The same screen as (app)/error.tsx, kept as its own file rather than a
 * re-export across route groups: Next requires the boundary to be a client
 * module, and a file whose first line says so cannot be mistaken for one that
 * is not. See (app)/error.tsx for `retry()` over `reset()` and for the digest.
 */
export default function PublicError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations('common');

  return (
    // No <main>: the chrome around the page owns the landmark (#362).
    <div className="safe-area-x flex flex-1 items-center justify-center py-6">
      <ErrorState
        description={t('error.body')}
        onRetry={retry}
        retryLabel={t('retry')}
        data-testid="route-error"
      >
        {error.digest && (
          <p className="text-content-muted w-full text-xs tabular-nums">
            {t('error.errorId', { id: error.digest })}
          </p>
        )}
      </ErrorState>
    </div>
  );
}
