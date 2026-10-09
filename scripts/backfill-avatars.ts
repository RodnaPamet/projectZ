import { parseArgs } from 'node:util';

import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { avatarSourceOf, isAvatarKey, ownAvatar } from '@/lib/media/avatar-url';
import { copyFailureOf, copyProviderPicture } from '@/lib/media/avatars';
import { getMediaStorage } from '@/lib/media/storage';

import { assertOwnerRole, die, ownerConnection } from './lib/onboarding-common';

/**
 * Copy the profile pictures stored before #458 into our media storage.
 *
 * Since #458 sign-in keeps its own copy of a Google or Facebook picture and
 * stores the copy's key. Accounts that signed in before it still hold the
 * provider's URL, which pages no longer show (the initials stand in, so no
 * viewer's IP address reaches Google or Meta). This copies each one, as a
 * sign-in would: fetched from the provider, resized, re-encoded with no
 * metadata, stored under `avatars/{userId}/`. docs/platform-admin-runbook.md,
 * "Copying the profile pictures (#458)", is the procedure.
 *
 * ═══ A DRY RUN UNLESS TOLD OTHERWISE ═══
 *
 * Without `--confirm` it counts the accounts holding a provider's URL, by
 * provider, and writes and fetches nothing. With `--confirm` it copies them,
 * one at a time.
 *
 * ═══ WHAT IT WRITES ═══
 *
 * The copy's key, only over the URL it read: an account that signed in
 * meanwhile keeps what that sign-in saved. A picture that cannot be copied
 * (Facebook's URLs expire within weeks) is cleared instead: the initials show,
 * and the person's next sign-in copies a fresh one. Either way no stored
 * picture points at Google or Meta afterwards. Safe to run again: an account
 * already copied is not read.
 *
 * Needs DIRECT_DATABASE_URL (the owner connection), like the other operator
 * scripts, and the media settings the app has (MEDIA_STORAGE, GCS_BUCKET,
 * GCS_CREDENTIALS_BASE64).
 */

const USAGE =
  'Usage: npm run backfill:avatars -- [--confirm]\n\n' +
  'Without --confirm it is a dry run: it counts the pictures to copy and changes nothing.';

const { values } = parseArgs({
  options: { confirm: { type: 'boolean', default: false }, help: { type: 'boolean' } },
});

async function main(): Promise<void> {
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const storage = getMediaStorage();
  if (!storage) {
    die(
      'Media storage is not configured: MEDIA_STORAGE, GCS_BUCKET and MEDIA_PUBLIC_BASE_URL\n' +
        '(docs/media-storage.md). Run this with the env file the app reads.',
    );
  }
  const prisma = ownerConnection();
  await assertOwnerRole(prisma);

  try {
    const rows = await runAsSuperuser(
      (db) =>
        db.user.findMany({
          where: { deletedAt: null, avatarUrl: { not: null } },
          select: { id: true, avatarUrl: true },
          orderBy: { createdAt: 'asc' },
        }),
      prisma,
    );
    const legacy = rows.filter(
      (r): r is { id: string; avatarUrl: string } => !isAvatarKey(r.avatarUrl),
    );
    const bySource = new Map<string, number>();
    for (const r of legacy) {
      const s = avatarSourceOf(r.avatarUrl) ?? 'neither provider';
      bySource.set(s, (bySource.get(s) ?? 0) + 1);
    }

    console.log(
      `\n${rows.length} account(s) have a picture; ${rows.length - legacy.length} are copies already, ` +
        `${legacy.length} hold a provider's URL:`,
    );
    for (const [s, n] of bySource) console.log(`  ${s.padEnd(16)}  ${n}`);

    if (!values.confirm) {
      console.log(
        '\nDRY RUN: nothing was fetched or written. To copy them:\n\n' +
          '  npm run backfill:avatars -- --confirm\n',
      );
      return;
    }

    let copied = 0;
    let cleared = 0;
    let skipped = 0;
    const failures = new Map<string, number>();
    for (const r of legacy) {
      const source = avatarSourceOf(r.avatarUrl);
      let key: string | null = null;
      if (source) {
        try {
          key = await copyProviderPicture(storage, { userId: r.id, source, url: r.avatarUrl });
        } catch (error) {
          const why = copyFailureOf(error);
          failures.set(why, (failures.get(why) ?? 0) + 1);
        }
      }
      // Only over the URL read above: a sign-in since then saved its own.
      const { count } = await runAsSuperuser(
        (db) =>
          db.user.updateMany({
            where: { id: r.id, avatarUrl: r.avatarUrl, deletedAt: null },
            data: { avatarUrl: ownAvatar(key) },
          }),
        prisma,
      );
      if (count === 0) skipped += 1;
      else if (key) copied += 1;
      else cleared += 1;
    }

    console.log(
      `\n✓ Copied ${copied}. Cleared ${cleared} that could not be copied (the initials show; ` +
        `the next sign-in copies a fresh one). Left ${skipped} that changed meanwhile.`,
    );
    for (const [why, n] of failures) console.log(`  not copied, ${why.padEnd(10)}  ${n}`);
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
