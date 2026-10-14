'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import type { ClubTournamentDto, DrawDto, DrawMatchDto } from '@/app/api/v1/_lib/tournament-dto';
import { DrawView } from '@/components/tournaments/DrawView';
import {
  tournamentErrorKey,
  type TournamentErrorKey,
} from '@/components/tournaments/tournament-errors';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

type Court = { id: string; name: string };

/**
 * The draw, for the club (#580): make it, then put each ready match on a court
 * and time (40) or give it as a walkover (58, 59). Results come from the
 * matches' bookings, as any booking's.
 */
export function AdminDraw({
  slug,
  tournament: x,
  courts,
  onChanged,
}: {
  slug: string;
  tournament: ClubTournamentDto;
  courts: Court[];
  onChanged: () => void;
}) {
  const t = useTranslations('admin.tournaments.draw');
  const tT = useTranslations('tournaments');
  const drawn = x.status === 'IN_PROGRESS' || x.status === 'COMPLETE';
  const { data: draw, mutate } = useV1SWR<DrawDto>(
    drawn ? KEYS.clubTournamentDraw(slug, x.id) : null,
  );
  const [making, setMaking] = useState(false);
  const [scheduling, setScheduling] = useState<DrawMatchDto | null>(null);
  const [walkingOver, setWalkingOver] = useState<DrawMatchDto | null>(null);
  const [error, setError] = useState<TournamentErrorKey | null>(null);

  const make = useV1Mutation<
    { groupCount?: number; qualifiersPerGroup?: number; thirdPlace: boolean },
    DrawDto
  >({
    url: () => V1.drawTournament(slug, x.id),
    body: (b) => b,
  });
  const schedule = useV1Mutation<
    { id: string; resourceId: string; startTs: string; durationMinutes: number },
    DrawDto
  >({
    url: ({ id }) => V1.tournamentMatchAction(slug, id, 'schedule'),
    body: ({ resourceId, startTs, durationMinutes }) => ({ resourceId, startTs, durationMinutes }),
  });
  const walkover = useV1Mutation<{ id: string; winnerSide: 0 | 1 }, DrawDto>({
    url: ({ id }) => V1.tournamentMatchAction(slug, id, 'walkover'),
    body: ({ winnerSide }) => ({ winnerSide }),
  });

  async function run(fn: () => Promise<DrawDto | undefined>): Promise<boolean> {
    setError(null);
    try {
      const next = await fn();
      if (next) void mutate(next, { revalidate: false });
      onChanged();
      return true;
    } catch (e) {
      setError(tournamentErrorKey(e));
      return false;
    }
  }

  const sideName = (m: DrawMatchDto, i: 0 | 1) =>
    (i === 0 ? m.sideA : m.sideB)?.players.map((p) => p.name ?? tT('unnamed')).join(' / ') ?? '';

  return (
    <section className="gap-compact flex flex-col" aria-labelledby="admin-draw">
      <Heading level={2} className="text-base" id="admin-draw">
        {t('heading')}
      </Heading>
      {error ? (
        <InlineNotice variant="error" data-testid="admin-draw-error">
          {tT(`error.${error}`)}
        </InlineNotice>
      ) : null}
      {x.status === 'REGISTRATION' ? (
        <>
          <Caption>{t('before', { confirmed: x.confirmed })}</Caption>
          <Button
            type="button"
            className="self-start"
            disabled={x.confirmed < 2}
            onClick={() => setMaking(true)}
            data-testid="admin-draw-make"
          >
            {t('make')}
          </Button>
        </>
      ) : drawn && draw ? (
        <DrawView
          draw={draw}
          actions={(m) =>
            m.status === 'READY' && x.status === 'IN_PROGRESS' ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setScheduling(m)}
                  data-testid="admin-draw-schedule"
                >
                  {m.scheduled ? t('move') : t('schedule')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setWalkingOver(m)}
                  data-testid="admin-draw-walkover"
                >
                  {t('walkover')}
                </Button>
              </div>
            ) : null
          }
        />
      ) : drawn ? null : (
        <Caption>{t('notYet')}</Caption>
      )}

      {making ? (
        <MakeDrawSheet
          format={x.format}
          confirmed={x.confirmed}
          busy={make.isMutating}
          onClose={() => setMaking(false)}
          onSubmit={(b) =>
            void run(() => make.trigger(b)).then((ok) => {
              if (ok) setMaking(false);
            })
          }
        />
      ) : null}

      {scheduling ? (
        <ScheduleSheet
          match={scheduling}
          courts={courts}
          names={[sideName(scheduling, 0), sideName(scheduling, 1)]}
          busy={schedule.isMutating}
          onClose={() => setScheduling(null)}
          onSubmit={(b) =>
            void run(() => schedule.trigger({ id: scheduling.id, ...b })).then((ok) => {
              if (ok) setScheduling(null);
            })
          }
        />
      ) : null}

      {walkingOver ? (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setWalkingOver(null);
          }}
          title={t('walkoverTitle')}
          size="sm"
        >
          <Sheet.Header title={t('walkoverTitle')} description={t('walkoverDescription')} />
          <Sheet.Body className="gap-compact grid content-start">
            {([0, 1] as const).map((side) => (
              <Button
                key={side}
                type="button"
                variant="secondary"
                disabled={walkover.isMutating}
                onClick={() =>
                  void run(() => walkover.trigger({ id: walkingOver.id, winnerSide: side })).then(
                    (ok) => {
                      if (ok) setWalkingOver(null);
                    },
                  )
                }
                data-testid={`admin-draw-walkover-${side}`}
              >
                {t('wins', { name: sideName(walkingOver, side) })}
              </Button>
            ))}
          </Sheet.Body>
        </Sheet>
      ) : null}
    </section>
  );
}

function MakeDrawSheet({
  format,
  confirmed,
  busy,
  onClose,
  onSubmit,
}: {
  format: string;
  confirmed: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (b: { groupCount?: number; qualifiersPerGroup?: number; thirdPlace: boolean }) => void;
}) {
  const t = useTranslations('admin.tournaments.draw');
  const id = useId();
  const groups = format === 'GROUPS_KNOCKOUT';
  const [groupCount, setGroupCount] = useState(
    String(Math.max(1, Math.min(4, Math.floor(confirmed / 4) || 1))),
  );
  const [qualifiers, setQualifiers] = useState('2');
  const [thirdPlace, setThirdPlace] = useState(false);

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('makeTitle')}
      size="sm"
    >
      <Sheet.Header title={t('makeTitle')} description={t('makeDescription')} />
      <Sheet.Body className="gap-section grid content-start">
        {groups ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="gap-tight flex flex-col">
              <Label htmlFor={`${id}-groups`}>{t('groupCount')}</Label>
              <Input
                id={`${id}-groups`}
                inputMode="numeric"
                value={groupCount}
                onChange={(e) => setGroupCount(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <div className="gap-tight flex flex-col">
              <Label htmlFor={`${id}-q`}>{t('qualifiers')}</Label>
              <Input
                id={`${id}-q`}
                inputMode="numeric"
                value={qualifiers}
                onChange={(e) => setQualifiers(e.target.value.replace(/\D/g, ''))}
              />
            </div>
          </div>
        ) : null}
        {format !== 'ROUND_ROBIN' ? (
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`${id}-third`}>{t('thirdPlace')}</Label>
            <Switch id={`${id}-third`} checked={thirdPlace} onCheckedChange={setThirdPlace} />
          </div>
        ) : null}
        <Caption>{t('makeHint')}</Caption>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            loading={busy}
            disabled={busy}
            onClick={() =>
              onSubmit({
                ...(groups
                  ? { groupCount: Number(groupCount), qualifiersPerGroup: Number(qualifiers) }
                  : {}),
                thirdPlace,
              })
            }
            data-testid="admin-draw-confirm"
          >
            {t('make')}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
        </div>
      </Sheet.Body>
    </Sheet>
  );
}

function ScheduleSheet({
  match,
  courts,
  names,
  busy,
  onClose,
  onSubmit,
}: {
  match: DrawMatchDto;
  courts: Court[];
  names: [string, string];
  busy: boolean;
  onClose: () => void;
  onSubmit: (b: { resourceId: string; startTs: string; durationMinutes: number }) => void;
}) {
  const t = useTranslations('admin.tournaments.draw');
  const id = useId();
  const [court, setCourt] = useState(courts[0]?.id ?? '');
  const [startsAt, setStartsAt] = useState('');
  const [duration, setDuration] = useState('90');
  const [problem, setProblem] = useState(false);

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('scheduleTitle')}
      size="sm"
    >
      <Sheet.Header title={t('scheduleTitle')} description={`${names[0]} — ${names[1]}`} />
      <Sheet.Body className="gap-section grid content-start">
        {courts.length > 0 ? (
          <div className="gap-tight flex flex-col">
            <span className="text-content-default text-sm font-medium">{t('court')}</span>
            <ToggleGroup
              options={courts.map((c) => ({ value: c.id, label: c.name }))}
              selected={court}
              selectAction={setCourt}
              ariaLabel={t('court')}
              size="sm"
              className="flex-wrap justify-self-start"
            />
          </div>
        ) : null}
        <div className="gap-tight flex flex-col">
          <Label htmlFor={`${id}-at`}>{t('startsAt')}</Label>
          <Input
            id={`${id}-at`}
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            data-testid="admin-draw-schedule-at"
          />
        </div>
        <div className="gap-tight flex flex-col">
          <Label htmlFor={`${id}-min`}>{t('duration')}</Label>
          <Input
            id={`${id}-min`}
            inputMode="numeric"
            value={duration}
            onChange={(e) => setDuration(e.target.value.replace(/\D/g, ''))}
          />
        </div>
        {problem ? <InlineNotice variant="error">{t('scheduleProblem')}</InlineNotice> : null}
        <Caption>{match.scheduled ? t('moveHint') : t('scheduleHint')}</Caption>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            loading={busy}
            disabled={busy}
            onClick={() => {
              const minutes = Number(duration);
              if (!court || !startsAt || !Number.isInteger(minutes) || minutes < 15) {
                setProblem(true);
                return;
              }
              setProblem(false);
              onSubmit({
                resourceId: court,
                startTs: new Date(startsAt).toISOString(),
                durationMinutes: minutes,
              });
            }}
            data-testid="admin-draw-schedule-save"
          >
            {t('save')}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
        </div>
      </Sheet.Body>
    </Sheet>
  );
}
