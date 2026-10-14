'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import { resultErrorKey, type ResultErrorKey } from '@/components/results/result-errors';
import { RESULT_TONE } from '@/components/results/result-tone';
import { ResultEditor } from '@/components/results/ResultEditor';
import { ResultSummary } from '@/components/results/ResultSummary';
import type { BookingResultDto, ResultDraft } from '@/components/results/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

/**
 * A booking's result (#575), on the player's booking once it is over.
 *
 *   no result, may report   «Въведи резултат»: the sides and the score
 *   reported, by my side    waiting for the other side, until when
 *   reported, to me         «Потвърди» or «Оспори» (with a note, for the club)
 *   answered or decided     the result and where it stands
 *
 * Nothing at all for a booking that cannot have one: still ahead, a sport
 * with no score, or past its 7 days with nothing reported.
 */
export function BookingResult({ bookingId, seed }: { bookingId: string; seed: BookingResultDto }) {
  const t = useTranslations('myBookings.result');
  const tResults = useTranslations('results');
  const format = useFormatter();
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<ResultErrorKey | null>(null);

  const { data, mutate } = useV1SWR<BookingResultDto>(KEYS.meBookingResult(bookingId), {
    fallbackData: seed,
  });
  const view = data ?? seed;

  const report = useV1Mutation<ResultDraft, BookingResultDto>({
    url: () => V1.reportBookingResult(bookingId),
    body: (draft) => draft,
  });
  const answer = useV1Mutation<{ id: string; verb: 'confirm' | 'reject'; note?: string }, unknown>({
    url: ({ id, verb }) => V1.answerResult(id, verb),
    body: ({ verb, note: n }) => (verb === 'reject' ? (n ? { note: n } : {}) : {}),
  });

  const when = (iso: string) =>
    format.dateTime(new Date(iso), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  async function send(draft: ResultDraft) {
    setError(null);
    try {
      const next = await report.trigger(draft);
      setEditing(false);
      if (next) void mutate(next, { revalidate: false });
    } catch (e) {
      setError(resultErrorKey(e));
      void mutate();
    }
  }

  async function respond(verb: 'confirm' | 'reject') {
    const r = view.result;
    if (!r) return;
    setError(null);
    try {
      await answer.trigger({ id: r.id, verb, note: note.trim() || undefined });
      setRejecting(false);
      void mutate();
    } catch (e) {
      setError(resultErrorKey(e));
      void mutate();
    }
  }

  const r = view.result;
  if (!r && !view.canReport) return null;
  const scored = view.format === 'PERIODS' || view.format === 'TOTAL';

  return (
    <section className="gap-tight flex flex-col" aria-labelledby="booking-result">
      <Heading level={2} tone="muted" className="text-sm" id="booking-result">
        {t('heading')}
      </Heading>

      <Card elevation="flat" className="gap-default flex flex-col" data-testid="booking-result">
        {r ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge variant={RESULT_TONE[r.status]} data-testid="booking-result-status">
                {tResults(`status.${r.status}`)}
              </StatusBadge>
            </div>
            <ResultSummary
              sides={r.sides}
              score={r.score}
              winnerSide={r.winnerSide}
              format={view.format}
            />
            {r.status === 'REPORTED' && r.autoConfirmAt ? (
              <Caption>
                {r.canAnswer
                  ? t('answerUntil', { deadline: when(r.autoConfirmAt) })
                  : t('waitingUntil', { deadline: when(r.autoConfirmAt) })}
              </Caption>
            ) : null}
            {r.status === 'REJECTED' ? <Caption>{t('withClub')}</Caption> : null}
            {r.canAnswer ? (
              rejecting ? (
                <div className="gap-tight flex flex-col" data-testid="booking-result-reject-form">
                  <label className="text-content-default text-sm" htmlFor="booking-result-note">
                    {t('rejectNote')}
                  </label>
                  <Textarea
                    id="booking-result-note"
                    value={note}
                    maxLength={500}
                    rows={3}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      loading={answer.isMutating}
                      disabled={answer.isMutating}
                      onClick={() => void respond('reject')}
                      data-testid="booking-result-reject-send"
                    >
                      {t('rejectSend')}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={answer.isMutating}
                      onClick={() => setRejecting(false)}
                    >
                      {t('back')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    loading={answer.isMutating}
                    disabled={answer.isMutating}
                    onClick={() => void respond('confirm')}
                    data-testid="booking-result-confirm"
                  >
                    {t('confirm')}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={answer.isMutating}
                    onClick={() => setRejecting(true)}
                    data-testid="booking-result-reject"
                  >
                    {t('reject')}
                  </Button>
                </div>
              )
            ) : null}
          </>
        ) : editing && scored ? (
          <>
            {view.pointsTotal ? (
              <Caption data-testid="booking-result-points">
                {t('pointsTotal', { total: view.pointsTotal })}
              </Caption>
            ) : null}
            <ResultEditor
              players={view.players}
              format={view.format as 'PERIODS' | 'TOTAL'}
              fixedSides={view.fixedSides ?? null}
              busy={report.isMutating}
              submitLabel={t('send')}
              onSubmit={(draft) => void send(draft)}
              onCancel={() => setEditing(false)}
            />
          </>
        ) : (
          <>
            <p className="text-content-default text-sm">
              {view.reportableUntil
                ? t('intro', { deadline: when(view.reportableUntil) })
                : t('introNoDeadline')}
            </p>
            <Button
              type="button"
              className="self-start"
              onClick={() => setEditing(true)}
              data-testid="booking-result-report"
            >
              {t('report')}
            </Button>
          </>
        )}
      </Card>

      {error ? (
        <InlineNotice variant="error" data-testid="booking-result-error">
          {tResults(`error.${error}`)}
        </InlineNotice>
      ) : null}
    </section>
  );
}
