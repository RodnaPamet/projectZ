import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import {
  listPlayers,
  PLAYER_LIST_LIMIT,
  playersWereTruncated,
} from '@/app-layer/repositories/player';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { PlayersBoard, type PlayerRow } from './PlayersBoard';

export async function generateMetadata() {
  const t = await getTranslations('admin.players');
  return { title: t('metaTitle') };
}

/**
 * The club's players.
 *
 * ═══ TWO PERMISSIONS ON ONE SCREEN ═══
 *
 * `players.view` gets you here — STAFF and COACH hold it. `players.credit_adjust`
 * is OWNER and MANAGER only, and gates the credit form specifically. A coach can
 * see who plays and label them; only a manager moves money.
 *
 * The flag is passed to the client, and the ACTION checks it again. Hiding a
 * form is a courtesy; the action is a POST endpoint reachable without it.
 */
export default async function PlayersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok') notFound();

  const { ctx } = result;
  if (!ctx.permissions.includes('players.view')) notFound();

  const t = await getTranslations('admin.players');

  const players = await runInTenantContext(ctx.tenantId, (db) => listPlayers(db, ctx.tenantId));

  // Dates do not cross the RSC boundary as Date objects usefully — serialise
  // to ISO here and let the client format with the viewer's locale.
  const rows = players.map((p): PlayerRow => ({
    ...p,
    lastPlayedAt: p.lastPlayedAt?.toISOString() ?? null,
  }));

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      {playersWereTruncated(players) && (
        <p className="text-content-muted mb-4 text-sm">
          {t('truncated', { limit: PLAYER_LIST_LIMIT })}
        </p>
      )}

      <PlayersBoard
        slug={slug}
        players={rows}
        canAdjustCredit={ctx.permissions.includes('players.credit_adjust')}
      />
    </section>
  );
}
