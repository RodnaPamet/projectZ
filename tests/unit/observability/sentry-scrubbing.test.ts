/**
 * @jest-environment node
 */
import type { ErrorEvent, EventHint } from '@sentry/nextjs';

import { scrubEvent } from '@/lib/observability/sentry';

/**
 * WHAT WE SEND TO SENTRY, PROVEN.
 *
 * A `beforeSend` buried inside an init call is a function nobody ever runs. It
 * looks right in review, it is never exercised, and a gap in it is discovered by
 * an auditor reading our Sentry project — which is the worst imaginable way to
 * find out we have been shipping bearer tokens to a third party for a year.
 *
 * So real events go through the real scrubber here.
 */

function eventWith(request: Partial<NonNullable<ErrorEvent['request']>>): ErrorEvent {
  return { request } as unknown as ErrorEvent;
}

describe('headers', () => {
  it('strips the Authorization header — WHATEVER ITS CASING', () => {
    // THE BUG THIS TEST WAS WRITTEN FOR.
    //
    // The original scrubber did `delete headers['authorization']`. HTTP header
    // names are CASE-INSENSITIVE, and `Authorization` — the conventional casing,
    // and what every HTTP library emits — sailed straight past it. The bearer
    // token went to Sentry.
    //
    // It passed every test anybody had written, because those tests used
    // lowercase keys.
    const scrubbed = scrubEvent(
      eventWith({
        headers: {
          Authorization: 'Bearer sk-live-abc123',
          COOKIE: 'session=deadbeef',
          'X-Api-Key': 'key_live_xyz',
          'Content-Type': 'application/json',
        },
      }),
    );

    const headers = scrubbed!.request!.headers!;
    const serialised = JSON.stringify(headers);

    expect(serialised).not.toContain('sk-live-abc123');
    expect(serialised).not.toContain('deadbeef');
    expect(serialised).not.toContain('key_live_xyz');

    // …while the harmless ones survive. A scrubber that strips everything is a
    // scrubber that makes the report useless.
    expect(headers['Content-Type']).toBe('application/json');
  });

  it.each(['authorization', 'Authorization', 'AUTHORIZATION', 'AuThOrIzAtIoN'])(
    'strips %s',
    (name) => {
      const scrubbed = scrubEvent(eventWith({ headers: { [name]: 'Bearer secret-token' } }));

      expect(JSON.stringify(scrubbed!.request!.headers)).not.toContain('secret-token');
    },
  );

  it('strips the Stripe webhook signature', () => {
    // It is a signing secret in all but name — it authenticates the request.
    const scrubbed = scrubEvent(eventWith({ headers: { 'Stripe-Signature': 't=123,v1=abcdef' } }));

    expect(JSON.stringify(scrubbed!.request!.headers)).not.toContain('abcdef');
  });
});

describe('bodies and URLs', () => {
  it('NEVER sends a request body', () => {
    // A body can hold a password, a card, a whole private message. Filtered
    // wholesale rather than field by field — an allowlist of "safe" fields is a
    // list somebody will add to on a Friday.
    const scrubbed = scrubEvent(
      eventWith({ data: { password: 'hunter2', email: 'ivan@example.com' } }),
    );

    expect(scrubbed!.request!.data).toBe('[Filtered]');
    expect(JSON.stringify(scrubbed)).not.toContain('hunter2');
    expect(JSON.stringify(scrubbed)).not.toContain('ivan@example.com');
  });

  it('redacts a token in a query string', () => {
    const scrubbed = scrubEvent(
      eventWith({ url: 'https://playerz.bg/reset?token=abc123secret&next=/home' }),
    );

    expect(scrubbed!.request!.url).not.toContain('abc123secret');
    // The non-sensitive part survives, so the report still says where it broke.
    expect(scrubbed!.request!.url).toContain('/reset');
  });

  it('redacts where a person stood: near me’s lat and lng (#697)', () => {
    const scrubbed = scrubEvent(
      eventWith({ url: '/api/v1/venues/near?lat=42.698&lng=23.322&radiusKm=25' }),
    );

    expect(scrubbed!.request!.url).not.toContain('42.698');
    expect(scrubbed!.request!.url).not.toContain('23.322');
    expect(scrubbed!.request!.url).toContain('/api/v1/venues/near');
    expect(scrubbed!.request!.url).toContain('radiusKm=25');
  });

  it('drops the query string entirely when Sentry sends it separately', () => {
    const scrubbed = scrubEvent(eventWith({ query_string: 'token=abc123secret' }));

    expect(scrubbed!.request!.query_string).toBe('[Filtered]');
  });

  it('redacts a token hidden in a BREADCRUMB url', () => {
    // Breadcrumbs are the quiet leak. Nobody thinks about them, and they record
    // every navigation — including the one carrying the password-reset token.
    const event = {
      breadcrumbs: [{ data: { url: 'https://playerz.bg/reset?token=leaked_token_value' } }],
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);

    expect(JSON.stringify(scrubbed)).not.toContain('leaked_token_value');
  });
});

describe('the user object', () => {
  it('keeps the id and DROPS the email and the IP', () => {
    // An id is enough to fix a stack trace. An email and an IP are personal data
    // we are shipping to a third party for no operational benefit — and Sentry
    // attaches them by default, without us writing a line of code.
    const event = {
      user: {
        id: 'usr_123',
        email: 'ivan@example.com',
        ip_address: '78.90.12.34',
        username: 'ivan',
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);

    expect(scrubbed!.user).toEqual({ id: 'usr_123' });
    expect(JSON.stringify(scrubbed)).not.toContain('ivan@example.com');
    expect(JSON.stringify(scrubbed)).not.toContain('78.90.12.34');
  });
});

describe('noise', () => {
  it.each(['NEXT_REDIRECT', 'NEXT_NOT_FOUND', 'DYNAMIC_SERVER_USAGE'])(
    'drops %s — it is control flow, not an incident',
    (pattern) => {
      const hint = { originalException: new Error(pattern) } as EventHint;

      expect(scrubEvent({} as unknown as ErrorEvent, hint)).toBeNull();
    },
  );

  it('does NOT drop a real error', () => {
    const hint = { originalException: new Error('Cannot read property of undefined') } as EventHint;

    expect(scrubEvent({} as unknown as ErrorEvent, hint)).not.toBeNull();
  });
});

describe('the scrubber survives a malformed event', () => {
  it('an event with no request is fine', () => {
    expect(scrubEvent({} as unknown as ErrorEvent)).toEqual({});
  });

  it('a URL that does not parse is passed through rather than throwing', () => {
    // A scrubber that throws is a scrubber that loses the error report — and the
    // error report was the point.
    const scrubbed = scrubEvent(eventWith({ url: 'not a url at all' }));

    expect(scrubbed).not.toBeNull();
  });
});
