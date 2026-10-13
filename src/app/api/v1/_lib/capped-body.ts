import type { NextRequest } from 'next/server';

/**
 * Read a request body, and stop at `maxBytes`.
 *
 * `req.formData()` buffers the whole body before a route can look at its
 * size, so an upload route that trusted it would hold whatever a client chose
 * to send. This reads the stream itself: a declared length over the cap is
 * refused before a byte is read, and an undeclared one is cut off as soon as
 * it passes the cap. `tooLarge` makes the route's own error.
 */
export async function readCappedBody(
  req: NextRequest,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<Buffer> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw tooLarge();
  if (!req.body) return Buffer.alloc(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * The one file of a `multipart/form-data` body already read into memory.
 * Null when the body is not multipart, cannot be parsed, or has no file under
 * `field`.
 */
export async function fileFromMultipart(
  body: Buffer,
  contentType: string,
  field = 'file',
): Promise<{ bytes: Buffer; name: string | null } | null> {
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return null;
  let form: FormData;
  try {
    form = await new Request('http://upload.invalid/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: new Uint8Array(body),
    }).formData();
  } catch {
    return null;
  }
  const file = form.get(field);
  if (!(file instanceof Blob)) return null;
  return {
    bytes: Buffer.from(await file.arrayBuffer()),
    name: file instanceof File ? file.name : null,
  };
}
