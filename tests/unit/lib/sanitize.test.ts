import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * The double-unescape bug (CodeQL js/double-escaping).
 *
 * `sanitizePlainText` decodes HTML entities after stripping tags. If it
 * decodes `&amp;` FIRST, the pass that follows can re-consume the `&` it
 * just produced as the start of a NEW entity — resurrecting the exact tag
 * that was stripped a moment earlier.
 *
 * This matters here specifically because playerz runs user free text
 * through it: Booking.notes, Coach.bio, ChatMessage.body — all of
 * which are read by other people.
 */
describe('sanitizePlainText', () => {
  it('does not resurrect a script tag via double-unescaping', () => {
    // Decoding &amp; first turns this into &lt;script&gt;… and then into a
    // live <script> tag. Decoding &amp; LAST cannot.
    const attack = '&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;';

    const out = sanitizePlainText(attack);

    expect(out).not.toContain('<script>');
    expect(out).not.toContain('</script>');
    // What the user literally typed, decoded exactly once.
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('does not resurrect a tag from a doubly-encoded ampersand', () => {
    expect(sanitizePlainText('&amp;lt;img src=x onerror=alert(1)&amp;gt;')).not.toContain('<img');
  });

  it('still strips real tags', () => {
    expect(sanitizePlainText('<script>alert(1)</script>hello')).toBe('hello');
    expect(sanitizePlainText('<b>bold</b>')).toBe('bold');
  });

  it('decodes ordinary entities exactly once', () => {
    expect(sanitizePlainText('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(sanitizePlainText('5 &lt; 6')).toBe('5 < 6');
    expect(sanitizePlainText('caf&#x27;s')).toBe("caf's");
  });

  it('handles null and non-strings without throwing', () => {
    expect(sanitizePlainText(null)).toBe('');
    expect(sanitizePlainText(undefined)).toBe('');
  });
});
