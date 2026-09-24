import { Meilisearch } from 'meilisearch';

/**
 * The Meilisearch client.
 *
 * SERVER-SIDE ONLY. Meilisearch is never exposed to the browser, and the
 * master key never leaves the process.
 *
 * The "obvious" optimisation — let the client query Meilisearch directly with
 * a search-only key — leaks the whole index. Our indexes carry `tenantId`, so
 * a browser with a search key could enumerate every venue, coach and session
 * of every tenant, ignoring RLS entirely. The database's isolation would be
 * intact and the data would be public anyway.
 *
 * So search goes through /api/search, which applies tenant-safe filters.
 */
let client: Meilisearch | undefined;

export function meili(): Meilisearch {
  if (!client) {
    const host = process.env.MEILISEARCH_HOST ?? 'http://localhost:7700';
    const apiKey = process.env.MEILISEARCH_MASTER_KEY;

    if (!apiKey && process.env.NODE_ENV === 'production') {
      // Fail fast, like the encryption key. A production search that silently
      // runs unauthenticated is worse than one that refuses to boot.
      throw new Error('MEILISEARCH_MASTER_KEY is required in production.');
    }

    client = new Meilisearch({ host, apiKey });
  }
  return client;
}

/** Test seam. */
export function __resetMeili(): void {
  client = undefined;
}
