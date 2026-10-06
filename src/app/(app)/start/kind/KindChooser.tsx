'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { PLAY_PATH, PLAYER_HOME } from '@/lib/auth/landing';
import { isApiClientError } from '@/lib/data/errors';
import { V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';

export type ChoosableKind = 'PLAYER' | 'COACH';
export type KindErrorKey = 'ALREADY_SET' | 'NOT_ALLOWED' | 'FAILED';

export function kindErrorKey(e: unknown): KindErrorKey {
  if (!isApiClientError(e)) return 'FAILED';
  if (e.code === 'ACCOUNT_KIND_ALREADY_SET') return 'ALREADY_SET';
  if (e.code === 'ACCOUNT_KIND_NOT_ALLOWED') return 'NOT_ALLOWED';
  return 'FAILED';
}

/**
 * Where a person goes once they have chosen: where they were going (`next`),
 * else Играй for a new player (nothing in Резервации yet), and the player UI
 * for a coach, which carries the "coach profile is coming" notice (#377).
 */
export function afterChoosing(kind: ChoosableKind, next: string | null): string {
  if (next) return next;
  return kind === 'PLAYER' ? PLAY_PATH : PLAYER_HOME;
}

const KINDS: readonly ChoosableKind[] = ['PLAYER', 'COACH'];

/**
 * The two answers, as a radio group of cards: Играч and Треньор, each with one
 * line on what it means. Nothing is chosen until the person picks; Продължи
 * stays disabled until then. Clubs are not offered: the owner creates them.
 */
export function KindChooser({ next }: { next: string | null }) {
  const t = useTranslations('onboarding.kind');
  const router = useRouter();
  const ids = useId();
  const [kind, setKind] = useState<ChoosableKind | null>(null);
  const [error, setError] = useState<KindErrorKey | null>(null);

  const choose = useV1Mutation<ChoosableKind>({
    url: () => V1.chooseAccountKind(),
    body: (k) => ({ kind: k }),
  });

  async function submit() {
    if (!kind) return;
    setError(null);
    try {
      await choose.trigger(kind);
      router.replace(afterChoosing(kind, next));
      router.refresh();
    } catch (e) {
      const key = kindErrorKey(e);
      // Chosen already (another tab): carry on, the page that asked is done.
      if (key === 'ALREADY_SET') {
        router.replace(afterChoosing(kind, next));
        router.refresh();
        return;
      }
      setError(key);
    }
  }

  return (
    <form
      className="gap-section flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset className="gap-compact flex flex-col">
        <legend className="sr-only">{t('legend')}</legend>
        <RadioGroup
          value={kind ?? ''}
          onValueChange={(v) => setKind(v as ChoosableKind)}
          aria-label={t('legend')}
          className="gap-compact"
          data-testid="kind-chooser"
        >
          {KINDS.map((k) => {
            const key = k === 'PLAYER' ? 'player' : 'coach';
            const id = `${ids}-${k}`;
            return (
              <Card key={k} elevation="flat" density="none">
                <Label
                  htmlFor={id}
                  className="flex min-h-14 cursor-pointer items-start gap-3 px-4 py-4"
                >
                  <RadioGroupItem value={k} id={id} className="mt-0.5" data-testid={`kind-${k}`} />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-content-emphasis text-base font-semibold">
                      {t(`${key}.label`)}
                    </span>
                    <span className="text-content-muted text-sm font-normal">
                      {t(`${key}.description`)}
                    </span>
                  </span>
                </Label>
              </Card>
            );
          })}
        </RadioGroup>
      </fieldset>

      {error ? (
        <InlineNotice variant="error" data-testid="kind-error">
          {t(`error.${error}`)}
        </InlineNotice>
      ) : null}

      <Button
        type="submit"
        disabled={!kind}
        loading={choose.isMutating}
        data-testid="kind-continue"
      >
        {t('continue')}
      </Button>
    </form>
  );
}
