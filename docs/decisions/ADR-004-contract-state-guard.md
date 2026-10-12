# ADR-004 — Contract State Guard: allowed status changes, locked columns, no delete after submission

- **Status:** Proposed. The code and the unit tests exist (233 tests in the project, 201 of them new for the guard and its policies). **Not registered and not tested on the server.**
- **Date:** 2026-10-12

## Problem

Two behaviors were proven earlier on the server, and a third follows from them:

1. **The flow wrote In Force over a user's Draft.** The user returned the contract to Draft while an approval was outstanding. The flow still finished and set In Force, and the platform accepted it because Draft and In Force are both State Active (`docs/flow-approval-v1.md`, section 10 case d, and section 6).
2. **Value edited while Pending left the frozen USD value unchanged.** The frozen value is correct as a snapshot, but Value and the frozen USD value then disagree while the approval is running (ADR-003, case 8).
3. **Nothing stops other edits or a delete** of a contract that is being approved or already in force (same cause: the platform only knows Active and Inactive).

## Decisions (approved by the business)

| # | Question | Decision |
|---|---|---|
| Q1 | After Rejected | **Rejected to Draft** is the only way out |
| Q2 | After In Force | **In Force is final** for now. No status change leaves it |
| Q3 | Value, currency, Contract Type, Contract Direction, Counterparty | **Locked after submission** (Pending Approval, In Force, Rejected). Editable in Draft |
| Q4 | Contract Number | **Fixed after submission**, editable in Draft |
| Q5 | Delete | **Nobody deletes** Pending Approval or In Force. Draft and Rejected may be deleted |

### Allowed status changes (decided by `statuscode` only)

| From \ To | Draft | Pending Approval | In Force | Rejected |
|---|---|---|---|---|
| **Draft** | same (no-op) | allowed | rejected | rejected |
| **Pending Approval** | allowed | same (no-op) | allowed | allowed |
| **In Force** | rejected | rejected | same (no-op) | rejected |
| **Rejected** | allowed | rejected | rejected | same (no-op) |

- **Same status to the same status is not a transition** (allowed, no-op).
- **Create:** the status may be absent (platform default Draft), Draft or Pending Approval. In Force and Rejected on Create are rejected.

### Locked columns

Evaluated with the status the row has **before** the request (PreImage `pre`).

| Column | Draft | Pending Approval | In Force | Rejected |
|---|---|---|---|---|
| Value `mwf_value` | editable | locked | locked | locked |
| Currency `transactioncurrencyid` | editable | locked | locked | locked |
| Contract Type `mwf_contracttype` | editable | locked | locked | locked |
| Contract Direction `mwf_direction` | editable | locked | locked | locked |
| Counterparty `mwf_counterpartyid` | editable | locked | locked | locked |
| Contract Number `mwf_contractnumber` | editable | locked | locked | locked |
| Value (USD, Frozen) `mwf_valueusdfrozen` | **locked** | **locked** | **locked** | **locked** |
| Contract Subject `mwf_name` | editable | editable | editable | editable |

- A column counts as **changed** only if the value in the Target **differs** from the PreImage value. Writing the identical value is a no-op and is allowed.
- Comparison: Money and decimal by value, option value by `Value`, reference by id and logical name, string by ordinal equality, null equals null.
- The frozen column rejects any Target value that differs from the PreImage value. On Create it rejects any non-null value (including 0).
- **Intentional edge:** a row in Pending, In Force or Rejected whose Contract Number is empty cannot get a number afterwards.
- The frozen column is written by plug-in 1 at PreOperation (stage 20). The guard runs at PreValidation (stage 10) and only sees what the client sent, so it does not block plug-in 1.

### Delete

| Status | Delete |
|---|---|
| Draft | allowed |
| Pending Approval | **rejected** |
| In Force | **rejected** |
| Rejected | allowed |

### One request that changes several attributes

The rule is: **evaluate with the PreImage status (the status before this pass)**.

- A single request {Value changed, status Draft to Pending} from Draft is **allowed** (Value is editable in Draft, the transition is allowed).
- A single request {Value changed, status Pending to Draft} from Pending is **rejected** (Value is locked while the PreImage status is Pending).
- If the platform splits a request into two passes (documented for PreOperation and PostOperation), the same rule gives the same verdict in both passes: the normal-column pass is judged by the PreImage status, and the status pass has the new Value already in the PreImage.

The unit tests cover both scenarios as one combined request **and** as two split passes.

## Structure

- One class `ContractStateGuard` (shell) for the three messages, registered later as three steps, all **PreValidation (10), synchronous**: Update (filtering attributes and PreImage `pre` with the guarded columns plus `statuscode` and `statecode`), Create (no filtering, no image), Delete (PreImage `pre` with `statuscode`).
- Pure classes without any SDK dependency, linked into the test project: `ContractStatus`, `ColumnValue`, `TransitionPolicy`, `LockedColumnsPolicy`, `DeletePolicy`, and `GuardEvaluator` (composes the three policies for one Target and PreImage pair, so the code that is tested is the code that ships).
- **Errors:** `InvalidPluginExecutionException` with an English message that names the from and to status, the locked column display names, or the status for a delete. A missing PreImage (Update, Delete) or a PreImage without `statuscode` is a configuration error (fail closed), the same way plug-in 1 behaves.

## Behaviors decided during implementation

1. **`statecode` alone means the default status of that state.** A request that carries `statecode` but no `statuscode` is read as the default status of the state (state 0 is Draft, state 1 is Rejected, from the solution source). Reason: Learn says that updating `StateCode` without `StatusCode` sets the default status, so a request "state 1 on an In Force row" would otherwise turn it into Rejected and bypass the table above. Consequences: In Force plus `statecode=1` is rejected, Rejected plus `statecode=0` (the Activate button) is allowed, and Pending plus `statecode=0` is evaluated as Pending to Draft (allowed, even if the platform would have left it Pending).
2. **Strict empty string.** `""` is **not** equal to null. Writing `""` over an empty text column counts as a change, so it is rejected in a locked status. This is fail closed. **To be checked on the server later** (it may be that Dataverse stores `""` as null).
3. **Columns left unlocked:** the Signed, Effective and Expiry dates and the owner (`ownerid`). The business did not list them, so they stay editable in every status, including In Force. The owner change goes through an assign and is not covered by the columns of this guard. Both are revisited later (see Follow-ups).
4. **`exchangerate` and `mwf_value_base` are not added to the locked columns.** In `src/Entities/mwf_Contract/Entity.xml` both have `ValidForCreateApi=0` and `ValidForUpdateApi=0`: a client cannot write them (the platform calculates them from Value and the currency). There is nothing to lock. The base value changes only when Value or the currency changes, and both are locked.
5. **Unknown status values are fail closed:** an unknown status is not editable, not deletable, and not a valid source or target of a transition.

## Rejected alternative: Status Reason Transitions (EnforceStateTransitions)

Dataverse has a built-in feature for allowed Status Reason transitions ([Define status reason transitions](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/define-status-reason-transitions), [Define custom state model transitions](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/define-custom-state-model-transitions)). It is not enough here:

- It **does not lock columns**. Value, currency, Type, Direction, Counterparty and Contract Number would stay editable in Pending and In Force.
- It **does not block delete**.
- It **does not protect the frozen column**.
- It **requires every Active status reason to have a path to an Inactive status** (as Learn describes it, to avoid a record that cannot be resolved or cancelled), which In Force (final) cannot satisfy.
- Learn describes state changes with `SetStateRequest` when state transitions are enforced, so an `Update` that changes the status may need to become a `SetState` call. **Not tested here.** The table currently has `EnforceStateTransitions = 0`.

## Not verified yet

- **Two-pass behavior with the guard.** Learn ([Behavior of specialized update operations](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/special-update-operation-behavior)) documents the split of a request into a normal-column pass and a status pass for **PreOperation and PostOperation only**. PreValidation is not mentioned, so the guard **probably receives the whole request once** (likely, **not verified**). The design does not depend on the answer (it decides by the PreImage status), but the unit tests simulate both models.
- **PreImage at PreValidation** for Update and Delete (Learn says images can be used in PreValidation or PreOperation steps; not tested here).
- **Bypass.** A caller with the privilege `prvBypassCustomBusinessLogic` can skip custom steps with `BypassBusinessLogicExecutionStepIds`. Not tested, and it is unknown whether the account used by the flow or by the owner has that privilege.
- **The guard cannot tell the flow from a user.** The flow runs with the same account, so a rule such as "only the flow may set In Force" cannot be expressed here.
- The effect of `""` against null on the server (decision 2).
- **SetState path.** The guard is registered on Create, Update and Delete only. Learn marks SetStateRequest as a deprecated message whose operation is now done with Update, but does not say that a step registered on Update runs for a SetState call. The Activate and Deactivate buttons of the app may use SetState. If the Update step does not run for them, the guard can be bypassed from those buttons, and a step on the SetState message must be added. To be tested on the server (Deactivate on a Draft row must be blocked with the guard message; Activate on a Rejected row must give Draft).

## Follow-ups

1. **Update the old scripts after the steps are registered and tested** (they use transitions that the guard rejects):
   - `scripts/load-test-data.mjs` moves Draft to In Force and Draft to Rejected directly. It must go through Pending Approval.
   - `scripts/test-usd-freeze.mjs`: the Rejected to Pending test (case 2) becomes a **negative** test; cleaning rows in Pending means **withdraw to Draft, then delete**; rows that reached In Force cannot be deleted without the bypass.
   - `scripts/verification-api-tests.mjs` and any other script that changes the status or deletes rows.
2. **Flow failure handling (flow step 4):** a late write of In Force over Draft will now fail with the guard message. The flow needs a deliberate handling of that failure (for example, run after failure), instead of an unhandled failed run.
3. **`ownerid` and the dates** are revisited later (decision 3).
4. **Registration plan** for the three steps and the package update, then integration tests with TEST-TMP rows, then the updated scripts.
5. **Integration test list for the registered steps:**
   - every allowed transition succeeds;
   - every rejected transition returns HTTP 400 and the row is unchanged;
   - each locked column in each status;
   - {Value, Pending} from Draft succeeds;
   - the frozen column written directly is rejected;
   - Create in each status;
   - delete in Draft and Rejected succeeds, and in Pending and In Force is rejected;
   - Pending withdrawn to Draft, then deleted, succeeds;
   - the Activate and Deactivate buttons (manual, by the user);
   - empty string versus null on a locked text column;
   - the bypass by step id;
   - a re-run of plug-in 1 cases 1, 2, 7 and 8 (case 2 becomes a negative test).

The status of this ADR stays **Proposed** until the integration tests pass.
