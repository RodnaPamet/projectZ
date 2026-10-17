import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';

/**
 * WHICH TRANSLATIONS THE BROWSER GETS (#599).
 *
 * The root layout used to hand `getMessages()`, the whole catalogue, to
 * NextIntlClientProvider. A provider's `messages` are a prop, so every full
 * page load and every refresh carried all of messages/<locale>.json in its RSC
 * payload: 241 KB of Bulgarian by 17 October 2026, up from 100 KB on
 * 8 October, as each module added its strings. On the club diary that took the
 * payload from 282 KB to 423 KB and the phone's first paint from 396 ms to
 * 482 ms (#402's quiet baseline). Most of it no browser ever reads: emails are
 * server-only, the platform's strings are only for the platform, and a server
 * component's `useTranslations` reads the request's catalogue on the server,
 * not this one.
 *
 * Each section's layout wraps its tree in `<ClientMessages section>`, which
 * sends only the namespaces the browser code under it binds with
 * `useTranslations('ns')`. A nested provider's `messages` REPLACE its
 * parent's (use-intl's IntlProvider), so each list is complete for its
 * section, not a delta. The locale, time zone and formats come from the
 * request config, as before (next-intl's server provider fills them in).
 *
 * ═══ WRITTEN DOWN, AND CHECKED ═══
 *
 * The lists are not inferred at run time: which modules run in the browser is
 * the build's knowledge, and the server has no cheap way to ask for it.
 * tests/guardrails/i18n-client-messages.test.ts follows every route file's
 * imports to the browser code it renders, and fails, with the list to paste,
 * when a section's list lacks a namespace or keeps one nothing uses. A lacking
 * namespace would otherwise render its keys in production (next-intl's
 * fallback), with nothing failing.
 */
export const CLIENT_NAMESPACES = {
  /** The root layout's own tree, and the routes no section below claims (/start, /t/{slug}). */
  root: [
    'common',
    'nav',
    'onboarding.kind',
    'onboarding.terms',
    'panels.sessionExpired',
    'panels.viewerChanged',
    'phone.step',
  ],
  /** `(home)`: the landing page, signed out. */
  home: ['common', 'landing.clubs.form', 'nav'],
  /** `(public)`: the venues, sign-in, and a player's own pages. */
  public: [
    'bookingInvite',
    'cities',
    'club',
    'coachLessons',
    'coachProfile',
    'coachVenues',
    'coaches.lesson',
    'coaches.reviews',
    'common',
    'games',
    'invite',
    'login',
    'messaging',
    'myBookings',
    'nav',
    'phone.required',
    'profile',
    'results',
    'sports',
    'tournaments',
    'ui.combobox',
    'venue',
    'venues',
  ],
  /** `/t/{slug}/admin`: the club admin. */
  clubAdmin: [
    'admin.calendar',
    'admin.coaches',
    'admin.courts',
    'admin.payouts',
    'admin.photos',
    'admin.players',
    'admin.pricing',
    'admin.reports',
    'admin.results',
    'admin.staff',
    'admin.tournaments',
    'billing.statement',
    'common',
    'messaging.conversation',
    'messaging.inbox',
    'messaging.report',
    'messaging.start',
    'myBookings.status',
    'nav',
    'notFound',
    'nouns',
    'phone.required',
    'results',
    'sports',
    'tournaments',
    'ui.combobox',
  ],
  /** `/platform`. */
  platform: [
    'billing.statement',
    'common',
    'nav',
    'notFound',
    'nouns',
    'platform.clubs',
    'platform.coaches',
    'platform.contactRequests',
    'platform.fees',
    'platform.moderation',
    'platform.security',
    'platform.stepUp',
    'platform.usage',
    'sports',
    'ui.combobox',
  ],
} as const satisfies Record<string, readonly string[]>;

export type ClientSection = keyof typeof CLIENT_NAMESPACES;

type Messages = Awaited<ReturnType<typeof getMessages>>;

/**
 * The parts of `messages` at these dotted paths, nested as they are. A path
 * the catalogue lacks is skipped, and so is one under a path already taken.
 * The catalogue itself is never written to.
 */
export function pickMessages(messages: Messages, paths: readonly string[]): Messages {
  const out: Record<string, unknown> = {};
  const taken: string[] = [];
  for (const path of [...paths].sort()) {
    if (taken.some((t) => path.startsWith(`${t}.`))) continue;
    const parts = path.split('.');
    let from: unknown = messages;
    for (const p of parts) {
      from =
        from !== null && typeof from === 'object'
          ? (from as Record<string, unknown>)[p]
          : undefined;
    }
    if (from === undefined) continue;
    let to = out;
    for (const p of parts.slice(0, -1)) {
      to = (to[p] ??= {}) as Record<string, unknown>;
    }
    to[parts[parts.length - 1]!] = from;
    taken.push(path);
  }
  return out as Messages;
}

/** One section's provider: the request's locale and config, and only that section's namespaces. */
export async function ClientMessages({
  section,
  children,
}: {
  section: ClientSection;
  children: React.ReactNode;
}) {
  // The locale explicitly, as the root layout always passed it: next-intl's
  // server provider would infer it, but the client build (jsdom, the rendered
  // tests) cannot.
  const [locale, all] = await Promise.all([getLocale(), getMessages()]);
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={pickMessages(all, CLIENT_NAMESPACES[section])}
    >
      {children}
    </NextIntlClientProvider>
  );
}
