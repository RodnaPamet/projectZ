import { LegalArticle, legalMetadata, loadLegalPage } from '@/components/legal/LegalPage';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';

export async function generateMetadata() {
  return legalMetadata('privacy');
}

/**
 * /privacy (#370): the owner's privacy policy, from
 * content/legal/{bg,en}/privacy.md. A 404 until the text for the page's
 * language is there, and nothing links here until then (docs/legal-pages.md).
 */
export default async function PrivacyPage() {
  const page = await loadLegalPage('privacy');
  return (
    <>
      {/* One crumb, the page itself: the top bar shows it from md. */}
      <PageBreadcrumbs items={[{ label: page.title }]} className="hidden" />
      <LegalArticle page={page} />
    </>
  );
}
