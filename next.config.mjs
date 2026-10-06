import createNextIntlPlugin from 'next-intl/plugin';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next 16 turns typedRoutes ON by default. The ported components build
  // hrefs as plain template strings (`/t/${slug}/dashboard`), which the
  // generated RouteImpl union rejects. Routes don't exist yet anyway —
  // P06 lands them. Revisit once the route tree is real.
  typedRoutes: false,
  // Loaded from node_modules at runtime rather than bundled (#366): the GCS
  // client resolves its own files and protobufs relative to its package, and
  // the runtime image ships the whole node_modules anyway. sharp is on Next's
  // built-in list already.
  serverExternalPackages: ['@google-cloud/storage'],
  experimental: {
    // ═══ THE CLIENT ROUTER CACHE (docs/perf/navigation-policy.md) ═══
    //
    // `dynamic` (default 0): how long the router keeps a dynamic page it
    // NAVIGATED to. At 0 it keeps nothing, so every revisit paid a full round
    // trip (warm phone floor ~200 ms, docs/perf/README.md) and, since T12's
    // loading.tsx, also React's 300 ms Suspense reveal throttle (#290). At 30 s
    // a revisit inside the window renders from memory with no fallback.
    //
    // `static` (default 300): prefetch={true}, router.prefetch and the
    // loading.tsx shells an auto prefetch fetches. 180 s, because the only
    // full-prefetch site is the player tab bar (T20), whose pages revalidate
    // through SWR after paint; admin links never use prefetch={true}, so no
    // admin screen can be up to 180 s old (tests/guardrails/router-cache-policy).
    //
    // A revalidating Server Action or router.refresh() purges all of it
    // (Next 16.3.6 invalidateSegmentCacheEntries bumps one global version), so
    // a write is never followed by a stale screen.
    //
    // `optimizePackageImports: ['motion']` was tried and dropped: First Load JS
    // was identical on every route to the tenth of a KB (Turbopack already
    // tree-shakes motion/react). lucide-react is on Next's default list.
    staleTimes: { dynamic: 30, static: 180 },
  },
};

// Points next-intl at our request config (default lookup path is
// ./i18n/request.ts, which is not where ours lives).
const withNextIntl = createNextIntlPlugin('./src/lib/i18n/request.ts');

export default withNextIntl(nextConfig);
