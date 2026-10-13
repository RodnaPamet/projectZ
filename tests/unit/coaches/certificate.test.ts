import {
  CERTIFICATE_MAX_BYTES,
  CertificateRefusedError,
  inspectCertificate,
  openCertificate,
  safeCertificateName,
  sealCertificate,
  sniffCertificateType,
} from '@/lib/coaches/certificate';

/**
 * A coach's certificate (#377): accepted by what it IS, stored sealed, and
 * never opened by anything that did not seal it.
 */
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 3),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WEBP'),
  Buffer.alloc(32, 4),
]);

describe('what a certificate is', () => {
  it.each([
    ['a PDF', PDF, 'application/pdf'],
    ['a JPEG', JPEG, 'image/jpeg'],
    ['a PNG', PNG, 'image/png'],
    ['a WebP', WEBP, 'image/webp'],
  ] as const)('%s, by its first bytes', (_l, bytes, mime) => {
    expect(sniffCertificateType(bytes)).toBe(mime);
  });

  it.each([
    ['an executable', Buffer.from('MZ\x90\x00 this program cannot be run in DOS mode')],
    ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ['a ZIP, which a .docx is', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])],
    ['a PDF header that is not at the start', Buffer.from('xx%PDF-1.7')],
    ['nothing much', Buffer.from('hello')],
  ])('%s is not one, whatever it is called', (_l, bytes) => {
    expect(sniffCertificateType(bytes)).toBeNull();
    expect(() => inspectCertificate(bytes, 'licence.pdf')).toThrow(CertificateRefusedError);
    try {
      inspectCertificate(bytes, 'licence.pdf');
    } catch (e) {
      expect((e as CertificateRefusedError).reason).toBe('NOT_A_CERTIFICATE');
    }
  });

  it('the content decides the type and the extension; the claimed name does not', () => {
    // A JPEG uploaded as "licence.pdf".
    const described = inspectCertificate(JPEG, 'licence.pdf');
    expect(described).toMatchObject({
      mimeType: 'image/jpeg',
      fileName: 'licence.jpg',
      byteSize: JPEG.byteLength,
    });
    expect(described.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an empty file and one over 5 MB, and takes one at exactly the limit', () => {
    const reason = (bytes: Uint8Array) => {
      try {
        inspectCertificate(bytes, 'a.pdf');
        return null;
      } catch (e) {
        return (e as CertificateRefusedError).reason;
      }
    };
    expect(reason(Buffer.alloc(0))).toBe('EMPTY');
    const atLimit = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(CERTIFICATE_MAX_BYTES - 5)]);
    expect(reason(atLimit)).toBeNull();
    expect(reason(Buffer.concat([atLimit, Buffer.from([0])]))).toBe('TOO_LARGE');
  });
});

describe('the name it is kept under', () => {
  it.each([
    ['Лиценз ББФТ 2024.pdf', 'application/pdf', 'Лиценз ББФТ 2024.pdf'],
    ['C:\\Users\\ivan\\Desktop\\licence.PDF', 'application/pdf', 'licence.pdf'],
    ['../../etc/passwd', 'application/pdf', 'passwd.pdf'],
    ['a"b\r\nSet-Cookie: x=1.pdf', 'application/pdf', 'a b Set-Cookie x=1.pdf'],
    ['', 'image/png', 'certificate.png'],
    [undefined, 'image/webp', 'certificate.webp'],
    ['x'.repeat(400) + '.jpg', 'image/jpeg', 'x'.repeat(120) + '.jpg'],
  ] as const)('%s → %s', (raw, mime, expected) => {
    const name = safeCertificateName(raw, mime);
    expect(name).toBe(expected);
    // Nothing a download header could be broken with.
    expect(name).not.toMatch(/[\r\n"\\/]/);
  });
});

describe('the seal', () => {
  it('opens to exactly what was sealed', () => {
    const sealed = sealCertificate(PDF);
    expect(Buffer.compare(openCertificate(sealed), PDF)).toBe(0);
    // The stored bytes are not the document: no header, no content.
    expect(sealed.includes(Buffer.from('%PDF-'))).toBe(false);
    expect(sealed[0]).toBe(0x01);
  });

  it('seals the same file differently each time', () => {
    expect(Buffer.compare(sealCertificate(PDF), sealCertificate(PDF))).not.toBe(0);
  });

  it('refuses a flipped byte, a truncated blob and an unknown version', () => {
    const sealed = sealCertificate(PDF);
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0xff;
    expect(() => openCertificate(flipped)).toThrow();
    expect(() => openCertificate(sealed.subarray(0, 20))).toThrow(/not a sealed file/);
    const versioned = Buffer.from(sealed);
    versioned[0] = 0x02;
    expect(() => openCertificate(versioned)).toThrow(/not a sealed file/);
    // The untouched one still opens: the refusals were about the damage.
    expect(openCertificate(sealed).byteLength).toBe(PDF.byteLength);
  });

  it('a file sealed under another key does not open', () => {
    const sealed = sealCertificate(PDF);
    const saved = process.env.DATA_ENCRYPTION_KEY;
    process.env.DATA_ENCRYPTION_KEY = 'another-key-entirely-0123456789abcdef-0123456789';
    try {
      expect(() => openCertificate(sealed)).toThrow();
    } finally {
      process.env.DATA_ENCRYPTION_KEY = saved;
    }
    expect(openCertificate(sealed).byteLength).toBe(PDF.byteLength);
  });
});
