import type { ComponentType, SVGProps } from 'react';

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import type { PilotClub } from '@/app-layer/usecases/pilot-clubs';
import { VenuePhotoImg } from '@/components/media/venue-photo-img';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  BoltFill,
  CalendarDays,
  CircleCheck,
  Gift,
  LocationPin,
  Magnifier,
  MoneyBill,
  Sparkle3,
  Users2,
} from '@/components/ui/icons/nucleo';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Eyebrow, Heading } from '@/components/ui/typography';
import { cityLabel } from '@/lib/geo/cities';
import { clubPath } from '@/lib/seo/sitemap';

import { ContactForm } from './ContactForm';

/**
 * The landing page's sections below the hero (#369). Server components: the
 * only client code on the page is the contact form, the footer's language
 * switch and the chrome every public page already ships.
 *
 * Every word comes from `landing.*` in the catalogues: the copy is a DRAFT the
 * owner edits before it goes live (Q45/Q49).
 */

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** A section's band: full width, the content in the page's column. */
function Band({
  id,
  labelledBy,
  tone = 'page',
  children,
  testId,
}: {
  id?: string;
  labelledBy: string;
  tone?: 'page' | 'muted';
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      data-testid={testId}
      className={
        tone === 'muted'
          ? 'bg-bg-subtle border-border-subtle scroll-mt-20 border-y'
          : 'scroll-mt-20'
      }
    >
      <div className="mx-auto w-full max-w-6xl px-6 py-14 md:py-20">{children}</div>
    </section>
  );
}

function SectionHead({
  id,
  eyebrow,
  title,
  lead,
}: {
  id: string;
  eyebrow: string;
  title: string;
  lead?: string;
}) {
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <Eyebrow className="text-content-brand mb-0">{eyebrow}</Eyebrow>
      <Heading level={2} id={id} className="text-2xl tracking-tight md:text-3xl">
        {title}
      </Heading>
      {lead && <p className="text-content-default text-base md:text-lg">{lead}</p>}
    </div>
  );
}

/** An icon in a brand-tinted disc, decorative: the heading beside it says it. */
function IconDisc({ icon: I }: { icon: Icon }) {
  return (
    <span className="bg-brand-subtle text-content-brand inline-flex size-10 shrink-0 items-center justify-center rounded-full">
      <I aria-hidden="true" className="size-5" />
    </span>
  );
}

function Feature({ icon, title, body }: { icon: Icon; title: string; body: string }) {
  return (
    <Card
      as="li"
      elevation="flat"
      density="comfortable"
      className="bg-bg-default flex flex-col gap-3"
    >
      <IconDisc icon={icon} />
      <Heading level={3} className="text-base">
        {title}
      </Heading>
      <Caption>{body}</Caption>
    </Card>
  );
}

export async function PlayersSection() {
  const t = await getTranslations('landing.players');
  const features: Array<{ key: 'search' | 'instant' | 'payAtClub' | 'team'; icon: Icon }> = [
    { key: 'search', icon: Magnifier },
    { key: 'instant', icon: BoltFill },
    { key: 'payAtClub', icon: MoneyBill },
    { key: 'team', icon: Users2 },
  ];
  return (
    <Band labelledBy="landing-players" testId="landing-players">
      <SectionHead id="landing-players" eyebrow={t('eyebrow')} title={t('title')} />
      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {features.map(({ key, icon }) => (
          <Feature key={key} icon={icon} title={t(`${key}.title`)} body={t(`${key}.body`)} />
        ))}
      </ul>
    </Band>
  );
}

/**
 * The pilot clubs, live from the database (`listPilotClubs`). With none yet,
 * the vendored EmptyState says the first are coming and points at the form:
 * never a made-up club.
 */
export async function PilotClubsSection({ clubs }: { clubs: PilotClub[] }) {
  const [t, tSports, tCities] = await Promise.all([
    getTranslations('landing.clubsList'),
    getTranslations('sports'),
    getTranslations('cities'),
  ]);
  return (
    <Band labelledBy="landing-pilot-clubs" tone="muted" testId="landing-pilot-clubs">
      <SectionHead
        id="landing-pilot-clubs"
        eyebrow={t('eyebrow')}
        title={t('title')}
        lead={t('lead')}
      />
      {clubs.length === 0 ? (
        <div className="mt-8" data-testid="pilot-clubs-empty">
          <EmptyState
            variant="no-records"
            title={t('empty.title')}
            description={t('empty.description')}
            primaryAction={{ label: t('empty.action'), href: '#clubs' }}
          />
        </div>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="pilot-clubs">
          {clubs.map((c) => (
            <Card
              key={c.id}
              as="li"
              elevation="flat"
              density="none"
              className="bg-bg-default focus-within:ring-ring relative flex flex-col overflow-hidden focus-within:ring-2"
            >
              {c.cover ? (
                <VenuePhotoImg
                  photo={c.cover}
                  sizes="(min-width: 1024px) 370px, (min-width: 640px) 50vw, 100vw"
                  className="bg-bg-muted aspect-[16/9] w-full"
                />
              ) : (
                // No photo yet: a tinted band, so the cards keep one shape.
                <div aria-hidden="true" className="bg-brand-subtle aspect-[16/9] w-full" />
              )}
              <div className="flex flex-col gap-2 p-4">
                <h3 className="text-content-emphasis font-medium">
                  {/* Default (auto) prefetch, as the club page's venue cards.
                      The name stretches over the card: one link, one target. */}
                  <Link
                    href={clubPath(c.slug)}
                    className="outline-none after:absolute after:inset-0 after:rounded-[inherit] hover:underline"
                  >
                    {c.name}
                  </Link>
                </h3>
                <Caption className="flex items-center gap-1">
                  <LocationPin className="size-3.5 shrink-0" aria-hidden="true" />
                  {[
                    ...c.cities.map((city) => cityLabel(tCities, city)),
                    t('venues', { count: c.venueCount }),
                  ].join(' · ')}
                </Caption>
                {c.sports.length > 0 && (
                  <ul
                    aria-label={t('sportsLabel', { club: c.name })}
                    className="flex flex-wrap gap-1"
                  >
                    {c.sports.map((s) => (
                      <li key={s}>
                        <StatusBadge variant="neutral" icon={null}>
                          {tSports(s)}
                        </StatusBadge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          ))}
        </ul>
      )}
    </Band>
  );
}

export async function ForClubsSection({ privacyHref }: { privacyHref: string | null }) {
  const t = await getTranslations('landing.clubs');
  const benefits: Array<{ key: 'diary' | 'free' | 'payAtClub' | 'onboarding'; icon: Icon }> = [
    { key: 'diary', icon: CalendarDays },
    { key: 'free', icon: Gift },
    { key: 'payAtClub', icon: CircleCheck },
    { key: 'onboarding', icon: Sparkle3 },
  ];
  return (
    <Band id="clubs" labelledBy="landing-clubs" testId="landing-clubs">
      <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
        <div className="flex flex-col gap-8">
          <SectionHead
            id="landing-clubs"
            eyebrow={t('eyebrow')}
            title={t('title')}
            lead={t('lead')}
          />
          <ul className="flex flex-col gap-5">
            {benefits.map(({ key, icon }) => (
              <li key={key} className="flex gap-4">
                <IconDisc icon={icon} />
                <div className="flex flex-col gap-1">
                  <Heading level={3} className="text-base">
                    {t(`${key}.title`)}
                  </Heading>
                  <Caption>{t(`${key}.body`)}</Caption>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <Card as="div" elevation="raised" density="comfortable" className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Heading level={3} as="h3" className="text-lg">
              {t('form.title')}
            </Heading>
            <Caption>{t('form.lead')}</Caption>
          </div>
          <ContactForm privacyHref={privacyHref} />
        </Card>
      </div>
    </Band>
  );
}

/** The closing band: one more way into the courts, at auto prefetch. */
export async function ClosingSection() {
  const t = await getTranslations('landing.closing');
  return (
    <Band labelledBy="landing-closing" tone="muted" testId="landing-closing">
      <div className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-2">
          <Heading level={2} id="landing-closing" className="text-2xl tracking-tight md:text-3xl">
            {t('title')}
          </Heading>
          <p className="text-content-default">{t('lead')}</p>
        </div>
        {/* Auto prefetch: the hero's link to /venues is the one full-prefetch
            site on this page (docs/perf/navigation-policy.md). */}
        <Link href="/venues" className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
          {t('cta')}
        </Link>
      </div>
    </Band>
  );
}
