/**
 * Argument parsing and exit codes shared by the ui-sync CLIs. Pure, so
 * reachability.mjs (which the guardrails import) can use it too.
 */

export class UsageError extends Error {}

/**
 * `--flag value` / `--flag=value` / `--switch` / positionals. An unknown flag
 * is a UsageError, so a typo cannot silently fall back to a default.
 */
export function parseCli(argv, { values = [], switches = [], multiple = [] }) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (switches.includes(name)) {
      flags[name] = true;
      continue;
    }
    if (!values.includes(name) && !multiple.includes(name)) {
      throw new UsageError(`Unknown option --${name}`);
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    if (multiple.includes(name)) (flags[name] ??= []).push(value);
    else flags[name] = value;
  }
  return { flags, positionals };
}

/** Run a CLI's main(): a UsageError exits 2, anything else 1. */
export function run(main, usage) {
  Promise.resolve()
    .then(main)
    .catch((err) => {
      if (err instanceof UsageError) {
        console.error(`${err.message}\n\n${usage}`);
        process.exit(2);
      }
      console.error(err);
      process.exit(1);
    });
}
