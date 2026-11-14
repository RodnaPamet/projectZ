/**
 * The outbound secret scan's patterns: `.secret-patterns`, as JavaScript.
 *
 * `.secret-patterns` is this repo's one list of secret shapes (the pre-commit
 * hook and the no-secrets guardrail read it). The assistant scans every answer
 * against the same list before a byte of it is sent (agri-saas #2584), but the
 * production image does not ship that file and its regexes are PCRE (`(?i)`),
 * so the list is copied here with the inline flag moved to `flags`.
 *
 * `tests/unit/assistant/egress-patterns-match-the-source.test.ts` fails when
 * the two differ: add a pattern there, and here in the same change.
 *
 * No `g` flag, ever: a module-level global regex keeps `lastIndex` between
 * calls and would skip matches on every second scan.
 */
export interface EgressPattern {
  readonly name: string;
  readonly source: string;
  readonly flags: string;
}

export const EGRESS_PATTERNS: readonly EgressPattern[] = [
  {
    name: 'AWS Access Key ID',
    source: '(^|[^A-Z0-9])(AKIA|ASIA)[0-9A-Z]{16}([^A-Z0-9]|$)',
    flags: '',
  },
  {
    name: 'AWS Secret Access Key (named assignment)',
    source:
      '(aws(.{0,20})?(secret|access)(.{0,20})?key|secret(.{0,20})?access(.{0,20})?key)\\s*[:=]\\s*[\\x27"][A-Za-z0-9/+=]{30,}[\\x27"]',
    flags: 'i',
  },
  { name: 'GitHub Token', source: '(^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}', flags: '' },
  {
    name: 'Slack Bot/User Token',
    source: '(^|[^A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}',
    flags: '',
  },
  {
    name: 'Slack Webhook URL',
    source: 'https://hooks\\.slack\\.com/services/T[A-Z0-9]{8,}/B[A-Z0-9]{8,}/[A-Za-z0-9]{20,}',
    flags: '',
  },
  { name: 'Anthropic API Key', source: '(^|[^A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{40,}', flags: '' },
  {
    name: 'OpenAI API Key',
    source:
      '(^|[^A-Za-z0-9])sk-(proj|svcacct)-[A-Za-z0-9_-]{40,}|(^|[^A-Za-z0-9])sk-[A-Za-z0-9]{20}[T]3Blbk[F]J[A-Za-z0-9]{20}',
    flags: '',
  },
  { name: 'Google API Key', source: '(^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{35}', flags: '' },
  { name: 'Stripe Live Secret Key', source: '(^|[^A-Za-z0-9])sk_live_[A-Za-z0-9]{24,}', flags: '' },
  { name: 'Stripe Restricted Key', source: '(^|[^A-Za-z0-9])rk_live_[A-Za-z0-9]{24,}', flags: '' },
  {
    name: 'JWT (in-source literal)',
    source: '[\\x27"]eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}[\\x27"]',
    flags: '',
  },
  {
    name: 'PEM Private Key',
    source: '-----BEGIN ((RSA|DSA|EC|OPENSSH|PGP) )?PRIVATE KEY-----',
    flags: '',
  },
  { name: 'NPM Token', source: '(^|[^A-Za-z0-9])npm_[A-Za-z0-9]{36}', flags: '' },
  {
    name: 'Hardcoded Password Assignment',
    source:
      '(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\\s*[:=]\\s*[\\x27"][^\\x27"\\s]{16,}[\\x27"]',
    flags: 'i',
  },
];
