import { globSync, readFileSync } from 'node:fs';

/**
 * «Асистент»'s boundaries, held in CI (owner 2026-11-14, #704; agri-saas
 * `assistant-answer-goes-through-the-scan`, `assistant-proposes-but-never-
 * writes`, `assistant-tools-go-through-usecases`, `assistant-memory-rules-
 * resolve`). Each is a sentence in a docblock until a check holds it.
 */
const read = (f: string) => readFileSync(f, 'utf8');
/** Code without its comments, so a docblock naming a call is not a call. */
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const ASSISTANT_FILES = [
  ...globSync('src/app-layer/ai/assistant/**/*.ts'),
  'src/app-layer/usecases/assistant-find-places.ts',
  'src/app-layer/usecases/assistant-best-time.ts',
  'src/lib/assistant/slots.ts',
].map(String);

describe('«Асистент» boundaries', () => {
  it('the scan sees the files it guards', () => {
    expect(ASSISTANT_FILES.length).toBeGreaterThanOrEqual(10);
    expect(ASSISTANT_FILES).toContain('src/app-layer/ai/assistant/tools.ts');
  });

  it('an `answer` event is built in emit-answer.ts only, behind the egress scan', () => {
    const builders = globSync('src/**/*.ts')
      .map(String)
      .filter((f) => /(?<!readonly )type:\s*'answer'/.test(code(f)));
    expect(builders).toEqual(['src/app-layer/ai/assistant/emit-answer.ts']);
    expect(code('src/app-layer/ai/assistant/emit-answer.ts')).toMatch(/scanEgress\(/);
  });

  it('the tools and what they call never write: they read, and a proposal is a draft', () => {
    const writes = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
    const offenders = ASSISTANT_FILES.filter((f) => writes.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('the tools reach data through use cases, never a repository or the database directly', () => {
    const src = code('src/app-layer/ai/assistant/tools.ts');
    expect(src).not.toMatch(/@\/app-layer\/repositories/);
    expect(src).not.toMatch(/@\/lib\/prisma|rls-middleware|@prisma\/client/);
  });

  it('every memory rule the code cites by number has its text in docs/assistant.md', () => {
    const doc = read('docs/assistant.md');
    for (let n = 1; n <= 9; n++)
      expect({ n, found: doc.includes(`### ${n}. `) }).toEqual({ n, found: true });
    const cited = new Set<number>();
    for (const f of globSync('src/**/*.ts').map(String)) {
      for (const m of read(f).matchAll(/memory rule (\d+)|\(rule (\d+)\)|Rule (\d+),/g)) {
        if (!/assistant/i.test(f)) continue;
        cited.add(Number(m[1] ?? m[2] ?? m[3]));
      }
    }
    for (const n of cited) expect({ n, inRange: n >= 1 && n <= 9 }).toEqual({ n, inRange: true });
  });
});
