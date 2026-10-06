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

Phase 1 (core): data model finalized for the owner's decisions, pending build. No test data until the owner asks.
