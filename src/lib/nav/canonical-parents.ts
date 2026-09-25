/**
 * RQ4-4 — Canonical parent resolver.
 *
 * Maps each route in `SUBPAGES` (RQ4-1) to the page the back affordance
 * should fall back to when no in-tab referrer is available (cold load,
 * fresh tab, deep link, history-cleared session).
 *
 * Convention: the canonical parent is the route one structural step up
 * from the subpage in the IA — NOT necessarily the URL parent. A nested
 * subpage like `/vendors/[vendorId]/assessment/[assessmentId]` falls
 * back to `/vendors/[vendorId]` (its parent entity), not `/vendors`,
 * because the user-mental-model parent is the vendor detail page.
 *
 * Patterns are written in the `[param]` form. The resolver normalises a
 * runtime pathname via `normalizePathname` (RQ4-1) before lookup.
 *
 * Labels are CONTEXTUAL — they name the destination ("Back to Risks",
 * "Back to Vendor"). Labels are static i18n-default English; localisation
 * threading is a follow-up — the strings are short and consistent so the
 * upgrade is mechanical.
 */
import { normalizePathname } from './page-segregation';

export interface CanonicalParent {
  /** Pattern relative to `/t/[tenantSlug]` — joined at render time. */
  href: string;
  /** Trailing portion of the affordance label: "Back to <label>". */
  label: string;
}

// ═══ THE MAP IS EMPTY, AND THAT IS THE POINT ═══
//
// It held ~170 lines of inflect-compliance routes — /frameworks/[frameworkKey],
// /access-reviews, /internal-audit, /business-continuity — with labels like
// "NIS2" and "Access reviews". None of those routes exist here, and none of it
// was reachable from any page in this app (#176 traces the chain).
//
// `resolveCanonicalParent` below is KEPT, because the idea is sound and
// playerz.bg will want it: a subpage should know its canonical parent so the
// back affordance goes somewhere predictable rather than wherever the referrer
// happened to be.
//
// Populate this with real playerz routes once the pages exist. Until then it
// resolves nothing, which is honest — an empty map is obviously unfinished,
// whereas a map of the wrong product reads as finished. That misreading is the
// whole reason #176 was filed.
const PARENT_MAP: Record<string, CanonicalParent> = {};

/**
 * Resolve the canonical parent for a runtime pathname. Returns `null` for
 * a route that is not a known subpage (i.e. main pages and unknown routes).
 *
 * `tenantSlug` is used to expand `/t/[tenantSlug]` into the returned href.
 * Dynamic-segment values in the SUBPAGE's pattern (`[riskId]`,
 * `[vendorId]`, etc.) are inherited from the input pathname when the
 * parent references the SAME segment — so
 * `/t/acme/vendors/v1/assessment/a1` → `/t/acme/vendors/v1`, NOT
 * `/t/acme/vendors/[vendorId]`.
 */
export function resolveCanonicalParent(
  pathname: string,
  tenantSlug: string,
): CanonicalParent | null {
  const pattern = normalizePathname(pathname);
  if (!pattern) return null;
  const parent = PARENT_MAP[pattern];
  if (!parent) return null;

  const expandedHref = expandDynamicSegments(parent.href, pattern, pathname);
  return {
    href: `/t/${tenantSlug}${expandedHref}`,
    label: parent.label,
  };
}

/**
 * Substitute `[param]` placeholders in the parent's href with the concrete
 * values from the child's pathname. Only segments that appear in BOTH the
 * child pattern and the parent href are substituted.
 */
function expandDynamicSegments(
  parentHref: string,
  childPattern: string,
  childPathname: string,
): string {
  const childPath = childPathname.replace(/^\/t\/[^/]+/, '');
  const childPatSegs = childPattern.split('/').filter(Boolean);
  const childPathSegs = childPath.split('/').filter(Boolean);
  const dynamicValues = new Map<string, string>();
  for (let i = 0; i < childPatSegs.length; i++) {
    const seg = childPatSegs[i];
    if (seg.startsWith('[') && seg.endsWith(']') && childPathSegs[i]) {
      dynamicValues.set(seg, childPathSegs[i]);
    }
  }
  return parentHref
    .split('/')
    .map((seg) => dynamicValues.get(seg) ?? seg)
    .join('/');
}

export const CANONICAL_PARENT_MAP_INTERNAL = PARENT_MAP;
