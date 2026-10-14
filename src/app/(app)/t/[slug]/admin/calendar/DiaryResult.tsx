'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { resultErrorKey, type ResultErrorKey } from '@/components/results/result-errors';
import { RESULT_TONE } from '@/components/results/result-tone';
import { RaceOrderEditor } from '@/components/results/RaceOrderEditor';
import { ResultEditor } from '@/components/results/ResultEditor';
import { ResultSummary } from '@/components/results/ResultSummary';
import type { ClubBookingResultDto, ResultDraft } from '@/components/results/types';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

/**
 * A completed booking's result, in its diary sheet (#575): the result if one
 * was reported or entered, else «Въведи резултат». A result the club enters
 * is final and counts at once (#378, round 4); the players are told.
 */
export function DiaryResult({ slug, bookingId }: { slug: string; bookingId: string }) {
  const t = useTranslations('admin.calendar.players.result');
  const tResults = useTranslations('results');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<ResultErrorKey | null>(null);

  const { data, mutate } = useV1SWR<ClubBookingResultDto>(KEYS.clubBookingResult(slug, bookingId));
  const enter = useV1Mutation<ResultDraft | { order: string[] }, unknown>({
    url: () => V1.enterClubResult(slug, bookingId),
    body: (draft) => draft,
  });

  async function send(draft: ResultDraft | { order: string[] }) {
    setError(null);
    try {
      await enter.trigger(draft);
      setEditing(false);
    } catch (e) {
      setError(resultErrorKey(e));
    }
    void mutate();
  }

  if (!data || (!data.result && !data.canEnter)) return null;
  const r = data.result;

  return (
    <section className="gap-compact grid" aria-labelledby="diary-result" data-diary-result>
      <Heading level={3} tone="muted" className="text-sm" id="diary-result">
        {t('heading')}
      </Heading>
      {r ? (
        <>
          <StatusBadge variant={RESULT_TONE[r.status]} className="justify-self-start">
            {tResults(`status.${r.status}`)}
          </StatusBadge>
          <ResultSummary
            sides={r.sides}
            score={r.score}
            winnerSide={r.winnerSide}
            format={r.format}
          />
        </>
      ) : editing && (data.format === 'PERIODS' || data.format === 'TOTAL') ? (
        <ResultEditor
          players={data.players}
          format={data.format}
          fixedSides={data.fixedSides ?? null}
          busy={enter.isMutating}
          submitLabel={t('save')}
          onSubmit={(draft) => void send(draft)}
          onCancel={() => setEditing(false)}
        />
      ) : editing && data.format === 'ORDER' ? (
        // A karting session (#577): the track's finishing order.
        <RaceOrderEditor
          drivers={data.players}
          busy={enter.isMutating}
          submitLabel={t('save')}
          onSubmit={(order) => void send({ order })}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <Caption>{data.format === 'ORDER' ? t('finalRace') : t('final')}</Caption>
          <Button
            type="button"
            variant="secondary"
            className="justify-self-start"
            onClick={() => setEditing(true)}
            data-diary-result-enter
          >
            {data.format === 'ORDER' ? t('enterRace') : t('enter')}
          </Button>
        </>
      )}
      {error ? <InlineNotice variant="error">{tResults(`error.${error}`)}</InlineNotice> : null}
    </section>
  );
}
