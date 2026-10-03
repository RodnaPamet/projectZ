# Audit playbook

A reusable way to audit an app the way its users see it, one account kind at a time. First run: playerz.bg,
2026-10-04, epic #352 (37 findings). Nothing here is playerz-specific, so other repos can use it as is.

1. **`AUDIT_BRIEF.md`:** fill in the `<…>` placeholders and give it to a background agent in an isolated
   worktree. It walks the app as every account kind, takes screenshots and writes `findings.json` and
   `journeys.md`. It files a GitHub epic plus issues for new blocker and major findings. It fixes nothing.
2. **`triage-template.html`:** the page the owner uses to set Now / Next / Later / Skip on each finding.
   - **Fill it in:** replace `__PAGE_TITLE__`, `__TITLE__`, `__LEDE__`, `__ISSUE_URL_BASE__` (e.g.
     `https://github.com/<owner>/<repo>/issues/`), `__NEW_ISSUES__` (a JSON array of the issue numbers the audit
     filed) and `__ROLE_ORDER__` (a JSON array of account kinds in display order).
   - **Embed the findings:** put `findings.json` in place of `__FINDINGS__`. Each `screenshot` field becomes
     `shots/<name>.jpg`, and every `</` is escaped as `<\/`.
   - **Prepare the screenshots:** convert them to JPEG at width 1100 or less
     (`sips -s format jpeg -s formatOptions 72 -Z 1100`).
   - **Publish:** use the Artifact tool, with the shots in `files` and `capabilities: {db: {}, user: {}}`.
     Decisions land in the `triage` collection (one document per finding id, holding `{priority, note}`). Read
     them back with `ArtifactData list`.
3. **Order of work after triage:** the owner's Now items first, and navigation as mockups for approval before
   anything is built.

Lessons from the first run:

- Sign-in that only offers OAuth can't be walked locally. Say so; don't silently skip it.
- The audit found two real bugs (a price preview using the wrong day's rates, and a list that was always empty) that tests had missed. Walking every role pays off.
- Don't `pkill` broadly when cleaning up; other sessions may have servers running.
