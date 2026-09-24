import { DEFAULT_LOCALE, resolveLocale, type Locale } from './locales';

/**
 * Translate for an EXPLICIT locale, outside any request scope.
 *
 * ═══ WHY NOT next-intl ═══
 *
 * `getTranslations()` resolves the locale from the REQUEST — our `NEXT_LOCALE`
 * cookie. That is the wrong source here. A notification is addressed to a
 * specific recipient, and the language that matters is their persisted
 * `User.locale`, not the locale of whoever happened to trigger the write. A
 * Stripe webhook has no user, no cookie and no request locale at all.
 *
 * It is also the wrong DEPENDENCY. `next-intl/server` is published behind a
 * `react-server` export condition, and anything that does not set it — Jest's
 * node environment, a worker, a cron process — resolves the client build and
 * gets "`getTranslations` is not supported in Client Components" at runtime.
 * Measured, by writing it that way first.
 *
 * ═══ SCOPE ═══
 *
 * Simple `{name}` placeholders only, NOT ICU plural/select. Notification copy
 * is short and its numbers are formatted by the caller before they arrive. A
 * message that genuinely needs plural rules should be rendered through
 * next-intl at DISPLAY time, where the full formatter is available.
 *
 * Every failure falls back rather than throwing: an unknown key returns the
 * key itself. This is called from a path that has already taken somebody's
 * money, where a wrong-looking string is strictly better than an exception.
 */

type MessageTree = { [key: string]: string | MessageTree };

/** Catalogues are immutable per process — parse each at most once. */
const cache = new Map<Locale, MessageTree>();

async function load(locale: Locale): Promise<MessageTree | null> {
  const hit = cache.get(locale);
  if (hit) return hit;

  try {
    const mod = (await import(`../../../messages/${locale}.json`)) as { default: MessageTree };
    cache.set(locale, mod.default);
    return mod.default;
  } catch {
    return null;
  }
}

/** Resolve a dotted key (`notifications.bookingConfirmed.title`). */
function lookup(messages: MessageTree, key: string): string | undefined {
  let node: string | MessageTree | undefined = messages;

  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = node[part];
  }

  return typeof node === 'string' ? node : undefined;
}

/** Replace `{name}`. An unknown placeholder is left verbatim rather than blanked. */
function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\s*([a-zA-Z0-9_]+)\s*\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/**
 * The message for `key` in `locale`.
 *
 * Falls back to {@link DEFAULT_LOCALE} when the requested catalogue lacks the
 * key, and finally to the key itself.
 */
export async function translateFor(
  locale: unknown,
  key: string,
  values: Record<string, string | number> = {},
): Promise<string> {
  const wanted = resolveLocale(locale);

  const primary = await load(wanted);
  const hit = primary ? lookup(primary, key) : undefined;
  if (hit) return interpolate(hit, values);

  if (wanted !== DEFAULT_LOCALE) {
    const fallback = await load(DEFAULT_LOCALE);
    const alt = fallback ? lookup(fallback, key) : undefined;
    if (alt) return interpolate(alt, values);
  }

  return key;
}

/**
 * Format money in the recipient's locale.
 *
 * Bulgarian writes "24,00 €" — amount first, comma for the decimal separator,
 * symbol last. A notification is exactly where "€24.00" is noticed.
 */
export function formatMoneyFor(locale: unknown, cents: number, currency: string): string {
  return new Intl.NumberFormat(resolveLocale(locale), {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}
