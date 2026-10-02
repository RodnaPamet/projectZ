import { act, render } from '@testing-library/react';

import { STALE_AFTER_MS, useRefreshWhenStale } from '@/lib/hooks/use-refresh-when-stale';

/**
 * The diary's self-refresh (T30). The router cache now keeps a dynamic page
 * for 30 s (next.config.mjs staleTimes), so a revisited diary paints from
 * memory. These pin what makes that safe for a live view: a payload shown
 * more than 10 s ago re-fetches itself on mount and when the tab comes back,
 * exactly once, and a clock that disagrees with the server's changes nothing.
 *
 * The refresh is the caller's (#314: the diary re-fetches its day, never the
 * route). It is passed as a NEW inline function on every render here, as a
 * component would write it: the hook must not re-run its check, or loop, on
 * that alone.
 */
const refresh = jest.fn();

function Diary({ renderedAt }: { renderedAt: number }) {
  useRefreshWhenStale(renderedAt, () => refresh());
  return null;
}

/** Every test uses its own payload: the hook's memory is module state, as in the app. */
let payload = 1_000_000;
const nextPayload = () => (payload += 1_000_000);

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-09-30T10:00:00Z') });
  refresh.mockClear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});
afterEach(() => jest.useRealTimers());

describe('useRefreshWhenStale', () => {
  it('is 10 s, inside the 30 s router-cache window', () => {
    expect(STALE_AFTER_MS).toBe(10_000);
  });

  it('does nothing when a fresh payload mounts', () => {
    render(<Diary renderedAt={Date.now()} />);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes a cached payload revisited after more than 10 s, once', () => {
    const at = nextPayload();
    const first = render(<Diary renderedAt={at} />);
    first.unmount();

    // A revisit from the router cache: the same payload remounts.
    act(() => jest.advanceTimersByTime(STALE_AFTER_MS + 1));
    const second = render(<Diary renderedAt={at} />);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Re-rendering the same payload, or remounting it at once, asks again for nothing.
    second.rerender(<Diary renderedAt={at} />);
    second.unmount();
    render(<Diary renderedAt={at} />);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('leaves a cached payload revisited within 10 s alone', () => {
    const at = nextPayload();
    render(<Diary renderedAt={at} />).unmount();
    act(() => jest.advanceTimersByTime(STALE_AFTER_MS - 1));
    render(<Diary renderedAt={at} />);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes when the tab becomes visible with a stale payload, not while hidden', () => {
    render(<Diary renderedAt={nextPayload()} />);
    act(() => jest.advanceTimersByTime(60_000));

    act(() => setVisibility('hidden'));
    expect(refresh).not.toHaveBeenCalled();

    act(() => setVisibility('visible'));
    expect(refresh).toHaveBeenCalledTimes(1);

    // A second wake inside the same window does not ask again.
    act(() => setVisibility('visible'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('stops once the refreshed payload arrives: it is fresh, so no loop', () => {
    const view = render(<Diary renderedAt={nextPayload()} />);
    act(() => jest.advanceTimersByTime(STALE_AFTER_MS + 1));
    act(() => setVisibility('visible'));
    expect(refresh).toHaveBeenCalledTimes(1);

    view.rerender(<Diary renderedAt={nextPayload()} />);
    act(() => setVisibility('visible'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('may retry a refresh that left the same payload on screen, once per window', () => {
    render(<Diary renderedAt={nextPayload()} />);
    act(() => jest.advanceTimersByTime(STALE_AFTER_MS + 1));
    act(() => setVisibility('visible'));
    act(() => jest.advanceTimersByTime(STALE_AFTER_MS + 1));
    act(() => setVisibility('visible'));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('ignores the server clock: a server a minute behind does not make a fresh payload stale', () => {
    render(<Diary renderedAt={Date.now() - 60_000} />);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('calls the refresh it was given LAST, not the one it mounted with', () => {
    const first = jest.fn();
    const second = jest.fn();
    function Grid({ at, onStale }: { at: number; onStale: () => void }) {
      useRefreshWhenStale(at, onStale);
      return null;
    }
    const at = nextPayload();
    const view = render(<Grid at={at} onStale={first} />);
    view.rerender(<Grid at={at} onStale={second} />);
    act(() => jest.advanceTimersByTime(STALE_AFTER_MS + 1));
    act(() => setVisibility('visible'));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('removes its listener on unmount', () => {
    const view = render(<Diary renderedAt={nextPayload()} />);
    view.unmount();
    act(() => jest.advanceTimersByTime(60_000));
    act(() => setVisibility('visible'));
    expect(refresh).not.toHaveBeenCalled();
  });
});
