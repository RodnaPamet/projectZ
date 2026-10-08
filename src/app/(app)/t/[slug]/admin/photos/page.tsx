import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import {
  loadPhotosScreen,
  MAX_ALT_LENGTH,
  MAX_GALLERY_PHOTOS,
} from '@/app-layer/usecases/venue-photos';
import { clubAdminCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { MAX_UPLOAD_BYTES, MIN_DIMENSION } from '@/lib/media/limits';
import { mediaUploadsEnabled } from '@/lib/media/storage';

import { PhotosBoard, type PhotoLimits } from './PhotosBoard';

const LIMITS: PhotoLimits = {
  maxGallery: MAX_GALLERY_PHOTOS,
  maxMb: MAX_UPLOAD_BYTES / (1024 * 1024),
  maxBytes: MAX_UPLOAD_BYTES,
  maxAlt: MAX_ALT_LENGTH,
  minPx: MIN_DIMENSION,
};

export async function generateMetadata() {
  const t = await getTranslations('admin.photos');
  return { title: t('metaTitle') };
}

/**
 * "Снимки и информация" (#366): each venue's cover and gallery.
 *
 * OWNER and MANAGER (`admin.venue_manage`), checked here as every admin page
 * does (a page GET has no edge permission rule), and again by the upload
 * route and every action. 404 for anyone else, as the courts page explains.
 *
 * Bound with runInTenantContext: the club's own venues and photos, row
 * security doing the work. One query: the venues with their photos.
 *
 * Without media storage configured the photos already stored still show, and
 * the upload controls give way to "Качването на снимки не е настроено".
 */
export default async function PhotosPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok') notFound();
  const { ctx } = result;
  if (!ctx.permissions.includes('admin.venue_manage')) notFound();

  const t = await getTranslations('admin.photos');
  const venues = await runInTenantContext(ctx.tenantId, (db) => loadPhotosScreen(db, ctx.tenantId));
  const enabled = mediaUploadsEnabled();

  const tNav = await getTranslations('common.nav');

  return (
    <section>
      <PageBreadcrumbs items={clubAdminCrumbs(slug, tNav, 'photos')} />
      <header className="mb-section">
        <Heading level={1}>{t('title')}</Heading>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      {!enabled && (
        <InlineNotice variant="info" title={t('notConfigured.title')} className="mb-default">
          {t('notConfigured.description')}
        </InlineNotice>
      )}

      {venues.length === 0 ? (
        <EmptyState title={t('noVenues.title')} description={t('noVenues.description')} />
      ) : (
        <PhotosBoard
          slug={ctx.tenantSlug}
          venues={venues}
          uploadsEnabled={enabled}
          limits={LIMITS}
        />
      )}
    </section>
  );
}
