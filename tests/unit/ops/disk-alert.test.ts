/**
 * @jest-environment node
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * THE DISK ALERT (#440), RUN FOR REAL WITH FAKE df, docker AND curl.
 *
 * deploy/ops/disk-alert.sh runs on the shared VM from cron. Every input it
 * reads can be overridden from the environment, so this runs the script
 * itself, in bash, against fakes that print what a full disk prints and
 * record what would have gone to Resend.
 */

const SCRIPT = path.resolve('deploy/ops/disk-alert.sh');
const KEY = 're_test_secret_key_123';
const HOUR = 3600;

let dir: string;

function fake(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

interface Run {
  stdout: string;
  status: number;
  /** One per email sent: curl's argv, the header it read on stdin, and the JSON body. */
  mails: Array<{
    argv: string;
    stdin: string;
    body: { subject: string; text: string; to: string[] };
  }>;
}

function run(opts: {
  used: number;
  logs?: Record<string, string>;
  now: number;
  args?: string[];
  curlStatus?: string;
}): Run {
  const logs = opts.logs ?? {};
  writeFileSync(
    path.join(dir, 'df.out'),
    `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 81106868 66000000 15106868 ${opts.used}% /\n`,
  );
  for (const c of ['playerz-db', 'playerz-redis', 'playerz-pgbouncer']) {
    writeFileSync(path.join(dir, `${c}.log`), logs[c] ?? 'LOG:  checkpoint complete\n');
  }
  writeFileSync(path.join(dir, 'curl.status'), opts.curlStatus ?? '200');
  const before = existsSync(path.join(dir, 'mails'))
    ? readFileSync(path.join(dir, 'mails'), 'utf8')
    : '';
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync('bash', [SCRIPT, ...(opts.args ?? [])], {
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH,
        DISK_ALERT_ENV_FILE: path.join(dir, '.env'),
        DISK_ALERT_STATE_DIR: path.join(dir, 'state'),
        DISK_ALERT_DF_CMD: `cat ${path.join(dir, 'df.out')}`,
        DISK_ALERT_DOCKER_CMD: path.join(dir, 'docker'),
        DISK_ALERT_CURL: path.join(dir, 'curl'),
        DISK_ALERT_NOW: String(opts.now),
      },
      encoding: 'utf8',
    });
  } catch (e) {
    const err = e as { stdout: string; status: number };
    stdout = err.stdout;
    status = err.status;
  }
  const all = existsSync(path.join(dir, 'mails'))
    ? readFileSync(path.join(dir, 'mails'), 'utf8')
    : '';
  const mails = all
    .slice(before.length)
    .split('\u0000MAIL\u0000')
    .filter((m) => m.trim())
    .map((m) => {
      const [argv, stdin, body] = m.split('\u0000PART\u0000') as [string, string, string];
      return { argv, stdin, body: JSON.parse(body) as Run['mails'][number]['body'] };
    });
  return { stdout, status, mails };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pilot-disk-alert-'));
  writeFileSync(
    path.join(dir, '.env'),
    [
      'NODE_ENV=production',
      `RESEND_API_KEY="${KEY}"`,
      'ALERT_EMAIL=ivo@inflect.bg',
      'EMAIL_FROM="playerz.bg <noreply@playerz.bg>"',
    ].join('\n'),
  );
  // `docker logs --since 20m <name>`: the fake prints that container's file.
  fake('docker', `cat "${dir}/\${4}.log"`);
  // curl: record argv, stdin (the header) and the body file it was pointed at.
  fake(
    'curl',
    [
      `body=""; for a in "$@"; do case "$a" in @*) [ "$a" = "@-" ] || body="\${a#@}";; esac; done`,
      `{ printf '\\0MAIL\\0%s' "$*"; printf '\\0PART\\0'; cat; printf '\\0PART\\0'; cat "$body"; } >> "${dir}/mails"`,
      `cat "${dir}/curl.status"`,
    ].join('\n'),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('disk-alert.sh (#440)', () => {
  it('a disk above 80% sends one email, then nothing for six hours, then again', () => {
    const t0 = 1_800_000_000;
    const first = run({ used: 85, now: t0 });
    expect(first.status).toBe(0);
    expect(first.mails).toHaveLength(1);
    expect(first.mails[0]!.body.to).toEqual(['ivo@inflect.bg']);
    expect(first.mails[0]!.body.subject).toMatch(/^\[playerz\] the disk of .+ is 85% full/);
    expect(first.mails[0]!.body.text).toContain('/dev/root');

    expect(run({ used: 86, now: t0 + 5 * HOUR }).mails).toHaveLength(0);
    expect(run({ used: 86, now: t0 + 6 * HOUR }).mails).toHaveLength(1);
  });

  it('80% exactly is not above 80%', () => {
    expect(run({ used: 80, now: 1_800_000_000 }).mails).toHaveLength(0);
  });

  it('says "OK again" once when the disk is back under, and then nothing', () => {
    const t0 = 1_800_000_000;
    run({ used: 91, now: t0 });
    const ok = run({ used: 60, now: t0 + 900 });
    expect(ok.mails.map((m) => m.body.subject)).toEqual([
      expect.stringMatching(/^\[playerz\] OK again: the disk of .+ is 60% full$/),
    ]);
    expect(run({ used: 60, now: t0 + 1800 }).mails).toHaveLength(0);
  });

  it('a PANIC, a "No space left" or a MISCONF in a container’s log alerts for that container', () => {
    const t0 = 1_800_000_000;
    const r = run({
      used: 40,
      now: t0,
      logs: {
        'playerz-db':
          'LOG:  checkpoint starting\nPANIC:  could not write to file "pg_wal/xlogtemp.29": No space left on device\n',
        'playerz-redis':
          'MISCONF Redis is configured to save RDB snapshots, but it is currently not able to persist on disk\n',
      },
    });
    expect(r.mails.map((m) => m.body.subject).sort()).toEqual([
      expect.stringMatching(/^\[playerz\] playerz-db on .+ logged a disk error/),
      expect.stringMatching(/^\[playerz\] playerz-redis on .+ logged a disk error/),
    ]);
    const db = r.mails.find((m) => m.body.subject.includes('playerz-db'))!;
    // The quote in the log line survives as JSON, and the clean lines are left out.
    expect(db.body.text).toBe(
      'PANIC:  could not write to file "pg_wal/xlogtemp.29": No space left on device',
    );
    expect(run({ used: 40, now: t0 + 1200 }).mails.map((m) => m.body.subject)).toEqual([
      expect.stringContaining('OK again: playerz-db'),
      expect.stringContaining('OK again: playerz-redis'),
    ]);
  });

  it('the key is never on curl’s command line; it is read from stdin', () => {
    const [mail] = run({ used: 95, now: 1_800_000_000 }).mails;
    expect(mail!.argv).not.toContain(KEY);
    expect(mail!.argv).toContain('-H @-');
    expect(mail!.argv).toContain('https://api.resend.com/emails');
    expect(mail!.stdin).toBe(`Authorization: Bearer ${KEY}\n`);
  });

  it('--dry-run prints what it would send, and sends and writes nothing', () => {
    const r = run({ used: 95, now: 1_800_000_000, args: ['--dry-run'] });
    expect(r.status).toBe(0);
    expect(r.mails).toHaveLength(0);
    expect(r.stdout).toContain('dry run: would email ivo@inflect.bg: [playerz] the disk of');
    expect(r.stdout).not.toContain(KEY);
    expect(existsSync(path.join(dir, 'state'))).toBe(false);
  });

  it('a send Resend refuses is logged, exits non-zero, and is tried again next run', () => {
    const t0 = 1_800_000_000;
    const refused = run({ used: 95, now: t0, curlStatus: '403' });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('FAILED: Resend answered 403');
    expect(refused.stdout).not.toContain(KEY);
    expect(run({ used: 95, now: t0 + 900 }).mails).toHaveLength(1);
  });
});
