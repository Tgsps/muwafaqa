# ADR-004 — Contract State Guard: allowed status changes, locked columns, no delete after submission

- **Status:** Accepted (verified on the server on 2026-10-12). 233 unit tests in the project (201 of them new for the guard and its policies), 89 API integration checks and 4 manual UI checks, no failure. The results are in `docs/plugin-registration-log.md`.
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
2. **Strict empty string.** `""` is **not** equal to null. Writing `""` over an empty text column counts as a change, so it is rejected in a locked status. This is fail closed. **Confirmed on the server** (see "Verified on the server"): the platform stores `""` as null in Draft, so the strict rule is a harmless false positive in a locked status.
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

## Verified on the server

Tested on 2026-10-12 with fictional TEST-TMP-GUARD rows, the approval flow OFF. Details: `docs/plugin-registration-log.md`.

- **89 API integration checks, no failure:** every allowed and every rejected transition, Create in each status, the six locked columns in Pending, In Force and Rejected (different value rejected with the row unchanged, identical value accepted) and editable in Draft, the frozen column, the Subject, combined requests, delete in each status, and plug-in 1 cases 1, 7, 8 and the old case 2 behind the guard.
- **4 UI checks, no failure** (by the owner, on three rows):
  1. Deactivate on a Draft row was blocked with "Cannot change the contract status from Draft to Rejected. Allowed next status: Pending Approval." and the row stayed Draft.
  2. Activate on a Rejected row succeeded and the row became Draft (the dialog sent Status Reason = Draft).
  3. Editing Value on a Pending row and saving was blocked with "Cannot change Value while the contract status is Pending Approval. Return the contract to Draft first." and the row stayed Pending.
  4. Delete on a Pending row was blocked with "Cannot delete a contract whose status is Pending Approval." and the row still exists.
- **The PreImage is available at PreValidation** for Update and Delete. The Update guard decided by the PreImage status and the Delete guard read the status from it.
- **The Update step also runs for the Deactivate button** (the guard message came from it). Together with the Activate result (the allowed transition Rejected to Draft went through), no step on the SetState message is needed, at least for those two buttons.
- **Activate with `{statecode: 0}` alone gives Draft** (HTTP 204, statuscode 1), and the guard allows it.
- **The platform ignores `statecode` on Create.** A Create with `{statecode: 1}` and no status produced a Draft row, so a Rejected row cannot be created that way.
- **`""` over a null locked text column** (Contract Number) is **rejected in Pending** (strict, confirmed). In Draft the platform stores `""` as null.
- **Rejected rows accept writes at the platform level.** Identical-value writes and a Subject edit on a Rejected row returned 204, so it is the guard that locks them.
- **The combined request behaves correctly:** one PATCH {Value, Pending} from Draft succeeds with the new frozen value, and one PATCH {Value, Draft} from Pending is rejected and the row is unchanged.

## Risk: the guard can be bypassed by a privileged caller

This is a **risk**, not a pending item.

- A caller with the privilege `prvBypassCustomBusinessLogic` can skip custom plug-in steps. `MSCRM.BypassBusinessLogicExecutionStepIds` skips the listed steps, and `MSCRM.BypassBusinessLogicExecution: CustomSync` skips **all** custom synchronous logic, this guard and plug-in 1 included ([Bypass custom Dataverse logic](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/bypass-custom-business-logic)).
- **It worked for the administrator account in the tests:** a DELETE of an In Force row with the step id of the guard Delete step returned HTTP 204 and the row was gone.
- Per Learn, by default only the System Administrator role holds this privilege, and it cannot be added to another role in the security role designer (only through the API). **The security roles phase must NOT grant it to any other role.**
- The test scripts use the bypass only to clean up In Force test rows.
- Flows are not covered by these parameters (Learn: Power Automate flows are managed separately), so the approval flow is still subject to the guard.

## Not verified yet

- **The exact number of passes at PreValidation.** Learn ([Behavior of specialized update operations](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/special-update-operation-behavior)) documents the split of a request into a normal-column pass and a status pass for PreOperation and PostOperation only. The combined requests behave correctly, but one pass against two cannot be proven from outside. The design does not depend on it.
- **Verified on 2026-10-13 (phase C): the guard with the approval flow ON, end to end.** An approval that finishes ended In Force, and a late write of In Force over a withdrawn Draft was rejected with the guard message, which failed that flow run. See `docs/plugin-registration-log.md`, section "Phase C: end-to-end with the approval flow ON". The run-to-contract mapping is inferred, not shown by name. The failure handling in the flow is still open (Follow-ups).
- **Messages the guard does not cover:** a change of owner (Assign, `ownerid`) and bulk messages such as `UpdateMultiple`. The Update step on the table does not see an assign, and the bulk messages were not exercised.
- **The guard cannot tell the flow from a user.** The flow runs with the same account, so a rule such as "only the flow may set In Force" cannot be expressed here.

## Follow-ups

1. **Update the old scripts** (they use transitions that the guard rejects):
   - `scripts/load-test-data.mjs` moves Draft to In Force and Draft to Rejected directly. It must go through Pending Approval.
   - `scripts/test-usd-freeze.mjs`: the Rejected to Pending test (case 2) becomes a **negative** test; cleaning rows in Pending means **withdraw to Draft, then delete**; rows that reached In Force cannot be deleted without the bypass.
   - `scripts/verification-api-tests.mjs` and any other script that changes the status or deletes rows.
2. **Flow failure handling (flow step 4): done for the guard case on 2026-10-13.** The flow now has two checkpoints (after each approval stage it re-reads the contract and ends Cancelled if it is no longer Pending Approval), so a late write of In Force over a withdrawn Draft is stopped before the write. Test and evidence: `docs/flow-approval-v1.md`, section 13. Before the checkpoints the same situation failed the run at `Update_a_row_3` with the guard message "Cannot change the contract status from Draft to In Force. Allowed next status: Pending Approval." (observed on 2026-10-13). **Still open:** the stale-run gap (a contract withdrawn and submitted again while the first run waits; flow spec section 12) and the race window between the check and the write (the guard still rejects that write and the run fails loudly).
3. **`ownerid` and the dates** are revisited later (decision 3 above). Assign is not covered by the guard.
4. **The end-to-end test with the approval flow ON:** done on 2026-10-13 (see "Not verified yet").
5. **Security roles phase:** do not grant `prvBypassCustomBusinessLogic` to any role other than System Administrator.
