import { globSync, readFileSync } from 'node:fs';

import ts from 'typescript';

/**
 * NO PROFILE PICTURE POINTS AT GOOGLE OR META (#458).
 *
 * A picture shown from `lh3.googleusercontent.com` or Facebook's CDN sends the
 * viewer's IP address to Google or Meta, and Facebook's URLs expire. Sign-in
 * now keeps our own copy (src/lib/media/avatars.ts), and this pins the three
 * ways a provider's URL could come back:
 *
 *   1. A WRITE. Every `avatarUrl` written to a User, in src/ and scripts/, is
 *      `null` or `ownAvatar(...)`, which throws on anything but our copy's
 *      key. So no stored avatarUrl is a provider's URL.
 *   2. A READ. Every file that selects `avatarUrl` maps it through
 *      `avatarUrlOf`, which returns our media URL or null, so no page, API
 *      answer or export carries what is stored raw. A provider's URL stored
 *      before #458 shows the initials until scripts/backfill-avatars.ts copies
 *      it. Hence no rendered <img> points at a provider.
 *   3. A LITERAL. The provider picture hosts appear only in the modules that
 *      recognise them.
 */

const SRC = globSync('src/**/*.{ts,tsx}').map((f) => f.toString());
const SCRIPTS = globSync('scripts/**/*.ts').map((f) => f.toString());

/** Files that read `avatarUrl` and hand nothing to a page, and why. */
const READS_WITHOUT_SHOWING: Record<string, string> = {
  'src/auth.ts': 'reads the stored key at sign-in, to decide whether to copy the picture again',
  'src/lib/media/avatar-objects.ts':
    'the sweep compares stored keys with the objects in storage, and shows nothing',
};

/** Where the provider picture hosts may be written, and why. */
const HOSTS_ALLOWED: Record<string, string> = {
  'src/lib/auth/facebook.ts': 'recognises a Facebook picture URL (FACEBOOK_PICTURE_DOMAINS)',
  'src/lib/media/avatar-url.ts': 'recognises a provider picture URL, to refuse and replace it',
  'src/lib/media/avatars.ts': 'asks Google for the picture at our size (atOurSize)',
};

const PROVIDER_HOST = /googleusercontent\.com|fbsbx\.com|fbcdn\.net/;
const USER_WRITES = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert']);

interface Finding {
  file: string;
  line: number;
  text: string;
}

/** Every `avatarUrl` a `*.user.<write>(...)` call writes that is not null or `ownAvatar(...)`. */
function unguardedAvatarWrites(file: string, text: string): Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Finding[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const checkData = (obj: ts.Expression) => {
    if (!ts.isObjectLiteralExpression(obj)) return;
    for (const p of obj.properties) {
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'avatarUrl') {
        out.push({ file, line: at(p), text: p.getText(sf) });
      }
      if (!ts.isPropertyAssignment(p) || p.name.getText(sf) !== 'avatarUrl') continue;
      const v = p.initializer;
      const ok =
        v.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isCallExpression(v) &&
          ts.isIdentifier(v.expression) &&
          v.expression.text === 'ownAvatar');
      if (!ok) out.push({ file, line: at(p), text: p.getText(sf) });
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      USER_WRITES.has(node.expression.name.text) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'user'
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const key = p.name.getText(sf);
          if (key === 'data' || key === 'create' || key === 'update') {
            const v = p.initializer;
            if (ts.isArrayLiteralExpression(v)) v.elements.forEach(checkData);
            else checkData(v);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const show = (fs: Finding[]) => fs.map((f) => `${f.file}:${f.line}  ${f.text}`);

describe('profile pictures are ours (#458)', () => {
  it('the scans read the tree', () => {
    expect(SRC.length).toBeGreaterThan(300);
    expect(SRC).toContain('src/auth.ts');
    expect(SCRIPTS).toContain('scripts/backfill-avatars.ts');
  });

  it('1. every avatarUrl written to a User is null or ownAvatar(...)', () => {
    const found = [...SRC, ...SCRIPTS].flatMap((f) =>
      unguardedAvatarWrites(f, readFileSync(f, 'utf8')),
    );
    expect(show(found)).toEqual([]);
    // And sign-in, the account deletion and the backfill are among the writers.
    const writers = [...SRC, ...SCRIPTS].filter((f) =>
      /avatarUrl:\s*(null|ownAvatar\()/.test(readFileSync(f, 'utf8')),
    );
    expect(writers).toEqual(
      expect.arrayContaining([
        'src/auth.ts',
        'src/app-layer/usecases/account-deletion.ts',
        'scripts/backfill-avatars.ts',
      ]),
    );
  });

  it('2. every file that reads avatarUrl shows it through avatarUrlOf', () => {
    const readers = SRC.filter((f) => /avatarUrl:\s*true/.test(readFileSync(f, 'utf8')));
    expect(readers.length).toBeGreaterThanOrEqual(5);
    const raw = readers.filter(
      (f) => !(f in READS_WITHOUT_SHOWING) && !/\bavatarUrlOf\(/.test(readFileSync(f, 'utf8')),
    );
    expect(raw).toEqual([]);
    for (const [f, why] of Object.entries(READS_WITHOUT_SHOWING)) {
      expect(readers).toContain(f);
      expect(why.length).toBeGreaterThan(30);
    }
  });

  it('3. the provider picture hosts are written only where they are recognised', () => {
    const offenders = SRC.filter(
      (f) => !(f in HOSTS_ALLOWED) && PROVIDER_HOST.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
    for (const f of Object.keys(HOSTS_ALLOWED)) {
      expect(PROVIDER_HOST.test(readFileSync(f, 'utf8'))).toBe(true);
    }
  });

  it('negative control: a provider URL, a variable or a shorthand is caught; null and ownAvatar pass', () => {
    const src = `
      db.user.update({ where: { id }, data: { avatarUrl: user.image } });
      tx.user.upsert({ where: { email }, create: { email, avatarUrl }, update: {} });
      prisma.user.updateMany({ where: {}, data: { avatarUrl: 'https://lh3.googleusercontent.com/a/x' } });
      db.user.update({ where: { id }, data: { avatarUrl: null } });
      db.user.update({ where: { id }, data: { avatarUrl: ownAvatar(key) } });
      db.venue.update({ where: { id }, data: { avatarUrl: anything } });
    `;
    expect(unguardedAvatarWrites('x.ts', src).map((f) => f.line)).toEqual([2, 3, 4]);
  });
});
