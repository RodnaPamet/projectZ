import { globSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

import ts from 'typescript';

import { aliasTarget } from '../../scripts/ui-sync/inflect-package.mjs';

/**
 * WHICH TRANSLATION NAMESPACES CAN A ROUTE'S BROWSER CODE ASK FOR? (#599)
 *
 * The scan behind i18n-client-messages. From each route file (a page, a
 * layout, a loading or error boundary) it follows the static imports, the
 * `export … from` re-exports and the `import('…')` calls through `src/`. A
 * module is browser code when it says 'use client', or when browser code
 * imports it. In every such module it records the namespace each
 * `useTranslations(…)` call binds:
 *
 *   useTranslations('admin.calendar')   admin.calendar
 *   useTranslations()                   ''           the whole catalogue
 *   useTranslations(ns)                 '<dynamic>'  a namespace the scan cannot read
 *
 * A server component's `useTranslations` reads the request's catalogue on the
 * server, so it is not recorded. Nor is anything a 'use server' module does:
 * browser code imports one as a reference to call, not as code to run.
 * Type-only imports are skipped; a barrel counts every module it re-exports,
 * which can only add namespaces.
 */

type ModuleInfo = { client: boolean; server: boolean; imports: string[]; namespaces: string[] };

export const ROUTE_FILES = (): string[] =>
  globSync(
    'src/app/**/{page,layout,loading,error,not-found,template,default,global-error,forbidden,unauthorized}.tsx',
  )
    .map(String)
    .filter((f) => !f.startsWith('src/app/api/'))
    .sort();

/**
 * The file an import names, or null for a package or a file that isn't
 * TypeScript. `@/` and the vendored `@inflect/ui/` both map into src/, as in
 * client-boundary.
 */
function resolveImport(from: string, spec: string): string | null {
  let base: string | null = aliasTarget(spec);
  if (base === null && spec.startsWith('.')) base = normalize(join(dirname(from), spec));
  if (base === null) return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (/\.tsx?$/.test(candidate) && statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      return candidate;
    }
  }
  return null;
}

function directives(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) break;
    out.push(st.expression.text);
  }
  return out;
}

const typeOnly = (n: ts.ImportDeclaration | ts.ExportDeclaration): boolean => {
  if (ts.isExportDeclaration(n)) {
    return (
      n.isTypeOnly ||
      (!!n.exportClause &&
        ts.isNamedExports(n.exportClause) &&
        n.exportClause.elements.length > 0 &&
        n.exportClause.elements.every((e) => e.isTypeOnly))
    );
  }
  const clause = n.importClause;
  if (!clause) return false; // a side-effect import runs
  if (clause.isTypeOnly) return true;
  const named = clause.namedBindings;
  return (
    !clause.name &&
    !!named &&
    ts.isNamedImports(named) &&
    named.elements.length > 0 &&
    named.elements.every((e) => e.isTypeOnly)
  );
};

const cache = new Map<string, ModuleInfo>();

function moduleInfo(file: string): ModuleInfo {
  const hit = cache.get(file);
  if (hit) return hit;
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const prologue = directives(sf);
  const specs: string[] = [];
  const namespaces: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      !typeOnly(n)
    ) {
      specs.push(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n)) {
      const [arg] = n.arguments;
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword && arg && ts.isStringLiteral(arg)) {
        specs.push(arg.text);
      }
      if (ts.isIdentifier(n.expression) && n.expression.text === 'useTranslations') {
        if (!arg) namespaces.push('');
        else if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
          namespaces.push(arg.text);
        else namespaces.push('<dynamic>');
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const info: ModuleInfo = {
    client: prologue.includes('use client'),
    server: prologue.includes('use server'),
    imports: specs.map((s) => resolveImport(file, s)).filter((f): f is string => f !== null),
    namespaces,
  };
  cache.set(file, info);
  return info;
}

/** Every namespace the browser code under one route file binds, and the module that binds each. */
export function clientNamespacesOf(entry: string): Map<string, string> {
  const found = new Map<string, string>();
  const seen = new Set<string>();
  const walk = (file: string, inBrowser: boolean) => {
    const info = moduleInfo(file);
    if (inBrowser && info.server) return;
    const browser = inBrowser || info.client;
    const key = `${browser ? 'c' : 's'}:${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (browser) for (const ns of info.namespaces) if (!found.has(ns)) found.set(ns, file);
    for (const next of info.imports) walk(next, browser);
  };
  walk(entry, false);
  return found;
}

/** The fewest dotted paths that cover every namespace: `admin` covers `admin.calendar`. */
export function minimalCover(namespaces: Iterable<string>): string[] {
  const all = [...new Set(namespaces)].sort();
  return all.filter((p) => !all.some((q) => q !== p && p.startsWith(`${q}.`)));
}
