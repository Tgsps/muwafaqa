# Before the repository is published, and before every push

**State (read from the repository on 2026-11-03).** The repository has a remote, `origin`, on github.com, and `main` has been pushed to it. The local record of `origin/main` (`git reflog show origin/main`) holds 12 pushes, dated 2026-10-25 (two), 2026-10-26 (seven), 2026-10-29 (two) and 2026-11-03 (one); it does not go back further than that, and it does not hold pushes made from another clone. **The first recorded push is dated 2026-10-25 10:27 (UTC+3), after the commit that records the second history rewrite (2026-10-25 10:09).** An anonymous request to the repository page answered HTTP 200 on 2026-11-03, so the repository was publicly readable at that moment; that check says nothing about any earlier time and does not say when it became public.

Items 1 to 3 were done on 2026-10-25 (history rewritten, whole-history scan run), before the first recorded push. This document is kept as the record of those items and as the checklist for the pushes that follow (item 5).

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

## 5. Before every push (the procedure; nothing here claims how earlier pushes were checked)

Run over **every commit that is ahead of `origin/main`**: the patches (added lines), the commit messages, and the author and committer fields. Count per category and list the commits covered. **Push only if every count is 0**, normally (no `--force`, no `--no-verify`); otherwise stop and report without pushing.

| Category | What counts as a hit |
|---|---|
| E-mail | Any e-mail address (reserved example domains are built at run time in tests, so none appears as a literal), and the university address in particular. An OData annotation key such as a lookup bind (a name, an at sign, then `odata.bind`) is not an address and is excluded from the count, by name |
| Registration number | A university registration number of the owner (a run of digits), in any file |
| Account owner | The display name of the account owner in a file (the author field carries the noreply identity only) |
| Profile picture | The account's profile picture or any link to the image host of the platform |
| Environment | The environment name or any real host. The generic placeholder `https://<org>.crm4.dynamics.com` in usage comments is acceptable; anything that is not generic is not |
| Tokens | A JWT-like or `Bearer` literal |
| Session | Any link or id of an assistant session, in a file or in a commit message |
| Trailers | Any trailer other than the one `Co-Authored-By` line that names the assistant model (the owner's rule; its address is not written here) |
| Identity | One author and committer identity, a GitHub noreply address |

GUIDs are allowed only inside `src/`; outside it, any GUID in an added line is listed and judged (made-up values in unit tests are expected). The local pre-commit hook (item 3) stops most of this at commit time but is not versioned and is not a substitute for the scan.
