/**
 * `refreshDiaryDayAction`: the diary's stale-data refresh (#314).
 *
 * It replaced `router.refresh()`, which purged the whole client router cache.
 * It leaves the cache alone only because it is a pure read: in Next 16.3.6 an
 * action that revalidates a path or tag, or sets a cookie, makes the client
 * evict its caches (server/app-render/action-handler.js
 * `addRevalidationHeader`). So these pin that it revalidates nothing, and that
 * it asks for the same permission as the page it refreshes.
 *
 * The day itself is built by `loadDiaryDay`, against a real database, in
 * tests/integration/admin-diary-day.test.ts.
 */

const revalidatePath = jest.fn();
const revalidateTag = jest.fn();
jest.mock('next/cache', () => ({
  revalidatePath: (...a: unknown[]) => revalidatePath(...a),
  revalidateTag: (...a: unknown[]) => revalidateTag(...a),
}));

jest.mock('next-intl/server', () => ({
  getLocale: async () => 'bg',
  getTranslations: async () => (key: string) => `t:${key}`,
}));

const requireTenantAction = jest.fn();
jest.mock('@/lib/auth/page-context', () => ({
  requireTenantAction: (...a: unknown[]) => requireTenantAction(...a),
}));

const loadDiaryDay = jest.fn();
jest.mock('@/app/(app)/t/[slug]/admin/calendar/diary-day', () => ({
  loadDiaryDay: (...a: unknown[]) => loadDiaryDay(...a),
}));

jest.mock('@/lib/db/rls-middleware', () => ({ runInTenantContext: jest.fn() }));
jest.mock('@/app-layer/usecases/booking-outcome', () => ({
  markNoShow: jest.fn(),
  NoShowRefusedError: class extends Error {},
}));

import { refreshDiaryDayAction } from '@/app/(app)/t/[slug]/admin/calendar/actions';

beforeEach(() => {
  jest.clearAllMocks();
  requireTenantAction.mockResolvedValue({ tenantId: 'tenant-1', userId: 'u1' });
  loadDiaryDay.mockResolvedValue({ isoDay: '2026-09-29', renderedAt: 1 });
});

describe('refreshDiaryDayAction', () => {
  it('returns the day loadDiaryDay builds, for the URL’s day, in the caller’s locale', async () => {
    await expect(refreshDiaryDayAction('sofia', '2026-09-29')).resolves.toEqual({
      isoDay: '2026-09-29',
      renderedAt: 1,
    });
    expect(loadDiaryDay).toHaveBeenCalledWith('tenant-1', '2026-09-29', {
      locale: 'bg',
      labels: { unknownPlayer: 't:unknownPlayer', guest: 't:guest' },
    });
  });

  it('THE POINT: revalidates nothing, so the router cache survives it', async () => {
    await refreshDiaryDayAction('sofia', null);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('needs bookings.view_all, as the diary page does, at the club named', async () => {
    await refreshDiaryDayAction('sofia', null);
    expect(requireTenantAction).toHaveBeenCalledWith('sofia', 'bookings.view_all');
  });

  it('refuses without it, and reads nothing', async () => {
    requireTenantAction.mockRejectedValue(new Error('denied'));
    await expect(refreshDiaryDayAction('sofia', null)).rejects.toThrow('denied');
    expect(loadDiaryDay).not.toHaveBeenCalled();
  });

  it('treats anything but a string day as the club’s today (an action’s arguments come from the client)', async () => {
    await refreshDiaryDayAction('sofia', { evil: true } as unknown as string);
    expect(loadDiaryDay).toHaveBeenCalledWith('tenant-1', null, expect.anything());
  });
});
