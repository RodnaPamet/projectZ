import { act, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

import {
  COOKIE_NOTICE_KEY,
  CookieNotice,
  __resetCookieNoticeForTests,
} from '@/components/layout/CookieNotice';

import { enMessages, messages, withIntl } from '../helpers/intl';

/**
 * The essential-only notice (#370, Q32): "playerz.bg uses only essential
 * cookies", for a visitor's first visit. Not a consent banner: nothing to
 * accept or reject, only a way to hide it, kept in this browser's
 * localStorage. Where it sits (above the phone's tab bar) is the browser's
 * half: tests/e2e/cookie-notice.spec.ts and its mobile twin.
 */
const c = messages.common.cookieNotice;

const notice = (cookiesHref: string | null = null, locale: 'bg' | 'en' = 'bg') =>
  render(withIntl(<CookieNotice cookiesHref={cookiesHref} />, locale));

/** A new page load: the module's memory is gone, only storage remembers. */
function nextVisit(unmount: () => void) {
  unmount();
  __resetCookieNoticeForTests();
}

beforeEach(() => {
  window.localStorage.clear();
  __resetCookieNoticeForTests();
});
afterEach(() => jest.restoreAllMocks());

describe('a first visit', () => {
  it('says what the cookies are for; one button, to hide it, and no accept or reject', () => {
    notice();
    expect(screen.getByTestId('cookie-notice')).toHaveTextContent(c.text);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: c.dismiss })).toBeInTheDocument();
  });

  it('no cookie policy yet: nothing links to a 404', () => {
    notice(null);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText(c.more)).not.toBeInTheDocument();
  });

  it('once the policy exists: links it', () => {
    notice('/cookies');
    expect(screen.getByRole('link', { name: c.more })).toHaveAttribute('href', '/cookies');
  });

  it('in English, for an English page', () => {
    notice('/cookies', 'en');
    expect(screen.getByTestId('cookie-notice')).toHaveTextContent(
      enMessages.common.cookieNotice.text,
    );
    expect(
      screen.getByRole('link', { name: enMessages.common.cookieNotice.more }),
    ).toBeInTheDocument();
  });

  it('sticks above the phone’s tab bar, by the height the bar publishes, never fixed over the page', () => {
    notice();
    const box = screen.getByTestId('cookie-notice');
    expect(box).toHaveClass('sticky');
    expect(box).not.toHaveClass('fixed');
    expect(box.className).toContain('bottom-[calc(var(--app-bottom-inset,0px)+0.75rem)]');
  });
});

describe('hiding it', () => {
  it('hides it at once, and the next visit remembers (localStorage)', () => {
    const { unmount } = notice();
    fireEvent.click(screen.getByRole('button', { name: c.dismiss }));
    expect(screen.queryByTestId('cookie-notice')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(COOKIE_NOTICE_KEY)).toBe('dismissed');

    nextVisit(unmount);
    notice();
    expect(screen.queryByTestId('cookie-notice')).not.toBeInTheDocument();
  });

  it('writes no cookie: the choice stays in this browser', () => {
    const before = document.cookie;
    notice();
    fireEvent.click(screen.getByRole('button', { name: c.dismiss }));
    expect(document.cookie).toBe(before);
  });

  it('hidden in another tab: hidden here too', () => {
    notice();
    act(() => {
      window.localStorage.setItem(COOKIE_NOTICE_KEY, 'dismissed');
      window.dispatchEvent(new StorageEvent('storage', { key: COOKIE_NOTICE_KEY }));
    });
    expect(screen.queryByTestId('cookie-notice')).not.toBeInTheDocument();
  });
});

describe('a browser that keeps no storage (a private window, a blocked origin)', () => {
  beforeEach(() => {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(denied);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);
  });

  it('still shows, still hides for this page, and nothing throws', () => {
    notice();
    expect(screen.getByTestId('cookie-notice')).toBeInTheDocument();
    expect(() => fireEvent.click(screen.getByRole('button', { name: c.dismiss }))).not.toThrow();
    expect(screen.queryByTestId('cookie-notice')).not.toBeInTheDocument();
  });

  it('with nowhere to remember it, the next visit shows it again', () => {
    const { unmount } = notice();
    fireEvent.click(screen.getByRole('button', { name: c.dismiss }));
    nextVisit(unmount);
    notice();
    expect(screen.getByTestId('cookie-notice')).toBeInTheDocument();
  });
});

describe('on the server', () => {
  it('renders nothing: whether this browser hid it is the client’s to know, so it never flashes', () => {
    expect(renderToString(withIntl(<CookieNotice cookiesHref="/cookies" />))).toBe('');
  });
});
