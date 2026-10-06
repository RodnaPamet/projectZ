'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import type { DeskCustomerMatchDto } from '@/app/api/v1/_lib/desk-dto';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FieldGroup } from '@/components/ui/field-group';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { normalizePhone } from '@/lib/booking/phone';
import { KEYS } from '@/lib/data/keys';
import { useV1SWR } from '@/lib/data/use-v1-swr';

/**
 * A desk customer: name, phone, and an optional link to one of the club's
 * players (#364). Shared by the new-booking sheet and the booking's detail.
 *
 * The link has two ways in: search the club's players by name, email or phone,
 * or — when the phone typed belongs to exactly one of them — a one-tap
 * suggestion. Never automatic. The lookup only ever searches THIS club's
 * players (`GET …/admin/customers`), and never shows a phone back.
 */
export interface DeskCustomerValue {
  name: string;
  phone: string;
  linked: ComboboxOption | null;
}

export function DeskCustomerFields({
  slug,
  value,
  onChange,
}: {
  slug: string;
  value: DeskCustomerValue;
  onChange: (next: DeskCustomerValue) => void;
}) {
  const t = useTranslations('admin.calendar.desk.create');
  const ids = useId();
  const [search, setSearch] = useState('');
  const { name, phone, linked } = value;

  const e164 = normalizePhone(phone);
  const phoneMatches = useV1SWR<DeskCustomerMatchDto[]>(
    e164 && !linked ? KEYS.deskCustomers(slug, e164) : null,
    { revalidateOnFocus: false },
  );
  const suggestion = phoneMatches.data?.length === 1 ? phoneMatches.data[0]! : null;

  const term = search.trim();
  const found = useV1SWR<DeskCustomerMatchDto[]>(
    term.length >= 2 ? KEYS.deskCustomers(slug, term) : null,
    { revalidateOnFocus: false, keepPreviousData: true },
  );
  const asOption = (m: DeskCustomerMatchDto): ComboboxOption => ({
    value: m.userId,
    label: m.name ?? m.email,
  });
  const found_ = found.data?.map(asOption) ?? [];
  const options = linked ? [linked, ...found_.filter((o) => o.value !== linked.value)] : found_;

  return (
    <>
      <FieldGroup columns={2}>
        <FormField label={t('name')} required>
          <Input
            id={`${ids}-name`}
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            required
            data-desk-name
          />
        </FormField>
        <FormField label={t('phone')} description={t('phoneHint')} required>
          <Input
            id={`${ids}-phone`}
            type="tel"
            inputMode="tel"
            value={phone}
            maxLength={32}
            autoComplete="off"
            onChange={(e) => onChange({ ...value, phone: e.target.value })}
            required
            data-desk-phone
          />
        </FormField>
      </FieldGroup>

      {suggestion && !linked && (
        <InlineNotice variant="info">
          <span className="gap-tight flex flex-wrap items-center">
            <span>{t('phoneMatch', { name: suggestion.name ?? suggestion.email })}</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onChange({ ...value, linked: asOption(suggestion) })}
            >
              {t('phoneMatchAction', { name: suggestion.name ?? suggestion.email })}
            </Button>
          </span>
        </InlineNotice>
      )}

      <FormField label={t('link')} description={t('linkHint')}>
        <Combobox
          id={`${ids}-player`}
          options={options}
          selected={linked}
          setSelected={(o) => onChange({ ...value, linked: o })}
          onSearchChange={setSearch}
          shouldFilter={false}
          loading={found.isLoading}
          placeholder={t('linkPlaceholder')}
          searchPlaceholder={t('linkSearch')}
          emptyState={term.length >= 2 ? t('linkEmpty') : t('linkSearch')}
          matchTriggerWidth
          caret
          buttonProps={{
            className: 'w-full',
            'aria-label': linked ? `${t('link')}, ${String(linked.label)}` : t('link'),
          }}
        />
      </FormField>
      {linked && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({ ...value, linked: null })}
          >
            {t('unlink')}
          </Button>
        </div>
      )}
    </>
  );
}

/** The customer as the API takes it, or null while it is incomplete. */
export function customerBody(value: DeskCustomerValue) {
  const name = value.name.trim();
  if (name === '' || !normalizePhone(value.phone)) return null;
  return { name, phone: value.phone, userId: value.linked?.value ?? null };
}
