import type { ComponentType, SVGProps } from 'react';

import {
  CalendarIcon,
  LocationPin,
  MoneyBill,
  NucleoPhoto,
  ShieldCheck,
  ShieldKeyhole,
  UserCheck,
  Users,
} from '@/components/ui/icons/nucleo';

import type { NavIconKey } from './nav-items';

/**
 * The glyph for each nav row, resolved on the CLIENT.
 *
 * The admin layouts are Server Components and the shell is a client one. A
 * component is not serialisable, so it cannot cross that boundary as a prop:
 * the server sends `iconKey` and the shell looks it up here. Nucleo, like
 * every other icon in the vendored shell; the vendored NavItem renders the
 * glyph `aria-hidden`, so the label stays the accessible name.
 */
export const NAV_ICONS: Record<NavIconKey, ComponentType<SVGProps<SVGSVGElement>>> = {
  calendar: CalendarIcon,
  courts: LocationPin,
  pricing: MoneyBill,
  photos: NucleoPhoto,
  players: Users,
  staff: UserCheck,
  moderation: ShieldCheck,
  security: ShieldKeyhole,
};
