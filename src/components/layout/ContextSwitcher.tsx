'use client';

import { Check, ChevronDown } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Fragment, useState, useTransition } from 'react';

import { Popover } from '@/components/ui/popover';
import { contextForPath, type LandingContext } from '@/lib/auth/landing';

/**
 * The role switcher (#227): every context this person holds, one click apart.
 *
 * ═══ REQUIRED, NOT A NICETY ═══
 *
 * The overlap is the normal case. An owner books courts for themselves; a
 * coach at one club plays at another. Sign-in lands them in ONE context, and
 * without this the only way into another is typing a URL.
 *
 * ═══ WHAT IT SHOWS ═══
 *
 * The player context, then each club where they are OWNER, MANAGER or STAFF,
 * labelled by the club's name with the role beside it. Coach contexts join the
 * list the day there is a coach UI — see COACH_HOME in `@/lib/auth/landing`.
 * Rendered only for two or more: one context is nothing to switch between.
 *
 * The CURRENT context is read from the URL, not from what was last chosen. An
 * owner who followed an email link into their club's staff screen is in that
 * club, whatever they picked yesterday.
 *
 * ═══ CHOOSING ONE ═══
 *
 * `switchAction` records the choice as last-used — so it is also where the
 * next sign-in lands — and redirects to the context's home. The action is a
 * prop rather than an import so this stays a plain component: `SiteHeader`
 * passes the real Server Action, a test passes a function.
 *
 * ═══ ACCESSIBLE BY CONSTRUCTION ═══
 *
 * `Popover.Menu` supplies the menu semantics and the arrow keys; Radix
 * supplies Escape, focus return and the dialog wiring; on a phone the same
 * content becomes a bottom sheet. Each entry is a `menuitemradio` with
 * `aria-checked`, because this is a choose-one list and a screen reader should
 * say which one is chosen. The trigger's accessible name carries the current
 * context too — its visible text is a club name, which on its own says nothing
 * about what the button does.
 */
export type SwitchAction = (key: string) => Promise<{ error: string } | void>;

export function ContextSwitcher({
  contexts,
  switchAction,
}: {
  contexts: readonly LandingContext[];
  switchAction: SwitchAction;
}) {
  const t = useTranslations('contextSwitcher');
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [pending, startTransition] = useTransition();

  if (contexts.length < 2) return null;

  const current = contextForPath(contexts, pathname ?? '/');
  const label = (c: LandingContext) => (c.kind === 'player' ? t('player') : c.tenantName);

  function choose(key: string) {
    // A second choice while the first is in flight would queue a second
    // redirect behind it. Ignored rather than disabled: disabling the control
    // that holds focus drops focus to <body>, and a keyboard user loses their
    // place.
    if (pending) return;
    setUnavailable(false);
    // Closed NOW, not when the navigation lands. Choosing the club whose page
    // you are already on keeps this layout — and this component — mounted, so
    // a menu left open would still be open on the page it led to. Radix hands
    // focus back to the trigger as it closes.
    setOpen(false);

    startTransition(async () => {
      // On success the action redirects: Next REJECTS this promise with a
      // redirect error for its RedirectBoundary, and navigates. So nothing
      // below runs, and nothing here may catch it.
      const result = await switchAction(key);
      if (!result) return;

      if (result.error === 'SIGN_IN_REQUIRED') {
        router.push('/login');
        return;
      }
      // The context went away after this page rendered — a suspension, a
      // demotion. Reopen to say so, and re-render the header so the list is
      // true again.
      setUnavailable(true);
      setOpen(true);
      router.refresh();
    });
  }

  return (
    <Popover
      openPopover={open}
      setOpenPopover={(next) => {
        setOpen(next);
        // The failure message is about the attempt that just failed. Closing
        // the menu dismisses it, so reopening later does not report it again.
        if (!next) setUnavailable(false);
      }}
      align="end"
      content={
        <div className="w-full sm:w-64">
          <Popover.Menu aria-label={t('menu')}>
            {contexts.map((c, i) => {
              const chosen = c.key === current.key;
              return (
                <Fragment key={c.key}>
                  {/* The person first, then the places they work. */}
                  {i === 1 ? <Popover.Separator /> : null}
                  <Popover.Item
                    role="menuitemradio"
                    aria-checked={chosen}
                    selected={chosen}
                    // An empty slot keeps every label on one left edge.
                    icon={chosen ? <Check aria-hidden="true" /> : <span aria-hidden="true" />}
                    right={
                      c.kind === 'club'
                        ? t(`role.${c.role}`)
                        : c.kind === 'coach'
                          ? t('role.COACH')
                          : undefined
                    }
                    onClick={() => choose(c.key)}
                  >
                    {label(c)}
                  </Popover.Item>
                </Fragment>
              );
            })}
          </Popover.Menu>

          {/* Outside the menu: `role="menu"` may own only menu items, and a
              status line inside it is an ARIA error axe reports. */}
          {unavailable ? (
            <p role="alert" className="text-content-error px-3 pt-1 pb-2 text-sm">
              {t('unavailable')}
            </p>
          ) : null}
        </div>
      }
    >
      <button
        type="button"
        aria-label={t('trigger', { current: label(current) })}
        // The menu has closed by the time a switch is in flight; this is what
        // is left to say that something is happening.
        aria-busy={pending || undefined}
        className="border-border-strong text-content-default hover:text-content-emphasis focus-visible:ring-focus-ring inline-flex h-9 max-w-[14rem] items-center gap-1.5 rounded-md border px-3 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="truncate">{label(current)}</span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
      </button>
    </Popover>
  );
}
