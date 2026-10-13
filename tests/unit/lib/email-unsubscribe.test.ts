import {
  UNSUBSCRIBE_CATEGORIES,
  readUnsubscribeToken,
  unsubscribeLinks,
  unsubscribeToken,
} from '@/lib/email/unsubscribe';

/**
 * The unsubscribe link (#528): signed for one account and one kind of email,
 * and readable by nothing but the server that signed it.
 */
describe('the unsubscribe token', () => {
  const USER = 'cmv75aj3500eh0kiz9kkyhjfh';

  it.each(UNSUBSCRIBE_CATEGORIES)('round-trips the account and the kind (%s)', (category) => {
    const token = unsubscribeToken(USER, category);
    expect(readUnsubscribeToken(token)).toEqual({ userId: USER, category });
    // Safe in a URL path and in a header, as it is.
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('is the same every time: the link in two emails of one kind is one link', () => {
    expect(unsubscribeToken(USER, 'reminder')).toBe(unsubscribeToken(USER, 'reminder'));
    expect(unsubscribeToken(USER, 'reminder')).not.toBe(unsubscribeToken(USER, 'messages'));
    expect(unsubscribeToken(USER, 'reminder')).not.toBe(
      unsubscribeToken('someone-else', 'reminder'),
    );
  });

  it('a link for one account or kind cannot be edited into another', () => {
    const [, tag] = unsubscribeToken(USER, 'reminder').split('.');
    const forged = (payload: string) =>
      `${Buffer.from(payload, 'utf8').toString('base64url')}.${tag}`;
    expect(readUnsubscribeToken(forged(`${USER}:messages`))).toBeNull();
    expect(readUnsubscribeToken(forged('another-account:reminder'))).toBeNull();
    // The untouched pair still reads, so the forgeries failed on the signature.
    expect(readUnsubscribeToken(forged(`${USER}:reminder`))).toEqual({
      userId: USER,
      category: 'reminder',
    });
  });

  it('reads nothing out of anything it did not sign', () => {
    const token = unsubscribeToken(USER, 'openPlay');
    const [payload, tag] = token.split('.') as [string, string];
    for (const bad of [
      '',
      'not-a-token',
      payload,
      `${payload}.`,
      `.${tag}`,
      `${payload}.${tag}.extra`,
      `${payload}.${tag.slice(0, -2)}`,
      `${payload}.${'A'.repeat(tag.length)}`,
      'x'.repeat(401),
      null,
      undefined,
      42,
      { token },
    ]) {
      expect(readUnsubscribeToken(bad)).toBeNull();
    }
  });

  it('an account id with a colon in it still reads whole', () => {
    const token = unsubscribeToken('odd:id', 'clubChanges');
    expect(readUnsubscribeToken(token)).toEqual({ userId: 'odd:id', category: 'clubChanges' });
  });
});

describe('what an email carries', () => {
  it('the footer’s link is the page; the header’s is the one-click address, on https and in angle brackets', () => {
    const { pageUrl, headers } = unsubscribeLinks('u1', 'reminder');
    const token = unsubscribeToken('u1', 'reminder');

    expect(new URL(pageUrl).pathname).toBe(`/email/unsubscribe/${token}`);
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    const m = /^<(.+)>$/.exec(headers['List-Unsubscribe']!);
    expect(m).not.toBeNull();
    const oneClick = new URL(m![1]!);
    expect(oneClick.pathname).toBe(`/api/email/unsubscribe/${token}`);
    expect(oneClick.origin).toBe(new URL(pageUrl).origin);
    // Nothing a header could be broken with.
    expect(headers['List-Unsubscribe']).not.toMatch(/[\r\n\s]/);
  });
});
