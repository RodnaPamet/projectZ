import { getTranslations } from 'next-intl/server';

import { ShellNotFound } from '@/components/layout/shell-not-found';
import { PLATFORM_HREF } from '@/components/layout/nav-items';

/**
 * A platform page this grant does not open: the app's 404, inside the
 * platform shell rather than in place of it (#362, audit S01's platform twin).
 * The way on is `/platform`, which sends the holder to the first page their
 * grant opens.
 */
export default async function PlatformNotFound() {
  const t = await getTranslations('notFound');
  return <ShellNotFound home={PLATFORM_HREF} homeLabel={t('backToPlatform')} />;
}
