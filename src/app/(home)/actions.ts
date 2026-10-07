'use server';

import { headers } from 'next/headers';
import { getLocale } from 'next-intl/server';

import { submitContactRequest, type ContactResult } from '@/app-layer/usecases/contact-requests';
import { getClientIp } from '@/lib/security/rate-limit-middleware';

/**
 * The landing page's "For clubs" form (#369). Anonymous by design: a club that
 * is not on playerz yet has no account.
 *
 * What stands in for a permission is in `submitContactRequest`: zod on every
 * field, a honeypot, a per-IP rate limit (the IP hashed, never stored), and an
 * email that only ever goes to the operator's fixed inbox
 * (`server-actions-authorise` lists this file and says so).
 *
 * The form's fields arrive as FormData; only the named ones are read, as
 * strings, so a crafted post cannot smuggle in anything the schema does not
 * know.
 */
export async function submitContactAction(
  _previous: ContactResult | null,
  form: FormData,
): Promise<ContactResult> {
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === 'string' ? v : undefined;
  };

  const [h, locale] = await Promise.all([headers(), getLocale()]);

  return submitContactRequest(
    {
      name: field('name'),
      clubName: field('clubName'),
      phone: field('phone'),
      email: field('email'),
      message: field('message'),
      website: field('website'),
    },
    { clientIp: getClientIp(new Request('http://contact.invalid', { headers: h })), locale },
  );
}
