import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';

import { ContextSwitcher } from '@/components/layout/ContextSwitcher';
import { landingContexts, type LandingMembership } from '@/lib/auth/landing';

import { messages, withIntl } from '../helpers/intl';

/**
 * THE ROLE SWITCHER, AS A PERSON USES IT (#227).
 *
 * The overlap between roles is the normal case — an owner books courts, a
 * coach plays elsewhere — so this is the way between them, not a nicety.
 * These assert what is rendered and what a keyboard does, because a switcher
 * that works with a mouse and traps a keyboard user is one that the people
 * who most need it cannot use.
 *
 * ═══ BOTH PRESENTATIONS, CHOSEN EXPLICITLY ═══
 *
 * `Popover` is a Radix popover on a desktop and a vaul bottom sheet on a
 * phone, keyed on `useMediaQuery`. jsdom answers every media query `false`,
 * which that hook reads as a phone — so a test that does not choose runs the
 * sheet and says nothing about the desktop menu. Each block below chooses.
 */

let pathname = '/';
let device: 'desktop' | 'mobile' = 'desktop';
const push = jest.fn();
const refresh = jest.fn();

// This file's own mock, over the shared one in rtl-setup: the current context
// is read from the URL, so the URL has to be something a test can set.
jest.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push, refresh, replace: jest.fn(), prefetch: jest.fn() }),
}));

jest.mock('@/components/ui/hooks', () => ({
  ...jest.requireActual('@/components/ui/hooks'),
  useMediaQuery: () => ({ isMobile: device === 'mobile', isDesktop: device === 'desktop' }),
}));

const m = (over: Partial<LandingMembership>): LandingMembership => ({
  tenantId: 'cx',
  tenantSlug: 'x',
  tenantName: 'X',
  role: 'PLAYER',
  status: 'ACTIVE',
  tenantStatus: 'ACTIVE',
  createdAt: new Date('2026-01-01'),
  ...over,
});

const CONTEXTS = landingContexts([
  m({ tenantId: 'csofia', tenantSlug: 'sofia-padel', tenantName: 'Sofia Padel', role: 'OWNER' }),
  m({ tenantId: 'cvarna', tenantSlug: 'varna', tenantName: 'Varna Tennis', role: 'STAFF' }),
  m({ tenantId: 'cburgas', tenantSlug: 'burgas', tenantName: 'Burgas Beach', role: 'PLAYER' }),
]);

const copy = messages.contextSwitcher;

// `jest.Mock`, not the type the default would infer: tests hand in actions
// that resolve to an error as well as ones that resolve to nothing.
function renderSwitcher(switchAction: jest.Mock = jest.fn(async () => undefined)) {
  const user = userEvent.setup();
  render(withIntl(<ContextSwitcher contexts={CONTEXTS} switchAction={switchAction} />));
  return { user, switchAction };
}

const trigger = () => screen.getByRole('button', { name: /Смяна на ролята/ });

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  return screen.findByRole('menu', { name: copy.menu });
}

/** WCAG A/AA, as the e2e axe runs use — minus contrast, which needs layout. */
async function axeViolations() {
  const results = await axe.run(document.body, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    rules: { 'color-contrast': { enabled: false } },
  });
  return results.violations.map((v) => `${v.id}: ${v.help}`);
}

beforeEach(() => {
  pathname = '/';
  device = 'desktop';
  push.mockReset();
  refresh.mockReset();
});

describe('ContextSwitcher', () => {
  it('renders nothing for somebody with one context — there is nothing to switch to', () => {
    const { container } = render(
      withIntl(<ContextSwitcher contexts={landingContexts([])} switchAction={jest.fn()} />),
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('names the current context on the button, and says what the button does', () => {
    pathname = '/t/varna/admin/players';
    renderSwitcher();

    // The visible text is the club; the accessible name says it is a switcher.
    expect(trigger()).toHaveTextContent('Varna Tennis');
    expect(trigger()).toHaveAccessibleName(copy.trigger.replace('{current}', 'Varna Tennis'));
  });

  it('is the player context everywhere that is not a club’s admin area', () => {
    pathname = '/venues';
    renderSwitcher();

    expect(trigger()).toHaveTextContent(copy.player);
  });

  it('lists the player context and every club they run, by club name, with the role', async () => {
    const { user } = renderSwitcher();
    const menu = await openMenu(user);

    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual([
      copy.player,
      `Sofia Padel${copy.role.OWNER}`,
      `Varna Tennis${copy.role.STAFF}`,
    ]);
    // A club they only PLAY at is not a club context.
    expect(within(menu).queryByText('Burgas Beach')).toBeNull();
  });

  it('marks exactly one entry as current', async () => {
    pathname = '/t/sofia-padel/admin/courts';
    const { user } = renderSwitcher();
    const menu = await openMenu(user);

    const checked = within(menu)
      .getAllByRole('menuitemradio')
      .filter((i) => i.getAttribute('aria-checked') === 'true');

    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveTextContent('Sofia Padel');
  });

  it('choosing a context hands its key to the action, and closes the menu', async () => {
    const { user, switchAction } = renderSwitcher();
    const menu = await openMenu(user);

    await user.click(within(menu).getByRole('menuitemradio', { name: /Varna Tennis/ }));

    expect(switchAction).toHaveBeenCalledWith('club:cvarna');
    // Closed at once, not when the navigation lands: choosing the club whose
    // page you are on keeps this component mounted, and a menu left open
    // would still be open on the page it led to.
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('is usable from the keyboard alone', async () => {
    const { user, switchAction } = renderSwitcher();

    trigger().focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');

    // Focus moves into the menu when it opens…
    await waitFor(() => expect(items[0]).toHaveFocus());

    // …the arrow keys walk it, and wrap…
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(items[2]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items[2]).toHaveFocus();

    // …Enter chooses, and focus goes back to the button rather than to <body>.
    await user.keyboard('{Enter}');
    expect(switchAction).toHaveBeenCalledWith('club:cvarna');
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it('Escape closes it and puts focus back on the button', async () => {
    const { user } = renderSwitcher();
    await openMenu(user);

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it('reopens to say so when the context has gone away since the page rendered', async () => {
    const { user } = renderSwitcher(jest.fn(async () => ({ error: 'NOT_AVAILABLE' })));
    const menu = await openMenu(user);

    await user.click(within(menu).getByRole('menuitemradio', { name: /Sofia Padel/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.unavailable);
    // The menu is back, so the message sits beside the list it is about…
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // …and the header re-renders so that list is true again.
    expect(refresh).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    // Dismissed with the menu: reopening later does not report it again.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await openMenu(user);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends a signed-out session to sign in', async () => {
    const { user } = renderSwitcher(jest.fn(async () => ({ error: 'SIGN_IN_REQUIRED' })));
    const menu = await openMenu(user);

    await user.click(within(menu).getByRole('menuitemradio', { name: copy.player }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'));
  });

  it('ignores a second choice while the first is still in flight', async () => {
    let finish: () => void = () => {};
    const switchAction = jest.fn(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const { user } = renderSwitcher(switchAction);

    await user.click(within(await openMenu(user)).getByRole('menuitemradio', { name: /Sofia/ }));
    // Busy, and says so on the one control still showing.
    expect(trigger()).toHaveAttribute('aria-busy', 'true');

    // Reopened mid-flight, and a different club chosen.
    await user.click(within(await openMenu(user)).getByRole('menuitemradio', { name: /Varna/ }));

    expect(switchAction).toHaveBeenCalledTimes(1);
    expect(switchAction).toHaveBeenCalledWith('club:csofia');
    await act(async () => finish());
    expect(trigger()).not.toHaveAttribute('aria-busy');
  });

  it('has no WCAG A/AA violations with the menu open', async () => {
    // The e2e axe runs sign nobody in, so they never see this menu. Colour
    // contrast needs a layout engine and is left to them and to the contrast
    // guardrail; everything structural — roles, names, required parents and
    // children — is checked here.
    pathname = '/t/sofia-padel/admin/calendar';
    const { user } = renderSwitcher();
    await openMenu(user);

    expect(await axeViolations()).toEqual([]);
  });

  it('has none with the failure message showing either', async () => {
    // The message sits OUTSIDE role="menu", which may own only menu items.
    const { user } = renderSwitcher(jest.fn(async () => ({ error: 'NOT_AVAILABLE' })));
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole('menuitemradio', { name: copy.player }));
    await screen.findByRole('alert');

    expect(await axeViolations()).toEqual([]);
  });
});

describe('ContextSwitcher on a phone — the same menu, in a bottom sheet', () => {
  beforeEach(() => {
    device = 'mobile';
  });

  it('opens as a sheet and still switches', async () => {
    const { user, switchAction } = renderSwitcher();
    const menu = await openMenu(user);

    expect(document.querySelectorAll('[data-vaul-drawer]').length).toBeGreaterThan(0);

    await user.click(within(menu).getByRole('menuitemradio', { name: /Sofia Padel/ }));
    expect(switchAction).toHaveBeenCalledWith('club:csofia');
  });

  it('has no WCAG A/AA violations as a sheet', async () => {
    const { user } = renderSwitcher();
    await openMenu(user);

    expect(await axeViolations()).toEqual([]);
  });
});
