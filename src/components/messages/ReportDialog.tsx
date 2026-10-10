'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, type Dispatch, type SetStateAction } from 'react';

import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { Modal } from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { REPORT_DETAILS_MAX, REPORT_REASONS, type ReportReason } from '@/lib/messaging/report';

/**
 * "Подай сигнал" (#375): report a message or a whole conversation to the
 * platform's moderators — a reason, and the person's own words if they want.
 * The vendored Modal (a dialog from `sm`, a drawer on a phone) over the
 * vendored RadioGroup and Textarea. The other side is never told; the
 * moderator never learns who reported. Mounted afresh for each report (the
 * caller keys it), so nothing from the last one lingers.
 */
export function ReportDialog({
  open,
  setOpen,
  subject,
  onSubmit,
}: {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  /** What is reported: one message, or the whole conversation. */
  subject: 'message' | 'conversation';
  /** Sends the report; rejects on a refusal. */
  onSubmit: (report: { reason: ReportReason; details: string }) => Promise<unknown>;
}) {
  const t = useTranslations('messaging.report');
  const ids = useId();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);
  const [state, setState] = useState<'idle' | 'sent' | 'failed'>('idle');

  async function send() {
    if (!reason) return;
    setSending(true);
    setState('idle');
    try {
      await onSubmit({ reason, details: details.trim() });
      setState('sent');
      setReason(null);
      setDetails('');
    } catch {
      setState('failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      showModal={open}
      setShowModal={setOpen}
      size="sm"
      title={subject === 'message' ? t('titleMessage') : t('titleConversation')}
    >
      <Modal.Header
        title={subject === 'message' ? t('titleMessage') : t('titleConversation')}
        description={t('description')}
      />
      <Modal.Form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Modal.Body className="gap-section grid content-start" data-testid="report-dialog">
          {state === 'sent' ? (
            <InlineNotice variant="success" data-testid="report-sent">
              {t('sent')}
            </InlineNotice>
          ) : (
            <>
              <fieldset className="gap-tight grid">
                <legend id={`${ids}-legend`} className="text-content-default mb-2 text-sm">
                  {t('reasonLabel')}
                </legend>
                <RadioGroup
                  value={reason ?? ''}
                  onValueChange={(v) => setReason(v as ReportReason)}
                  aria-labelledby={`${ids}-legend`}
                >
                  {REPORT_REASONS.map((r) => (
                    <div key={r} className="flex min-h-11 items-center gap-2">
                      <RadioGroupItem
                        value={r}
                        id={`${ids}-${r}`}
                        data-testid={`report-reason-${r}`}
                      />
                      <Label htmlFor={`${ids}-${r}`} className="cursor-pointer">
                        {t(`reason.${r}`)}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </fieldset>
              <div className="gap-tight grid">
                <Label htmlFor={`${ids}-details`}>{t('detailsLabel')}</Label>
                <Textarea
                  id={`${ids}-details`}
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  rows={3}
                  maxLength={REPORT_DETAILS_MAX}
                  data-testid="report-details"
                />
              </div>
              {state === 'failed' ? (
                <InlineNotice variant="error" data-testid="report-failed">
                  {t('failed')}
                </InlineNotice>
              ) : null}
            </>
          )}
        </Modal.Body>
        <Modal.Actions>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            {state === 'sent' ? t('close') : t('cancel')}
          </Button>
          {state === 'sent' ? null : (
            <Button
              type="submit"
              variant="destructive"
              disabled={!reason}
              loading={sending}
              data-testid="report-submit"
            >
              {t('submit')}
            </Button>
          )}
        </Modal.Actions>
      </Modal.Form>
    </Modal>
  );
}
