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
    expect(owedStep(page('/me/bookings', { search: '?tab=past' }), me(), CURRENT)).toBe(
      `/start/terms?next=${encodeURIComponent('/me/bookings?tab=past')}`,
    );
    // An older version is not this one.
    expect(owedStep(page('/venues'), me('terms=t1;privacy=p1'), CURRENT)).toContain('/start/terms');
    // The router's own fetch of a page is a page too.
    expect(owedStep(page('/games', { accept: '*/*', rsc: true }), me(), CURRENT)).toContain(
      '/start/terms',
    );
  });

  it('lets through an account that has accepted them', () => {
    expect(owedStep(page('/me/bookings'), me(ACCEPTED), CURRENT)).toBeNull();
  });

  it('asks nobody while no version is in force', () => {
    expect(owedStep(page('/me/bookings'), me(), {})).toBeNull();
  });

  it('never holds back a signed-out visitor', () => {
    expect(owedStep(page('/venues'), null, CURRENT)).toBeNull();
    expect(owedStep(page('/venues'), { sub: null }, CURRENT)).toBeNull();
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
    expect(owedStep(page(pathname), me(), CURRENT)).toBeNull();
  });

  it('a path that only starts like a free one is not free', () => {
    expect(owedStep(page('/terms-of-sale'), me(), CURRENT)).toContain('/start/terms');
    expect(owedStep(page('/me/profile-pictures'), me(), CURRENT)).toContain('/start/terms');
    expect(owedStep(page('/me/profile/sessions'), me(), CURRENT)).toBeNull();
  });

  it('only pages are redirected: no write, and nothing that did not ask for HTML', () => {
    expect(owedStep(page('/me/bookings', { method: 'POST' }), me(), CURRENT)).toBeNull();
    expect(owedStep(page('/manifest.webmanifest', { accept: '*/*' }), me(), CURRENT)).toBeNull();
    expect(owedStep(page('/robots.txt', { accept: null }), me(), CURRENT)).toBeNull();
  });
});
