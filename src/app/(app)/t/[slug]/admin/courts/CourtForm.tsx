'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { archiveCourtAction, createCourtAction, updateCourtAction } from './actions';

/**
 * One form for adding a court and for editing one.
 *
 * ═══ WHY THE SAME COMPONENT FOR BOTH ═══
 *
 * The fields are identical and the validation is identical — `courtCreateSchema`
 * and `courtUpdateSchema` differ only in that create also carries `venueId`.
 * Two components would be two places for the booking-window rules to drift out
 * of agreement with the server, and the server is the one that decides.
 *
 * ═══ WHAT THIS DOES NOT VALIDATE ═══
 *
 * Anything. `required` and `type="number"` are conveniences for the person
 * typing; none of it reaches the server, and the action re-parses every field
 * with Zod regardless. The error shown here is the one the server returned, so
 * what the user reads is what actually stopped the write.
 */

export interface CourtFormValues {
  id?: string;
  name: string;
  sport: string;
  surface: string;
  isIndoor: boolean;
  capacity: number;
  basePriceCents: number;
  minBookingMinutes: number;
  maxBookingMinutes: number;
  slotStepMinutes: number;
}

const SPORTS = ['PADEL', 'TENNIS', 'SQUASH', 'BADMINTON', 'FOOTBALL', 'BASKETBALL'] as const;
const SURFACES = [
  'CLAY',
  'HARD',
  'GRASS',
  'ARTIFICIAL_GRASS',
  'CARPET',
  'WOOD',
  'CONCRETE',
] as const;

export function CourtForm({
  slug,
  venues,
  court,
  onDone,
}: {
  slug: string;
  /** Only needed when creating — an edit cannot move a court between sites. */
  venues?: ReadonlyArray<{ id: string; name: string }>;
  court?: CourtFormValues;
  onDone?: () => void;
}) {
  const t = useTranslations('admin.courts');
  const editing = Boolean(court?.id);

  const [state, formAction, pending] = useActionState(
    editing ? updateCourtAction.bind(null, slug, court!.id!) : createCourtAction.bind(null, slug),
    null,
  );

  // A successful submit closes the form. Checked on render rather than in an
  // effect: `state` only changes when the action returns, so there is nothing
  // to synchronise.
  if (state?.ok && onDone) onDone();

  return (
    <form action={formAction} className="border-border-subtle grid gap-4 rounded-lg border p-4">
      {!editing && venues && (
        <div className="grid gap-1.5">
          <Label htmlFor="venueId">{t('field.venue')}</Label>
          <select
            id="venueId"
            name="venueId"
            required
            className="border-border-subtle bg-bg-surface h-10 rounded-md border px-3"
            defaultValue={venues[0]?.id}
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="name">{t('field.name')}</Label>
        <Input id="name" name="name" required maxLength={80} defaultValue={court?.name} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="sport">{t('field.sport')}</Label>
          <select
            id="sport"
            name="sport"
            className="border-border-subtle bg-bg-surface h-10 rounded-md border px-3"
            defaultValue={court?.sport ?? 'PADEL'}
          >
            {SPORTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="surface">{t('field.surface')}</Label>
          <select
            id="surface"
            name="surface"
            className="border-border-subtle bg-bg-surface h-10 rounded-md border px-3"
            defaultValue={court?.surface ?? 'ARTIFICIAL_GRASS'}
          >
            {SURFACES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="capacity">{t('field.capacity')}</Label>
          <Input
            id="capacity"
            name="capacity"
            type="number"
            min={1}
            max={64}
            required
            defaultValue={court?.capacity ?? 4}
          />
        </div>

        <div className="grid gap-1.5">
          {/* Cents, and the label says so — a club typing 24 and getting
              €0.24 is the predictable failure of a field called "price". */}
          <Label htmlFor="basePriceCents">{t('field.basePriceCents')}</Label>
          <Input
            id="basePriceCents"
            name="basePriceCents"
            type="number"
            min={0}
            required
            defaultValue={court?.basePriceCents ?? 2400}
          />
        </div>
      </div>

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="text-content-muted mb-2 text-sm">{t('field.bookingWindow')}</legend>
        {(
          [
            ['minBookingMinutes', court?.minBookingMinutes ?? 60],
            ['maxBookingMinutes', court?.maxBookingMinutes ?? 180],
            ['slotStepMinutes', court?.slotStepMinutes ?? 30],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="grid gap-1.5">
            <Label htmlFor={key}>{t(`field.${key}`)}</Label>
            <Input id={key} name={key} type="number" min={5} required defaultValue={value} />
          </div>
        ))}
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isIndoor" defaultChecked={court?.isIndoor} />
        {t('setting.indoor')}
      </label>

      {state && !state.ok && (
        <p role="alert" className="text-content-error text-sm">
          {state.error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {editing ? t('action.save') : t('action.add')}
        </Button>
        {onDone && (
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('action.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * Archive and reopen.
 *
 * Separate from the form because it is not an edit: it changes availability for
 * everyone, and the confirmation says what it does NOT do — the bookings
 * already on the court survive, and stay cancellable through the ordinary path
 * with its ordinary refund policy. An owner archiving a court mid-season will
 * otherwise expect the diary to clear.
 */
export function ArchiveCourtButton({
  slug,
  courtId,
  archived,
  upcomingBookings,
}: {
  slug: string;
  courtId: string;
  archived: boolean;
  upcomingBookings: number;
}) {
  const t = useTranslations('admin.courts');
  const [busy, setBusy] = useState(false);

  return (
    <Button
      type="button"
      variant="ghost"
      disabled={busy}
      onClick={async () => {
        if (
          !archived &&
          upcomingBookings > 0 &&
          !window.confirm(t('archive.confirm', { count: upcomingBookings }))
        ) {
          return;
        }
        setBusy(true);
        try {
          await archiveCourtAction(slug, courtId, archived);
        } finally {
          setBusy(false);
        }
      }}
    >
      {archived ? t('action.reopen') : t('action.archive')}
    </Button>
  );
}
