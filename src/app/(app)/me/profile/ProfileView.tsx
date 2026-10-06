'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getCsrfToken, signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import type { MeDto, NotificationSettingsDto } from '@/app/api/v1/_lib/dto';
import { LocaleSwitcher } from '@/components/layout/LocaleSwitcher';
import { NotificationSettingsRow } from '@/components/profile/NotificationSettingsRow';
import { PersonalDataSection } from '@/components/profile/PersonalDataSection';
import { SportLevelsSection } from '@/components/profile/SportLevelsSection';
import { useAccount } from '@/components/profile/use-account';
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
  await refreshSession();
}

/**
 * next-auth's CSRF-checked session update: `auth.ts` re-reads the locale and
 * the display name (#359) from the user's own row into the token.
 */
async function refreshSession() {
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
  account: seed,
  showSports,
  notificationSettings,
}: {
  name: string | null;
  email: string | null;
  platformHref: string | null;
  /** `GET /api/v1/me`, read by the page: what #359's sections edit. */
  account: MeDto;
  /** Sports and levels are a player's; a CLUB account does not play (#263). */
  showSports: boolean;
  /** Which emails the account gets (#367); the bell has no switch. */
  notificationSettings: NotificationSettingsDto;
}) {
  const t = useTranslations('profile');
  const tCommon = useTranslations('common');
  const tNav = useTranslations('common.nav');
  const router = useRouter();
  const [saveFailed, setSaveFailed] = useState(false);
  // The live account (#359): a name saved below shows in the header at once.
  const { account } = useAccount(seed);
  const display = account.name?.trim() || name?.trim() || email || tNav('account');

  return (
    <main className="gap-section mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6 md:px-6 md:py-10">
      <div className="flex items-center gap-4">
        {/* The sign-in provider's picture when there is one (#359). */}
        <InitialsAvatar value={display} size="lg" imageUrl={account.avatarUrl} />
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
        #359, between the identity and the settings: the display name (N01),
        then the sports with a self-declared 1–7 level for each (Q37). A new
        name goes into the session's token and the header is re-rendered, so
        the account menu says it too.
      */}
      <PersonalDataSection
        seed={seed}
        onNameSaved={async () => {
          await refreshSession();
          router.refresh();
        }}
      />
      {showSports ? <SportLevelsSection seed={seed} /> : null}

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
        <NotificationSettingsRow seed={notificationSettings} />
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
