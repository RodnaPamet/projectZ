'use client';

import { useTranslations } from 'next-intl';

import { ErrorState } from '@/components/ui/error-state';

/**
 * The signed-in pages' error boundary.
 *
 * There was none, so a thrown render anywhere under /me, /t or /platform fell
 * through to Next's built-in screen: English, unstyled, and with no way back
 * but the browser's reload — for a Bulgarian-first app, on the page most likely
 * to be seen by someone who already had a bad moment.
 *
 * `retry()`, not `reset()`. This Next (16.3, node_modules/next/dist/docs/01-app/
 * 03-api-reference/03-file-conventions/error.md) has both: `reset` only clears
 * the boundary and re-renders the same RSC payload, so a server error renders
 * the same error again; `retry` re-fetches the segment first.
 *
 * The digest is shown because it is the one thing that ties what the person saw
 * to a server log line, and a production error message is generic by design.
 * (public)/error.tsx is the same screen for the signed-out pages.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations('common');

  return (
    <main className="safe-area-top safe-area-x flex min-h-dvh items-center justify-center p-6">
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
    </main>
  );
}
