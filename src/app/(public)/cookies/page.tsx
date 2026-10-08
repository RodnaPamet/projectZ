import { LegalArticle, legalMetadata, loadLegalPage } from '@/components/legal/LegalPage';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';

export async function generateMetadata() {
  return legalMetadata('cookies');
}

/**
 * /cookies (#370): the owner's cookie policy, from
 * content/legal/{bg,en}/cookies.md. A 404 until the text for the page's
 * language is there, and nothing links here until then: the essential-only
 * notice and the footer then point at it (docs/legal-pages.md).
 */
export default async function CookiesPage() {
  const page = await loadLegalPage('cookies');
  return (
    <>
      {/* One crumb, the page itself: the top bar shows it from md. */}
      <PageBreadcrumbs items={[{ label: page.title }]} className="hidden" />
      <LegalArticle page={page} />
    </>
  );
}
