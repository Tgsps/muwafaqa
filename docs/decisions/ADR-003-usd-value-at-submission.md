# ADR-003 — USD value frozen at submission: current rate, fail loudly

- **Status:** Accepted. Registered and integration tested on the Update path, the Create path and with the existing approval flow (2026-10-12). All cases passed.
- **Date:** 2026-10-12

## Context

The authority threshold in the approval matrix is in USD. The environment base currency is TRY, so the platform base amount (`mwf_value_base`) is in TRY and cannot be compared with a USD threshold. The contract also has its own currency (USD, KWD, AED, SAR). A USD value is needed, and it must not change after the contract is submitted for approval, otherwise a rate change could move a contract from one approval band to another while it is being approved.

## Decision

A plugin writes `mwf_valueusdfrozen` (Decimal, 2 decimals) on `mwf_contract` when the contract **enters Pending Approval**.

- **Trigger.** Create with status Pending Approval, or Update where the status changes to Pending Approval. A save that keeps Pending Approval does not recompute. Every re-entry (Pending, Draft, Pending) recomputes.
- **Stage.** PreOperation (20), synchronous, so the value is written in the same transaction as the status change. The approval flow, which starts after commit, always sees the frozen value.
- **Rate source: current rates at submission.** `USD = Value * rate(USD) / rate(contract currency)`, with `rate` read from the currency table at that moment. The `exchangerate` stored on the contract is **not** used.
- **Rounding.** 2 decimals, `MidpointRounding.AwayFromZero`.
- **Fail loudly.** If the active USD currency record is missing or ambiguous, a needed rate is null or not greater than zero, or the contract has no Value or no currency, the plugin throws `InvalidPluginExecutionException` with an English message and writes nothing. The status change is rolled back.
- **Value 0** writes `0.00`. **A negative Value** is an error. **An inactive contract currency** is not checked (its rate is still used).
- **Reading the rates** uses the System user (`CreateOrganizationService(null)`, which Microsoft Learn documents as the SYSTEM user in a plug-in), so a user without read access to the currency table can still submit. Only the currency table is read this way.
- **Packaging.** Unsigned plug-in package `mwf_muwafaqaplugins`, version fixed at 1.0.0, target .NET Framework **4.6.2 (`net462`)**, namespace `Muwafaqa.Plugins`. The package name and version cannot be changed on the server after creation (Learn), so the assembly version is the one that moves.
  - **Why net462 and not 4.8.** The plug-in package upload accepts only `net462` and `net471` (server error `0x80040265`, "No supported target framework folder found in package"). The 4.8 recommendation in Learn applies to loose assemblies, not to packages. This is **observed on the server on 2026-10-12, not documented**. A first attempt with a `net48` package was rejected with that error and nothing was created.

## What happens to the value after the contract leaves Pending Approval

`mwf_valueusdfrozen` **keeps its last value** after the contract returns to Draft or is Rejected. It is **authoritative only while the contract is Pending Approval or In Force**. A consumer that reads it in Draft or Rejected must not treat it as the current value.

## Alternatives considered

| Option | Upside | Downside |
|---|---|---|
| **Current rate at submission (chosen)** | Reflects the rate when the decision is made. Independent of when the contract was created or last edited | A rate change between creation and submission changes the USD value. The stored `exchangerate` on the contract may differ from the rate used |
| Use the `exchangerate` stored on the contract | No extra read. Same rate as `mwf_value_base` | That rate is refreshed only when Value is edited (verified earlier). A contract created long before submission would use an old rate |
| Compute from `mwf_value_base` and a USD rate | One conversion | Two conversions that both depend on rates, and the base amount may be stale for the same reason |
| Compute at read time (calculated column or flow) | Always current | Not frozen, so the approval band can change during approval. Against the purpose |

| Choice | Trade-off |
|---|---|
| **Fail loudly** (chosen) | A contract cannot be submitted while a rate or the USD record is broken. The user sees an error. This is intended, because a silent fallback would put a wrong amount in the approval decision. Cost: submission is blocked until an administrator fixes the currency data |
| Write nothing and let the contract through | Submission never blocks | The approval would run without a USD value, and the matrix could not be applied |
| System context for reading rates (chosen) | Works for any user | Reads with higher privilege than the caller (one reference table, read only) |

## Consequences

- If the USD currency record is deactivated or removed, no contract can enter Pending Approval. The error text names the cause.
- The value in Draft or Rejected may be stale or empty (see above).
- The same-value save (Pending to Pending) does not recompute, but it still starts a new approval flow run (documented in `docs/flow-approval-v1.md`).
- **Read-only on the form is not enforcement.** Any API call can write the column outside the plugin. Enforcement needs another step or a column security profile (out of scope).
- A request that changes status and other columns together runs Update plug-ins twice in the platform (Learn, "Behavior of specialized update operations"). The step is filtered on `statuscode`, so only the status pass reaches it. **Verified on 2026-10-12 (case 1):** the PreImage in that pass already reflects the Value edited in the same request, and the column written in the status pass is persisted. A PATCH from Rejected to Pending with `statecode` and `statuscode` together also runs the step (case 2).

## Not verified

- Zero Value (`0.00` written) was not run as an integration case. It is covered by a unit test.

## Verified on the server (2026-10-12)

- `POST /pluginpackages` with the base64 package in `content` and the `MSCRM.SolutionUniqueName` header works. The assembly and the plug-in type are created automatically. Results are in `docs/plugin-registration-log.md`.
- Create directly as Pending Approval without a currency: the platform fills the base currency (TRY) **before** PreOperation, so the plug-in does not fail with "no currency" (case 3). The USD value is computed from that currency.
- A Draft contract with no Value cannot be submitted: HTTP 400, status stays Draft, nothing is written (case 10).
- The existing approval flow still starts for a contract that enters Pending Approval, and the row holds the frozen value (case 9). The owner checked the run and rejected the stage 1 approval. The row ended Rejected and Inactive with the frozen value unchanged.
- Editing Value while the contract is Pending Approval does not change the frozen value (case 8). Value and the frozen USD value can then differ. Blocking the edit is the next plug-in, "prevent edit of a contract in Pending/In Force" (not started).
- The default read privilege on the currency table for users without a custom role (not documented in Learn). Not needed with the System context.
