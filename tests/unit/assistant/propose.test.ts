import { proposeDraft } from '@/app-layer/ai/assistant/propose';

describe('a proposal is a draft in the shape of the app’s own create body', () => {
  const base = {
    venueId: 'cvenue1',
    resourceId: 'ccourt1',
    startTs: '2026-11-15T16:00:00.000Z',
    endTs: '2026-11-15T17:00:00.000Z',
  };

  it('booking: venue, court and times', () => {
    expect(proposeDraft('booking', base)).toMatchObject({
      ok: true,
      proposal: { kind: 'booking', draft: base },
    });
  });

  it('game: the booking plus the open game’s fields; a null level is left out', () => {
    const out = proposeDraft('game', { ...base, spots: 2, levelMin: 3, levelMax: null });
    expect(out.proposal).toEqual({ kind: 'game', draft: { ...base, spots: 2, levelMin: 3 } });
  });

  it('refuses anything else in the draft, rather than stripping it', () => {
    expect(proposeDraft('booking', { ...base, totalCents: 1 }).ok).toBe(false);
    expect(proposeDraft('booking', { ...base, notes: 'the model wrote this' }).ok).toBe(false);
  });

  it('refuses a draft the booking route would refuse', () => {
    expect(proposeDraft('booking', { ...base, startTs: 'tomorrow' }).ok).toBe(false);
    expect(proposeDraft('booking', { ...base, endTs: base.startTs }).ok).toBe(false);
    expect(proposeDraft('game', { ...base }).ok).toBe(false); // spots missing
  });
});
