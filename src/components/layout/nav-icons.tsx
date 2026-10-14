import type { ComponentType, SVGProps } from 'react';

import { BadgeCheck } from '@/components/ui/icons/nucleo/badge-check';
import { CalendarIcon } from '@/components/ui/icons/nucleo/calendar';
import { CalendarDays } from '@/components/ui/icons/nucleo/calendar-days';
import { ChartLine } from '@/components/ui/icons/nucleo/chart-line';
import { CircleUser } from '@/components/ui/icons/nucleo/circle-user';
import { Crown } from '@/components/ui/icons/nucleo/crown';
import { Envelope } from '@/components/ui/icons/nucleo/envelope';
import { InvoiceDollar } from '@/components/ui/icons/nucleo/invoice-dollar';
import { LocationPin } from '@/components/ui/icons/nucleo/location-pin';
import { Magnifier } from '@/components/ui/icons/nucleo/magnifier';
import { MoneyBill } from '@/components/ui/icons/nucleo/money-bill';
import { Msgs } from '@/components/ui/icons/nucleo/msgs';
import { OfficeBuilding } from '@/components/ui/icons/nucleo/office-building';
import { NucleoPhoto } from '@/components/ui/icons/nucleo/photo';
import { ShieldCheck } from '@/components/ui/icons/nucleo/shield-check';
import { ShieldKeyhole } from '@/components/ui/icons/nucleo/shield-keyhole';
import { ShieldUser } from '@/components/ui/icons/nucleo/shield-user';
import { Trophy } from '@/components/ui/icons/nucleo/trophy';
import { UserArrowRight } from '@/components/ui/icons/nucleo/user-arrow-right';
import { UserCheck } from '@/components/ui/icons/nucleo/user-check';
import { Users } from '@/components/ui/icons/nucleo/users';
import { Users2 } from '@/components/ui/icons/nucleo/users2';

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
  clubs: OfficeBuilding,
  usage: ChartLine,
  security: ShieldKeyhole,
  contactRequests: Envelope,
  coaches: ShieldUser,
  results: Trophy,
  tournaments: Crown,
  discover: Magnifier,
  games: Users2,
  bookings: CalendarDays,
  messages: Msgs,
  profile: CircleUser,
  coachProfile: BadgeCheck,
  signIn: UserArrowRight,
};
