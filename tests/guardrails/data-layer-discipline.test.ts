import { globSync, readFileSync } from 'node:fs';

import ts from 'typescript';

/**
 * ONE WAY TO READ /api/v1 FROM THE BROWSER: src/lib/data.
 *
 * The client data layer exists so that four things are true of every call —
 * the session and viewer seams stop it, errors carry `status` and `code`,
 * audited reads never fire on their own, keys are spelled once. Each rule below
 * closes one way of quietly going around it:
 *
 *   1. `swr` is imported only by src/lib/data. A raw `useSWR` elsewhere gets
 *      SWR's defaults, a fetcher that may put the status in a message (the bug
 *      inflect's #2222 documents), and keys spelled by hand.
 *   2. No `fetch()` inside a `useEffect` in src/app or src/components. That is
 *      the shape ModerationQueue had before this layer — fetch on an effect,
 *      state in useState — with no dedupe, no seam, and a cleanup race.
 *   3. No `/api/v1/` string outside src/lib/data/keys.ts in client code, so a
 *      cache identity is never spelled twice.
 *   4. No `signOut({ redirect: false })`. It clears the cookie and leaves the
 *      page — and every SWR cache on it — rendered for the account that just
 *      left. The redirect is what throws that memory away.
 *
 * AST, not regex: comments and prose naming these things are not violations,
 * and `fetch` inside a nested callback of an effect still is.
 */

type Finding = { file: string; line: number; what: string };

const ALLOW_SWR_IMPORT: Record<string, string> = {
  'src/components/ui/user-combobox.tsx':
    'vendored from inflect and imported by nothing in playerz (dead). T28 deletes the file and ' +
    'this entry with it; it is not edited here because vendored files change only via copy.mjs.',
};

const ALL = globSync('src/**/*.{ts,tsx}')
  .map((f) => f.toString())
  .filter((f) => !f.endsWith('.d.ts'));

const CLIENT_DIRS = (f: string) =>
  (f.startsWith('src/app/') && !f.startsWith('src/app/api/')) ||
  f.startsWith('src/components/') ||
  f.startsWith('src/lib/data/');

function parse(file: string, text = readFileSync(file, 'utf8')) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function lineOf(sf: ts.SourceFile, node: ts.Node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

const calleeName = (call: ts.CallExpression) => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
};

function swrImports(sf: ts.SourceFile): Finding[] {
  const out: Finding[] = [];
  for (const st of sf.statements) {
    if (
      (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      /^swr(?:\/|$)/.test(st.moduleSpecifier.text)
    ) {
      out.push({
        file: sf.fileName,
        line: lineOf(sf, st),
        what: `import '${st.moduleSpecifier.text}'`,
      });
    }
  }
  return out;
}

function fetchInEffects(sf: ts.SourceFile): Finding[] {
  const out: Finding[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const name = calleeName(n);
    if (name !== 'useEffect' && name !== 'useLayoutEffect') return;
    const body = n.arguments[0];
    if (!body) return;
    walk(body, (m) => {
      if (ts.isCallExpression(m) && calleeName(m) === 'fetch') {
        out.push({ file: sf.fileName, line: lineOf(sf, m), what: `fetch() inside ${name}` });
      }
    });
  });
  return out;
}

function v1Strings(sf: ts.SourceFile): Finding[] {
  const out: Finding[] = [];
  walk(sf, (n) => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) {
      text = n.head.text + n.templateSpans.map((s) => s.literal.text).join('');
    }
    if (text?.includes('/api/v1/') || text === '/api/v1') {
      out.push({ file: sf.fileName, line: lineOf(sf, n), what: `'/api/v1' literal` });
    }
  });
  return out;
}

function signOutWithoutRedirect(sf: ts.SourceFile): Finding[] {
  const out: Finding[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n) || calleeName(n) !== 'signOut') return;
    const arg = n.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return;
    for (const p of arg.properties) {
      if (
        ts.isPropertyAssignment(p) &&
        p.name.getText(sf) === 'redirect' &&
        p.initializer.kind === ts.SyntaxKind.FalseKeyword
      ) {
        out.push({ file: sf.fileName, line: lineOf(sf, n), what: 'signOut({ redirect: false })' });
      }
    }
  });
  return out;
}

const fmt = (fs: Finding[]) => fs.map((f) => `  ${f.file}:${f.line}  ${f.what}`).join('\n');

describe('the scan is not vacuous', () => {
  it('found the source tree and the data layer', () => {
    expect(ALL.length).toBeGreaterThan(200);
    expect(ALL).toContain('src/lib/data/keys.ts');
    expect(ALL).toContain('src/lib/data/use-v1-swr.ts');
  });

  it('the data layer itself imports swr — so rule 1 is looking at real imports', () => {
    expect(swrImports(parse('src/lib/data/use-v1-swr.ts')).length).toBeGreaterThan(0);
  });
});

describe('the rules', () => {
  it('1. swr is imported only by src/lib/data', () => {
    const found = ALL.filter(
      (f) => !f.startsWith('src/lib/data/') && !(f in ALLOW_SWR_IMPORT),
    ).flatMap((f) => swrImports(parse(f)));
    if (found.length) {
      throw new Error(
        `swr imported outside src/lib/data:\n${fmt(found)}\n\n` +
          'Use useV1SWR / useV1SWRInfinite / useV1Mutation from @/lib/data, which carry the ' +
          'session and viewer seams and the audited-read switch.',
      );
    }
  });

  it('1a. every allowlisted file still imports swr, and says why', () => {
    for (const [file, why] of Object.entries(ALLOW_SWR_IMPORT)) {
      expect(why.length).toBeGreaterThan(40);
      // A stale entry is a hole nobody can see: when T28 deletes the file, the
      // line must go too.
      expect(swrImports(parse(file)).length).toBeGreaterThan(0);
    }
  });

  it('2. no fetch() inside an effect in src/app or src/components', () => {
    const found = ALL.filter(
      (f) => f.startsWith('src/app/') || f.startsWith('src/components/'),
    ).flatMap((f) => fetchInEffects(parse(f)));
    if (found.length) {
      throw new Error(
        `fetch() inside an effect:\n${fmt(found)}\n\nRead through useV1SWR (src/lib/data).`,
      );
    }
  });

  it('3. no /api/v1 string in client code outside src/lib/data/keys.ts', () => {
    const found = ALL.filter((f) => CLIENT_DIRS(f) && f !== 'src/lib/data/keys.ts').flatMap((f) =>
      v1Strings(parse(f)),
    );
    if (found.length) {
      throw new Error(
        `/api/v1 spelled outside keys.ts:\n${fmt(found)}\n\nAdd it to KEYS or V1 in src/lib/data/keys.ts.`,
      );
    }
  });

  it('4. no signOut({ redirect: false })', () => {
    const found = ALL.flatMap((f) => signOutWithoutRedirect(parse(f)));
    expect(fmt(found)).toBe('');
  });
});

describe('the detectors fire on the code they forbid', () => {
  const sf = (text: string) => parse('x.tsx', text);

  it('rule 1 sees swr and its subpaths, and not a package that merely starts with it', () => {
    expect(swrImports(sf(`import useSWR from 'swr';`))).toHaveLength(1);
    expect(swrImports(sf(`import x from 'swr/infinite';`))).toHaveLength(1);
    expect(swrImports(sf(`export { mutate } from 'swr';`))).toHaveLength(1);
    expect(swrImports(sf(`import x from 'swrv';`))).toHaveLength(0);
    expect(swrImports(sf(`// import useSWR from 'swr';`))).toHaveLength(0);
  });

  it('rule 2 sees fetch nested anywhere inside an effect, and nowhere else', () => {
    expect(
      fetchInEffects(sf(`useEffect(() => { void (async () => { await fetch('/x'); })(); }, []);`)),
    ).toHaveLength(1);
    expect(fetchInEffects(sf(`React.useEffect(() => { window.fetch('/x'); });`))).toHaveLength(1);
    expect(fetchInEffects(sf(`async function f() { await fetch('/x'); }`))).toHaveLength(0);
    expect(fetchInEffects(sf(`useEffect(() => { /* fetch('/x') */ });`))).toHaveLength(0);
  });

  it('rule 3 sees strings and templates, and not comments', () => {
    expect(v1Strings(sf('const u = `/api/v1/t/${slug}/me`;'))).toHaveLength(1);
    expect(v1Strings(sf(`const u = '/api/v1/venues';`))).toHaveLength(1);
    expect(v1Strings(sf(`// see /api/v1/venues`))).toHaveLength(0);
  });

  it('rule 4 sees redirect: false, and lets the default through', () => {
    expect(signOutWithoutRedirect(sf(`signOut({ redirect: false });`))).toHaveLength(1);
    expect(signOutWithoutRedirect(sf(`signOut({ callbackUrl: '/' });`))).toHaveLength(0);
  });
});
