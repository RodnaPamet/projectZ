'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { MeDto } from '@/app/api/v1/_lib/dto';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption } from '@/components/ui/typography';
import { PROFILE_SPORTS, SPORT_LEVELS } from '@/lib/profile/limits';

import { PROFILE_ROW, ProfileSection } from './ProfileSection';
import { useAccount } from './use-account';

type Picks = Record<string, number>;

/** The level a newly ticked sport starts at: the middle, which the player then moves. */
export const DEFAULT_LEVEL = 3;

/** The picks, in the catalogue's order, as `PATCH /me` takes them. */
export function picksToSports(picks: Picks): Array<{ sport: string; level: number }> {
  return PROFILE_SPORTS.filter((s) => picks[s] !== undefined).map((sport) => ({
    sport,
    level: picks[sport]!,
  }));
}

/**
 * "Спортове и ниво" on /me/profile (#359, Q37): the sports a player plays,
 * each with a level they declare themselves, 1 ("току-що започвам") to 7
 * ("състезател"). Rankings (#378) take over from this as the starting point.
 *
 * The section lists what is set; "Промени" opens a sheet with every sport in
 * the catalogue (`PROFILE_SPORTS`, the registry's bookable sports). Ticking a
 * sport shows its 1–7 toggle and, under it, what the chosen level means in
 * words, so a 4 is a sentence and not a guess. Save sends the whole list
 * (`PATCH /api/v1/me`), which replaces it: a sport unticked is a sport the
 * player no longer plays.
 *
 * For a player account. A CLUB account does not play (#263); the page does
 * not render this section for one, and the API refuses it anyway.
 */
export function SportLevelsSection({ seed }: { seed: MeDto }) {
  const t = useTranslations('profile.sports');
  const tSports = useTranslations('sports');
  const { account, save } = useAccount(seed);
  const [open, setOpen] = useState(false);
  const [picks, setPicks] = useState<Picks>({});
  const [failed, setFailed] = useState(false);

  function edit() {
    setPicks(Object.fromEntries(account.sports.map((s) => [s.sport, s.level])));
    setOpen(true);
  }

  function toggle(sport: string, on: boolean) {
    setPicks(({ [sport]: _gone, ...rest }) => (on ? { ...rest, [sport]: DEFAULT_LEVEL } : rest));
  }

  async function submit() {
    setFailed(false);
    setOpen(false);
    try {
      await save.trigger({ sports: picksToSports(picks) });
    } catch {
      setFailed(true);
    }
  }

  return (
    <>
      <ProfileSection title={t('title')} testId="profile-sports">
        {account.sports.length === 0 ? (
          <div className={PROFILE_ROW}>
            <span className="text-content-muted text-sm">{t('none')}</span>
          </div>
        ) : (
          account.sports.map((s) => (
            <div key={s.sport} className={PROFILE_ROW} data-testid={`profile-sport-${s.sport}`}>
              <span className="text-content-default text-sm font-medium">
                {tSports(s.sport as never)}
              </span>
              <span className="min-w-0 text-right">
                <span className="text-content-default block text-sm">
                  {t('levelShort', { level: s.level })}
                </span>
                <Caption className="block">{t(`level.${s.level}` as never)}</Caption>
              </span>
            </div>
          ))
        )}
        <div className="px-4 py-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={edit}
            data-testid="profile-sports-edit"
          >
            {account.sports.length === 0 ? t('pick') : t('edit')}
          </Button>
        </div>
      </ProfileSection>

      {failed ? (
        <InlineNotice variant="error" data-testid="profile-sports-failed">
          {t('failed')}
        </InlineNotice>
      ) : null}

      <Sheet open={open} onOpenChange={setOpen} title={t('sheetTitle')} size="sm">
        <Sheet.Header title={t('sheetTitle')} description={t('sheetDescription')} />
        <Sheet.Body className="gap-compact grid content-start">
          <ul className="divide-border-subtle divide-y">
            {PROFILE_SPORTS.map((sport) => {
              const level = picks[sport];
              const id = `profile-sport-pick-${sport}`;
              return (
                <li key={sport} className="py-2" data-testid={id}>
                  <div className="flex min-h-11 items-center gap-3">
                    <Checkbox
                      id={id}
                      checked={level !== undefined}
                      onCheckedChange={(v) => toggle(sport, v === true)}
                    />
                    <Label htmlFor={id} className="flex-1 cursor-pointer">
                      {tSports(sport as never)}
                    </Label>
                  </div>
                  {level !== undefined ? (
                    <div className="gap-tight mt-1 grid pl-8">
                      <ToggleGroup
                        size="sm"
                        ariaLabel={t('levelLabel', { sport: tSports(sport as never) })}
                        options={SPORT_LEVELS.map((n) => ({ value: String(n), label: String(n) }))}
                        selected={String(level)}
                        selectAction={(v) => setPicks((p) => ({ ...p, [sport]: Number(v) }))}
                        className="self-start justify-self-start"
                        optionClassName="min-h-11 min-w-9 justify-center"
                      />
                      <Caption data-testid={`${id}-meaning`}>
                        {t('levelShort', { level })} · {t(`level.${level}` as never)}
                      </Caption>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="gap-tight flex">
            <Button type="button" onClick={() => void submit()} data-testid="profile-sports-save">
              {t('save')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
        </Sheet.Body>
      </Sheet>
    </>
  );
}
