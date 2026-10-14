'use client';

import dynamic from 'next/dynamic';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import { RESULT_TONE } from '@/components/results/result-tone';
import { resultErrorKey, type ResultErrorKey } from '@/components/results/result-errors';
import { ResultEditor } from '@/components/results/ResultEditor';
import { ResultSummary } from '@/components/results/ResultSummary';
import type { ClubResultDto, ResultDraft } from '@/components/results/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Sheet } from '@/components/ui/sheet';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);

type Decision = { action: 'confirm'; sides?: string[][]; score?: number[][] } | { action: 'void' };

/**
 * The club's results (#575). A rejected one waits at the top: the desk
 * confirms it as reported, corrects it and confirms that, or voids it
 * (decision 34). Each answer tells the players.
 */
export function ClubResults({
  slug,
  waiting: waitingSeed,
  recent: recentSeed,
}: {
  slug: string;
  waiting: ClubResultDto[];
  recent: ClubResultDto[];
}) {
  const t = useTranslations('admin.results');
  const tResults = useTranslations('results');
  const [correcting, setCorrecting] = useState<ClubResultDto | null>(null);
  const [voiding, setVoiding] = useState<ClubResultDto | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [error, setError] = useState<ResultErrorKey | null>(null);

  const waitingRead = useV1SWR<{ items: ClubResultDto[] }>(KEYS.clubResults(slug, 'REJECTED'), {
    fallbackData: { items: waitingSeed },
  });
  const recentRead = useV1SWR<{ items: ClubResultDto[] }>(KEYS.clubResults(slug), {
    fallbackData: { items: recentSeed },
  });
  const waiting = waitingRead.data?.items ?? waitingSeed;
  const recent = (recentRead.data?.items ?? recentSeed).filter((r) => r.status !== 'REJECTED');

  const decide = useV1Mutation<{ id: string; decision: Decision }, unknown>({
    url: ({ id }) => V1.decideResult(slug, id),
    body: ({ decision }) => decision,
  });

  async function run(id: string, decision: Decision) {
    setError(null);
    try {
      await decide.trigger({ id, decision });
      setCorrecting(null);
    } catch (e) {
      setError(resultErrorKey(e));
    }
    void waitingRead.mutate();
    void recentRead.mutate();
  }

  const row = (r: ClubResultDto, actions: boolean) => (
    <ResultCard
      key={r.id}
      result={r}
      busy={decide.isMutating}
      actions={actions}
      onConfirm={() => void run(r.id, { action: 'confirm' })}
      onCorrect={() => setCorrecting(r)}
      onVoid={() => {
        setVoiding(r);
        setVoidOpen(true);
      }}
    />
  );

  return (
    <div className="gap-section flex flex-col">
      {error ? (
        <InlineNotice variant="error" data-testid="club-results-error">
          {tResults(`error.${error}`)}
        </InlineNotice>
      ) : null}

      <section className="gap-compact flex flex-col" aria-labelledby="club-results-waiting">
        <Heading level={2} className="text-base" id="club-results-waiting">
          {t('waiting')}
        </Heading>
        {waiting.length === 0 ? (
          <Caption data-testid="club-results-none-waiting">{t('noneWaiting')}</Caption>
        ) : (
          <ul className="gap-compact flex flex-col" data-testid="club-results-waiting">
            {waiting.map((r) => (
              <li key={r.id}>{row(r, true)}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="gap-compact flex flex-col" aria-labelledby="club-results-recent">
        <Heading level={2} className="text-base" id="club-results-recent">
          {t('recent')}
        </Heading>
        {recent.length === 0 ? (
          <EmptyState title={t('noneRecent')} />
        ) : (
          <ul className="gap-compact flex flex-col" data-testid="club-results-recent">
            {recent.map((r) => (
              <li key={r.id}>{row(r, r.status === 'REPORTED')}</li>
            ))}
          </ul>
        )}
      </section>

      {correcting && (correcting.format === 'PERIODS' || correcting.format === 'TOTAL') ? (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setCorrecting(null);
          }}
          title={t('correctTitle')}
          size="sm"
        >
          <Sheet.Header title={t('correctTitle')} description={t('correctDescription')} />
          <Sheet.Body>
            <ResultEditor
              players={correcting.sides.flat()}
              format={correcting.format}
              initial={{
                sides: correcting.sides.map((s) => s.map((p) => p.userId)),
                score: correcting.score ?? [],
              }}
              busy={decide.isMutating}
              submitLabel={t('correctSave')}
              onSubmit={(draft: ResultDraft) =>
                void run(correcting.id, {
                  action: 'confirm',
                  sides: draft.sides,
                  score: draft.score,
                })
              }
              onCancel={() => setCorrecting(null)}
            />
          </Sheet.Body>
        </Sheet>
      ) : null}

      {voiding ? (
        <ConfirmDialog
          showModal={voidOpen}
          setShowModal={setVoidOpen}
          title={t('voidConfirm.title')}
          description={t('voidConfirm.description')}
          confirmLabel={t('voidConfirm.yes')}
          cancelLabel={t('voidConfirm.no')}
          onConfirm={() => void run(voiding.id, { action: 'void' })}
        />
      ) : null}
    </div>
  );
}

function ResultCard({
  result: r,
  busy,
  actions,
  onConfirm,
  onCorrect,
  onVoid,
}: {
  result: ClubResultDto;
  busy: boolean;
  actions: boolean;
  onConfirm: () => void;
  onCorrect: () => void;
  onVoid: () => void;
}) {
  const t = useTranslations('admin.results');
  const tResults = useTranslations('results');
  const tSports = useTranslations('sports');
  const format = useFormatter();
  const when = format.dateTime(new Date(r.startTs), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Card elevation="flat" className="gap-default flex flex-col" data-testid="club-result">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Caption>
          {t('when', { when, court: r.courtName, sport: tSports(r.sport as never) })}
        </Caption>
        <StatusBadge variant={RESULT_TONE[r.status]}>{tResults(`status.${r.status}`)}</StatusBadge>
      </div>
      <ResultSummary sides={r.sides} score={r.score} winnerSide={r.winnerSide} />
      {r.rejectNote ? (
        <p
          className="text-content-default text-sm break-words whitespace-pre-wrap"
          data-testid="club-result-note"
        >
          {t('note', { note: r.rejectNote })}
        </p>
      ) : null}
      {actions ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={onConfirm}
            data-testid="club-result-confirm"
          >
            {t('confirm')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={onCorrect}
            data-testid="club-result-correct"
          >
            {t('correct')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onVoid}
            data-testid="club-result-void"
          >
            {t('void')}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
