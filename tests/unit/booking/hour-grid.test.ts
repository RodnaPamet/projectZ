import type { ResourceSlotsDto } from '@/app/api/v1/_lib/dto';
import { hourGrid } from '@/lib/booking/hour-grid';

// 2026-11-14 in Sofia (UTC+2): 09:00 local is 07:00Z.
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 14, h! - 2, m!)).toISOString();
};

function court(slots: { start: string; available: boolean }[]): ResourceSlotsDto {
  return {
    resourceId: 'r1',
    name: 'Корт 1',
    sport: 'TENNIS',
    resourceType: 'COURT',
    currency: 'EUR',
    minBookingMinutes: 60,
    maxBookingMinutes: 120,
    slotStepMinutes: 30,
    slots: slots.map(({ start, available }) => ({
      startTs: at(start),
      endTs: at(start),
      priceCents: 3000,
      available,
      durations: available ? [{ minutes: 60, endTs: at(start), priceCents: 3000 }] : [],
    })),
  } as unknown as ResourceSlotsDto;
}

const NOW = Date.parse(at('08:00'));

describe('hourGrid', () => {
  it('groups starts on the hour by part of the venue day, half hours left out', () => {
    const grid = hourGrid(
      court([
        { start: '09:00', available: true },
        { start: '09:30', available: true },
        { start: '13:00', available: true },
        { start: '18:00', available: true },
      ]),
      60,
      NOW,
      'Europe/Sofia',
    );
    expect(grid.map((g) => g.part)).toEqual(['morning', 'afternoon', 'evening']);
    expect(grid[0]!.cells.map((c) => c.startTs)).toEqual([at('09:00')]);
  });

  it('keeps a taken hour, marked, and drops one already begun', () => {
    const grid = hourGrid(
      court([
        { start: '07:00', available: true },
        { start: '10:00', available: false },
        { start: '11:00', available: true },
      ]),
      60,
      NOW,
      'Europe/Sofia',
    );
    expect(grid).toHaveLength(1);
    expect(grid[0]!.cells.map((c) => c.offer === null)).toEqual([true, false]);
  });
});
