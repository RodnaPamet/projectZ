import { isDeliverableAddress } from './provider';

/**
 * The operator's inbox for the landing page's club enquiries (#369):
 * `CONTACT_INBOX_EMAIL`, or null when it is unset or not one plain address.
 *
 * Read from `process.env` on every call, not from the parsed `env` object, for
 * the same reason the outbox stores no address: the form asks it when deciding
 * whether to queue an email at all, and the drain asks it again at send time,
 * so a changed (or removed) inbox is honoured by rows already queued. src/env.ts
 * declares and validates it at boot.
 */
export function contactInboxAddress(): string | null {
  const value = process.env.CONTACT_INBOX_EMAIL?.trim();
  if (!value) return null;
  return isDeliverableAddress(value) ? value : null;
}
