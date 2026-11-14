/**
 * @jest-environment node
 */
import {
  contentFingerprint,
  wasEditedByUser,
  type EventContent,
  type ExistingEvent,
} from '@/lib/google-calendar/api';
import { planSync } from '@/lib/google-calendar/plan';

/**
 * The diff of a player's calendar sync (owner 2026-11-14): what is created,
 * updated, deleted and left alone, and the three reasons an absence is not
 * evidence (the window, a capped schedule, a calendar read back only in part).
 */

const window = { from: new Date('2026-10-15T00:00:00Z'), to: new Date('2027-11-14T00:00:00Z') };

function content(summary: string, start = '2026-11-20T16:00:00.000Z'): EventContent {
  const end = new Date(Date.parse(start) + 3_600_000).toISOString();
  return { summary, start, end, timeZone: 'Europe/Sofia', location: 'Клуб', description: null };
}

/** An event as we wrote it, read back from Google with Google's offset spelling. */
function existing(
  playerzId: string,
  c: EventContent,
  over: Partial<ExistingEvent> = {},
): ExistingEvent {
  const hash = contentFingerprint(c);
  return {
    eventId: `ev-${playerzId}`,
    playerzId,
    writtenHash: hash,
    currentHash: hash,
    start: c.start,
    ...over,
  };
}

const plan = (
  desired: Array<[string, EventContent]>,
  events: ExistingEvent[],
  opts: { scheduleTruncated?: boolean; calendarComplete?: boolean } = {},
) =>
  planSync({
    desired: new Map(desired),
    existing: events,
    window,
    scheduleTruncated: opts.scheduleTruncated ?? false,
    calendarComplete: opts.calendarComplete ?? true,
  });

describe('contentFingerprint', () => {
  it('compares instants, not spellings: Google answers with an offset', () => {
    const a = contentFingerprint({
      summary: 'Игра',
      start: '2026-11-20T16:00:00.000Z',
      end: '2026-11-20T17:00:00.000Z',
    });
    const b = contentFingerprint({
      summary: 'Игра',
      start: '2026-11-20T18:00:00+02:00',
      end: '2026-11-20T19:00:00+02:00',
    });
    expect(a).toBe(b);
  });

  it('to the second: Google keeps no milliseconds', () => {
    const a = contentFingerprint({
      summary: 'x',
      start: '2026-11-20T16:00:00.581Z',
      end: '2026-11-20T17:00:00.999Z',
    });
    const b = contentFingerprint({
      summary: 'x',
      start: '2026-11-20T18:00:00+02:00',
      end: '2026-11-20T19:00:00+02:00',
    });
    expect(a).toBe(b);
  });

  it('changes with the title and with either time, and cannot be fooled by moving a space', () => {
    const base = { summary: 'a b', start: '2026-11-20T16:00:00Z', end: '2026-11-20T17:00:00Z' };
    expect(contentFingerprint({ ...base, summary: 'a  b' })).not.toBe(contentFingerprint(base));
    expect(contentFingerprint({ ...base, end: '2026-11-20T17:30:00Z' })).not.toBe(
      contentFingerprint(base),
    );
    expect(contentFingerprint({ ...base, start: '2026-11-20T16:30:00Z' })).not.toBe(
      contentFingerprint(base),
    );
  });

  it('an event without our fingerprint reads as not edited, so it is not frozen for ever', () => {
    expect(wasEditedByUser({ writtenHash: null, currentHash: 'x' })).toBe(false);
    expect(wasEditedByUser({ writtenHash: 'a', currentHash: 'a' })).toBe(false);
    expect(wasEditedByUser({ writtenHash: 'a', currentHash: 'b' })).toBe(true);
  });
});

describe('planSync', () => {
  it('creates what is missing, leaves what is right, updates what moved', () => {
    const kept = content('Игра · Клуб');
    const moved = content('Урок · Клуб', '2026-11-21T16:00:00.000Z');
    const p = plan(
      [
        ['booking:new', content('Резервация · Клуб')],
        ['booking:kept', kept],
        ['booking:moved', moved],
      ],
      [
        existing('booking:kept', kept),
        existing('booking:moved', content('Урок · Клуб', '2026-11-21T15:00:00.000Z')),
      ],
    );
    expect(p.create.map((c) => c.playerzId)).toEqual(['booking:new']);
    expect(p.update.map((u) => u.playerzId)).toEqual(['booking:moved']);
    expect(p.unchanged).toBe(1);
    expect(p.remove).toEqual([]);
    expect(p.partial).toBe(false);
  });

  it('deletes an event no longer wanted (a cancelled booking) inside the window', () => {
    const p = plan([], [existing('booking:gone', content('Игра'))]);
    expect(p.remove).toEqual(['ev-booking:gone']);
  });

  it('never deletes an event outside the window: it aged out, it was not cancelled', () => {
    const old = content('Игра', '2026-09-01T16:00:00.000Z');
    const far = content('Игра', '2028-01-01T16:00:00.000Z');
    const p = plan([], [existing('booking:old', old), existing('booking:far', far)]);
    expect(p.remove).toEqual([]);
  });

  it('a capped schedule deletes nothing and says partial, but still creates and updates', () => {
    const p = plan(
      [['booking:new', content('Игра')]],
      [existing('booking:gone', content('Игра'))],
      { scheduleTruncated: true },
    );
    expect(p.remove).toEqual([]);
    expect(p.create).toHaveLength(1);
    expect(p.partial).toBe(true);
  });

  it('a calendar read only in part neither deletes nor creates (it would duplicate)', () => {
    const p = plan(
      [['booking:new', content('Игра')]],
      [existing('booking:gone', content('Игра'))],
      { calendarComplete: false },
    );
    expect(p.remove).toEqual([]);
    expect(p.create).toEqual([]);
    expect(p.partial).toBe(true);
  });

  it('an event the person edited is neither updated nor deleted', () => {
    const c = content('Игра');
    const edited = existing('booking:x', c, {
      currentHash: contentFingerprint({ ...c, summary: 'Моят мач' }),
    });
    const editedGone = { ...edited, eventId: 'ev-y', playerzId: 'booking:y' };
    const p = plan(
      [['booking:x', content('Игра', '2026-11-20T17:00:00.000Z')]],
      [edited, editedGone],
    );
    expect(p.update).toEqual([]);
    expect(p.remove).toEqual([]);
    expect(p.skippedEdited).toBe(2);
  });

  it('a second event for the same id (a lost create answer) is removed, the first kept', () => {
    const c = content('Игра');
    const p = plan(
      [['booking:x', c]],
      [existing('booking:x', c), { ...existing('booking:x', c), eventId: 'dup' }],
    );
    expect(p.unchanged).toBe(1);
    expect(p.remove).toEqual(['dup']);
  });

  it('ignores nothing it does not own: only events carrying our id reach the plan', () => {
    // listEvents drops events without `playerzId`; the plan never sees them.
    const p = plan([], []);
    expect(p).toEqual({
      create: [],
      update: [],
      remove: [],
      unchanged: 0,
      skippedEdited: 0,
      partial: false,
    });
  });
});
