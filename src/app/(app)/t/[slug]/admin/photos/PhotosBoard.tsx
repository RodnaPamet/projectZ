'use client';

import { useActionState, useRef, useState, useTransition, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { VenuePhotoImg } from '@/components/media/venue-photo-img';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  FileDropzone,
  type FileDropzoneHandle,
  type FileUploadHandlerCtx,
} from '@/components/ui/FileDropzone';
import { FormField } from '@/components/ui/form-field';
import { ChevronUp, Trash } from '@/components/ui/icons/nucleo';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Caption, Heading, TextLink } from '@/components/ui/typography';
import { cn } from '@/lib/cn';
import type { PhotoView } from '@/lib/media/photo-shape';

import {
  deletePhotoAction,
  movePhotoAction,
  updatePhotoAltAction,
  type PhotoActionResult,
} from './actions';

/** Loaded on the first ask, as on the courts board: most visits never delete. */
const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);

export interface PhotosVenue {
  id: string;
  name: string;
  publicSlug: string | null;
  cover: PhotoView | null;
  gallery: PhotoView[];
}

export interface PhotoLimits {
  maxGallery: number;
  maxMb: number;
  maxBytes: number;
  maxAlt: number;
  minPx: number;
}

type ErrorCode = Extract<PhotoActionResult, { ok: false }>['error'] | 'generic';

/** The sentence for a refusal, with the numbers the messages name. */
function useErrorText() {
  const t = useTranslations('admin.photos.errors');
  return (code: ErrorCode, limits: PhotoLimits) =>
    t(code, { max: limits.maxAlt, mb: limits.maxMb, min: limits.minPx });
}

/**
 * The photo screen's interactive half (#366). The page reads and authorises;
 * this holds the forms.
 *
 * Vendored upstream pieces only: Card, Button, FileDropzone, FormField, Input,
 * InlineNotice and ConfirmDialog. FileDropzone came once upstream made it
 * portable (#428, upstream be83732e8): its copy is `common.upload`, in the
 * reader's language. Reordering is up/down buttons: upstream has no sortable
 * list.
 */
export function PhotosBoard({
  slug,
  venues,
  uploadsEnabled,
  limits,
}: {
  slug: string;
  venues: PhotosVenue[];
  uploadsEnabled: boolean;
  limits: PhotoLimits;
}) {
  return (
    <div className="gap-section grid">
      {venues.map((v) => (
        <VenuePhotosCard
          key={v.id}
          slug={slug}
          venue={v}
          uploadsEnabled={uploadsEnabled}
          limits={limits}
        />
      ))}
    </div>
  );
}

function VenuePhotosCard({
  slug,
  venue,
  uploadsEnabled,
  limits,
}: {
  slug: string;
  venue: PhotosVenue;
  uploadsEnabled: boolean;
  limits: PhotoLimits;
}) {
  const t = useTranslations('admin.photos');
  const full = venue.gallery.length >= limits.maxGallery;

  return (
    <Card as="section" density="compact" aria-labelledby={`venue-${venue.id}`}>
      <div className="mb-default flex flex-wrap items-baseline justify-between gap-2">
        <Heading level={2} id={`venue-${venue.id}`}>
          {venue.name}
        </Heading>
        {venue.publicSlug && (
          <TextLink tone="link" href={`/venues/${encodeURIComponent(venue.publicSlug)}`}>
            {t('viewPublic', { venue: venue.name })}
          </TextLink>
        )}
      </div>

      <div className="gap-default grid">
        <section aria-labelledby={`cover-${venue.id}`} className="gap-compact grid">
          <div>
            <Heading level={3} id={`cover-${venue.id}`}>
              {t('cover.title')}
            </Heading>
            <Caption>{t('cover.description')}</Caption>
          </div>
          {venue.cover ? (
            <PhotoEditor slug={slug} photo={venue.cover} limits={limits} isCover />
          ) : (
            <Caption>{t('cover.none')}</Caption>
          )}
          {uploadsEnabled && (
            <UploadForm
              slug={slug}
              venueId={venue.id}
              kind="cover"
              label={venue.cover ? t('cover.replace') : t('upload.choose')}
              limits={limits}
            />
          )}
        </section>

        <section aria-labelledby={`gallery-${venue.id}`} className="gap-compact grid">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Heading level={3} id={`gallery-${venue.id}`}>
              {t('gallery.title')}
            </Heading>
            <Caption>
              {t('gallery.count', { count: venue.gallery.length, max: limits.maxGallery })}
            </Caption>
          </div>
          {venue.gallery.length === 0 ? (
            <Caption>{t('gallery.empty')}</Caption>
          ) : (
            <ol
              aria-label={t('gallery.label', { venue: venue.name })}
              className="gap-default grid sm:grid-cols-2"
            >
              {venue.gallery.map((p, i) => (
                <li key={p.id}>
                  <PhotoEditor
                    slug={slug}
                    photo={p}
                    limits={limits}
                    first={i === 0}
                    last={i === venue.gallery.length - 1}
                  />
                </li>
              ))}
            </ol>
          )}
          {uploadsEnabled &&
            (full ? (
              <InlineNotice variant="info">{t('gallery.full')}</InlineNotice>
            ) : (
              <UploadForm
                slug={slug}
                venueId={venue.id}
                kind="gallery"
                label={t('upload.choose')}
                limits={limits}
              />
            ))}
        </section>
      </div>
    </Card>
  );
}

/** One stored photo: its preview, its alt text, and its order and removal controls. */
function PhotoEditor({
  slug,
  photo,
  limits,
  isCover = false,
  first = false,
  last = false,
}: {
  slug: string;
  photo: PhotoView;
  limits: PhotoLimits;
  isCover?: boolean;
  first?: boolean;
  last?: boolean;
}) {
  const t = useTranslations('admin.photos');
  const errorText = useErrorText();
  const [altState, saveAlt, savingAlt] = useActionState(
    updatePhotoAltAction.bind(null, slug, photo.id),
    null,
  );
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<ErrorCode | null>(null);
  const [asked, setAsked] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const run = (fn: () => Promise<PhotoActionResult>) =>
    startTransition(async () => {
      setFailure(null);
      try {
        const res = await fn();
        if (!res.ok) setFailure(res.error);
      } catch {
        setFailure('generic');
      }
    });

  return (
    <div className="gap-compact grid">
      <VenuePhotoImg
        photo={photo}
        sizes={isCover ? '(min-width: 768px) 720px, 100vw' : '(min-width: 640px) 360px, 100vw'}
        className={cn('bg-bg-muted w-full rounded-md', isCover ? 'aspect-[3/1]' : 'aspect-[4/3]')}
      />
      <form action={saveAlt} className="gap-compact flex flex-wrap items-end">
        <div className="min-w-0 flex-1">
          <FormField label={t('photo.altLabel')} required>
            <Input name="alt" defaultValue={photo.alt} maxLength={limits.maxAlt} required />
          </FormField>
        </div>
        <Button type="submit" variant="secondary" disabled={savingAlt}>
          {t('photo.save')}
        </Button>
      </form>
      {altState && !savingAlt && !altState.ok && (
        <InlineNotice variant="error">{errorText(altState.error, limits)}</InlineNotice>
      )}
      {altState?.ok && !savingAlt && (
        <InlineNotice variant="success">{t('photo.saved')}</InlineNotice>
      )}

      <div className="gap-tight flex flex-wrap">
        {!isCover && (
          <>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              aria-label={t('photo.moveUp', { alt: photo.alt })}
              disabled={first || pending}
              onClick={() => run(() => movePhotoAction(slug, photo.id, 'up'))}
            >
              <ChevronUp aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              aria-label={t('photo.moveDown', { alt: photo.alt })}
              disabled={last || pending}
              onClick={() => run(() => movePhotoAction(slug, photo.id, 'down'))}
            >
              <ChevronUp aria-hidden="true" className="rotate-180" />
            </Button>
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          aria-label={isCover ? undefined : t('photo.delete', { alt: photo.alt })}
          icon={<Trash aria-hidden="true" />}
          onClick={() => {
            setAsked(true);
            setConfirming(true);
          }}
        >
          {isCover ? t('cover.remove') : t('photo.deleteAction')}
        </Button>
      </div>
      {failure && <InlineNotice variant="error">{errorText(failure, limits)}</InlineNotice>}

      {asked && (
        <ConfirmDialog
          showModal={confirming}
          setShowModal={setConfirming}
          tone="danger"
          title={isCover ? t('cover.removeTitle') : t('photo.deleteTitle')}
          description={isCover ? t('cover.removeConfirm') : t('photo.deleteConfirm')}
          confirmLabel={isCover ? t('cover.remove') : t('photo.deleteAction')}
          cancelLabel={t('photo.cancel')}
          onConfirm={() => run(() => deletePhotoAction(slug, photo.id))}
        />
      )}
    </div>
  );
}

/**
 * Choose a file, describe it, upload it (#366). The file is picked in the
 * vendored FileDropzone (#428): by drag-and-drop or by browsing, checked
 * against the accepted types and the size limit there, in the reader's
 * language. It waits (`autoStart={false}`) until the description is written
 * and the form is sent; the upload posts multipart to the upload route (an
 * event handler, not an effect), then refreshes the page's server data.
 *
 * `accept` lists JPEG, PNG and WebP and NOT HEIC on purpose: iOS then converts
 * a photo from the library to JPEG as it hands it over (image.ts).
 */
function UploadForm({
  slug,
  venueId,
  kind,
  label,
  limits,
}: {
  slug: string;
  venueId: string;
  kind: 'cover' | 'gallery';
  label: string;
  limits: PhotoLimits;
}) {
  const t = useTranslations('admin.photos');
  const errorText = useErrorText();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const dropRef = useRef<FileDropzoneHandle>(null);
  // The refusal of the upload in flight, read once the drop zone settles.
  const failure = useRef<ErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<
    { ok: true } | { ok: false; error: ErrorCode } | { ok: false; noFile: true } | null
  >(null);

  /** One file to the upload route; a refusal becomes the row's own words. */
  async function upload(file: File, ctx: FileUploadHandlerCtx) {
    const data = new FormData();
    data.set('file', file);
    data.set('alt', String(new FormData(formRef.current ?? undefined).get('alt') ?? ''));
    data.set('kind', kind);
    ctx.onProgress(null);
    let error: ErrorCode;
    try {
      const res = await fetch(
        `/api/t/${encodeURIComponent(slug)}/admin/venues/${encodeURIComponent(venueId)}/photos`,
        { method: 'POST', body: data, credentials: 'same-origin', signal: ctx.signal },
      );
      if (res.ok) return null;
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      const code = body?.error?.code;
      error = isKnown(code) ? code : 'generic';
    } catch {
      // The browser's own wording ("Failed to fetch") would reach the row.
      error = 'generic';
    }
    failure.current = error;
    throw new Error(errorText(error, limits));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const queued = dropRef.current?.getEntries().filter((x) => x.status === 'queued') ?? [];
    if (queued.length === 0) {
      setState({ ok: false, noFile: true });
      return;
    }
    failure.current = null;
    setBusy(true);
    setState(null);
    try {
      await dropRef.current?.startAll();
    } finally {
      setBusy(false);
    }
    if (failure.current) {
      setState({ ok: false, error: failure.current });
      return;
    }
    formRef.current?.reset();
    setState({ ok: true });
    router.refresh();
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      className="gap-compact grid"
      data-testid={`photo-upload-${kind}`}
    >
      <FileDropzone
        ref={dropRef}
        accept="image/jpeg,image/png,image/webp"
        maxFileSizeMB={limits.maxMb}
        multiple={false}
        autoStart={false}
        clearAfterMs={4000}
        compact
        title={label}
        hint={t('upload.hint', { mb: limits.maxMb })}
        onUpload={upload}
        onPick={() => setState(null)}
        inputId={`upload-${venueId}-${kind}`}
        data-testid={`photo-dropzone-${kind}`}
      />
      <div className="gap-compact flex flex-wrap items-end">
        <div className="min-w-0 flex-1">
          <FormField label={t('upload.alt')} description={t('upload.altHint')} required>
            <Input name="alt" maxLength={limits.maxAlt} required />
          </FormField>
        </div>
        <Button type="submit" loading={busy} disabled={busy}>
          {busy ? t('upload.uploading') : t('upload.submit')}
        </Button>
      </div>
      {state && !busy && !state.ok && (
        <InlineNotice variant="error">
          {'noFile' in state ? t('upload.noFile') : errorText(state.error, limits)}
        </InlineNotice>
      )}
      {state?.ok && !busy && <InlineNotice variant="success">{t('upload.done')}</InlineNotice>}
    </form>
  );
}

const KNOWN = new Set<string>([
  'VENUE_NOT_FOUND',
  'PHOTO_NOT_FOUND',
  'ALT_REQUIRED',
  'ALT_TOO_LONG',
  'GALLERY_FULL',
  'MEDIA_NOT_CONFIGURED',
  'UNSUPPORTED_TYPE',
  'TOO_LARGE',
  'TOO_MANY_PIXELS',
  'TOO_SMALL',
  'UNREADABLE',
]);

function isKnown(code: string | undefined): code is ErrorCode {
  return !!code && KNOWN.has(code);
}
