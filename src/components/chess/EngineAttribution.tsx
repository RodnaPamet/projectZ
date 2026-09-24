import { ENGINE_LICENSE_URL, ENGINE_NAME, ENGINE_SOURCE_URL } from '@/lib/chess/engine';
import { useTranslations } from 'next-intl';

/**
 * The Stockfish attribution.
 *
 * ─── This is a LICENCE CONDITION, not a credit ───────────────────────
 *
 * Stockfish is GPL-3. The licence requires that whoever receives the program can
 * obtain its SOURCE and read its LICENCE. A link buried in a source file that no
 * user will ever open does not satisfy that — it has to be somewhere a person
 * can actually find.
 *
 * So this renders wherever the analysis feature does, and
 * `tests/guardrails/gpl-isolation.test.ts` fails the build if no component
 * renders it at all.
 *
 * Do not remove it because it clutters the panel. Do not hide it behind a
 * tooltip. If it is in the way, move it — but it ships.
 */
export function EngineAttribution({ className }: { className?: string }) {
  const t = useTranslations('engine');

  return (
    <p className={className ?? 'text-muted-foreground text-xs'}>
      {t('analysisBy')}{' '}
      <a
        href={ENGINE_SOURCE_URL}
        target="_blank"
        rel="noreferrer noopener"
        className="hover:text-foreground underline underline-offset-2"
      >
        {ENGINE_NAME}
      </a>
      {t('usedUnmodified')}{' '}
      <a
        href={ENGINE_LICENSE_URL}
        target="_blank"
        rel="noreferrer noopener"
        className="hover:text-foreground underline underline-offset-2"
      >
        GNU GPL v3
      </a>
      .
    </p>
  );
}
