'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';

import { ArchiveCourtButton, CourtForm, type CourtFormValues } from './CourtForm';

/**
 * The courts screen's interactive half.
 *
 * The page stays a server component — it resolves the tenant, checks the
 * permission and runs the query inside `runInTenantContext`. Only the bits that
 * need state live here, and they receive plain serialisable data.
 *
 * Money is formatted with next-intl's `useFormatter`, not `'€' + toFixed(2)`:
 * Bulgarian writes `24,00 €`, with the symbol trailing and a comma decimal.
 */

export interface CourtRow extends CourtFormValues {
  id: string;
  status: string;
  venueName: string;
  upcomingBookings: number;
}

export function CourtsBoard({
  slug,
  courts,
  venues,
}: {
  slug: string;
  courts: readonly CourtRow[];
  venues: ReadonlyArray<{ id: string; name: string }>;
}) {
  const t = useTranslations('admin.courts');
  const format = useFormatter();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: 'EUR' });

  return (
    <>
      <div className="mb-4">
        {adding ? (
          <CourtForm slug={slug} venues={venues} onDone={() => setAdding(false)} />
        ) : (
          // A club with no venue has nowhere to put a court, and a form whose
          // only select is empty is a worse explanation than not offering it.
          <Button type="button" onClick={() => setAdding(true)} disabled={venues.length === 0}>
            {t('action.add')}
          </Button>
        )}
        {venues.length === 0 && <p className="text-content-muted mt-2 text-sm">{t('needVenue')}</p>}
      </div>

      {courts.length === 0 ? (
        <EmptyState title={t('empty.title')} description={t('empty.description')} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {courts.map((court) => (
            <li key={court.id} className="border-border-subtle bg-bg-surface rounded-lg border p-4">
              {editingId === court.id ? (
                <CourtForm slug={slug} court={court} onDone={() => setEditingId(null)} />
              ) : (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="font-medium">{court.name}</h2>
                      <p className="text-content-muted text-sm">{court.venueName}</p>
                    </div>
                    <StatusBadge variant={court.status === 'ACTIVE' ? 'success' : 'neutral'}>
                      {t(`status.${court.status}`)}
                    </StatusBadge>
                  </div>

                  <dl className="text-content-muted mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <dt>{t('field.setting')}</dt>
                    <dd className="text-content-default">
                      {court.isIndoor ? t('setting.indoor') : t('setting.outdoor')}
                    </dd>
                    <dt>{t('field.capacity')}</dt>
                    <dd className="text-content-default">
                      {t('capacity', { count: court.capacity })}
                    </dd>
                    <dt>{t('field.basePrice')}</dt>
                    <dd className="text-content-default">{money(court.basePriceCents)}</dd>
                  </dl>

                  <div className="mt-3 flex gap-2">
                    <Button type="button" variant="ghost" onClick={() => setEditingId(court.id)}>
                      {t('action.edit')}
                    </Button>
                    <ArchiveCourtButton
                      slug={slug}
                      courtId={court.id}
                      archived={court.status === 'CLOSED'}
                      upcomingBookings={court.upcomingBookings}
                    />
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
