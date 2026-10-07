import { globSync, readFileSync } from 'node:fs';

/**
 * EVERY SERVER ACTION AUTHORISES ITSELF.
 *
 * ═══ WHY THIS IS NOT COVERED BY ANYTHING ELSE ═══
 *
 * A `'use server'` export compiles to a POST endpoint. The action id travels in
 * the page payload, so anyone who can load the screen — or replay a request —
 * can invoke it directly. It does NOT re-run the page, so the page's own
 * permission check protects the screen and not the mutation behind it.
 *
 * Middleware is no defence here at all. An action posts to the page's own
 * `/t/[slug]/…` path, and since #250 `checkTenantAccess` lets any signed-in
 * caller through to a club their token does not list — a token cannot prove
 * that somebody is NOT a member — so it gates authentication only. It never
 * gated the permission: every rule in `route-permissions.ts` is anchored at
 * `^/api/`, and they cover mutating HTTP verbs on API paths only. A COACH, or
 * a stranger, would sail through the edge into a court mutation.
 *
 * `route-permission-coverage` does not see these either — it globs
 * `src/app/api/**\/route.ts`.
 *
 * So the check has to be in the action, and "remember to write it" is not a
 * control. This is the control.
 *
 * ═══ WHAT IT CANNOT SEE ═══
 *
 * Whether the permission demanded is the RIGHT one. `requireTenantAction(slug,
 * 'players.view')` guarding a court mutation would pass this and be wrong.
 * Saying so is better than implying more — it checks that authorisation
 * happens, not that it is correct.
 */

/**
 * Actions that authorise by something OTHER than a club permission.
 *
 * Each names why, because an exemption list with no reasons is where holes go
 * to be forgotten.
 */
const ALLOWED_WITHOUT_PERMISSION: Record<string, string> = {
  'src/app/(public)/invite/[token]/actions.ts':
    'accepting an invite is how somebody BECOMES a member — there is no membership to ' +
    'check, and demanding one would make the invite unusable by exactly the people it is ' +
    'for. The authorisation is the token: 32 random bytes, stored only as a keyed hash, ' +
    'single-use, expiring, and sent to an address a member of that club chose. The action ' +
    'still requires a signed-in user, because a membership must belong to an account.',
  'src/app/(public)/me/profile/actions.ts':
    "saving one's own UI language (#362) is not club work: there is no club in the request " +
    'and no membership to check. The authorisation is the session: the action updates only ' +
    "the signed-in user's own row, by the id requireSignedIn returns, never by an id the " +
    'request names, and refuses a locale outside the catalogue.',
};

/**
 * Actions open to ANYONE, signed in or not, which the rule below (an exempt
 * action still demands a signed-in user) cannot apply to. Each names the guard
 * that stands in for authentication, and the guard's module must rate-limit:
 * an open endpoint with no limit is a spam cannon.
 */
const OPEN_TO_ANYONE: Record<string, { guard: string; module: string; why: string }> = {
  'src/app/(home)/actions.ts': {
    guard: 'submitContactRequest',
    module: 'src/app-layer/usecases/contact-requests.ts',
    why:
      "the landing page's club enquiry form (#369) is for clubs that have no account yet, so " +
      'there is nobody to sign in. What stands in for it is submitContactRequest: zod on every ' +
      'field, a honeypot, a per-IP rate limit keyed on a keyed hash of the IP (never stored), ' +
      "and an email that only ever goes to the operator's one configured inbox, never to an " +
      'address the visitor typed.',
  },
};

const ACTION_FILES = globSync('src/app/**/*.ts')
  .map((f) => f.toString())
  .filter((f) => /^\s*['"]use server['"]/.test(readFileSync(f, 'utf8')));

/** Comment lines out, so prose about the helper is not mistaken for calling it. */
function codeOnly(src: string): string {
  let inBlock = false;
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (inBlock) {
        if (t.includes('*/')) inBlock = false;
        return false;
      }
      if (t.startsWith('/*')) {
        if (!t.includes('*/')) inBlock = true;
        return false;
      }
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

/**
 * Every exported name that becomes an endpoint.
 *
 * ═══ BOTH SPELLINGS, BECAUSE NEXT COMPILES BOTH ═══
 *
 * This matched only `export async function`. An arrow function —
 * `export const doThingAction = async (...) => {}` — is equally a POST
 * endpoint and was never scanned, so an unauthorised one passed the suite
 * whose entire job is to catch it. The file-level fallback did not help
 * either: a compliant neighbour satisfied it.
 */
function exportedActions(code: string): string[] {
  const declared = [...code.matchAll(/^export\s+async\s+function\s+([A-Za-z_$][\w$]*)/gm)];
  const arrows = [
    ...code.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*async\b/gm),
  ];
  return [...declared, ...arrows].map((m) => m[1]!);
}

/** The body of one exported action, to the next top-level declaration. */
function bodyOf(code: string, name: string): string {
  const lines = code.split('\n');
  const start = lines.findIndex((l) =>
    new RegExp(
      `^export\\s+(?:async\\s+function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\b)`,
    ).test(l),
  );
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const AUTHORISES = /\brequireTenantAction\b|\brequireTenantAction\s*\(/;

describe('server actions authorise themselves', () => {
  it('found the action modules — a broken glob would pass everything', () => {
    // If this ever legitimately reaches zero, delete the suite rather than
    // leaving it green over nothing.
    expect(ACTION_FILES.length).toBeGreaterThanOrEqual(1);
    const total = ACTION_FILES.flatMap((f) => exportedActions(codeOnly(readFileSync(f, 'utf8'))));
    expect(total.length).toBeGreaterThanOrEqual(1);
  });

  it.each(ACTION_FILES)('%s exports at least one action', (file) => {
    // A `'use server'` module exporting nothing is either a mistake or a
    // directive left on a file that no longer needs it.
    expect(exportedActions(codeOnly(readFileSync(file, 'utf8'))).length).toBeGreaterThan(0);
  });

  it('every exemption points at a file that still exists and still has actions', () => {
    // An exemption for a deleted or emptied file is a hole waiting for someone
    // to recreate that path.
    for (const file of Object.keys(ALLOWED_WITHOUT_PERMISSION)) {
      expect(ACTION_FILES).toContain(file);
      expect(exportedActions(codeOnly(readFileSync(file, 'utf8'))).length).toBeGreaterThan(0);
    }
  });

  it('every exemption states a reason', () => {
    const unexplained = Object.entries(ALLOWED_WITHOUT_PERMISSION)
      .filter(([, why]) => why.trim().length < 40)
      .map(([f]) => f);
    expect(unexplained).toEqual([]);
  });

  it.each(Object.entries(OPEN_TO_ANYONE))(
    '%s is open to anyone, behind its named, rate-limited guard',
    (file, { guard, module, why }) => {
      expect(ACTION_FILES).toContain(file);
      expect(why.trim().length).toBeGreaterThanOrEqual(40);
      const code = codeOnly(readFileSync(file, 'utf8'));
      const names = exportedActions(code);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect({
          file,
          name,
          guarded: new RegExp(`\\b${guard}\\b`).test(bodyOf(code, name)),
        }).toEqual({ file, name, guarded: true });
      }
      const guardSrc = codeOnly(readFileSync(module, 'utf8'));
      expect(guardSrc).toMatch(new RegExp(`export async function ${guard}\\b`));
      expect(guardSrc).toMatch(/\bcheckRateLimit\s*\(/);
    },
  );

  it('an exempt action still demands a signed-in user', () => {
    // The exemption is from the PERMISSION check, not from authentication.
    // Without this, "exempt" would drift into "open".
    for (const file of Object.keys(ALLOWED_WITHOUT_PERMISSION)) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const name of exportedActions(code)) {
        expect({ file, name, guarded: /\brequireSignedIn\b/.test(bodyOf(code, name)) }).toEqual({
          file,
          name,
          guarded: true,
        });
      }
    }
  });

  it.each(
    ACTION_FILES.filter(
      (f) => !(f in ALLOWED_WITHOUT_PERMISSION) && !(f in OPEN_TO_ANYONE),
    ).flatMap((file) => {
      const code = codeOnly(readFileSync(file, 'utf8'));
      return exportedActions(code).map((name) => [`${file}:${name}`, code, name] as const);
    }),
  )('%s demands a permission before it does anything', (_label, code, name) => {
    const body = bodyOf(code as string, name as string);

    if (!AUTHORISES.test(body)) {
      throw new Error(
        `${name} is an exported Server Action that never calls requireTenantAction.\n\n` +
          `It compiles to a POST endpoint reachable independently of the page that rendered\n` +
          `the form. Middleware gates MEMBERSHIP on /t/[slug]/** but not the permission —\n` +
          `every rule in route-permissions.ts is anchored at ^/api/ — so any member of the\n` +
          `club, including a COACH, reaches this.\n\n` +
          `Call requireTenantAction(slug, '<permission>') as the first statement.`,
      );
    }
  });

  // ── Negative controls ──────────────────────────────────────────────
  it('the detectors fire on the shapes they are meant to', () => {
    const guarded = [
      'export async function doThing(slug: string) {',
      "  const ctx = await requireTenantAction(slug, 'courts.manage');",
      '  return ctx;',
      '}',
    ].join('\n');
    const unguarded = [
      'export async function doThing(slug: string) {',
      '  return mutate(slug);',
      '}',
    ].join('\n');

    expect(exportedActions(guarded)).toEqual(['doThing']);
    expect(AUTHORISES.test(bodyOf(guarded, 'doThing'))).toBe(true);
    expect(AUTHORISES.test(bodyOf(unguarded, 'doThing'))).toBe(false);
  });

  it('sees an ARROW-function action, which Next compiles the same way', () => {
    // The hole this suite shipped with: it matched only
    // `export async function`, so an unauthorised arrow action was never
    // scanned at all — by the check whose whole purpose is to catch it.
    const src = [
      'export const forgottenAction = async (slug: string) => {',
      '  return mutate(slug);',
      '};',
      '',
      'export const guardedAction = async (slug: string) => {',
      "  await requireTenantAction(slug, 'courts.manage');",
      '};',
    ].join('\n');

    expect(exportedActions(src).sort()).toEqual(['forgottenAction', 'guardedAction']);
    expect(AUTHORISES.test(bodyOf(src, 'forgottenAction'))).toBe(false);
    expect(AUTHORISES.test(bodyOf(src, 'guardedAction'))).toBe(true);
  });

  it('sees a typed arrow action too', () => {
    const src = [
      'export const typedAction: Action = async (slug) => {',
      '  return mutate(slug);',
      '};',
    ].join('\n');
    expect(exportedActions(src)).toEqual(['typedAction']);
    expect(AUTHORISES.test(bodyOf(src, 'typedAction'))).toBe(false);
  });

  it('does not treat a non-async export as an action', () => {
    // `export const PAGE_SIZE = 50` is not an endpoint and must not be
    // demanded to authorise anything.
    const src = ['export const PAGE_SIZE = 50;', 'export const rows: Row[] = [];'].join('\n');
    expect(exportedActions(src)).toEqual([]);
  });

  it('does not credit one action with another’s authorisation', () => {
    // The realistic mistake: a second action added beside a compliant one.
    const src = [
      'export async function guarded(slug: string) {',
      "  await requireTenantAction(slug, 'courts.manage');",
      '}',
      '',
      'export async function forgotten(slug: string) {',
      '  return mutate(slug);',
      '}',
    ].join('\n');

    expect(exportedActions(src)).toEqual(['guarded', 'forgotten']);
    // The file as a whole mentions it — which is why this checks per body.
    expect(AUTHORISES.test(src)).toBe(true);
    expect(AUTHORISES.test(bodyOf(src, 'forgotten'))).toBe(false);
  });

  it('reads code, not the docblock that explains the rule', () => {
    const prose = [
      '/**',
      ' * Every action calls requireTenantAction first.',
      ' */',
      'export async function forgotten(slug: string) {',
      '  return mutate(slug);',
      '}',
    ].join('\n');

    expect(AUTHORISES.test(prose)).toBe(true);
    expect(AUTHORISES.test(bodyOf(codeOnly(prose), 'forgotten'))).toBe(false);
  });
});
