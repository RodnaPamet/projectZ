/** @jest-environment node */

import { NextRequest } from 'next/server';

import { GET } from '@/app/api/v1/config/route';
import { readModules } from '@/lib/modules';

/**
 * GET /api/v1/config (#621): the module switches, for the native app, which
 * cannot read them and would otherwise show a module that is off.
 */
jest.mock('@/lib/modules', () => ({ readModules: jest.fn() }));
const modules = readModules as jest.MockedFunction<typeof readModules>;

const get = async () => {
  const res = await GET(new NextRequest('http://t/api/v1/config'), { params: Promise.resolve({}) });
  return { res, body: await res.json() };
};

describe('GET /api/v1/config (#621)', () => {
  it('answers a caller with no session with the switches as production has them', async () => {
    modules.mockReturnValue({ openPlay: true, messaging: true, coaches: false, ranking: false });
    const { res, body } = await get();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      data: { modules: { openPlay: true, messaging: true, coaches: false, ranking: false } },
    });
  });

  it('follows the switches, so staging shows coaches and ranking', async () => {
    modules.mockReturnValue({ openPlay: true, messaging: true, coaches: true, ranking: true });
    expect((await get()).body.data.modules).toEqual({
      openPlay: true,
      messaging: true,
      coaches: true,
      ranking: true,
    });
  });

  it('is not cached, so a switch shows on the next call after a restart', async () => {
    modules.mockReturnValue({ openPlay: false, messaging: false, coaches: false, ranking: false });
    expect((await get()).res.headers.get('cache-control')).toBe('private, no-store');
  });
});
