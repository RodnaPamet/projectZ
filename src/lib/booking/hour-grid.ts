import type { ResourceSlotsDto } from '@/app/api/v1/_lib/dto';

import { offersFor, type Offer } from './offers';

/** The part of the day an hour starts in: before 12:00, to 17:00, from 17:00. */
export type Daypart = 'morning' | 'afternoon' | 'evening';

/** One cell of the grid: a free start (its offer) or a taken one. */
export type HourCell = { startTs: string; offer: Offer } | { startTs: string; offer: null };

const PARTS: Daypart[] = ['morning', 'afternoon', 'evening'];

/** The hour and minute of `iso` on the venue's clock. */
function clock(iso: string, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: n('hour'), minute: n('minute') };
}

function partOf(hour: number): Daypart {
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

/**
 * A court's hours as the phone shows them (owner 2026-11-13, "Full match with
 * the phone"): starts on the hour only, not yet begun, in the parts of the
 * venue's day; a free one carries its offer for `minutes`, a taken one is
 * kept and marked (`offer: null`) so the grid can say «Заето». A part with
 * no hour is left out.
 */
export function hourGrid(
  r: ResourceSlotsDto,
  minutes: number,
  now: number,
  timeZone: string,
): { part: Daypart; cells: HourCell[] }[] {
  const free = new Map(offersFor(r, minutes, now).map((o) => [o.startTs, o]));
  const cells: (HourCell & { part: Daypart })[] = [];
  for (const s of r.slots) {
    if (Date.parse(s.startTs) <= now) continue;
    const { hour, minute } = clock(s.startTs, timeZone);
    if (minute !== 0) continue;
    const offer = free.get(s.startTs);
    if (offer) cells.push({ startTs: s.startTs, offer, part: partOf(hour) });
    else if (!s.available) cells.push({ startTs: s.startTs, offer: null, part: partOf(hour) });
  }
  cells.sort((a, b) => Date.parse(a.startTs) - Date.parse(b.startTs));
  return PARTS.flatMap((part) => {
    const here = cells.filter((c) => c.part === part).map(({ part: _part, ...c }) => c);
    return here.length ? [{ part, cells: here }] : [];
  });
}
