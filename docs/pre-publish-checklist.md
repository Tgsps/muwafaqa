# Before the repository is published, and before every push

**State (read from the repository on 2026-11-07, after the last push).** The repository has a remote, `origin`, on github.com, and `main` has been pushed to it. `origin/main` and `HEAD` were the same commit (`ac1ba11`) with 0 ahead and 0 behind after `git fetch`, when the last push below was verified (the commit that records this state comes after it); `main` held 154 commits at that point (`git rev-list --count ac1ba11`; the commit that records this state makes it 155, `git rev-list --count HEAD`). The local record of `origin/main` (`git reflog show origin/main`) holds 17 pushes, dated 2026-10-25 (two), 2026-10-26 (seven), 2026-10-29 (two), 2026-11-03 (two) and 2026-11-07 (four). The two pushes of 2026-11-03 published 13 and 7 commits; the four of 2026-11-07 published 7 (up to `7509be8`), 1 (`25a12e6`), 1 (`cd06330`) and 2 (`61b2f23` and `ac1ba11`, pushed together), 11 in all; 31 commits since 2026-10-29 (counted with `git rev-list --count`); it does not go back further than that, and it does not hold pushes made from another clone. **The first recorded push is dated 2026-10-25 10:27 (UTC+3), after the commit that records the second history rewrite (2026-10-25 10:09).** An anonymous request to the repository page answered HTTP 200 on 2026-11-03, so the repository was publicly readable at that moment; that check says nothing about any earlier time and does not say when it became public.

**The scan before the push of 2026-11-07 (run over the 7 commits ahead of `origin/main`, 959 added lines in 13 files, none under `src/`; reported in the chat, recorded here).** Counts: e-mail in the patch (the OData annotation key excluded by name) 0; account owner's display name 0; profile picture 0; environment or real host 0; tokens 0; secrets 0; session links or ids 0; local paths 0; trailers other than the one `Co-Authored-By` line 0 (one line in each of the 7 messages); identity: one GitHub noreply identity for author and committer in all 7. **Three non-zero findings, all accepted by the owner as false positives:** (1) 2 e-mail-like strings in commit messages, both the lookup bind property name (a name, an at sign, then `odata.bind`); (2) 34 digit strings of 8 or more digits, which are Dataverse error codes, Choice values and made-up numbers in unit tests; (3) 1 GUID outside `src/`, a made-up value in a unit test. **The registration number** was checked by deriving it at run time from the signed-in account name and counting matches in the patches, the messages and the author fields of the 7 commits and in the tracked files: 0 (the value was not printed or written; the check assumes the number is part of the account name, which is the only source it had). After the checks `git fetch` showed 7 ahead and 0 behind, the push was an ordinary `git push origin main` (no `--force`, no `--no-verify`), and afterwards `origin/main` equalled `HEAD` and the 7 new commits carried the noreply identity and only the allowed trailer.
**The pushes after the first one of 2026-11-07.** Each ran the scan of item 5 on the commits ahead of `origin/main` before it went out. `25a12e6`: all counts 0 except one hit of the first trailer pattern, which matched a commit subject (the owner classified it a false positive; the trailer check was then replaced by the `git interpret-trailers` command below). `cd06330`: all counts 0, the trailer check with the new command (0 other trailers, the allowed one present once). **`61b2f23` and `ac1ba11` together (the synchronization of `src/`, 4295 added lines in 48 files, all under `src/`):** e-mail, host, token or secret, owner name, avatar, local path and session counts 0; the registration-number check derived at run time 0 (the patch, both messages, the author fields and the tracked files); the trailer check 0 other trailers and the allowed one twice; the identity one noreply identity on both. **The digit-string check found 41 matches in 39 lines, all explained** (24 inside ids, 8 limits of an integer column, 8 Choice values, 1 error code of the alternate key), and **185 lines with an id (GUID), all under `src/`**, which allows them. The owner approved each push in the chat.
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
| Trailers | Any trailer other than the one `Co-Authored-By` line that names the assistant model (the owner's rule; its address is not written here). **Counted with git's own parser, per commit, and never by matching "key: value" lines**: a subject such as `docs: ...` or a body line such as `Note: ...` is not a trailer (on 2026-11-07 the first pattern counted exactly such a subject; the owner classified it a false positive). The command is under the table |
| Identity | One author and committer identity, a GitHub noreply address |

GUIDs are allowed only inside `src/`; outside it, any GUID in an added line is listed and judged (made-up values in unit tests are expected). The local pre-commit hook (item 3) stops most of this at commit time but is not versioned and is not a substitute for the scan.

**The trailer count (the command).** The allowed line is held in a shell variable so that its address is not written in this document.

```bash
ALLOWED='<the one Co-Authored-By line that names the assistant model>'
for c in $(git rev-list origin/main..HEAD); do git log -1 --format=%B "$c" | git interpret-trailers --parse; done > trailers.txt
grep -vxF "$ALLOWED" trailers.txt | grep -c .     # trailers other than the allowed one: must be 0
grep -cxF "$ALLOWED" trailers.txt                  # must equal the number of commits ahead (a missing trailer is caught here)
```

`git interpret-trailers --parse` reads only the trailer block at the end of a message. **Tested offline on 2026-11-07** on made-up messages: a `docs: ...` subject with the allowed trailer gives 0 other trailers (the old pattern gave 1); a body line `Note: ...` gives 0 (old: 2); a second real trailer and a session trailer give 1 each; a message with no trailer gives 0 allowed. On the last 8 real commits: 0 other trailers and the allowed one in 8 of 8. The local `commit-msg` hook only rejects a session link or a session trailer; it does not enforce "only the allowed trailer" (the hook is not versioned).
