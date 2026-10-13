'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { buttonVariants } from '@/components/ui/button-variants';

type Carrier = { carried: boolean; setCarried: (carried: boolean) => void };

const NOOP: Carrier = { carried: false, setCarried: () => {} };
const CarrierContext = createContext<Carrier>(NOOP);

/**
 * One «Ново съобщение» on screen at a time (#375). The page header has one;
 * the empty «Разговори» list has its own, in the middle of the page, where the
 * eye already is. While the list is that empty state, it carries the button
 * and the header's steps aside.
 *
 * The list is client state (seeded by the page, re-read by polling), so the
 * header follows what the list says, not what the server saw. `carriedBySeed`
 * is what the server saw, so the first paint already agrees with the list and
 * nothing jumps once it hydrates.
 */
export function NewMessageProvider({
  carriedBySeed,
  children,
}: {
  carriedBySeed: boolean;
  children: ReactNode;
}) {
  const [carried, setCarried] = useState(carriedBySeed);
  const value = useMemo(() => ({ carried, setCarried }), [carried]);
  return <CarrierContext.Provider value={value}>{children}</CarrierContext.Provider>;
}

/** For the list: tell the header whether the empty state is carrying the button. */
export function useReportEmptyAction(): (carried: boolean) => void {
  return useContext(CarrierContext).setCarried;
}

/** The header's «Ново съобщение», unless the empty list is carrying one. */
export function NewMessageLink() {
  const t = useTranslations('messaging');
  const { carried } = useContext(CarrierContext);
  if (carried) return null;
  return (
    <Link
      href="/messages/new"
      className={buttonVariants({ variant: 'primary' })}
      data-testid="messages-new"
    >
      {t('new')}
    </Link>
  );
}
