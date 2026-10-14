'use client';

import { useFormatter, useTranslations } from 'next-intl';

import { cn } from '@/lib/cn';

import type { ResultPlayerDto } from './types';

/**
 * A result as two lines, one a side: its players, then its score in each set
 * (or its one total), the winning side in bold. Side 0 first, as the score is
 * stored (#575).
 */
export function ResultSummary({
  sides,
  score,
  winnerSide,
  className,
}: {
  sides: ResultPlayerDto[][];
  score: number[][] | null;
  winnerSide: number | null;
  className?: string;
}) {
  const t = useTranslations('results');
  const format = useFormatter();
  const name = (p: ResultPlayerDto) => p.name ?? t('unnamed');

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
