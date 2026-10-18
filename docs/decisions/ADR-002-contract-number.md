# ADR-002 — Contract number: plain text now, plugin in Phase 2

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

Contracts need a human-readable identifier. Phase 1 builds the core data model only; generation logic is out of scope there.

## Decision

- **Phase 1:** `mwf_contractnumber` is a plain Single line of text, Optional, populated manually or left empty.
- **Phase 2:** a Dataverse plugin generates the number on create.

## Alternative considered: Autonumber column

Dataverse offers a native Autonumber column (e.g. format `CT-{SEQNUM:5}`) that needs no code and has platform-managed concurrency.

**Why not chosen:**
- The project goal is to demonstrate plugin development (PL-400). A plugin also allows logic a plain Autonumber format may not support, such as a prefix derived from contract type or a per-year sequence reset. Whether Autonumber supports a per-year reset or a type-based prefix is **not verified**; it was not needed to reach this decision.
- The cost is real: custom code to maintain and deploy, and concurrency handling that the platform otherwise provides.

## Trade-offs

| Option | Upside | Downside |
|---|---|---|
| Plugin (chosen) | Full control over format and rules, demonstrates PL-400 skills | Code to maintain. Duplicate numbers possible under concurrent creates unless handled explicitly |
| Autonumber | No code, platform-managed concurrency | Less flexible formatting (limits unverified) |

## Consequences

- Phase 2 must design the plugin's concurrency strategy and an uniqueness guarantee (e.g. an Alternate key; its behavior with empty values was verified on 2026-10-07, see the next point).
- **Update 2026-10-07 / 2026-10-11:** a unique alternate key `Contract Number Key` now exists on `mwf_contractnumber`. Duplicate numbers are rejected (UI, and HTTP 412 through the API). Several rows with an empty number are accepted. See verification checklist item 5.
- **Format constraint:** the contract number format must **not** contain any of these characters: `/` `<` `>` `*` `%` `&` `:` `\` `?` `+`. If the data in a column used by an alternate key contains one of them, retrieving (`GET`) or updating (`PATCH`) a row by that key does not work. Uniqueness alone still works. Source: Microsoft Learn, [Work with alternate keys](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/define-alternate-keys-entity), constraint "Unicode characters in key value". This now applies: the key exists. **Confirmed on 2026-10-11 for `/`:** `GET` and `PATCH` by key return HTTP 400 "Bad Request - Error in query syntax.", both with the plain and the percent-encoded character, while creating the row with that number succeeds. The other characters of the list were not tested here. The result agrees with the Microsoft Learn constraint (verification checklist, Results log "Alternate key API tests").
- **Update 2026-10-13:** the generator is built and tested, see `ADR-006-contract-number-generator.md` (per contract type, `PREFIX-NNNN`, counter table, pre-lock plug-in). The Contract Number is system-written; a client can no longer choose it, so the GET/PATCH-by-key restricted-character cases above cannot be re-tested through the API. The 2026-10-11 results stay valid for numbers that already exist.
