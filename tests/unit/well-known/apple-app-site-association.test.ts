/** @jest-environment node */

import { GET } from '@/app/api/apple-app-site-association/route';
import { checkPublicRoute } from '@/lib/auth/guard';

/** Which playerz.bg links open the iPhone app (playerz-ios#24). */
describe('apple-app-site-association', () => {
  it('names the app and only the links it can open', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as {
      applinks: { details: Array<{ appIDs: string[]; components: Array<Record<string, string>> }> };
    };
    const [detail] = body.applinks.details;
    expect(detail!.appIDs).toEqual(['9423GKWL67.bg.playerz.app']);
    expect(detail!.components.map((c) => c['/'])).toEqual(['/invite/booking/*']);
  });

  it('is public: Apple fetches it signed out', () => {
    expect(checkPublicRoute('/.well-known/apple-app-site-association')).toBe(true);
    expect(checkPublicRoute('/.well-known/anything-else')).toBe(false);
  });
});
