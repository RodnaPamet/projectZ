import { owedStep, type OwedStepRequest } from '@/lib/auth/owed-step';

/**
 * The step a signed-in account owes before anything else (#462): the
 * middleware's question, answered from the token and the versions in force.
 */
const CURRENT = { terms: 't2', privacy: 'p1' };
const ACCEPTED = 'terms=t2;privacy=p1';

const page = (pathname: string, over: Partial<OwedStepRequest> = {}): OwedStepRequest => ({
  pathname,
  search: '',
  method: 'GET',
  accept: 'text/html,application/xhtml+xml',
  rsc: false,
  ...over,
});
const me = (legal?: string) => ({ sub: 'u1', legal });

describe('owedStep', () => {
  it('sends an account that has not accepted the versions in force to the step, with the way back', () => {
    expect(
      owedStep(page('/me/bookings', { search: '?tab=past' }), me(), { current: CURRENT }),
    ).toBe(`/start/terms?next=${encodeURIComponent('/me/bookings?tab=past')}`);
    // An older version is not this one.
    expect(owedStep(page('/venues'), me('terms=t1;privacy=p1'), { current: CURRENT })).toContain(
      '/start/terms',
    );
    // The router's own fetch of a page is a page too.
    expect(
      owedStep(page('/games', { accept: '*/*', rsc: true }), me(), { current: CURRENT }),
    ).toContain('/start/terms');
  });

  it('lets through an account that has accepted them', () => {
    expect(owedStep(page('/me/bookings'), me(ACCEPTED), { current: CURRENT })).toBeNull();
  });

  it('asks nobody while no version is in force', () => {
    expect(owedStep(page('/me/bookings'), me(), { current: {} })).toBeNull();
  });

  it('never holds back a signed-out visitor', () => {
    expect(owedStep(page('/venues'), null, { current: CURRENT })).toBeNull();
    expect(owedStep(page('/venues'), { sub: null }, { current: CURRENT })).toBeNull();
  });

  it.each([
    '/start/terms',
    '/start/kind',
    '/start',
    '/login',
    '/terms',
    '/privacy',
    '/cookies',
    '/delete-account',
    '/me/profile',
    '/offline',
    '/api/v1/me',
    '/api/auth/session',
  ])('%s stays open: the step, the texts, the way out', (pathname) => {
    expect(owedStep(page(pathname), me(), { current: CURRENT })).toBeNull();
  });

  it('a path that only starts like a free one is not free', () => {
    expect(owedStep(page('/terms-of-sale'), me(), { current: CURRENT })).toContain('/start/terms');
    expect(owedStep(page('/me/profile-pictures'), me(), { current: CURRENT })).toContain(
      '/start/terms',
    );
    expect(owedStep(page('/me/profile/sessions'), me(), { current: CURRENT })).toBeNull();
  });

  it('only pages are redirected: no write, and nothing that did not ask for HTML', () => {
    expect(
      owedStep(page('/me/bookings', { method: 'POST' }), me(), { current: CURRENT }),
    ).toBeNull();
    expect(
      owedStep(page('/manifest.webmanifest', { accept: '*/*' }), me(), { current: CURRENT }),
    ).toBeNull();
    expect(owedStep(page('/robots.txt', { accept: null }), me(), { current: CURRENT })).toBeNull();
  });

  describe('the one-time ask for a phone number (#500)', () => {
    const NONE = { current: {} };
    const on = { ...NONE, phoneRequired: true };
    const who = (phone?: string) => ({ sub: 'u1', phone });

    it('a player or coach with no number is sent to the phone step, with the way back', () => {
      expect(owedStep(page('/games', { search: '?tab=mine' }), who('ask'), on)).toBe(
        `/start/phone?next=${encodeURIComponent('/games?tab=mine')}`,
      );
    });

    it('a token from before the claim existed is asked too: the step’s page decides', () => {
      expect(owedStep(page('/venues'), who(undefined), on)).toContain('/start/phone');
      expect(owedStep(page('/venues'), who('something-else'), on)).toContain('/start/phone');
    });

    it('not asked: a confirmed number, an account the rule is not for, or «Не сега»', () => {
      expect(owedStep(page('/venues'), who('ok'), on)).toBeNull();
      expect(owedStep(page('/venues'), who('na'), on)).toBeNull();
      expect(owedStep(page('/venues'), who('ask'), { ...on, phoneLater: true })).toBeNull();
    });

    it('with the rule off nobody is asked', () => {
      expect(owedStep(page('/venues'), who('ask'), NONE)).toBeNull();
      expect(owedStep(page('/venues'), who('ask'), { ...NONE, phoneRequired: false })).toBeNull();
    });

    it('new terms come first, and «Не сега» does not skip them', () => {
      const both = { current: CURRENT, phoneRequired: true, phoneLater: true };
      expect(owedStep(page('/venues'), who('ask'), both)).toContain('/start/terms');
      expect(
        owedStep(
          page('/venues'),
          { sub: 'u1', phone: 'ask', legal: ACCEPTED },
          {
            ...both,
            phoneLater: false,
          },
        ),
      ).toContain('/start/phone');
    });

    it('the same pages stay open, and only pages are redirected', () => {
      for (const free of ['/start/phone', '/start/kind', '/me/profile', '/api/v1/me', '/login'])
        expect(owedStep(page(free), who('ask'), on)).toBeNull();
      expect(owedStep(page('/venues', { method: 'POST' }), who('ask'), on)).toBeNull();
      expect(owedStep(page('/venues'), null, on)).toBeNull();
    });
  });
});
