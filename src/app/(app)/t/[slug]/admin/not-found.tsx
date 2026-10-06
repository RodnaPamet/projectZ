'use client';

import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { ShellNotFound } from '@/components/layout/shell-not-found';

/**
 * A club admin page this role does not reach (audit S01): the app's 404,
 * inside the admin shell rather than in place of it. See `ShellNotFound`.
 *
 * A client component because a `not-found.tsx` is handed no params; the slug
 * comes from the URL. The way on is `/t/{slug}/admin`, which sends the member
 * to the first page their role opens.
 */
export default function ClubAdminNotFound() {
  const t = useTranslations('notFound');
  const params = useParams<{ slug: string }>();
  return <ShellNotFound home={`/t/${params?.slug ?? ''}/admin`} homeLabel={t('backToAdmin')} />;
}
