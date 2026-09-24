import { INDEXES } from '@/lib/search/indexes';
import { meili } from '@/lib/search/client';

/**
 * Push index settings. IDEMPOTENT — safe to run on every deploy.
 *
 * Settings live in code, not in a running container's state. Configure
 * Meilisearch by hand and the config exists nowhere reviewable, nowhere in
 * git, and disappears the first time somebody recreates the volume — after
 * which search quietly stops being typo-tolerant and nobody knows why.
 */
async function main() {
  const client = meili();

  for (const def of Object.values(INDEXES)) {
    await client.createIndex(def.uid, { primaryKey: def.primaryKey }).catch(() => {
      // Already exists. Settings are still pushed below.
    });

    const index = client.index(def.uid);

    // 0.62 returns an EnqueuedTaskPromise: `.waitTask()` chains off the call
    // rather than the old `waitForTask(task.taskUid)`, which no longer exists
    // on an index.
    await index
      .updateSettings({
        searchableAttributes: [...def.searchable],
        filterableAttributes: [...def.filterable, '_geo'],
        sortableAttributes: [...def.sortable, '_geo'],
        // Typo tolerance is the point. "padle" must find padel — that is what a
        // user actually types on a phone.
        typoTolerance: { enabled: true, minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 } },
      })
      .waitTask();
    console.log(
      `  ✓ ${def.uid} — ${def.searchable.length} searchable, ${def.filterable.length} filterable`,
    );
  }

  console.log('\nSearch indexes configured.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
