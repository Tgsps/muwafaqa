# ADR-001 — Dedicated solution with publisher prefix `mwf`

- **Status:** Accepted
- **Date:** 2026-10-06 (amended 2026-10-06: environment constraints added)

## Context

Every Dataverse component (tables, columns, flows, apps) is created inside a solution, and each solution belongs to a publisher that defines the customization prefix. Without an explicit choice, components land in the Default Solution under a default publisher with a random prefix (e.g. `cr123_`) and cannot be cleanly moved between environments.

## Decision

- One dedicated solution: unique name `Muwafaqa`, display name `Muwafaqa`.
- Dedicated publisher: unique name `MuwafaqaDev`, **prefix `mwf`**. (The publisher display name was not recorded here.)
- Choice value prefix (Option Value Prefix): `86764`, generated at publisher creation. Choice option values start at `867640000` and increase from there.
- The solution is Unmanaged in the development environment and exported as Managed to test and production via pipelines.
- All schema names use the form `mwf_<name>`, lowercase.
- No component is created outside this solution. Always create from inside it, or add it to it immediately.

## Environment constraints

Both are set when the environment is created:

| Constraint | Value | Consequence |
|---|---|---|
| Base currency | **TRY** (Turkish Lira; verified by querying the organization on 2026-10-06) | The environment already existed and TRY is a deliberate decision. The `_base` (base amount) column of every Currency column is stored in TRY. The exchange rate stored on each record means units of that currency per 1 TRY (verified by test: base = value ÷ rate). It can be changed through the Base Currency Conversion process, which is heavy, so it is treated as practically fixed. [Source](https://learn.microsoft.com/en-us/power-platform/admin/change-base-currency-environment) |
| Base language | **English** | All Display names, Choice labels, and descriptions are authored in English. Other languages would be translations only. |

**Consequence for approvals:** the approval authority threshold is defined in US dollars, but base amounts are in TRY. Phase 2 therefore computes an **independent USD value** (from the base amount and a USD rate) and freezes it when the contract is submitted. Base amounts alone must not be used to test the threshold.

**History:** the first draft of this ADR assumed a USD base. A query on 2026-10-06 showed TRY. The exchange rates on the currency records are placeholders for test data, not market rates. See [data-model-phase1.md](../data-model-phase1.md) section 8.

## Trade-offs

| Aspect | Upside | Downside |
|---|---|---|
| Dedicated solution | Exportable, portable, source-controllable, ALM-ready | Admin overhead: always check the active solution when creating components |
| Fixed prefix `mwf` | Readable names, no collisions | The prefix cannot be changed once components use it. A mistake means a rebuild |
| Single publisher | Simplicity | No separation between project layers later (e.g. a separate plugins solution). More solutions can share the same publisher without issue |
| Unmanaged in dev | Fast direct editing | Never ship Unmanaged to production. Requires pipeline discipline |
| Practically fixed base currency (TRY) | Simple, consistent aggregation in one currency | Base amounts are in TRY, not in the currency used for authority limits (USD). Changing it needs the Base Currency Conversion process (backup, historical exchange rates, conversion job) |

## Rejected alternatives

- **Default Solution:** non-portable components, random prefix, unsuitable for a portfolio project meant to show ALM practice.
- **Default publisher with only the prefix changed:** pollutes the shared default publisher and does not isolate ownership.

## Notes

- Publisher prefix rules: 2–8 alphanumeric characters, starts with a letter, cannot start with `mscrm`. `mwf` satisfies them.
