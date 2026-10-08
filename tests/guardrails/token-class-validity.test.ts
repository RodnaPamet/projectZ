import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { __unstable__loadDesignSystem } from '@tailwindcss/node';
import ts from 'typescript';

import { treeFiles } from '../helpers/scan-floor';

/**
 * EVERY COLOUR, BORDER, RING AND ANIMATION CLASS RESOLVES TO CSS (T29).
 *
 * ═══ WHY ═══
 *
 * Tailwind never fails on a class it does not know. It emits nothing, and the
 * element silently goes unstyled. playerz inherited three vocabularies of
 * semantic class names: its own tokens (`text-content-muted`, `bg-bg-default`),
 * shadcn's (`text-muted-foreground`, `hover:text-foreground`) and inflect's
 * older ones (`bg-bg-surface`, `animate-spinner`). Only the first is in
 * tailwind.config.ts. Measured on main before this guard: 134 distinct
 * bg-/text-/border-/ring-/animate- classes in src string literals, 5 of
 * them compiling to nothing, among them the chess engine credit's GPL licence
 * line (`text-muted-foreground`, so it rendered in the inherited body colour,
 * not the muted one it asked for).
 *
 * Ports two upstream guards in one: content-token-validity (text-*) and
 * no-renegade-bg-tokens (bg-*), widened to border-, ring- and animate-.
 *
 * ═══ HOW ═══
 *
 * The question "does this class exist" is answered by Tailwind itself, not by
 * a copy of the config: src/app/globals.css is loaded into Tailwind's design
 * system (the same @config, @theme and tokens the app builds with), and every
 * candidate goes through `candidatesToCss`, which returns null for a class
 * that produces no CSS. Variants (`hover:`, `group-hover/row:`), opacity
 * (`/50`) and `!` are Tailwind's to parse. A core utility (`text-sm`,
 * `border-2`, `animate-spin`) passes the same way a config key does.
 *
 * Candidates are read from string literals and template parts (AST, so a
 * class named in a comment is prose), split on whitespace, and kept when they
 * look like one of the five families. Arbitrary values (`bg-[var(--x)]`) are
 * always valid CSS to Tailwind and are left to tailwind-css-optimizes-clean.
 *
 * ═══ VENDORED FILES ═══
 *
 * A vendored copy cannot be edited here. Its dead classes are allow-listed
 * with the upstream issue; the next copy.mjs re-sync removes the entry.
 */

const FAMILY =
  /^!?(?:(?:[\w-]+|\[[^\]]*\])(?:\/[\w-]+)?:)*!?-?(?:bg|text|border|ring|animate)-[a-z0-9][\w./-]*!?$/;

const UPSTREAM = 'https://github.com/RodnaPamet/inflect-compliance/issues/3133';

/** class → the files allowed to use it while it compiles to nothing. */
const ALLOWED: Record<string, { files: string[]; reason: string }> = {
  'animate-fadeIn': {
    files: ['src/components/ui/skeleton.tsx'],
    reason: `vendored; no fadeIn animation in either theme, ${UPSTREAM}`,
  },
  'animate-blink': {
    files: ['src/components/ui/icons/loading-dots.tsx'],
    reason: `vendored (pending row, held by the icons barrel); no blink animation, ${UPSTREAM}`,
  },
};

const SOURCE = globSync('src/**/*.{ts,tsx}').map(String).sort();

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** Every family-shaped class in a file's string literals, with its line. */
function candidatesIn(file: string, src: string): Array<{ cls: string; line: number }> {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKind(file));
  const out: Array<{ cls: string; line: number }> = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isStringLiteralLike(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      for (const tok of n.text.split(/\s+/)) if (FAMILY.test(tok)) out.push({ cls: tok, line });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

type DesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;
let ds: DesignSystem;

beforeAll(async () => {
  const globals = path.resolve('src/app/globals.css');
  ds = await __unstable__loadDesignSystem(readFileSync(globals, 'utf8'), {
    base: path.dirname(globals),
  });
}, 60_000);

/** The classes among `classes` that produce no CSS. */
const dead = (classes: string[]) => {
  const css = ds.candidatesToCss(classes);
  return classes.filter((_, i) => css[i] == null);
};

describe('the scan is not vacuous', () => {
  it('reads every source file', () => {
    expect(SOURCE).toEqual(treeFiles(['src'], /\.tsx?$/));
  });

  it('finds the classes, and Tailwind loaded the playerz theme', () => {
    const all = new Set(
      SOURCE.flatMap((f) => candidatesIn(f, readFileSync(f, 'utf8'))).map((c) => c.cls),
    );
    expect(all.size).toBeGreaterThan(100);
    for (const known of ['text-content-muted', 'bg-bg-default', 'border-border-subtle'])
      expect(all).toContain(known);
    // A config-only key compiles: without @config these three would be dead too.
    expect(dead(['text-content-muted', 'bg-brand-emphasis', 'border-border-strong'])).toEqual([]);
  });
});

describe('every semantic utility in src/ resolves', () => {
  it('has no class that compiles to nothing, outside the allow-list', () => {
    const uses = new Map<string, string[]>();
    for (const f of SOURCE)
      for (const { cls, line } of candidatesIn(f, readFileSync(f, 'utf8'))) {
        const at = uses.get(cls) ?? [];
        at.push(`${f}:${line}`);
        uses.set(cls, at);
      }

    const bad = dead([...uses.keys()]).flatMap((cls) =>
      (uses.get(cls) ?? [])
        .filter((at) => !ALLOWED[cls]?.files.includes(at.split(':')[0]!))
        .map((at) => `  ${at}  ${cls}`),
    );
    if (bad.length > 0) {
      throw new Error(
        `${bad.length} class(es) that Tailwind compiles to NOTHING:\n\n${bad.join('\n')}\n\n` +
          `The element renders unstyled, with no warning anywhere. Use a token that\n` +
          `tailwind.config.ts defines: text-content-{emphasis,default,muted,subtle,…},\n` +
          `bg-bg-{default,muted,subtle,elevated,page,…}, border-border-{default,strong,…},\n` +
          `or a core utility. shadcn's text-muted-foreground is text-content-muted here.`,
      );
    }
  });

  it('every allow-list entry is still dead, still used where it says, and says why', () => {
    for (const [cls, { files, reason }] of Object.entries(ALLOWED)) {
      expect(dead([cls])).toEqual([cls]);
      for (const f of files)
        expect(candidatesIn(f, readFileSync(f, 'utf8')).some((c) => c.cls === cls)).toBe(true);
      expect(reason).toContain(UPSTREAM);
    }
  });
});

// ── Negative controls ────────────────────────────────────────────────

describe('the rule fires on the classes it exists for', () => {
  it.each([
    'text-muted-foreground',
    'hover:text-foreground',
    'bg-bg-surface',
    'animate-spinner',
    'border-border-hairline',
    'ring-brand-glow',
    'bg-status-success',
    'md:hover:bg-bg-surface/50',
    // The fixed green shades, deleted in #362.
    'bg-brand-600',
  ])('%s is dead', (cls) => {
    expect(dead([cls])).toEqual([cls]);
  });

  it.each([
    'text-content-muted',
    'hover:text-content-emphasis',
    'bg-bg-page/95',
    'group-hover/row:bg-bg-muted',
    'border-border-error',
    'focus-visible:ring-offset-bg-default',
    'animate-spin',
    'text-sm',
    'border-2',
    '!bg-brand-emphasis',
    // The accent's tint and text (#362), the bell's count.
    'bg-bg-accent',
    'text-content-accent',
  ])('%s is alive', (cls) => {
    expect(dead([cls])).toEqual([]);
  });

  it('reads string literals and templates, not comments', () => {
    const src =
      "// text-muted-foreground in prose\nconst a = cn('flex text-muted-foreground', `p-2 ${x} bg-bg-surface`);";
    expect(candidatesIn('x.tsx', src).map((c) => c.cls)).toEqual([
      'text-muted-foreground',
      'bg-bg-surface',
    ]);
  });
});
