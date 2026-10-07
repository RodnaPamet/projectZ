import type { ComponentType, SVGProps } from 'react';

import {
  CalendarDays,
  CalendarIcon,
  ChartLine,
  CircleUser,
  InvoiceDollar,
  Envelope,
  LocationPin,
  Magnifier,
  MoneyBill,
  Msgs,
  NucleoPhoto,
  ShieldCheck,
  ShieldKeyhole,
  UserArrowRight,
  UserCheck,
  Users,
  Users2,
} from '@/components/ui/icons/nucleo';

import type { NavIconKey } from './nav-items';

/**
 * The glyph for each nav row and tab, resolved on the CLIENT.
 *
 * The layouts are Server Components and the shells and the tab bar are client
 * ones. A component is not serialisable, so it cannot cross that boundary as a
 * prop: the server sends `iconKey` and the client looks it up here. Nucleo,
 * like every other icon in the vendored shell; the vendored NavItem and the
 * tab bar render the glyph `aria-hidden`, so the label stays the accessible
 * name.
 */
export const NAV_ICONS: Record<NavIconKey, ComponentType<SVGProps<SVGSVGElement>>> = {
  calendar: CalendarIcon,
  courts: LocationPin,
  pricing: MoneyBill,
  photos: NucleoPhoto,
  players: Users,
  staff: UserCheck,
  reports: ChartLine,
  moderation: ShieldCheck,
  fees: InvoiceDollar,
  usage: ChartLine,
  security: ShieldKeyhole,
  contactRequests: Envelope,
  discover: Magnifier,
  games: Users2,
  bookings: CalendarDays,
  messages: Msgs,
  profile: CircleUser,
  signIn: UserArrowRight,
};
