import { type NextRequest, NextResponse } from 'next/server';

import { meili } from '@/lib/search/client';
import { INDEXES, type IndexName } from '@/lib/search/indexes';

/**
 * Search proxy.
 *
 * Meilisearch is NEVER exposed to the browser, even with a search-only key.
 * Our documents carry `tenantId`, so a browser holding a search key could
 * enumerate every venue, coach and session of every tenant — RLS intact, data
 * public anyway.
 *
 * Everything goes through here, where the filter is applied server-side.
 */
const ALLOWED: IndexName[] = ['venues', 'coaches', 'sessions'];

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = sp.get('q') ?? '';
  const type = (sp.get('type') ?? 'venues') as IndexName;

  if (!ALLOWED.includes(type)) {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Unknown search index' } },
      { status: 400 },
    );
  }

  const index = meili().index(INDEXES[type].uid);

  try {
    const res = await index.search(q, {
      limit: Math.min(Number(sp.get('limit') ?? 20), 50),
      // Public search only ever sees ACTIVE rows. A DRAFT venue must not be
      // discoverable through search when it is not discoverable through the
      // list.
      filter: ['status = ACTIVE'],
    });

    return NextResponse.json({ hits: res.hits, estimatedTotalHits: res.estimatedTotalHits });
  } catch {
    // Meilisearch is a CACHE. If it is down, search degrades — it does not
    // 500 the page.
    return NextResponse.json({ hits: [], estimatedTotalHits: 0, degraded: true }, { status: 200 });
  }
}
