import type { ResourceSlotsDto } from '@/app/api/v1/_lib/dto';

/** A free start on one court, offered for one length. */
export interface Offer {
  startTs: string;
  endTs: string;
  minutes: number;
  priceCents: number;
}

/** The lengths a court allows: whole units of its minimum, up to its maximum. */
export function allowedMinutes(
  r: Pick<ResourceSlotsDto, 'minBookingMinutes' | 'maxBookingMinutes'>,
) {
  const out: number[] = [];
  const unit = r.minBookingMinutes;
  if (!(unit > 0)) return out;
  for (let m = unit; m <= (r.maxBookingMinutes ?? unit); m += unit) out.push(m);
  return out;
}

/** The free starts on one court for one length, not yet begun at `now`. */
export function offersFor(r: ResourceSlotsDto, minutes: number, now: number): Offer[] {
  const out: Offer[] = [];
  for (const s of r.slots) {
    if (!s.available || Date.parse(s.startTs) <= now) continue;
    const d = s.durations?.find((x) => x.minutes === minutes);
    if (d) out.push({ startTs: s.startTs, endTs: d.endTs, minutes, priceCents: d.priceCents });
  }
  return out;
}
