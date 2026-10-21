/**
 * @jest-environment node
 */
import { isValidElement } from 'react';

import ReportsPage from '@/app/(app)/t/[slug]/admin/reports/page';
import { PayoutsCard } from '@/components/billing/PayoutsCard';

/**
 * «ОНЛАЙН ПЛАЩАНИЯ» ONLY WHERE STRIPE CAN BE REACHED (#651).
 *
 * The card's one button starts Stripe onboarding. On a server without
 * `STRIPE_SECRET_KEY` (production and staging until the owner adds the keys,
 * #581) that call can only fail, so «Отчети и такса» leaves the card out. The
 * route refuses too (`tests/integration/tenant-gate.test.ts`).
 */

jest.mock('@/lib/auth/page-context', () => ({
  resolveTenantPageContext: jest.fn(async () => ({
    kind: 'ok',
    ctx: { tenantId: 't1', tenantSlug: 'alpha', permissions: ['admin.billing_manage'] },
  })),
}));

jest.mock('@/lib/db/rls-middleware', () => ({
  runInTenantContext: jest.fn((_tenantId: string, fn: (db: unknown) => unknown) =>
    Promise.resolve(fn({})),
  ),
}));

jest.mock('@/app-layer/usecases/club-fees', () => ({
  loadClubStatement: jest.fn(async () => ({ clubSinceMonth: '2026-01' })),
}));

jest.mock('@/app-layer/usecases/connect-onboarding', () => ({
  clubPayoutStatus: jest.fn(async () => ({ connected: false, payoutsEnabled: false })),
}));

jest.mock('@/lib/billing/statement-dto', () => ({ toClubStatementDto: jest.fn(() => ({})) }));

jest.mock('next-intl/server', () => ({
  getTranslations: jest.fn(async () => (key: string) => key),
}));

/** Every element type in a tree the page returned, without rendering it. */
const typesIn = (node: unknown): unknown[] => {
  if (Array.isArray(node)) return node.flatMap(typesIn);
  if (!isValidElement(node)) return [];
  return [node.type, ...typesIn((node.props as { children?: unknown }).children)];
};

const page = async () =>
  typesIn(
    await ReportsPage({
      params: Promise.resolve({ slug: 'alpha' }),
      searchParams: Promise.resolve({}),
    }),
  );

describe('«Отчети и такса» and the Stripe key (#651)', () => {
  const key = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    if (key === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = key;
  });

  it('shows the online payments card on a server with a Stripe key', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'; // pragma: allowlist secret
    expect(await page()).toContain(PayoutsCard);
  });

  it('leaves it out on a server without one: its button could only fail', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(await page()).not.toContain(PayoutsCard);
  });
});
