'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ChevronUp } from '@/components/ui/icons/nucleo/chevron-up';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Switch } from '@/components/ui/switch';
import { Caption } from '@/components/ui/typography';

import type { ResultPlayerDto } from './types';

/**
 * A karting session's finishing order (#577, decision 33), as the track's
 * timing system shows it: the drivers first to last, moved up or down, and
 * a driver who did not race switched off. Two drivers at least.
 */
export function RaceOrderEditor({
  drivers,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  drivers: ResultPlayerDto[];
  busy: boolean;
  submitLabel: string;
  onSubmit: (order: string[]) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('results.race');
  const tResults = useTranslations('results');
  const [order, setOrder] = useState(() => drivers.map((d) => d.userId));
  const [out, setOut] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState(false);
  const tCommon = useTranslations('common');
  const nameOf = new Map(
    drivers.map((d) => [
      d.userId,
      d.deleted ? tCommon('deletedUser') : (d.name ?? tResults('unnamed')),
    ]),
  );
  const racing = order.filter((id) => !out.has(id));

  function move(id: string, by: -1 | 1) {
    setOrder((current) => {
      const i = current.indexOf(id);
      const j = i + by;
      if (j < 0 || j >= current.length) return current;
      const next = [...current];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (racing.length < 2) {
      setProblem(true);
      return;
    }
    setProblem(false);
    onSubmit(racing);
  }

  return (
    <form
      className="gap-section flex flex-col"
      onSubmit={submit}
      noValidate
      data-testid="race-order-editor"
    >
      <Caption>{t('hint')}</Caption>
      <ol className="divide-border-subtle divide-y">
        {order.map((id, i) => {
          const name = nameOf.get(id)!;
          const racingNow = !out.has(id);
          const place = racingNow ? racing.indexOf(id) + 1 : null;
          return (
            <li key={id} className="flex items-center gap-2 py-2" data-testid="race-order-driver">
              <span className="text-content-emphasis w-6 shrink-0 text-right text-sm font-semibold tabular-nums">
                {place ?? '–'}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-sm ${racingNow ? 'text-content-default' : 'text-content-muted line-through'}`}
              >
                {name}
              </span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={i === 0}
                onClick={() => move(id, -1)}
                aria-label={t('up', { name })}
              >
                <ChevronUp aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={i === order.length - 1}
                onClick={() => move(id, 1)}
                aria-label={t('down', { name })}
              >
                <ChevronUp className="rotate-180" aria-hidden="true" />
              </Button>
              <Switch
                checked={racingNow}
                onCheckedChange={(on) =>
                  setOut((s) => {
                    const next = new Set(s);
                    if (on) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                aria-label={t('raced', { name })}
              />
            </li>
          );
        })}
      </ol>
      {problem ? (
        <InlineNotice variant="error" data-testid="race-order-problem">
          {t('problem')}
        </InlineNotice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} disabled={busy} data-testid="race-order-submit">
          {submitLabel}
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}
