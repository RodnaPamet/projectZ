'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import type { MeDto, NotificationSettingsDto } from '@/app/api/v1/_lib/dto';
import { LocaleSwitcher } from '@/components/layout/LocaleSwitcher';
import {
  DataExportRow,
  DeleteAccountSection,
  type DeletionStandingView,
} from '@/components/profile/DeleteAccountSection';
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
import { Caption, Heading } from '@/components/ui/typography';
import { V1 } from '@/lib/data/keys';
import { persistMyLocale, refreshSession } from '@/lib/i18n/persist-my-locale';

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
 * The profile page's body (#362): identity, settings, privacy, the platform
 * for a grant holder, and sign-out.
 *
 * ═══ WHAT THE ACCOUNT MENU ALSO HOLDS ═══
 *
 * Every shell's account menu has the theme, the language and sign-out, at
 * every width (owner, 2026-10-08). From `md` this page leaves the theme and
 * sign-out to it (`md:hidden` rows), as before; on a phone, where the Профил
 * tab lands, it keeps them in reach on the page too. The language row stays
 * here at every width, the account's own setting, and writes the record the
 * same way the menu's does (`persistMyLocale`).
 */
export function ProfileView({
  name,
  email,
  platformHref,
  account: seed,
  showSports,
  notificationSettings,
  deletion,
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
  /** May the account delete itself, and if not, why (#370). */
  deletion: DeletionStandingView;
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
    // No <main>: the chrome owns the landmark; inside the shell the frame pads.
    <div className="gap-section in-shell:p-0 mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6 md:px-6 md:py-10">
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
                await persistMyLocale(locale);
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
        {/* #370: everything playerz holds about the account, as a file. */}
        <DataExportRow href={V1.exportMyData()} />
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

      {/* Last, below everything else (#370): what deleting the account takes. */}
      <DeleteAccountSection standing={deletion} />
    </div>
  );
}
