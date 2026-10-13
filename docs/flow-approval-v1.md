# Flow Specification — Contract Approval v1

A Power Automate cloud flow, built manually by clicking. Two sequential approval stages, fixed approvers.

- **Flow name:** `Muwafaqa - Contract Approval v1`
- **Solution:** `Muwafaqa` (create the flow from inside the solution so it carries the `mwf` publisher context and is exportable)
- **Depends on:** Contract table (`mwf_contract`) with Status Reasons Draft, Pending Approval, In Force, Rejected ([data-model-phase1.md](data-model-phase1.md))
- **Replaced in Phase 2** by an ApprovalMatrix-driven flow. The approvers below are placeholders.

Items marked **(not verified)** must be checked while building. They are also tracked in [verification-checklist.md](verification-checklist.md).

---

## 0. Placeholders to fill before building

| Placeholder | Meaning | How to get it |
|---|---|---|
| `<PENDING_APPROVAL_VALUE>` | Numeric value of Status Reason "Pending Approval" | Verified: `867640000` (2026-10-06). |
| `<IN_FORCE_VALUE>` | Numeric value of "In Force" | Verified: `867640001`. |
| `<REJECTED_VALUE>` | Numeric value of "Rejected" | Verified: `2` (the renamed default Inactive option; State Inactive). |
| `<DEPT_HEAD_TEST_ACCOUNT>` | Test user for the Department Head stage | A test user in the dev tenant. **Never commit a real address or UPN.** |
| `<FINANCE_MGR_TEST_ACCOUNT>` | Test user for the Finance Manager stage | Same |
| `<ENV_URL>` | Dev environment base URL | From the environment details page |

Rule: compare status by **numeric value**, not label. Values do not change when a label is renamed (see data model note 7).

---

## 1. Trigger

**Connector action:** Microsoft Dataverse → *When a row is added, modified or deleted*

| Setting | Value |
|---|---|
| Change type | `Modified` |
| Table name | `Contracts` |
| Scope | `Organization` |
| Select columns | `statuscode`. In the Power Automate UI the "Filter columns" setting is labelled **Select columns**. It must contain `statuscode` and must **not** be left empty |
| Filter rows | `statuscode eq <PENDING_APPROVAL_VALUE>` |

Notes:
- **Filter columns** (labelled **Select columns** in the UI) limits which column changes fire the trigger. Only `statuscode` is listed there.
- **Filter rows** is an OData expression evaluated on the server. It is the condition "Status Reason = Pending Approval".
- Both are required. See section 6 for why Filter columns alone is not enough.
- **Update 2026-10-13:** the live trigger now uses Select columns `mwf_valueusdfrozen` instead of `statuscode` (same Filter rows). See section 12.

**Optional second guard** (Settings → Trigger conditions), redundant with Filter rows, kept as a defence in depth:

```
@equals(triggerOutputs()?['body/statuscode'], <PENDING_APPROVAL_VALUE>)
```

**Concurrency control is NOT enabled, by decision.** An earlier version of this spec said "Concurrency control = On, degree of parallelism = 1". That was never applied: the exported flow contains no `runtimeConfiguration`, concurrency or `triggerConditions` (read on 2026-10-11). Reasons for not enabling it, from Microsoft Learn (verified 2026-10-11): concurrency control is off by default; turning it on can't be undone; the waiting runs limit is 10 plus the degree of parallelism; additional triggers beyond that might be retried by the connector and might not succeed; and Microsoft recommends leaving it off so that all triggers result in runs. Sources: [Limits of automated, scheduled, and instant flows](https://learn.microsoft.com/power-automate/limits-and-config#concurrency,-looping,-and-debatching-limits) and [Optimize Power Automate triggers](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/optimize-power-automate-triggers) (concurrency control is irreversible; the best practice is to leave the default). Duplicate runs are handled in Phase 2 instead (section 11).

---

## 2. Stage 1 — Department Head approval

**Action:** *Start and wait for an approval*  
**Rename to:** `Approval_DeptHead` (no spaces or hyphens, so expressions stay simple)

| Field | Value |
|---|---|
| Approval type | `Approve/Reject - First to respond` |
| Title | `Approve contract: @{triggerOutputs()?['body/mwf_name']}` |
| Assigned to | `<DEPT_HEAD_TEST_ACCOUNT>` |
| Details | see below |
| Item link | `<ENV_URL>/main.aspx?etn=mwf_contract&pagetype=entityrecord&id=@{triggerOutputs()?['body/mwf_contractid']}` |
| Item link description | `Open contract` |

Cosmetic note: in the built flow, the request title of `Approval_DeptHead` shows a space before the colon ("Approve contract :"). It does not affect behavior.

Details (Markdown):

```
**Contract:** @{triggerOutputs()?['body/mwf_name']}
**Number:** @{triggerOutputs()?['body/mwf_contractnumber']}
**Value (base amount, TRY):** @{triggerOutputs()?['body/mwf_value_base']}
**Stage:** 1 of 2 (Department Head)
```

(`mwf_value_base` is the expected logical name of the auto-created base column. Confirm after the table is built: **not verified**.)

### Condition 1 — Outcome

**Action:** *Condition*, rename to `Check_Stage1`

| Left | Operator | Right |
|---|---|---|
| `outputs('Approval_DeptHead')?['body/outcome']` | is equal to | `Approve` |

Expression form of the same condition:

```
@equals(outputs('Approval_DeptHead')?['body/outcome'], 'Approve')
```

**If no (Reject):**
1. *Update a row* (Dataverse)
   - Table name: `Contracts`
   - Row ID: `@{triggerOutputs()?['body/mwf_contractid']}`
   - **Status** (State): `Inactive`
   - Status Reason: `Rejected` (dropdown shows the label; if you must enter it as a value use `<REJECTED_VALUE>`)
   - Both are required. Setting Status Reason alone fails with the real error: "2 is not a valid status code for state code mwf_ContractState.Active"
2. *Terminate*
   - Status: `Succeeded` (the rejection is a normal business outcome, not a flow failure)

**If yes (Approve):** continue to Stage 2, placed inside this branch.

---

## 3. Stage 2 — Finance Manager approval (inside "If yes" of Condition 1)

**Action:** *Start and wait for an approval*, rename `Approval_FinanceMgr`

Same settings as Stage 1 except:

| Field | Value |
|---|---|
| Assigned to | `<FINANCE_MGR_TEST_ACCOUNT>` |
| Details, last line | `**Stage:** 2 of 2 (Finance Manager)` |

### Condition 2 — Outcome

**Action:** *Condition*, rename `Check_Stage2`

```
@equals(outputs('Approval_FinanceMgr')?['body/outcome'], 'Approve')
```

**If no (Reject):**
1. *Update a row* → **Status** (State) = `Inactive` **and** Status Reason = `Rejected`, Row ID `@{triggerOutputs()?['body/mwf_contractid']}` (same reason as stage 1: Status Reason alone fails)
2. *Terminate* → Status `Succeeded`

**If yes (Approve):**
1. *Update a row*
   - Table name: `Contracts`
   - Row ID: `@{triggerOutputs()?['body/mwf_contractid']}`
   - Status Reason: `In Force`

---

## 4. Flow outline

```
Trigger: Contract modified, statuscode = Pending Approval
└─ Approval_DeptHead
   └─ Check_Stage1: outcome = Approve ?
      ├─ No:  Update row → Rejected; Terminate (Succeeded)
      └─ Yes: Approval_FinanceMgr
              └─ Check_Stage2: outcome = Approve ?
                 ├─ No:  Update row → Rejected; Terminate (Succeeded)
                 └─ Yes: Update row → In Force
```

---

## 5. Column and expression reference

| Use | Logical name / expression |
|---|---|
| Contract primary key | `mwf_contractid` |
| Contract Subject | `mwf_name` |
| Contract Number | `mwf_contractnumber` |
| Value (original) | `mwf_value` |
| Value (base amount, TRY) | `mwf_value_base` (**verified** to exist; in the environment base currency TRY, not USD) |
| Status Reason | `statuscode` |
| State | `statecode` |
| Currency (lookup, GUID in Web API) | `_transactioncurrencyid_value` |
| Counterparty (lookup, GUID in Web API) | `_mwf_counterpartyid_value` |
| Trigger field | `triggerOutputs()?['body/<logicalname>']` |
| Approval result | `outputs('<ActionName>')?['body/outcome']`, values `Approve` / `Reject` |

---

## 6. Avoiding an infinite loop

**The risk.** The flow updates `statuscode` on the same row that triggered it. A Modified trigger on `statuscode` fires again on that update.

**Why Filter columns alone is NOT sufficient.** The flow's own update changes `statuscode` (to Rejected or In Force), and `statuscode` is exactly the filtered column, so the trigger would fire again.

**What actually breaks the loop: Filter rows.** After the flow's update the row's Status Reason is Rejected or In Force. `statuscode eq <PENDING_APPROVAL_VALUE>` is false, so the second trigger evaluation does not start a run. Filter columns reduces noise (edits to other columns never start a run), and Filter rows is the loop guard.

**Tested live (2026-10-07):** 5 runs for 5 contracts, **one run per contract**. The flow's own update of the contract status did not start another run. The observed behavior is consistent with Filter rows being evaluated against the post-update row. The internal mechanism was not inspected.

**Re-trigger tested live (2026-10-11):** the loop guard holds for the flow's own updates, but the trigger fires again for any save that targets Pending Approval, including a save with the **same** value, and for Pending → Draft → Pending. Each starts a new run and a duplicate approval chain. Editing another column (Subject) while Pending starts no run. Details in section 10.

**Still not tested:**
- Whether the platform applies any loop-breaking protection to cloud-flow-triggered updates. Do not rely on it.

**Activate (Inactive → Draft).** Verified on 2026-10-11: Activate in the app turns an Inactive row into Draft and starts no run (Draft does not match Filter rows).

**Race condition, now observed (section 10).** If someone moves the contract from Pending Approval back to Draft while an approval is outstanding, the flow still finishes and overwrites the status when the approver responds. The hardening (re-read the row before writing) is a Phase 2 item (section 11).

---

## 7. Technical points

**Settled by live testing (2026-10-07):**
- Power Automate Approvals accept the flow creator as the assigned approver.
- *Update a row* with only Status Reason set **works for In Force**.
- *Update a row* with only Status Reason set **does not work for Rejected** without Status (State) = Inactive (error quoted in section 2). Rejected needs State and Status Reason together. Scenarios 2 and 3 ended with the contract Rejected after this was corrected.

**Still open (not verified):**
- Maximum duration of a flow run waiting on an approval: believed to be 30 days. A run waiting longer would time out and leave the contract in Pending Approval. Needs confirmation and a timeout/escalation design in Phase 2.
- Approver comments are shown in the approval but **not stored** on the contract in Phase 1 (no column exists).
- The connection used by the trigger and actions runs as its owner. The owner needs read and update privilege on Contract. Using a personal connection is acceptable for a portfolio dev environment, not for production.

---

## 8. Trade-offs

| Choice | Upside | Downside |
|---|---|---|
| Native Power Automate Approvals | No custom approval table, built-in email and Teams actions, approvals visible in the Approvals app | Approval history lives in platform tables, not in the contract model. Reporting needs extra work |
| Two fixed sequential stages | Simple to build and test | No amount-based routing, no delegation, no skipping. Replaced by ApprovalMatrix in Phase 2 and Delegation in Phase 3 |
| First to respond | One decision per stage | No multi-approver consensus |
| Filter rows + Filter columns on trigger | Server-side, cheap, breaks the loop | Hard-coded numeric value in the flow. A rebuilt environment with different Choice values breaks it (mitigation: environment variable, or read the value in a Phase 2 design) |
| Status changed by the flow | Single source of truth for state is the contract row | The flow's connection identity appears as the modifier on the row |
| Terminate with Succeeded on reject | Run history is clean, rejection is not an error | Run history alone does not show a rejection. The contract's status does |
| No hardening against concurrent status changes (v1), no concurrency control | Fewer actions, no queue to manage | Duplicate runs and the overwrite of a user's Draft, observed in section 10 |

---

## 9. Test plan

Prerequisite: test data imported ([data/README.md](../data/README.md)), the flow turned **on** after the import, two test accounts available to act as approvers, and a way to inspect flow run history. Use a contract that is **Draft** (e.g. `TEST-CT-0009`). Note: after Scenario 2 or 3 the contract is Rejected and Inactive. To reuse it, press **Activate** in the app command bar: observed on 2026-10-07, it turns the contract into Draft (Active) with no dialog for choosing a status (see verification checklist, item 4 and the Results log). Activate starts no flow run (verified 2026-10-11). Otherwise use a different Draft contract for the next scenario.

For every scenario: change Status Reason from Draft to Pending Approval, then observe.

### Scenario 1 — Full approval

| Step | Action | Expected |
|---|---|---|
| 1 | Set Status Reason = Pending Approval | Exactly one flow run starts |
| 2 | Department Head approves | Finance Manager receives an approval. Contract still Pending Approval |
| 3 | Finance Manager approves | Run ends |
| Result | | Status Reason = In Force, State = Active. Run history shows one run, Succeeded. No second run from the flow's own update |

### Scenario 2 — Rejection at stage 1

| Step | Action | Expected |
|---|---|---|
| 1 | Set Status Reason = Pending Approval | One run starts |
| 2 | Department Head rejects | Run ends via Terminate (Succeeded) |
| Result | | Status Reason = Rejected, State = Inactive. Finance Manager **never** receives an approval. One run, no re-trigger |

### Scenario 3 — Rejection at stage 2

| Step | Action | Expected |
|---|---|---|
| 1 | Set Status Reason = Pending Approval | One run starts |
| 2 | Department Head approves | Finance Manager receives an approval |
| 3 | Finance Manager rejects | Run ends via Terminate (Succeeded) |
| Result | | Status Reason = Rejected, State = Inactive. Both approvals exist in the Approvals history (first Approve, second Reject). One run, no re-trigger |

Record deviations (especially extra runs, wrong State, or an approval sent after a rejection) in [verification-checklist.md](verification-checklist.md) under the flow items. Results of the 2026-10-07 run are recorded there.

---

## 10. Findings of 2026-10-11: re-trigger and conflicting decisions

All observed on the live environment (rows `TEST-TMP-FLOW-01 edited`, `-02`, `-03`, deleted afterwards).

| # | Test | Result |
|---|---|---|
| a | Edit Subject while Pending Approval | No new run |
| b | Save a Pending row again with the same value, or Pending → Draft → Pending | Each starts a **new run and a duplicate approval chain** (two runs, two pending approvals). The UI quick toggle was inconclusive (one run, saves not verifiable). Redone through the API on `TEST-TMP-FLOW-03`: two runs |
| c | Conflicting decisions on `TEST-TMP-FLOW-03` (two runs) | Run 1 rejected: row Inactive / Rejected. Run 2 approved both stages, then its final *Update a row 3* (In Force) **failed** with BadRequest: "867640001 is not a valid status code for state code mwf_ContractState.Inactive". Final state: Rejected |
| d | Change to Draft while an approval is pending (`TEST-TMP-FLOW-02`) | Draft saved and confirmed in the UI, then both stages approved: the run finished Succeeded and the row ended **In Force**. The flow overwrote the user's Draft (Draft is in State Active, so the write is valid) |
| e | Duplicate reject on an already Rejected row | Observed on `TEST-TMP-FLOW-01`: a duplicate reject on an already Rejected row did not fail; both runs ended Succeeded |
| f | UI **Activate** on an Inactive row | Draft, no run started (Draft does not match the trigger filter) |
| g | Exported flow JSON | No `runtimeConfiguration`, concurrency or `triggerConditions` |

**What this means:**
- In (c) the rejection survived **only because of the platform's State / Status Reason constraint**, not because of flow logic.
- In (d) the flow does **not** check the row's current status before writing its decision, so a legitimate user change is lost.
- **Since the Contract State Guard is registered (ADR-004), case (d) ends differently:** the late write of In Force over the withdrawn Draft is rejected (Draft to In Force is not an allowed transition), the row stays Draft, and the run **fails** at the update action. Observed on 2026-10-13, see [the phase C section of the registration log](plugin-registration-log.md#phase-c-end-to-end-with-the-approval-flow-on). The flow still has no deliberate handling of that failure (Phase 2).
- Two runs for one contract create two approval chains, which can contradict each other.

---

## 11. Phase 2 implications

1. **Guard against duplicate runs:** for example an "approval in progress" marker column on the contract, checked at the start of the flow (and cleared when it ends).
2. **Re-read before writing:** before writing In Force or Rejected, re-read the row and proceed only if `statuscode` is still Pending Approval.
3. **Server-side enforcement of allowed status transitions** in a plugin (no direct Draft → In Force).
4. **The plugin freezes the exchange rate at submission** (see ADR-001 and verification checklist item 3).

Each item has a trade-off to state when it is designed (extra column and flow logic against the extra read and the plugin to maintain). They are not designed yet.

---

## 12. Trigger: only a real submission starts a run

### The old trigger and why it did not prevent duplicates

- **Old trigger:** Change type Modified, Select columns `statuscode`, Filter rows `statuscode eq 867640000`.
- **Why it did not prevent duplicate runs:** Select columns fires when the column is **included in the request**, even if its value is unchanged (Learn, as read by the owner; not re-checked in this pass). Filter rows is evaluated on the row **after** the change. A save that sends `statuscode = Pending Approval` again, or Pending to Draft to Pending, passes both. This is what section 10 (case b) observed: every such save started a new run and a duplicate approval chain.

### The new trigger

- **Change type** Modified, **Select columns** `mwf_valueusdfrozen`, **Filter rows** `statuscode eq 867640000` (read back from the flow definition as stored).
- **Idea:** `mwf_valueusdfrozen` is written by plug-in 1 only when the contract **enters** Pending Approval (ADR-003). So only a real submission includes that column in the update, and a save that merely repeats the status does not.

### The test

`scripts/test-flow-trigger.mjs` ran four actions on one fictional contract, with the flow ON:

| # | Action | Expected new runs |
|---|---|---|
| 1 | PATCH Draft to Pending Approval | 1 |
| 2 | PATCH only the Subject of the Pending contract | 0 |
| 3 | PATCH `statuscode` = Pending Approval again (same value) | 0 |
| 4 | PATCH the Subject together with `statuscode` = Pending Approval | 0 |

**Evidence (observed by the owner in the Power Automate run history, not readable by the script):**
- After all four actions the run history showed **exactly one new run**, started about 24 seconds after action 1.
- The trigger output of that run: `modifiedon` equal to the second of action 1, `statuscode` Pending Approval, `mwf_valueusdfrozen` 1000, `mwf_name` the **original** name (not the edited one), SdkMessage Update. So the run belongs to action 1, and actions 2 to 4 started none.

### Limits of this result

- **One test, one run of it.** It was not repeated.
- **Inference:** an attribute added by plug-in 1 at PreOperation counts as "included in the request" for the Select columns filter. This is inferred from this single test. Learn does not document it.
- Not tested: a re-entry (Pending, Draft, Pending again) with the new trigger. It is expected to start one run, because plug-in 1 writes the column again on every entry, but this was not observed.

### Two known facts

- **(a) Change type is Modified.** A contract created directly in Pending Approval through the API starts **no run** (the app form creates a Draft). Not tested separately.
- **(b) The `flowruns` table lists finished runs only.** A row is written after the run ends (observed: `createdon` is later than `endtime`, and no row has the status Running). A run that waits for an approval is not listed, so runs cannot be counted from that table right after an action. Use the run history in Power Automate.

### Known gap: a stale run can complete a re-submitted contract

A contract withdrawn to Draft and submitted again **while the first run still waits for approvals** can be completed by the stale run: both runs end with a write of the decision, and a status check alone cannot tell which run belongs to which submission. (The guard of ADR-004 rejects the stale write only when the status is no longer allowed for it; a re-submitted contract is Pending Approval again, so the transition is valid for either run.)

**Proposed fix, not built:** a **submission-round column** written by plug-in 1 on each entry into Pending Approval. The flow would copy the round when it starts and check it before writing its decision. It would also be a cleaner trigger column than `mwf_valueusdfrozen`. It needs changes in plug-in 1, the guard (the column must be locked like the frozen value), an ADR and tests.
