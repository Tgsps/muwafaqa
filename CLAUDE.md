# CLAUDE.md — Muwafaqa

Portfolio project: a contract and approval management system on Microsoft Power Platform, demonstrating PL-400 and AB-620 skills.

## Language rules

- **Chat replies to the owner: Arabic**, with technical terms kept in English.
- **All project files are English only**: README, ADRs, data model, specs, code comments, Display names, Choice values, status values, column descriptions. No Arabic in the repository (the project is global-facing).

## Working rules

- Be direct and concise. No preamble, no motivational filler.
- Do not invent numbers or facts. If information is unavailable, say so explicitly. Mark anything not verified as such in documents.
- If the owner's idea is bad, say so and propose an alternative.
- State the trade-off for every design suggestion.
- The data model must be reviewed and approved before anything is built on it.

## Confidentiality

There are no real contracts in this project. All data is entirely fictitious (obviously fake company names, fake numbers).

Forbidden in any file or test data:
- Real organization names
- Account numbers, IBANs
- Person names
- Phone numbers
- Real email addresses (use reserved domains such as `example.com` / `example.test` only)
- Real contractual prices

If a task approaches violating this, warn the owner before proceeding.

Exported flow files (`src/Workflows/`): they carry the environment host in the record links and could carry an approver email:
- **After every `pac solution sync`, run `node scripts/scrub-emails.mjs` before `git add`.** It replaces email addresses under `src/Workflows/` with `<APPROVER_TEST_ACCOUNT>` and the environment host of the record link (`itemLink`) with `<ORG_HOST>`, and prints counts only, never the values. A scrubbed flow is not importable until its host is filled in again (since flow v1 was retired on 2026-10-24 the only flow, v2, has no approver account; the scrubber keeps the placeholder `<APPROVER_TEST_ACCOUNT>` for any future flow).
- A local pre-commit hook (`.git/hooks/pre-commit`) rejects any commit whose staged diff adds an email-like string. **`.git/hooks` is not versioned**, so the hook must be recreated on a fresh clone.

## Division of labor

- The owner performs all click-work manually in make.powerapps.com and Power Automate.
- Claude writes code, specifications, documentation, files, and `pac` commands.

## Conventions

- Publisher prefix: `mwf`. Schema names are `mwf_<name>`, lowercase (see `docs/decisions/ADR-001-dedicated-solution.md`).
- Environment: Base currency **TRY** (existing environment, deliberate decision; changing it is possible through Base Currency Conversion but heavy), Base language English (see ADR-001). Base amounts are in TRY. The authority threshold is in USD, so Phase 2 computes an independent USD value.
- Architecture decisions are recorded in `docs/decisions/` as `ADR-NNN-<slug>.md`.

## Repository layout

| Path | Content |
|---|---|
| `src/` | Unpacked solution |
| `plugins/` | Dataverse plugins (.NET) |
| `pcf/` | PCF controls |
| `pipelines/` | ALM / CI-CD |
| `docs/` | Specifications and documentation |
| `docs/decisions/` | ADRs |
| `data/` | Fictitious test data only |

## Current status

Phase 1 (core) was completed on 2026-10-11 (owner's statement); Phase 2 (server rules, approval chain, roles, auditing) is built too. Details and numbers: `README.md` and the ADRs.

- **Built (one unmanaged Developer environment):** 6 tables, a model-driven app, 4 plug-in classes in 7 steps, flow v2 (v1 retired on 2026-10-24), 4 security roles, auditing on 5 tables and 4 lookups, 110 matrix rows and 5 approver assignments.
- **Tested:** the plug-ins and the seed rules by scripts with the owner's account (last regression pass 2026-10-25); flow v2 with real approvals, cases A to D, and the failed endings F1 and F2 (2026-10-22, the owner answered each request); roles with a non-interactive application user (2026-10-24); auditing, including a change of `mwf_user` (2026-10-24 and 2026-10-25).
- **Not tested:** the solution import (never run), roles with an interactive user or in the app, a non-admin caller of the audit test, whether the nine platform privileges return after an import. Full list: `README.md` and `docs/rebuild-runbook.md`, section 5.
- **Environment:** an unmanaged Developer environment; per Learn it is suspended from 2026-12-15 and deleted from 2027-01-15 (not checked: whether a managed or other environment is available). The rebuild plan, with a rehearsal that has not been run yet, is `docs/rebuild-runbook.md`.
- **Data:** fictional only; the scripts create and remove their own `TEST-TMP` rows (the environment holds 11 contracts).
