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

/** A league's draw (#591, 44). */
type LeagueDraw = {
  divisions?: string[][];
  divisionCount?: number;
  firstDeadline?: string;
  roundDays?: number;
};

/** The club's divisions by hand: entries by the number typed beside them, 1 by default. */
function byHandDivisions(
  entries: ReadonlyArray<{ id: string }>,
  divisionOf: Record<string, string>,
): string[][] {
  const out = new Map<number, string[]>();
  for (const e of entries) {
    const n = Math.max(1, Number(divisionOf[e.id] ?? '1') || 1);
    out.set(n, [...(out.get(n) ?? []), e.id]);
  }
  return [...out.keys()].sort((a, b) => a - b).map((n) => out.get(n)!);
}

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
    {
      groupCount?: number;
      qualifiersPerGroup?: number;
      thirdPlace: boolean;
      rounds?: number;
      pointsPerMatch?: number;
    } & LeagueDraw,
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
  const walkover = useV1Mutation<{ id: string; winnerSide: 0 | 1 | null }, DrawDto>({
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

  // A league's matches past their round's deadline wait for the club (#591, 58).
  const overdue = draw
    ? [...draw.groups.flatMap((g) => g.matches), ...draw.knockout.flat()].filter((m) => m.overdue)
        .length
    : 0;
  const sideName = (m: DrawMatchDto, i: 0 | 1) =>
    (i === 0 ? [m.sideA, m.sideA2] : [m.sideB, m.sideB2])
      .flatMap((e) => e?.players ?? [])
      .map((p) => p.name ?? tT('unnamed'))
      .join(' / ');

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
        <>
          {overdue > 0 ? (
            <InlineNotice variant="warning" data-testid="admin-draw-overdue">
              {t('overdue', { count: overdue })}
            </InlineNotice>
          ) : null}
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
        </>
      ) : drawn ? null : (
        <Caption>{t('notYet')}</Caption>
      )}

      {making ? (
        <MakeDrawSheet
          format={x.format}
          confirmed={x.confirmed}
          entries={x.entries
            .filter((e) => e.status === 'CONFIRMED')
            .map((e) => ({
              id: e.id,
              name: [e.player, e.partner]
                .filter((p) => !!p)
                .map((p) => p!.name ?? tT('unnamed'))
                .join(' / '),
            }))}
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
            {/* A league match not played by its deadline may be lost by both (#591, 58). */}
            {x.format === 'LEAGUE' ? (
              <Button
                type="button"
                variant="secondary"
                disabled={walkover.isMutating}
                onClick={() =>
                  void run(() => walkover.trigger({ id: walkingOver.id, winnerSide: null })).then(
                    (ok) => {
                      if (ok) setWalkingOver(null);
                    },
                  )
                }
                data-testid="admin-draw-walkover-both"
              >
                {t('lostByBoth')}
              </Button>
            ) : null}
          </Sheet.Body>
        </Sheet>
      ) : null}
    </section>
  );
}

function MakeDrawSheet({
  format,
  confirmed,
  entries,
  busy,
  onClose,
  onSubmit,
}: {
  format: string;
  confirmed: number;
  entries: Array<{ id: string; name: string }>;
  busy: boolean;
  onClose: () => void;
  onSubmit: (
    b: {
      groupCount?: number;
      qualifiersPerGroup?: number;
      thirdPlace: boolean;
      rounds?: number;
      pointsPerMatch?: number;
    } & LeagueDraw,
  ) => void;
}) {
  const t = useTranslations('admin.tournaments.draw');
  const id = useId();
  const groups = format === 'GROUPS_KNOCKOUT';
  // Americano and Mexicano (#590): the rounds (60) and the points a match is played to (56).
  const rotating = format === 'AMERICANO' || format === 'MEXICANO';
  const [rounds, setRounds] = useState(String(Math.max(1, confirmed - 1)));
  const [points, setPoints] = useState('24');
  // A league (#591, 44): divisions by level or by hand, and the rounds' deadlines.
  const league = format === 'LEAGUE';
  const [divisionCount, setDivisionCount] = useState('1');
  const [byHand, setByHand] = useState(false);
  const [divisionOf, setDivisionOf] = useState<Record<string, string>>({});
  const [firstDeadline, setFirstDeadline] = useState('');
  const [roundDays, setRoundDays] = useState('7');
  const [problem, setProblem] = useState(false);
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
        {rotating ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="gap-tight flex flex-col">
              <Label htmlFor={`${id}-rounds`}>{t('rounds')}</Label>
              <Input
                id={`${id}-rounds`}
                inputMode="numeric"
                value={rounds}
                onChange={(e) => setRounds(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <div className="gap-tight flex flex-col">
              <Label htmlFor={`${id}-points`}>{t('pointsPerMatch')}</Label>
              <Input
                id={`${id}-points`}
                inputMode="numeric"
                value={points}
                onChange={(e) => setPoints(e.target.value.replace(/\D/g, ''))}
              />
            </div>
          </div>
        ) : null}
        {league ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="gap-tight flex flex-col">
                <Label htmlFor={`${id}-divisions`}>{t('divisionCount')}</Label>
                <Input
                  id={`${id}-divisions`}
                  inputMode="numeric"
                  value={divisionCount}
                  onChange={(e) => setDivisionCount(e.target.value.replace(/\D/g, ''))}
                  data-testid="admin-draw-divisions"
                />
              </div>
              <div className="gap-tight flex flex-col">
                <span className="text-content-default text-sm font-medium">{t('divisionsBy')}</span>
                <ToggleGroup
                  options={[
                    { value: 'level', label: t('byLevel') },
                    { value: 'hand', label: t('byHand') },
                  ]}
                  selected={byHand ? 'hand' : 'level'}
                  selectAction={(v) => setByHand(v === 'hand')}
                  ariaLabel={t('divisionsBy')}
                  size="sm"
                  className="justify-self-start"
                />
              </div>
            </div>
            {byHand ? (
              <ul className="gap-tight flex flex-col" data-testid="admin-draw-division-list">
                {entries.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">{e.name}</span>
                    <Input
                      aria-label={t('divisionOf', { name: e.name })}
                      inputMode="numeric"
                      className="w-16 shrink-0"
                      value={divisionOf[e.id] ?? '1'}
                      onChange={(ev) =>
                        setDivisionOf((d) => ({ ...d, [e.id]: ev.target.value.replace(/\D/g, '') }))
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="gap-tight flex flex-col">
                <Label htmlFor={`${id}-deadline`}>{t('firstDeadline')}</Label>
                <Input
                  id={`${id}-deadline`}
                  type="date"
                  value={firstDeadline}
                  onChange={(e) => setFirstDeadline(e.target.value)}
                  data-testid="admin-draw-first-deadline"
                />
              </div>
              <div className="gap-tight flex flex-col">
                <Label htmlFor={`${id}-days`}>{t('roundDays')}</Label>
                <Input
                  id={`${id}-days`}
                  inputMode="numeric"
                  value={roundDays}
                  onChange={(e) => setRoundDays(e.target.value.replace(/\D/g, ''))}
                />
              </div>
            </div>
            {problem ? <InlineNotice variant="error">{t('leagueProblem')}</InlineNotice> : null}
          </>
        ) : null}
        {format !== 'ROUND_ROBIN' && format !== 'LEAGUE' && !rotating ? (
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
            onClick={() => {
              if (league && !firstDeadline) {
                setProblem(true);
                return;
              }
              setProblem(false);
              onSubmit({
                ...(groups
                  ? { groupCount: Number(groupCount), qualifiersPerGroup: Number(qualifiers) }
                  : {}),
                ...(rotating ? { rounds: Number(rounds), pointsPerMatch: Number(points) } : {}),
                ...(league
                  ? {
                      ...(byHand
                        ? { divisions: byHandDivisions(entries, divisionOf) }
                        : { divisionCount: Number(divisionCount) }),
                      // The round's deadline is the end of that day.
                      firstDeadline: new Date(`${firstDeadline}T23:59:59`).toISOString(),
                      roundDays: Number(roundDays),
                    }
                  : {}),
                thirdPlace,
              });
            }}
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
