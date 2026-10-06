/** The upload limits (#366), without sharp: a page can show them cheaply. image.ts explains each. */

/** The largest upload, in bytes. Under Caddy's and the edge proxy's 10 MB body limits. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** 50 MP: a 48 MP phone photo passes; a declared 10-gigapixel PNG does not. */
export const MAX_INPUT_PIXELS = 50_000_000;
/** Smaller than this is not a photo a venue page can use. */
export const MIN_DIMENSION = 200;
/** The widths each upload is resized to (never upscaled). */
export const RENDITION_WIDTHS = [640, 1280, 1920] as const;
/** The rendition a plain `src` names: sharp enough on a laptop, light on a phone. */
export const DEFAULT_WIDTH = 1280;
