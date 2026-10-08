import { LegalArticle, legalMetadata, loadLegalPage } from '@/components/legal/LegalPage';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';

export async function generateMetadata() {
  return legalMetadata('terms');
}

/**
 * /terms (#370): the owner's terms of use, from content/legal/{bg,en}/terms.md.
 * A 404 until the text for the page's language is there, and nothing links
 * here until then (docs/legal-pages.md).
 */
export default async function TermsPage() {
  const page = await loadLegalPage('terms');
  return (
    <>
      {/* One crumb, the page itself: the top bar shows it from md. */}
      <PageBreadcrumbs items={[{ label: page.title }]} className="hidden" />
      <LegalArticle page={page} />
    </>
  );
}
