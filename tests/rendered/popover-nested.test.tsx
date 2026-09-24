import { render, screen } from '@testing-library/react';

import { Popover } from '@/components/ui/popover';
import { OverlayDepthProvider } from '@/components/ui/overlay-depth';

import { withIntl } from '../helpers/intl';

/**
 * THE INTEGRATION, not just the context.
 *
 * overlay-depth.test.tsx proves the context accumulates. This proves the POPOVER
 * actually reads it — that a Popover nested inside a sheet does NOT mount a
 * second drawer.
 *
 * Testing the context alone would leave the real bug perfectly intact: the
 * provider could work flawlessly while Popover ignored it.
 */

// Force the mobile presentation. Without this the desktop branch runs and the
// test passes for entirely the wrong reason.
jest.mock('@/components/ui/hooks', () => ({
  ...jest.requireActual('@/components/ui/hooks'),
  useMediaQuery: () => ({ isMobile: true, isDesktop: false }),
}));

/** Vaul renders a `[data-vaul-drawer]` element. Count them. */
const drawerCount = () => document.querySelectorAll('[data-vaul-drawer]').length;

describe('a Popover nested inside a sheet', () => {
  it('mounts a drawer when it is NOT nested (the normal mobile case)', async () => {
    render(
      withIntl(
        <Popover openPopover setOpenPopover={() => {}} content={<div>picker</div>}>
          <button type="button">open</button>
        </Popover>,
      ),
    );

    // The whole point of the primitive on mobile: a bottom sheet.
    expect(await screen.findByText('picker')).toBeInTheDocument();
    expect(drawerCount()).toBeGreaterThan(0);
  });

  it('does NOT mount a second drawer when it IS nested', async () => {
    // A searchable Combobox inside a Modal. Two drawers would mean overlapping
    // scroll locks, a drag gesture that dismisses the wrong sheet, and an escape
    // key that closes both or neither.
    render(
      withIntl(
        <OverlayDepthProvider>
          <Popover openPopover setOpenPopover={() => {}} content={<div>picker</div>}>
            <button type="button">open</button>
          </Popover>
        </OverlayDepthProvider>,
      ),
    );

    expect(await screen.findByText('picker')).toBeInTheDocument();

    // The content is still there — it just presents as a popover, not a sheet.
    expect(drawerCount()).toBe(0);
  });

  it('forceDropdown still works as an explicit override', async () => {
    // The prop is kept. The 11 existing call sites become redundant rather than
    // wrong, and a caller who knows something the tree does not can still say so.
    render(
      withIntl(
        <Popover openPopover setOpenPopover={() => {}} forceDropdown content={<div>picker</div>}>
          <button type="button">open</button>
        </Popover>,
      ),
    );

    expect(await screen.findByText('picker')).toBeInTheDocument();
    expect(drawerCount()).toBe(0);
  });
});
