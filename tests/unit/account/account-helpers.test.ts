/**
 * @jest-environment node
 */
import { NextRequest, NextResponse } from 'next/server';

import { confirmsDeletion, DELETE_CONFIRM_WORDS } from '@/lib/account/confirm-word';
import {
  DELETED_EMAIL_DOMAIN,
  isDeletedAccount,
  isTombstoneEmail,
  tombstoneEmail,
} from '@/lib/account/deleted-user';
import { expireSessionCookies } from '@/lib/auth/session-cookies';

import bg from '../../../messages/bg.json';
import en from '../../../messages/en.json';

describe('the word that confirms a deletion (#370)', () => {
  it('is the catalogue’s word in each language, so the two cannot drift', () => {
    expect([...DELETE_CONFIRM_WORDS].sort()).toEqual(
      [
        bg.profile.delete.dialog.word.toLocaleLowerCase(),
        en.profile.delete.dialog.word.toLocaleLowerCase(),
      ].sort(),
    );
  });

  it.each(['ИЗТРИЙ', 'изтрий', ' Изтрий ', 'DELETE', 'delete', ' Delete\n'])(
    'accepts %j in either language, any case, spaces around',
    (typed) => expect(confirmsDeletion(typed)).toBe(true),
  );

  it.each(['', 'изтри', 'delet', 'ИЗТРИЙ ГО', 'yes', 'deleted'])('refuses %j', (typed) =>
    expect(confirmsDeletion(typed)).toBe(false),
  );
});

describe('a deleted account’s tombstone (#370)', () => {
  it('carries an address in the reserved .invalid domain, pinned to its id', () => {
    expect(tombstoneEmail('cabc123')).toBe(`deleted-cabc123@${DELETED_EMAIL_DOMAIN}`);
    expect(DELETED_EMAIL_DOMAIN.endsWith('.invalid')).toBe(true);
    // The same shape the CHECK app_user_deleted_is_scrubbed pins (P52).
    expect(tombstoneEmail('cabc123')).toBe('deleted-' + 'cabc123' + '@deleted.playerz.invalid');
  });

  it('is told apart by deletedAt, or by its address alone', () => {
    expect(isDeletedAccount({ deletedAt: new Date() })).toBe(true);
    expect(isDeletedAccount({ deletedAt: null })).toBe(false);
    expect(isDeletedAccount(null)).toBe(false);
    expect(isTombstoneEmail(tombstoneEmail('cabc123'))).toBe(true);
    expect(isTombstoneEmail('ivo@example.bg')).toBe(false);
  });
});

describe('expireSessionCookies (#370)', () => {
  const req = (cookie: string) =>
    new NextRequest('https://playerz.bg/api/v1/me', { method: 'DELETE', headers: { cookie } });

  it('expires the session cookie and its chunks, secure ones as secure, and nothing else', () => {
    const res = expireSessionCookies(
      new NextResponse(null, { status: 204 }),
      req(
        '__Secure-next-auth.session-token.0=a; __Secure-next-auth.session-token.1=b; ' +
          'next-auth.csrf-token=c; NEXT_LOCALE=bg; playerz_theme=dark',
      ),
    );
    const set = res.headers.getSetCookie();
    expect(set).toHaveLength(2);
    for (const line of set) {
      expect(line).toMatch(/^__Secure-next-auth\.session-token\.[01]=;/);
      expect(line).toMatch(/Max-Age=0/i);
      expect(line).toMatch(/Secure/);
      expect(line).toMatch(/HttpOnly/i);
      expect(line).toMatch(/Path=\//);
    }
  });

  it('a plain-http session cookie is expired without Secure', () => {
    const res = expireSessionCookies(
      new NextResponse(null, { status: 204 }),
      req('next-auth.session-token=a'),
    );
    const [line] = res.headers.getSetCookie();
    expect(line).toMatch(/^next-auth\.session-token=;/);
    expect(line).not.toMatch(/Secure/);
  });
});
