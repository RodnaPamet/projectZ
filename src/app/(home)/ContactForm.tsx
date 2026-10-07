'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';

import type { ContactField, ContactResult } from '@/app-layer/usecases/contact-requests';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Caption, TextLink } from '@/components/ui/typography';

import { submitContactAction } from './actions';

/**
 * The "For clubs" contact form (#369): vendored fields, a Server Action.
 *
 * Everything is decided on the server (`submitContactRequest`); this only
 * shows its answer in the visitor's language. Field errors come back as codes
 * and are worded here from `landing.clubs.form.errors.*`.
 *
 * ═══ CONTROLLED FIELDS ═══
 *
 * React resets an uncontrolled form after its action runs. On a validation
 * error that would empty everything the person typed, so the fields hold
 * their own values.
 *
 * ═══ A DEPLOY BETWEEN LOAD AND SUBMIT ═══
 *
 * A Server Action's id is per build. A tab opened before a release posts an id
 * the new server does not know, and the call throws. That is caught and said
 * plainly ("reload the page") rather than handed to the error boundary.
 *
 * The honeypot is a real text input moved off screen, out of the tab order and
 * hidden from assistive technology: a person never fills it, a form-filling bot
 * does, and the server then pretends to succeed.
 */

type State = ContactResult | { ok: false; code: 'unavailable' } | null;

async function submit(_previous: State, form: FormData): Promise<State> {
  try {
    // The action keeps no state between calls; the previous answer is ours.
    return await submitContactAction(null, form);
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}

export function ContactForm({ privacyHref }: { privacyHref: string }) {
  const t = useTranslations('landing.clubs.form');
  const [state, action, pending] = useActionState<State, FormData>(submit, null);
  const [values, setValues] = useState<Record<ContactField, string>>({
    name: '',
    clubName: '',
    phone: '',
    email: '',
    message: '',
  });

  if (state?.ok) {
    return (
      <div role="status" data-testid="contact-success">
        <InlineNotice variant="success" title={t('success.title')}>
          {t('success.body')}
        </InlineNotice>
      </div>
    );
  }

  const fieldErrors = state && !state.ok && state.code === 'invalid' ? state.fieldErrors : {};
  const errorOf = (f: ContactField) => {
    const code = fieldErrors[f];
    return code ? t(`errors.${code}`) : undefined;
  };
  const formError =
    state && !state.ok && state.code !== 'invalid' ? t(`errors.${state.code}`) : null;
  const bind = (f: ContactField) => ({
    name: f,
    value: values[f],
    onChange: (e: { target: { value: string } }) =>
      setValues((v) => ({ ...v, [f]: e.target.value })),
  });

  return (
    <form action={action} noValidate className="flex flex-col gap-4" data-testid="contact-form">
      {formError && (
        <InlineNotice variant="error" data-testid="contact-error">
          {formError}
        </InlineNotice>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('name')} error={errorOf('name')} required>
          <Input {...bind('name')} autoComplete="name" maxLength={120} />
        </FormField>
        <FormField label={t('clubName')} error={errorOf('clubName')} required>
          <Input {...bind('clubName')} autoComplete="organization" maxLength={160} />
        </FormField>
        <FormField label={t('phone')} error={errorOf('phone')}>
          <Input {...bind('phone')} type="tel" autoComplete="tel" maxLength={40} />
        </FormField>
        <FormField label={t('email')} error={errorOf('email')}>
          <Input {...bind('email')} type="email" autoComplete="email" maxLength={254} />
        </FormField>
      </div>
      {/* Hidden when a field error already says it. */}
      {!fieldErrors.phone && <Caption className="-mt-2">{t('reachHint')}</Caption>}

      <FormField label={t('message')} error={errorOf('message')} required>
        <Textarea
          {...bind('message')}
          rows={5}
          maxLength={2000}
          placeholder={t('messagePlaceholder')}
        />
      </FormField>

      {/* The honeypot. Not `display: none`, which some bots skip. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label>
          {t('honeypot')}
          <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>

      <Caption>
        {t.rich('privacy', {
          link: (chunks) => (
            <TextLink tone="link" href={privacyHref}>
              {chunks}
            </TextLink>
          ),
        })}
      </Caption>

      <div>
        <Button
          type="submit"
          size="lg"
          loading={pending}
          disabled={pending}
          data-testid="contact-submit"
        >
          {pending ? t('sending') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
