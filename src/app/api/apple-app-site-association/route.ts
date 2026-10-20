import { NextResponse } from 'next/server';

/**
 * GET /.well-known/apple-app-site-association — which playerz.bg links open
 * the iPhone app (RodnaPamet/playerz-ios#24). Served from here through a
 * rewrite in next.config.mjs (not a redirect, which Apple refuses): the
 * source scans skip dot folders, so an app/.well-known route would be missed.
 *
 * Apple's CDN fetches this when the app is installed, and the app opens a
 * listed link instead of Safari once it declares `applinks:playerz.bg` in its
 * Associated Domains. It must answer 200 with JSON at exactly this path, with
 * no redirect.
 *
 * Only what the app can open: an invite to a booking (#358), which it previews
 * and joins (playerz-ios#14). A link the app would only ignore is left to the
 * web, so it never lands someone in the app with nothing to show. Add a path
 * here when the app learns to open it.
 */
export const dynamic = 'force-static';

/** The Apple team that signs the app, and its bundle id (playerz-ios `project.yml`). */
const APP_ID = '9423GKWL67.bg.playerz.app';

export function GET(): NextResponse {
  return NextResponse.json(
    {
      applinks: {
        details: [
          {
            appIDs: [APP_ID],
            components: [{ '/': '/invite/booking/*', comment: 'An invite to a booking (#358).' }],
          },
        ],
      },
    },
    {
      headers: {
        // Apple's CDN refreshes it on its own schedule; a day is plenty here.
        'cache-control': 'public, max-age=86400',
      },
    },
  );
}
