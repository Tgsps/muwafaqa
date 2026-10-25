# Before making the repo public

Items that must be done before the repository is published. **Items 1 to 3 were done on 2026-10-25** (history rewritten, whole-history scan run). Nothing has been pushed anywhere: the repository has no remote.

## 1. The environment host existed in earlier commits (DONE 2026-10-25)

- The solution source of the approval flow (the retired v1 flow, `src/Workflows/…json`) contained the real host of the development environment in the record link (`WebhookApprovalCreationInput/itemLink`, twice). It was in 32 revisions: the commit that added that flow and the 31 commits after it, until the working tree was scrubbed (`scripts/scrub-emails.mjs` replaces the host by `<ORG_HOST>`).
- **Done:** the history was rewritten with `git filter-repo`, in a separate clone and then applied to the working folder: the host literal was replaced by the placeholder `<ORG_HOST>` in every revision. The tree of `HEAD` is byte-identical before and after (same tree hash); 32 older trees changed, the ones that held the host.
- **The commit hashes changed on that date.** Every citation of a commit hash in the docs and scripts was updated (7 citations of 6 commits: ADR-006, ADR-007, `docs/plugin-registration-log.md`, `scripts/build-flow-v2.mjs`). SHA-256 values of assemblies and packages are not commit hashes and did not change.
- The pre-rewrite history (a git bundle and a full copy of the folder) is **kept locally outside the repository**. It still holds the old values, so it must never be copied into the repository or uploaded.

## 2. A scan of the whole history (DONE 2026-10-25)

The checks used on staged files (email-like values outside OData annotations, tokens, organization host, environment, user, owner and tenant ids, local paths) were run over every commit, every commit message and every author field, **before** the rewrite (to find the problems) and **after** it (0 occurrences of the old host label, the old author email, its domain and the old author handle in any revision, message or author field; 0 secrets; 0 local paths). Re-run it before publishing if more commits are added: the local pre-commit hook only checks the staged diff.

## 3. The author email in the commit metadata (DONE 2026-10-25)

- The author and committer email of the first 92 commits was a personal university address. It is not written in any file, including this one.
- **Done:** all commits now carry one identity, a GitHub noreply address (rewritten with a mailmap). The repository-local git configuration (`user.name`, `user.email`) is set to the same identity, not the global one.
- The local pre-commit hook (`.git/hooks`, **not versioned**, so it must be recreated on a fresh clone) now also refuses a commit when the git identity is not a GitHub noreply address, or when an added line holds a real-looking Dataverse host.

## 4. Placeholders in the exported flow

The flow in `src/` (v2; flow v1 and its approver placeholder were retired on 2026-10-24) has one placeholder, `<ORG_HOST>`. A reader who imports it must fill it in. This is intended and is explained in `docs/plugin-registration-log.md` and `docs/rebuild-runbook.md`.
