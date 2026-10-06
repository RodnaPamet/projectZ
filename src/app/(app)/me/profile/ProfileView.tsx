'use client';

import Link from 'next/link';
import { getCsrfToken, signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import { LocaleSwitcher } from '@/components/layout/LocaleSwitcher';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChevronRight, ShieldCheck, UserArrowRight } from '@/components/ui/icons/nucleo';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';

import { saveMyLocaleAction } from './actions';

/**
 * A titled group of rows: the vendored `Heading` over a flat `Card` whose rows
 * the card divides.
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gap-tight flex flex-col">
      <Heading level={2} tone="muted" className="text-sm">
        {title}
      </Heading>
      <Card elevation="flat" density="none" className="divide-border-subtle divide-y">
        {children}
      </Card>
    </section>
  );
}

const ROW = 'flex min-h-14 items-center justify-between gap-3 px-4 py-2';

/**
 * Write the language to the user record, then have next-auth re-read it into
 * the token, BEFORE the switcher sets the cookie (the switcher's
 * `onLocaleChange`, upstream #3185). The middleware re-seeds the cookie from
 * the token on every request, so with the old token in place the new language
 * would be flipped straight back. `auth.ts` reads the value from the
 * database on `trigger: 'update'`; this request carries none.
 */
async function persistLocale(locale: string) {
  const saved = await saveMyLocaleAction(locale);
  if (!saved.ok) throw new Error('locale not saved');
  const csrfToken = await getCsrfToken();
  const res = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken, data: {} }),
  });
  if (!res.ok) throw new Error('session not refreshed');
}

/**
 * The profile page's body (#362): identity, settings, privacy, the platform
 * for a grant holder, and sign-out.
 *
 * ═══ ONE PLACE PER SCREEN SIZE ═══
 *
 * From `md` the avatar keeps the vendored account menu, which has the theme
 * and sign-out built in. So the theme row and the sign-out button here are
 * phone-only (`md:hidden`): the same control is never on screen twice. The
 * language is only here, at every width: the menu's row is off, because it
 * would write the cookie alone.
 */
export function ProfileView({
  name,
  email,
  platformHref,
}: {
  name: string | null;
  email: string | null;
  platformHref: string | null;
}) {
  const t = useTranslations('profile');
  const tCommon = useTranslations('common');
  const tNav = useTranslations('common.nav');
  const [saveFailed, setSaveFailed] = useState(false);
  const display = name?.trim() || email || tNav('account');

  return (
    <main className="gap-section mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6 md:px-6 md:py-10">
      <div className="flex items-center gap-4">
        <InitialsAvatar value={display} size="lg" />
        <div className="min-w-0">
          <Heading level={1} className="truncate">
            {display}
          </Heading>
          {email && display !== email ? (
            <Caption className="truncate" data-testid="profile-email">
              {email}
            </Caption>
          ) : null}
        </div>
      </div>

      {/*
        #359 adds the player's sports and a self-declared 1–7 level for each
        HERE, between the identity and the settings, as its own <Section>
        ("Спортове и ниво"). Nothing is drawn for it until then.
      */}

      <Section title={t('settings')}>
        <div className={ROW} data-testid="profile-language-row">
          <span className="text-content-default text-sm">{tCommon('language')}</span>
          <LocaleSwitcher
            onLocaleChange={async (locale) => {
              setSaveFailed(false);
              try {
                await persistLocale(locale);
              } catch (err) {
                setSaveFailed(true);
                throw err;
              }
            }}
          />
        </div>
        <div className={`${ROW} md:hidden`} data-testid="profile-theme-row">
          <span className="text-content-default text-sm">{tCommon('theme')}</span>
          <ThemeToggle id="profile-theme-toggle" />
        </div>
      </Section>

      {saveFailed ? (
        <InlineNotice variant="error" data-testid="profile-language-failed">
          {t('languageSaveFailed')}
        </InlineNotice>
      ) : null}

      <Section title={t('privacy')}>
        {/* The data page comes with #370 (legal pages, export, deletion).
            Until then the row says so rather than linking to a 404. */}
        <div className={ROW} data-testid="profile-privacy-row">
          <span className="text-content-default text-sm">{t('privacyData')}</span>
          <StatusBadge size="sm" variant="neutral" icon={null}>
            {t('comingSoon')}
          </StatusBadge>
        </div>
      </Section>

      {platformHref ? (
        <Section title={tNav('platform')}>
          <Link
            href={platformHref}
            className="text-content-default hover:bg-bg-muted flex min-h-14 items-center gap-3 px-4 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none focus-visible:ring-inset"
            data-testid="profile-platform"
          >
            <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{t('platformRow')}</span>
            <ChevronRight className="text-content-muted size-4" aria-hidden="true" />
          </Link>
        </Section>
      ) : null}

      <Button
        variant="secondary"
        icon={<UserArrowRight aria-hidden="true" />}
        className="self-start md:hidden"
        data-testid="profile-sign-out"
        onClick={() => void signOut({ callbackUrl: '/' })}
      >
        {tCommon('signOut')}
      </Button>
    </main>
  );
}
