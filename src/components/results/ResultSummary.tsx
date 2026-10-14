'use client';

import { useFormatter, useTranslations } from 'next-intl';

import { cn } from '@/lib/cn';

import type { ResultFormatDto, ResultPlayerDto } from './types';

/**
 * A result as two lines, one a side: its players, then its score in each set
 * (or its one total), the winning side in bold. Side 0 first, as the score is
 * stored (#575).
 */
export function ResultSummary({
  sides,
  score,
  winnerSide,
  format: scoreFormat,
  className,
}: {
  sides: ResultPlayerDto[][];
  score: number[][] | null;
  winnerSide: number | null;
  /** ORDER: a race, one driver a place, first to last (#577). */
  format?: ResultFormatDto;
  className?: string;
}) {
  const t = useTranslations('results');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const name = (p: ResultPlayerDto) =>
    p.deleted ? tCommon('deletedUser') : (p.name ?? t('unnamed'));

  if (scoreFormat === 'ORDER') {
    return (
      <ol className={cn('flex flex-col gap-1 text-sm', className)} data-testid="result-order">
        {sides.map((side, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-content-emphasis w-6 shrink-0 text-right font-semibold tabular-nums">
              {t('place', { place: i + 1 })}
            </span>
            <span
              className={i === 0 ? 'text-content-emphasis font-semibold' : 'text-content-default'}
            >
              {side.map(name).join(', ')}
            </span>
          </li>
        ))}
      </ol>
    );
  }

  // A raw table, not <DataTable>: two rows, a name column and up to five
  // narrow score cells, read as a scoreboard. Long names could still push it
  // past a phone's width, so it scrolls in place rather than the page.
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full text-sm" data-testid="result-summary">
        <caption className="sr-only">{t('summaryCaption')}</caption>
        <tbody>
          {sides.map((side, i) => {
            const won = winnerSide === i;
            return (
              <tr
                key={i}
                className={won ? 'text-content-emphasis font-semibold' : 'text-content-default'}
              >
                <th
                  scope="row"
                  // A header cell is bold by default; only the winners' row is.
                  className={cn('py-1 pr-3 text-left', won ? 'font-semibold' : 'font-normal')}
                >
                  {format.list(side.map(name), { type: 'conjunction' })}
                  {won ? <span className="sr-only">{` (${t('winner')})`}</span> : null}
                </th>
                {(score ?? []).map((pair, j) => (
                  <td key={j} className="w-8 py-1 text-right tabular-nums">
                    {pair[i]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
