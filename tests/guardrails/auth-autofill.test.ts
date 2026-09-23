import { readFileSync, globSync } from 'node:fs';

/**
 * PASSWORD FIELDS MUST BE AUTOFILLABLE.
 *
 * A password manager can only fill a field it can IDENTIFY, and `autoComplete`
 * is how it identifies one. Without it the browser offers nothing — or, worse,
 * offers the wrong thing, confidently filling a stale password into a "choose a
 * new one" box.
 *
 * ═══ THE REGRESSION CLASS IS SILENT ═══
 *
 * Nothing errors. Nothing looks broken. No test fails. The field simply never
 * autofills, and the user — who has a 40-character generated password in their
 * manager and no idea what it is — cannot log in to your app. They assume the
 * app is bad, and they are not wrong.
 *
 * It is invisible to everyone who builds the app, because everyone who builds
 * the app types their test password by hand.
 *
 * ═══ THIS GUARD MUST NOT PASS VACUOUSLY ═══
 *
 * playerz.bg has NO auth routes yet — no login, no register, no reset-password.
 *
 * A guard that scans for password fields, finds none, and reports success is
 * WORSE THAN NO GUARD. It is a green check that means nothing, and it will go on
 * meaning nothing on the day somebody adds a login form without autoComplete —
 * which is precisely the day it was supposed to fire.
 *
 * So it works the other way round. It asserts what MUST be true whenever a
 * password field exists, and it states plainly, in its own output, that it is
 * currently guarding an empty set. The moment the first password input lands, it
 * has something to check and it checks it.
 */

const SOURCE = [...globSync('src/app/**/*.tsx'), ...globSync('src/components/**/*.tsx')].map((f) =>
  f.toString(),
);

/** Strip comments — the prose in this repo discusses autoComplete constantly. */
function code(source: string): string {
  const out: string[] = [];
  let inBlock = false;

  for (const raw of source.split('\n')) {
    let line = raw;

    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) {
        out.push('');
        continue;
      }
      inBlock = false;
      line = line.slice(end + 2);
    }

    const block = line.indexOf('/*');
    if (block !== -1) {
      const end = line.indexOf('*/', block + 2);
      if (end === -1) {
        inBlock = true;
        line = line.slice(0, block);
      } else {
        line = line.slice(0, block) + line.slice(end + 2);
      }
    }

    const lineComment = line.indexOf('//');
    if (lineComment !== -1) line = line.slice(0, lineComment);

    out.push(line);
  }

  return out.join('\n');
}

/** A rendered password field — ours or a raw one. */
const PASSWORD_FIELD = /type=["']password["']/;

/** The only two values that are ever right on a password field. */
const VALID_PASSWORD_AUTOCOMPLETE = /autoComplete=["'](?:current-password|new-password)["']/;

interface Field {
  file: string;
  line: number;
  source: string;
}

/**
 * The ELEMENT a match sits in, not the line.
 *
 * This used to read one line and look for `autoComplete` on that same line —
 * which only works for an input written as a single line. Prettier formats JSX
 * attributes one per line at this repo's width, so a correctly-written field:
 *
 *     <input
 *       type="password"
 *       autoComplete="current-password"
 *     />
 *
 * was reported as a violation, because the attribute is two lines below the
 * match. This guard shipped before any auth form existed and its own prose said
 * so ("allowed to be guarding an empty set today"), so nothing ever exercised
 * it against real JSX until the first login form arrived and it failed on
 * correct code.
 *
 * The window is bounded by the element, not by a fixed line count: a ±N window
 * would happily read a NEIGHBOURING field's autoComplete and pass a password
 * input that has none.
 */
function elementAround(lines: string[], index: number): string {
  let start = index;
  // Walk back to the opening tag. 12 lines is more attributes than any input
  // in this repo carries, and stopping is better than running into the field
  // above.
  for (let i = index; i >= 0 && index - i < 12; i--) {
    if (/<[A-Za-z][A-Za-z0-9.]*\b/.test(lines[i]!)) {
      start = i;
      break;
    }
  }

  let end = index;
  for (let i = index; i < lines.length && i - index < 12; i++) {
    end = i;
    if (/\/?>\s*$/.test(lines[i]!)) break;
  }

  return lines.slice(start, end + 1).join('\n');
}

function passwordFields(): Field[] {
  const found: Field[] = [];

  for (const file of SOURCE) {
    const lines = code(readFileSync(file, 'utf8')).split('\n');

    lines.forEach((line, i) => {
      if (PASSWORD_FIELD.test(line)) {
        found.push({ file, line: i + 1, source: elementAround(lines, i) });
      }
    });
  }

  return found;
}

describe('the scan is not vacuous', () => {
  it('found the source tree', () => {
    // A broken glob would make this guard pass by scanning nothing — the exact
    // failure it exists to prevent, one level up.
    expect(SOURCE.length).toBeGreaterThan(100);
  });

  it('states honestly whether it is currently guarding anything', () => {
    const fields = passwordFields();

    // Not an assertion — a REPORT. This guard is allowed to be guarding an empty
    // set today (there are no auth routes yet). What it is not allowed to do is
    // pretend that means something is verified.
    if (fields.length === 0) {
      console.info(
        '\n  [auth-autofill] No password fields exist yet — no auth routes have been built.\n' +
          '  This guard is armed, not satisfied. It will fire on the first login form that\n' +
          '  ships without autoComplete.\n',
      );
    }

    // The scan mechanism itself must work even when there is nothing to find.
    expect(Array.isArray(fields)).toBe(true);
  });
});

describe('every password field is autofillable', () => {
  it('carries autoComplete="current-password" or "new-password"', () => {
    const violations = passwordFields().filter((f) => !VALID_PASSWORD_AUTOCOMPLETE.test(f.source));

    if (violations.length > 0) {
      throw new Error(
        `Password field(s) with no usable autoComplete:\n\n` +
          violations.map((v) => `  ${v.file}:${v.line}\n      ${v.source}`).join('\n\n') +
          `\n\nA password manager can only fill a field it can IDENTIFY. Without autoComplete\n` +
          `the browser offers nothing — and the user, who has a 40-character generated\n` +
          `password and no idea what it is, cannot log in.\n\n` +
          `Nothing errors. Nothing looks broken. It is invisible to everyone who builds the\n` +
          `app, because everyone who builds the app types their test password by hand.\n\n` +
          `  login / re-auth      → autoComplete="current-password"\n` +
          `  register / reset     → autoComplete="new-password"\n\n` +
          `The distinction MATTERS: "current-password" on a reset form makes the browser\n` +
          `confidently fill the OLD password into the "choose a new one" box.`,
      );
    }
  });

  it('an email field beside a password field is identified too', () => {
    // A password manager matches on the PAIR. An unlabelled username field means
    // it cannot tell which account the password belongs to, and it offers all of
    // them — or none.
    const authFiles = new Set(passwordFields().map((f) => f.file));

    const violations: string[] = [];

    for (const file of authFiles) {
      const source = code(readFileSync(file, 'utf8'));

      const emailLines = source
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /type=["']email["']/.test(line));

      for (const { line, n } of emailLines) {
        // `Input` derives autoComplete="email" from type="email" automatically
        // (src/components/ui/input.tsx), so an <Input type="email"> is already
        // covered. A RAW <input> is not.
        const isRawInput = /<input[\s]/.test(line);
        const hasExplicit = /autoComplete=/.test(line);

        if (isRawInput && !hasExplicit) {
          violations.push(`${file}:${n}  raw <input type="email"> with no autoComplete`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

describe('the Input primitive derives what it safely can', () => {
  const input = readFileSync('src/components/ui/input.tsx', 'utf8');

  it('derives autoComplete from type where it is unambiguous', () => {
    expect(input).toMatch(/TYPE_TO_AUTOCOMPLETE/);
    expect(input).toMatch(/autoComplete=\{autoComplete\}/);
  });

  it('does NOT guess for password — the wrong guess is worse than none', () => {
    // `current-password` and `new-password` are the same input TYPE. A default
    // would be right half the time, and the wrong half fills a stale password
    // into a "choose a new one" field.
    const map = input.slice(
      input.indexOf('TYPE_TO_AUTOCOMPLETE'),
      input.indexOf('};', input.indexOf('TYPE_TO_AUTOCOMPLETE')),
    );

    expect(map).not.toMatch(/password/);
  });

  it('sets enterKeyHint, which was app-wide ZERO before this', () => {
    expect(input).toMatch(/enterKeyHint=\{enterKeyHint\}/);
  });

  it('a search field does not capitalise or spellcheck', () => {
    // Otherwise the user types "sofia", the phone sends "Sofia", and a red
    // squiggle appears under a venue name that is spelled perfectly correctly.
    expect(input).toMatch(/autoCapitalize=\{autoCapitalize\}/);
    expect(input).toMatch(/spellCheck=\{spellCheck\}/);
  });
});

// ── Negative control ─────────────────────────────────────────────────

describe('the rule fires on the code it forbids', () => {
  it('detects a password field', () => {
    expect(PASSWORD_FIELD.test('<Input type="password" name="pw" />')).toBe(true);
    expect(PASSWORD_FIELD.test('<input type="password" />')).toBe(true);
    expect(PASSWORD_FIELD.test('<Input type="email" />')).toBe(false);
  });

  it('accepts only the two valid autoComplete values', () => {
    expect(VALID_PASSWORD_AUTOCOMPLETE.test('autoComplete="current-password"')).toBe(true);
    expect(VALID_PASSWORD_AUTOCOMPLETE.test('autoComplete="new-password"')).toBe(true);

    // `autoComplete="password"` is not a real value and does nothing. It looks
    // right in review, which is exactly why it needs to fail here.
    expect(VALID_PASSWORD_AUTOCOMPLETE.test('autoComplete="password"')).toBe(false);
    expect(VALID_PASSWORD_AUTOCOMPLETE.test('autoComplete="off"')).toBe(false);
  });

  it('a password field with no autoComplete IS a violation', () => {
    const line = '<Input type="password" name="password" />';

    expect(PASSWORD_FIELD.test(line) && !VALID_PASSWORD_AUTOCOMPLETE.test(line)).toBe(true);
  });
});
