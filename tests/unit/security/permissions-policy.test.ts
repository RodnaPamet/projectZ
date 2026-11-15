/**
 * @jest-environment node
 */
import { getSecurityHeaders } from '@/lib/security/headers';

/**
 * WHAT THE BROWSER MAY USE, PINNED (#697).
 *
 * «Близо до мен» asks the browser where the person is. `geolocation=()`
 * refused that on every page before any prompt could show, so near-me could
 * never work. Geolocation is allowed for this origin only; camera, microphone
 * and topics stay off.
 */
describe('Permissions-Policy', () => {
  it.each([true, false])('allows geolocation to this origin only (production: %s)', (prod) => {
    const policy = getSecurityHeaders(prod)['Permissions-Policy'];
    expect(policy).toBe('camera=(), microphone=(), geolocation=(self), browsing-topics=()');
    const directives = Object.fromEntries(
      policy.split(',').map((d) => d.trim().split('=') as [string, string]),
    );
    expect(directives.geolocation).toBe('(self)');
    expect(directives.camera).toBe('()');
    expect(directives.microphone).toBe('()');
    expect(directives['browsing-topics']).toBe('()');
  });
});
