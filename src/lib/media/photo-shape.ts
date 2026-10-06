/**
 * A venue photo as the browser sees it (#366). No imports, so a client
 * component can take one as a prop and render it; `photo-view.ts` builds it
 * on the server.
 */

export interface PhotoVariant {
  width: number;
  url: string;
}

export interface PhotoView {
  id: string;
  alt: string;
  /** The default rendition: 1280 px wide, or the widest below that. */
  url: string;
  /** The largest rendition's size; null only for a pre-P47 row. */
  width: number | null;
  height: number | null;
  /** Every rendition, ascending by width. Empty for a pre-P47 row. */
  variants: PhotoVariant[];
  blurDataUrl: string | null;
}

/** `srcset` for an `<img>`: each rendition with its width descriptor. */
export function srcSetOf(view: PhotoView): string | undefined {
  return view.variants.length > 0
    ? view.variants.map((v) => `${v.url} ${v.width}w`).join(', ')
    : undefined;
}
