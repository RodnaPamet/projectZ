/** @jest-environment node */

import { readFileSync } from 'node:fs';

import { NextResponse } from 'next/server';

import { privateUnlessSaid } from '@/app/api/v1/_lib/define-route';

describe('v1 responses are private unless the route says otherwise (#297)', () => {
  it('marks a response with no Cache-Control private, no-store', () => {
    const res = privateUnlessSaid(NextResponse.json({ data: { mine: true } }));
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('keeps a header the route chose', () => {
    const res = privateUnlessSaid(
      NextResponse.json(
        {},
        { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } },
      ),
    );
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('leaves a response with immutable headers alone instead of throwing', () => {
    const redirect = Response.redirect('https://playerz.bg/venues', 302);
    expect(() => privateUnlessSaid(redirect)).not.toThrow();
  });

  it('wraps both the handler path and the error path', () => {
    // A route that bypassed this would be invisible to the tests above.
    const src = readFileSync('src/app/api/v1/_lib/define-route.ts', 'utf8');
    expect(src).toContain('return privateUnlessSaid(await handler(req, ctx));');
    expect(src).toContain('return privateUnlessSaid(NextResponse.json(payload, { status }));');
  });
});
