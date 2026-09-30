import { act, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';

import { Providers } from '@/app/providers';
import { Modal } from '@/components/ui/modal';

import bg from '../../messages/bg.json';

/**
 * The root providers, rendered the way the root layout renders them.
 *
 * DELIBERATELY NOT tests/helpers/render.tsx: that wrapper mounts its own
 * TooltipProvider, which is exactly what hid the bug. Every primitive test
 * passed, and in the real app the first <Modal> on a desktop page threw
 * "`Tooltip` must be used within `TooltipProvider`" from its close button,
 * because the root layout mounted no TooltipProvider at all. Here the ONLY
 * provider above the tree is <Providers> itself (plus the intl provider the
 * layout puts outside it), so a provider that goes missing fails this file.
 */
function renderInApp(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="bg" messages={bg}>
      <Providers>{ui}</Providers>
    </NextIntlClientProvider>,
  );
}

/**
 * A 1280px desktop, as far as matchMedia is concerned. The shared jsdom stub
 * matches NOTHING, which useMediaQuery reads as a phone — the Modal would take
 * its vaul drawer presentation, which has no close button and so no Tooltip,
 * and the one case this file exists for would pass by never rendering.
 */
function desktopMatchMedia(query: string): MediaQueryList {
  return {
    matches: /min-width/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  };
}

const jsdomMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = desktopMatchMedia;
});
afterEach(() => {
  window.matchMedia = jsdomMatchMedia;
});

describe('<Providers>', () => {
  it("renders a Modal with its desktop close-button Tooltip, and no helper's TooltipProvider", () => {
    renderInApp(
      <Modal showModal setShowModal={() => {}} title="Корт 3">
        <p>Събота 18:00</p>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Събота 18:00')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: bg.common.close })).toBeInTheDocument();
  });

  it('mounts a Toaster, so a toast actually renders — under the translated container label', async () => {
    renderInApp(<p>app</p>);

    act(() => {
      toast('Резервацията е потвърдена');
    });

    expect(await screen.findByText('Резервацията е потвърдена')).toBeInTheDocument();
    // sonner appends its hotkey hint to the label ("Известия alt+T").
    expect(
      screen.getByRole('region', { name: new RegExp(`^${bg.common.ui.notifications}(\\s|$)`) }),
    ).toBeInTheDocument();
  });

  it('the Bulgarian container label is Cyrillic, not the English default', () => {
    // sonner's own default is "Notifications". If the prop were dropped the
    // region would still exist — and announce English to a Bulgarian user.
    expect(bg.common.ui.notifications).toBe('Известия');
  });
});
