'use client';

import { AccountMenuRows, type AccountLinks } from './account-links';
import { UserMenu } from './user-menu';

/**
 * The player chrome's account menu, from `md`: upstream's vendored `UserMenu`
 * with playerz's account rows in its `items` slot (T20, #362).
 *
 *   identity · Тема (built in) · (Админ на клуба) · Профил · (Платформа) · Изход
 *
 * Below `md` there is no menu: the Профил tab opens `/me/profile`, which holds
 * the same things as a page. Each lives in one place per screen size: theme
 * and sign-out here from `md` (the profile page hides its own rows there),
 * language only on the profile page.
 *
 * A client module of its own because `items` is a render prop, and a function
 * cannot cross from the server-rendered header to the client. The language row
 * is off (`showLanguage={false}`, upstream #3100): the language belongs to the
 * user record, and the profile page's switcher writes that record first.
 */
export function PlayerUserMenu({
  name,
  email,
  links,
}: {
  name: string | null;
  email: string | null;
  links: AccountLinks;
}) {
  return (
    <UserMenu
      displayName={name ?? email}
      displayEmail={email}
      displayImage={null}
      showLanguage={false}
      items={({ close }) => <AccountMenuRows links={links} close={close} />}
    />
  );
}
