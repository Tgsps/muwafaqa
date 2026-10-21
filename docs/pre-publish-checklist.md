# Before making the repo public

Items that must be done before the repository is published. **None of them is done.** Nothing has been pushed anywhere: the repository has no remote.

## 1. The environment host exists in an earlier commit (NOT done)

- The solution source of the approval flow, `src/Workflows/…json`, contained the real host of the development environment in the record link (`WebhookApprovalCreationInput/itemLink`, twice).
- The working tree is now scrubbed: the host is replaced by `<ORG_HOST>` by `scripts/scrub-emails.mjs`.
- **The old commit still holds it.** Counts, taken before the scrub was committed: **1 commit** touches the workflow file, and **1 commit** has the host string in `src/` (found with `git log -S`, the host is not printed here).
- **Required before publishing:** rewrite the history (for example with `git filter-repo`, replacing the host) or recreate the repository from the current tree. Either way the commit hashes quoted in the docs change.
- **Status: NOT done. History was not rewritten.** Do not push this repository before this item is done.

## 2. A scan of the whole history (NOT done)

The checks used on staged files (email-like values outside OData annotations, tokens, organization host, environment, user, owner and tenant ids) were run on the files being committed. They were **not** run over every commit in the history. Run them over the full history, or on the recreated repository, before publishing.

## 3. The author email in the commit metadata is a real university address (NOT done)

- The author (and committer) email stored in the data of **every commit** is a real university address. It is in the history metadata, not in any file of the repository, and it is **not written in any file**, including this one.
- **Required before publishing:** deal with it in the same step as item 1: rewrite the history (the author and committer fields too, for example with `git filter-repo` and a mailmap) or create a new repository from the current tree. Either way the commit hashes quoted in the docs change. Going forward, the address used for new commits can be changed in the git configuration of the clone; that does not change the existing commits.
- **Status: NOT done. Nothing was rewritten and the git configuration was not changed.** Do not push this repository before this item is done.

## 4. Placeholders in the exported flow

The flow in `src/` has two placeholders, `<APPROVER_TEST_ACCOUNT>` and `<ORG_HOST>`. A reader who imports it must fill both in. This is intended and is explained in `docs/plugin-registration-log.md`.
