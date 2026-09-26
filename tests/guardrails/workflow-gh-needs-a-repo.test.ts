import { globSync, readFileSync } from 'node:fs';

/**
 * A WORKFLOW JOB THAT CALLS `gh` CAN ACTUALLY REACH THE REPOSITORY.
 *
 * ═══ THE DEFECT THIS IS BUILT FROM ═══
 *
 * The nightly's `report-failure` job files an issue when the nightly breaks.
 * It had no `actions/checkout` — correctly, it needs no repo content to write
 * an issue — and no `GH_REPO`. `gh` resolves the target repository from the git
 * remote, so every call died before it started:
 *
 *   failed to run git: fatal: not a git repository
 *   Process completed with exit code 1
 *
 * The reporter could never have filed anything. It shipped in #165 and was
 * never exercised, so nothing said so; a scheduled run reports at 02:00 into a
 * tab nobody opens, which is the whole reason that job exists.
 *
 * ═══ WHY THE EXISTING GUARDRAIL DID NOT CATCH IT ═══
 *
 * There is already a check that the job exists, depends on every other job,
 * keeps its `always()` guard and holds `issues: write`. All four were correct.
 * It asserts the job's SHAPE, and the shape was perfect — what was missing was
 * the one thing that made the command able to run at all.
 *
 * So this checks the OTHER half: a job that invokes `gh` must be able to say
 * which repository it means.
 *
 * ═══ WHAT COUNTS AS BEING ABLE TO ═══
 *
 *   actions/checkout   gives it a git remote, the usual answer
 *   GH_REPO            names the repository with no working tree, which is
 *                      cheaper when the job only wants to write an issue
 *   --repo on the call itself
 *
 * Any of the three is fine. None of them is not.
 */

const WORKFLOWS = globSync('.github/workflows/*.yml').map((f) => f.toString());

/** Split a workflow into its top-level jobs: `  job-name:` at two spaces. */
function jobs(src: string): Array<{ name: string; body: string }> {
  const lines = src.split('\n');
  const inJobs = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (inJobs === -1) return [];

  const starts: Array<{ name: string; at: number }> = [];
  for (let i = inJobs + 1; i < lines.length; i++) {
    const m = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(lines[i]!);
    if (m) starts.push({ name: m[1]!, at: i });
    else if (/^\S/.test(lines[i]!)) break;
  }

  return starts.map((s, i) => ({
    name: s.name,
    body: lines.slice(s.at, i + 1 < starts.length ? starts[i + 1]!.at : lines.length).join('\n'),
  }));
}

/** `gh` invoked as a command, not the word appearing in prose. */
const CALLS_GH = /(^|[;&|(\s])gh\s+(issue|pr|api|release|run|workflow|repo|label)\b/m;

const allJobs = WORKFLOWS.flatMap((file) =>
  jobs(readFileSync(file, 'utf8')).map((j) => ({ file, ...j })),
);

describe('workflow jobs that call gh', () => {
  it('found workflows and jobs — a broken glob would pass everything', () => {
    expect(WORKFLOWS.length).toBeGreaterThanOrEqual(2);
    expect(allJobs.length).toBeGreaterThanOrEqual(5);
    // And that the detector finds the job this suite was written for.
    expect(allJobs.filter((j) => CALLS_GH.test(j.body)).length).toBeGreaterThanOrEqual(1);
  });

  it.each(allJobs.filter((j) => CALLS_GH.test(j.body)).map((j) => [`${j.file}:${j.name}`, j]))(
    '%s can tell gh which repository it means',
    (_label, job) => {
      const j = job as { file: string; name: string; body: string };
      const hasCheckout = /uses:\s*actions\/checkout/.test(j.body);
      const hasGhRepo = /GH_REPO:/.test(j.body);
      const hasRepoFlag = /gh\s+\w+[^\n]*--repo\b/.test(j.body);

      if (!hasCheckout && !hasGhRepo && !hasRepoFlag) {
        throw new Error(
          `${j.file}: job "${j.name}" calls gh with no way to resolve the repository.\n\n` +
            `gh reads the target repo from the git remote. With no actions/checkout, no\n` +
            `GH_REPO and no --repo, every call fails with:\n\n` +
            `  failed to run git: fatal: not a git repository\n\n` +
            `Add \`GH_REPO: \${{ github.repository }}\` to the step's env — cheapest when the\n` +
            `job wants no repo content — or check the repository out.`,
        );
      }
    },
  );

  // ── Negative controls ──────────────────────────────────────────────
  it('the detector fires on a gh call and not on the word', () => {
    // This suite passes by finding nothing wrong, which is indistinguishable
    // from a regex that matches no job at all.
    expect(CALLS_GH.test('          gh issue create --title x')).toBe(true);
    expect(CALLS_GH.test('          gh pr comment 1 --body y')).toBe(true);
    expect(CALLS_GH.test('  EXISTING=$(gh issue list --state open)')).toBe(true);

    // …and not on prose, nor on a word that merely starts with gh.
    expect(CALLS_GH.test('          # gh is not available here')).toBe(false);
    expect(CALLS_GH.test('          echo "ghost"')).toBe(false);
    expect(CALLS_GH.test('          run: ghcr.io/owner/image')).toBe(false);
  });

  it('the job splitter finds the nightly reporter by name', () => {
    // A rename or a reformat that broke the splitter would empty every list
    // above and turn this suite green for the wrong reason.
    const nightly = jobs(readFileSync('.github/workflows/nightly.yml', 'utf8'));
    expect(nightly.map((j) => j.name)).toContain('report-failure');

    const reporter = nightly.find((j) => j.name === 'report-failure')!;
    expect(CALLS_GH.test(reporter.body)).toBe(true);
    // The fix itself, pinned: this is the line whose absence broke it.
    expect(reporter.body).toMatch(/GH_REPO:\s*\$\{\{\s*github\.repository\s*\}\}/);
  });
});
