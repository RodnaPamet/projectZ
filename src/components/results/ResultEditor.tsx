'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption, Heading } from '@/components/ui/typography';

import type { ResultDraft, ResultPlayerDto } from './types';

type Seat = '0' | '1' | 'out';

const MAX_SETS = 5;

/**
 * Entering a result (#575): who played on which side (decision 30), then the
 * score (decision 46), side 1's number first in every row.
 *
 *   PERIODS  a row a set: one to five, «Добави сет» for the next
 *   TOTAL    one row: goals, points, or the game
 *
 * Every player starts on a side, the first half on side 1, so a singles or a
 * doubles booking needs no change when it was booked in the order it was
 * played; «Не игра» leaves someone out. The server checks the rest
 * (`@/lib/ranking/score`): this form only stops what is plainly not a result.
 */
export function ResultEditor({
  players,
  format,
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  players: ResultPlayerDto[];
  format: 'PERIODS' | 'TOTAL';
  initial?: ResultDraft | null;
  busy: boolean;
  submitLabel: string;
  onSubmit: (draft: ResultDraft) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('results.editor');
  const tResults = useTranslations('results');
  const tCommon = useTranslations('common');
  const nameOf = (p: ResultPlayerDto) =>
    p.deleted ? tCommon('deletedUser') : (p.name ?? tResults('unnamed'));
  const id = useId();
  const [seats, setSeats] = useState<Record<string, Seat>>(() => firstSeats(players, initial));
  const [rows, setRows] = useState<string[][]>(() =>
    initial?.score.length
      ? initial.score.map((pair) => pair.map(String))
      : format === 'PERIODS'
        ? [
            ['', ''],
            ['', ''],
          ]
        : [['', '']],
  );
  const [problem, setProblem] = useState<'sides' | 'score' | null>(null);

  const seatOptions = [
    { value: '0', label: t('side', { n: 1 }) },
    { value: '1', label: t('side', { n: 2 }) },
    { value: 'out', label: t('out') },
  ];

  function setCell(row: number, side: 0 | 1, value: string) {
    setRows((current) =>
      current.map((pair, i) =>
        i === row ? (side === 0 ? [value, pair[1]!] : [pair[0]!, value]) : pair,
      ),
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const sides = (['0', '1'] as const).map((s) =>
      players.filter((p) => seats[p.userId] === s).map((p) => p.userId),
    );
    if (sides.some((side) => side.length === 0)) {
      setProblem('sides');
      return;
    }
    const score = rows.map((pair) => pair.map((v) => Number(v.trim())));
    if (rows.some((pair) => pair.some((v) => !/^\d{1,3}$/.test(v.trim())))) {
      setProblem('score');
      return;
    }
    setProblem(null);
    onSubmit({ sides, score });
  }

  return (
    <form
      className="gap-section flex flex-col"
      onSubmit={submit}
      noValidate
      data-testid="result-editor"
    >
      <fieldset className="gap-tight flex flex-col">
        <legend className="mb-2">
          <Heading level={3} tone="muted" className="text-sm">
            {t('sides')}
          </Heading>
        </legend>
        <ul className="gap-tight flex flex-col">
          {players.map((p) => (
            <li
              key={p.userId}
              className="flex flex-wrap items-center justify-between gap-2"
              data-testid="result-editor-player"
            >
              <span className="text-content-default min-w-0 truncate text-sm">{nameOf(p)}</span>
              <ToggleGroup
                options={seatOptions}
                selected={seats[p.userId] ?? 'out'}
                selectAction={(v) => setSeats((s) => ({ ...s, [p.userId]: v as Seat }))}
                ariaLabel={t('sideOf', { name: nameOf(p) })}
                size="sm"
              />
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset className="gap-tight flex flex-col">
        <legend className="mb-2">
          <Heading level={3} tone="muted" className="text-sm">
            {format === 'PERIODS' ? t('scoreSets') : t('scoreTotal')}
          </Heading>
        </legend>
        <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-2">
          <span aria-hidden="true" />
          <Caption className="text-center">{t('side', { n: 1 })}</Caption>
          <Caption className="text-center">{t('side', { n: 2 })}</Caption>
          {rows.map((pair, i) => {
            const rowLabel = format === 'PERIODS' ? t('set', { n: i + 1 }) : t('total');
            return [
              <span key={`l${i}`} className="text-content-muted text-sm" id={`${id}-row-${i}`}>
                {rowLabel}
              </span>,
              ...([0, 1] as const).map((side) => (
                <Input
                  key={`${i}-${side}`}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={3}
                  value={pair[side]}
                  onChange={(e) => setCell(i, side, e.target.value.replace(/\D/g, ''))}
                  aria-label={t('cell', { row: rowLabel, side: side + 1 })}
                  className="text-center tabular-nums"
                  data-testid={`result-editor-cell-${i}-${side}`}
                />
              )),
            ];
          })}
        </div>
        {format === 'PERIODS' ? (
          <div className="flex flex-wrap gap-2">
            {rows.length < MAX_SETS ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setRows((r) => [...r, ['', '']])}
                data-testid="result-editor-add-set"
              >
                {t('addSet')}
              </Button>
            ) : null}
            {rows.length > 1 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setRows((r) => r.slice(0, -1))}
              >
                {t('removeSet')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      {problem ? (
        <InlineNotice variant="error" data-testid="result-editor-problem">
          {problem === 'sides' ? t('problemSides') : t('problemScore')}
        </InlineNotice>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} disabled={busy} data-testid="result-editor-submit">
          {submitLabel}
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}

function firstSeats(
  players: ResultPlayerDto[],
  initial?: ResultDraft | null,
): Record<string, Seat> {
  const seats: Record<string, Seat> = {};
  if (initial) {
    for (const p of players) {
      seats[p.userId] = initial.sides[0]?.includes(p.userId)
        ? '0'
        : initial.sides[1]?.includes(p.userId)
          ? '1'
          : 'out';
    }
    return seats;
  }
  const half = Math.ceil(players.length / 2);
  players.forEach((p, i) => {
    seats[p.userId] = i < half ? '0' : '1';
  });
  return seats;
}
