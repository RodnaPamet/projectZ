'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRef, useState, type ReactNode } from 'react';

import type { toMyCoachProfile } from '@/app/api/v1/_lib/coach-dto';
import { ProfileSection } from '@/components/profile/ProfileSection';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Checkbox } from '@/components/ui/checkbox';
import { FormField } from '@/components/ui/form-field';
import { CloudUpload } from '@/components/ui/icons/nucleo';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption, Heading } from '@/components/ui/typography';
import { cn } from '@/lib/cn';
import {
  CERTIFICATE_MAX_BYTES,
  CERTIFICATE_TYPES,
  certificateSize,
} from '@/lib/coaches/certificate-limits';
import {
  COACH_BIO_MAX,
  COACH_BIO_MIN,
  COACH_QUALIFICATIONS_MAX,
  COACH_SPORTS,
  missingForSubmission,
} from '@/lib/coaches/profile';
import { isApiClientError } from '@/lib/data/errors';
import { V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { MAX_SPORT_LEVEL, MIN_SPORT_LEVEL, SPORT_LEVELS } from '@/lib/profile/limits';

/** The profile as `GET /api/v1/me/coach-profile` answers. */
export type CoachProfileView = ReturnType<typeof toMyCoachProfile>;

type Picks = Record<string, { levelMin: number; levelMax: number }>;

/** The levels a newly ticked sport starts with: everyone. */
const ALL_LEVELS = { levelMin: MIN_SPORT_LEVEL, levelMax: MAX_SPORT_LEVEL };

const picksOf = (p: CoachProfileView): Picks =>
  Object.fromEntries(
    p.sports.map((s) => [s.sport, { levelMin: s.levelMin, levelMax: s.levelMax }]),
  );

/** The picks in the catalogue's order, as `PUT /me/coach-profile` takes them. */
export function picksToCoachSports(picks: Picks) {
  return COACH_SPORTS.filter((s) => picks[s] !== undefined).map((sport) => ({
    sport,
    ...picks[sport]!,
  }));
}

const ERRORS = new Set([
  'COACH_PROFILE_LOCKED',
  'COACH_PROFILE_INCOMPLETE',
  'COACH_PROFILE_NOT_SUBMITTED',
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'NETWORK',
]);
const REFUSALS = new Set(['EMPTY', 'TOO_LARGE', 'NOT_A_CERTIFICATE']);

/** Which sentence under `coachProfile.error` says what went wrong. */
export function coachErrorKey(e: unknown): string {
  if (!isApiClientError(e)) return 'UNKNOWN';
  if (e.code === 'CERTIFICATE_REFUSED') {
    const reason = (e.details as { reason?: unknown } | undefined)?.reason;
    return typeof reason === 'string' && REFUSALS.has(reason) ? reason : 'NOT_A_CERTIFICATE';
  }
  return ERRORS.has(e.code) ? e.code : 'UNKNOWN';
}

const MB = Math.round(CERTIFICATE_MAX_BYTES / (1024 * 1024));
const ACCEPT = Object.keys(CERTIFICATE_TYPES).join(',');
const TIME_ZONE = 'Europe/Sofia';

/**
 * A coach's own profile (#545; owner decision 13): what they teach, their
 * qualifications, one certificate, and sending it all for approval.
 *
 * One page, top to bottom, in the order it is filled in. What the state the
 * profile is in allows comes from the server with every answer (`canEdit`,
 * `missing`), and the server decides again on every write; this only shows
 * it. Each write answers with the whole profile, which replaces what is on
 * screen, so the page never guesses what a write did.
 *
 * "Send for approval" saves first when something was changed: nobody sends a
 * text other than the one they are looking at.
 */
export function CoachProfileEditor({
  seed,
  children,
}: {
  seed: CoachProfileView;
  /** What follows the profile on the page: the coach's clubs and days off (#546). */
  children?: ReactNode;
}) {
  const t = useTranslations('coachProfile');
  const tSports = useTranslations('sports');
  const format = useFormatter();

  const [profile, setProfile] = useState(seed);
  const [bio, setBio] = useState(seed.bio ?? '');
  const [qualifications, setQualifications] = useState(seed.qualifications ?? '');
  const [picks, setPicks] = useState<Picks>(() => picksOf(seed));
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'saved' | 'submitted' | 'withdrawn' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = useV1Mutation<void, CoachProfileView>({
    url: () => V1.coachProfile(),
    method: 'PUT',
    body: () => ({
      bio,
      qualifications,
      sports: picksToCoachSports(picks),
    }),
  });
  const upload = useV1Mutation<FormData, CoachProfileView>({
    url: () => V1.coachCertificate(),
    method: 'PUT',
    body: (form) => form,
  });
  const removeFile = useV1Mutation<void, CoachProfileView>({
    url: () => V1.coachCertificate(),
    method: 'DELETE',
  });
  const submit = useV1Mutation<void, CoachProfileView>({ url: () => V1.submitCoachProfile() });
  const withdraw = useV1Mutation<void, CoachProfileView>({ url: () => V1.withdrawCoachProfile() });

  const busy =
    save.isMutating ||
    upload.isMutating ||
    removeFile.isMutating ||
    submit.isMutating ||
    withdraw.isMutating;

  const canText = profile.canEdit.text;
  const canFile = profile.canEdit.certificate;
  const dirty =
    bio.trim() !== (profile.bio ?? '') ||
    qualifications.trim() !== (profile.qualifications ?? '') ||
    JSON.stringify(picksToCoachSports(picks)) !== JSON.stringify(profile.sports);
  const canSubmit =
    profile.state === 'NONE' || profile.state === 'DRAFT' || profile.state === 'DECLINED';
  // What it still needs, from what is ON SCREEN: a text typed and a sport
  // ticked count before they are saved, because "send" saves them first. The
  // same rule the server applies (`missingForSubmission`), and the server
  // applies it again.
  const missing = missingForSubmission({
    bio: bio.trim() || null,
    sports: picksToCoachSports(picks),
    hasCertificate: profile.certificate !== null,
  });

  /**
   * Take the server's answer: it is the profile now.
   *
   * The form follows it only after a write that carried the form (a save, and
   * the send or the take-back that follow one), where the answer is the text
   * as stored. A write about the certificate carried none of it, and its
   * answer is the text as LAST SAVED: following it would wipe what the coach
   * has typed since. So those keep the form, which then simply reads as
   * unsaved.
   */
  function settle(next: CoachProfileView, form: 'follow' | 'keep') {
    setProfile(next);
    if (form === 'keep') return;
    setBio(next.bio ?? '');
    setQualifications(next.qualifications ?? '');
    setPicks(picksOf(next));
  }

  async function run(
    what: () => Promise<CoachProfileView | undefined>,
    said: typeof done = null,
    form: 'follow' | 'keep' = 'follow',
  ) {
    setError(null);
    setDone(null);
    try {
      const next = await what();
      if (next) settle(next, form);
      setDone(said);
      return true;
    } catch (e) {
      setError(coachErrorKey(e));
      return false;
    }
  }

  async function onUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    // Said here without a round trip; the server checks again.
    if (file.size > CERTIFICATE_MAX_BYTES) {
      setDone(null);
      setError('TOO_LARGE');
      return;
    }
    const form = new FormData();
    form.set('file', file);
    if (await run(() => upload.trigger(form), null, 'keep')) {
      setFileName(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function onSubmit() {
    if (dirty && !(await run(() => save.trigger()))) return;
    await run(() => submit.trigger(), 'submitted');
  }

  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'long', timeZone: TIME_ZONE });
  const size = (bytes: number) => {
    const { value, unit } = certificateSize(bytes);
    return `${format.number(value, { maximumFractionDigits: 1 })} ${unit}`;
  };

  const noticeVariant =
    profile.state === 'APPROVED' ? 'success' : profile.state === 'DECLINED' ? 'warning' : 'info';

  return (
    <div
      className="gap-section in-shell:p-0 mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6 md:px-6 md:py-10"
      data-testid="coach-profile"
      data-state={profile.state}
    >
      <header className="gap-tight flex flex-col">
        <Heading level={1}>{t('title')}</Heading>
        {/* How it works, while there is still something to send. */}
        {canSubmit ? <Caption>{t('intro')}</Caption> : null}
      </header>

      <InlineNotice
        variant={noticeVariant}
        title={t(`state.${profile.state}.title`)}
        data-testid="coach-profile-state"
      >
        {t(`state.${profile.state}.body`, {
          date: profile.submittedAt ? date(profile.submittedAt) : '',
        })}
        {profile.decisionNote ? (
          <span className="mt-2 block" data-testid="coach-profile-note">
            <span className="block font-medium">{t('note')}</span>
            <span className="block whitespace-pre-wrap">{profile.decisionNote}</span>
          </span>
        ) : null}
      </InlineNotice>

      <ProfileSection title={t('about.title')} testId="coach-profile-about">
        <div className="gap-compact grid px-4 py-3">
          <FormField
            label={t('about.bio')}
            description={t('about.bioHint', { count: bio.length, max: COACH_BIO_MAX })}
          >
            <Textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={COACH_BIO_MAX}
              rows={6}
              disabled={!canText}
              data-testid="coach-profile-bio"
            />
          </FormField>
          <FormField label={t('about.qualifications')} description={t('about.qualificationsHint')}>
            <Textarea
              value={qualifications}
              onChange={(e) => setQualifications(e.target.value)}
              maxLength={COACH_QUALIFICATIONS_MAX}
              rows={3}
              disabled={!canText}
              data-testid="coach-profile-qualifications"
            />
          </FormField>
        </div>
      </ProfileSection>

      <ProfileSection title={t('sports.title')} testId="coach-profile-sports">
        <Caption className="px-4 py-2">{t('sports.hint')}</Caption>
        <ul className="divide-border-subtle divide-y">
          {COACH_SPORTS.map((sport) => {
            const pick = picks[sport];
            const id = `coach-sport-${sport}`;
            const name = tSports(sport as never);
            const options = SPORT_LEVELS.map((n) => ({ value: String(n), label: String(n) }));
            return (
              <li key={sport} className="px-4 py-2" data-testid={id}>
                <div className="flex min-h-11 items-center gap-3">
                  <Checkbox
                    id={id}
                    checked={pick !== undefined}
                    disabled={!canText}
                    onCheckedChange={(v) =>
                      setPicks(({ [sport]: _gone, ...rest }) =>
                        v === true ? { ...rest, [sport]: ALL_LEVELS } : rest,
                      )
                    }
                  />
                  <Label htmlFor={id} className="flex-1 cursor-pointer">
                    {name}
                  </Label>
                  {pick ? (
                    <Caption data-testid={`${id}-range`}>
                      {pick.levelMin === pick.levelMax
                        ? t('sports.one', { level: pick.levelMin })
                        : t('sports.range', { min: pick.levelMin, max: pick.levelMax })}
                    </Caption>
                  ) : null}
                </div>
                {pick && canText ? (
                  <div className="gap-tight mt-1 grid pl-8">
                    <Caption>{t('sports.from')}</Caption>
                    <ToggleGroup
                      size="sm"
                      ariaLabel={t('sports.fromLabel', { sport: name })}
                      options={options}
                      selected={String(pick.levelMin)}
                      // Moving the bottom above the top takes the top with it.
                      selectAction={(v) =>
                        setPicks((p) => ({
                          ...p,
                          [sport]: {
                            levelMin: Number(v),
                            levelMax: Math.max(Number(v), pick.levelMax),
                          },
                        }))
                      }
                      className="self-start justify-self-start"
                      optionClassName="min-h-11 min-w-9 justify-center"
                    />
                    <Caption>{t('sports.to')}</Caption>
                    <ToggleGroup
                      size="sm"
                      ariaLabel={t('sports.toLabel', { sport: name })}
                      options={options}
                      selected={String(pick.levelMax)}
                      selectAction={(v) =>
                        setPicks((p) => ({
                          ...p,
                          [sport]: {
                            levelMin: Math.min(Number(v), pick.levelMin),
                            levelMax: Number(v),
                          },
                        }))
                      }
                      className="self-start justify-self-start"
                      optionClassName="min-h-11 min-w-9 justify-center"
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </ProfileSection>

      <ProfileSection title={t('certificate.title')} testId="coach-profile-certificate">
        <div className="gap-compact grid px-4 py-3">
          <Caption>{t('certificate.hint', { mb: MB })}</Caption>
          <p className="text-content-default text-sm" data-testid="coach-profile-certificate-file">
            {profile.certificate
              ? t('certificate.uploaded', {
                  name: profile.certificate.fileName,
                  size: size(profile.certificate.byteSize),
                  date: date(profile.certificate.uploadedAt),
                })
              : t('certificate.none')}
          </p>
          {canFile ? (
            <div className="gap-compact flex flex-wrap items-center">
              <label
                htmlFor="coach-certificate-file"
                className={cn(
                  buttonVariants({ variant: 'secondary' }),
                  'cursor-pointer focus-within:ring-2',
                )}
              >
                <CloudUpload aria-hidden="true" />
                {profile.certificate ? t('certificate.replace') : t('certificate.choose')}
                <input
                  ref={fileRef}
                  id="coach-certificate-file"
                  type="file"
                  accept={ACCEPT}
                  className="sr-only"
                  data-testid="coach-profile-certificate-input"
                  onChange={(e) => setFileName(e.currentTarget.files?.[0]?.name ?? null)}
                />
              </label>
              {fileName ? (
                <>
                  <Caption className="min-w-0 truncate">
                    {t('certificate.chosen', { name: fileName })}
                  </Caption>
                  <Button
                    type="button"
                    loading={upload.isMutating}
                    disabled={busy}
                    onClick={() => void onUpload()}
                    data-testid="coach-profile-certificate-upload"
                  >
                    {t('certificate.upload')}
                  </Button>
                </>
              ) : profile.certificate ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void run(() => removeFile.trigger(), null, 'keep')}
                  data-testid="coach-profile-certificate-remove"
                >
                  {t('certificate.remove')}
                </Button>
              ) : null}
            </div>
          ) : (
            <Caption data-testid="coach-profile-certificate-locked">
              {profile.state === 'APPROVED'
                ? t('certificate.lockedApproved')
                : t('certificate.lockedSubmitted')}
            </Caption>
          )}
        </div>
      </ProfileSection>

      {canSubmit && missing.length > 0 ? (
        <div data-testid="coach-profile-missing">
          <Caption>{t('missing.title')}</Caption>
          <ul className="text-content-muted list-disc pl-5 text-sm">
            {missing.map((m) => (
              <li key={m}>{t(`missing.${m}`, { min: COACH_BIO_MIN })}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? (
        <InlineNotice variant="error" data-testid="coach-profile-error">
          {/* Every sentence takes `mb`; only the size one uses it. */}
          {t(`error.${error}` as 'error.TOO_LARGE', { mb: MB })}
        </InlineNotice>
      ) : null}
      {done ? (
        <p role="status" className="text-content-muted text-sm" data-testid="coach-profile-done">
          {done === 'saved' ? t('saved') : done === 'submitted' ? t('submitted') : t('withdrawn')}
        </p>
      ) : null}

      <div className="gap-tight flex flex-wrap">
        {canText ? (
          <Button
            type="button"
            variant={canSubmit ? 'secondary' : 'primary'}
            loading={save.isMutating}
            disabled={busy || !dirty}
            onClick={() => void run(() => save.trigger(), 'saved')}
            data-testid="coach-profile-save"
          >
            {t('save')}
          </Button>
        ) : null}
        {canSubmit ? (
          <Button
            type="button"
            loading={submit.isMutating}
            disabled={busy}
            onClick={() => void onSubmit()}
            data-testid="coach-profile-submit"
          >
            {t('submit')}
          </Button>
        ) : null}
        {profile.state === 'SUBMITTED' ? (
          <Button
            type="button"
            variant="secondary"
            loading={withdraw.isMutating}
            disabled={busy}
            onClick={() => void run(() => withdraw.trigger(), 'withdrawn')}
            data-testid="coach-profile-withdraw"
          >
            {t('withdraw')}
          </Button>
        ) : null}
      </div>

      {children}
    </div>
  );
}
