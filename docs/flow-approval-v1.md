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
- **Since the Contract State Guard is registered (ADR-004), case (d) ends differently.** The late write of In Force over the withdrawn Draft is never accepted (Draft to In Force is not an allowed transition), and the row stays Draft:
  - **When the withdrawal happens before the answer of a stage,** the checkpoint after that stage stops the run **Cancelled, before any write** (section 13, observed 2026-10-13).
  - **Otherwise** (the withdrawal falls in the short window between the check and the write) the guard still rejects the write and the run **fails** at the update action. That failure was observed on 2026-10-13 before the checkpoints existed, see [the phase C section of the registration log](plugin-registration-log.md#phase-c-end-to-end-with-the-approval-flow-on).
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

- **(a) Change type is Modified.** A contract created directly in Pending Approval through the API starts **no run** (the app form creates a Draft). Not tested separately. **Since 2026-10-22 such a Create is rejected by the guard** (ADR-004 update), so the case cannot occur.
- **(b) The `flowruns` table lists finished runs only.** A row is written after the run ends (observed: `createdon` is later than `endtime`, and no row has the status Running). A run that waits for an approval is not listed, so runs cannot be counted from that table right after an action. Use the run history in Power Automate.

### Known gap: a stale run can complete a re-submitted contract

A contract withdrawn to Draft and submitted again **while the first run still waits for approvals** can be completed by the stale run: both runs end with a write of the decision, and a status check alone cannot tell which run belongs to which submission. (The guard of ADR-004 rejects the stale write only when the status is no longer allowed for it; a re-submitted contract is Pending Approval again, so the transition is valid for either run.)

**Status: closed for the scenario withdraw and resubmit, tested once.** The submission-round column `mwf_approvalround` is written by plug-in 1 on each real entry into Pending Approval (ADR-005), and the two checkpoints of the flow now also compare it (section 14). A stale run that was started by an earlier submission stops at its checkpoint once the contract was withdrawn and submitted again. Evidence and its limits: section 14 (owner-observed in the run history, one test). Not covered: see the open points of ADR-005 (a short race between the check and the write, two concurrent submissions, Rejected to Draft to Pending Approval).

---

## 13. Checkpoints: a withdrawn contract stops the run

### Structure

After each approval stage the flow re-reads the contract and ends quietly if it is no longer Pending Approval:

| After | Get a row by ID | Condition (statuscode equals 867640000) | False branch |
|---|---|---|---|
| Approval DepthHead | "Get contract after stage 1" | "Is still Pending (stage 1)" | Terminate, status **Cancelled**, named "Stop - contract no longer Pending (stage 1)" |
| Approval FinanceMgr | "Get contract after stage 2" | "Is still Pending (stage 2)" | Terminate, status **Cancelled**, named "Stop - contract no longer Pending (stage 2)" |

- The condition compares the status of the re-read row (`body/statuscode`) with 867640000, by value.
- The **True** branch of each checkpoint continues to the original **Check Stage1** and **Check Stage2**, which stay after their checkpoint.

### Why two checkpoints cover all three writes

The flow writes the contract status in three places: Check Stage1 False (reject at stage 1), Check Stage2 False (reject at stage 2) and Check Stage2 True (approve, In Force). Checkpoint 1 sits before Check Stage1, so it covers the first write. Checkpoint 2 sits before Check Stage2, so it covers both stage 2 writes.

### The test

`scripts/test-flow-checkpoints.mjs` (flow ON, fictional rows TEST-TMP-CHK1 to CHK4, USD 1000):

| Contract | What was done | Expected |
|---|---|---|
| CHK1 normal | stage 1 and stage 2 approved | In Force, run Succeeded |
| CHK2 withdrawn before stage 1 | withdrawn to Draft right after the submission, then its stage 1 approved | Draft, run Cancelled at checkpoint 1, no stage 2 request |
| CHK3 withdrawn after stage 1 | stage 1 approved, withdrawn to Draft once its stage 2 request was visible, then stage 2 approved | Draft, run Cancelled at checkpoint 2 |
| CHK4 rejected | rejected at stage 1 | Rejected (Inactive), run Succeeded |

### Evidence

Marked **(script)** when read by the test script, **(owner)** when observed by the owner in Power Automate. No host, URL, user id, environment id, approval id or row id is recorded here.

- **(script)** Setup at 2026-10-13 15:34:16 UTC: the four contracts moved to Pending Approval, each with the frozen value 1000.00. CHK2 was withdrawn to Draft at once.
- **(owner)** Stage 1 was approved for CHK1, CHK2 and CHK3, and rejected for CHK4. **Only two stage 2 requests arrived (CHK1 and CHK3)**: none for CHK2 (withdrawn) and none for CHK4 (rejected).
- **(script)** CHK3 was withdrawn to Draft at about 15:48:48 UTC, after its stage 2 request was visible. The owner then approved both stage 2 requests.
- **(script)** Rows read afterwards: CHK1 In Force / Active, CHK2 Draft / Active, CHK3 Draft / Active, CHK4 Rejected / Inactive. The frozen value was 1000.00 in all four.
- **(script)** `flowruns`: 4 finished runs, 2 Succeeded and 2 Cancelled, **0 Failed**, no error message. The table does not name the contract of a run.
- **(owner)** Run history: four new runs: Canceled (11:35 min), Succeeded (13:44), Canceled (14:37), Succeeded (11:21). **No run Failed.**
- **(owner, screenshot)** The Canceled run of 11:35: Approval DepthHead succeeded (11 min 34 s), "Get contract after stage 1" succeeded, "Is still Pending (stage 1)" took the False branch and shows Terminated, the action "Stop - contract no longer Pending (stage 1)" ran successfully, and Check Stage1 was skipped.
- **(owner, screenshot)** The Canceled run of 14:37: checkpoint 1 passed, Approval FinanceMgr succeeded (2 min 56 s), "Get contract after stage 2" succeeded, "Is still Pending (stage 2)" took the False branch and shows Terminated, and the action "Stop - contract no longer Pending (stage 2)" ran successfully.
- **Mapping of runs to contracts:** the two Canceled runs are CHK2 (stage 1) and CHK3 (stage 2), confirmed by the two run pages and by their end times. **The mapping of the two Succeeded runs to CHK1 and CHK4 is inferred** from the final row states.
- **(script, independent count)** In the approvals table (Dataverse) **6 approvals** were created since the setup, all Completed (5 Approve, 1 Reject). This matches CHK1 two stages, CHK2 stage 1 only, CHK3 two stages and CHK4 one stage (reject). A stage 2 request for CHK2 would have made it 7. Only counts were read. The approval requests table still showed Active for these rows after completion; its meaning is unknown and nothing is concluded from it.
- **Comparison with phase C (2026-10-13, before the checkpoints):** the late write of In Force over a withdrawn Draft failed the run at `Update_a_row_3` with the guard message. Now such a run ends **Cancelled** before any write.

### What the checkpoints do NOT cover

- **(a) The short window between the check and the write.** If the contract is withdrawn after the check passed and before the write, the guard still rejects the write and the run fails loudly. This is on purpose: a failed run is visible, a silent overwrite is not.
- **(b) A stale run after withdraw and resubmit.** A contract withdrawn and submitted again while the first run still waits passes the checkpoint of the stale run (it is Pending Approval again). This is the gap described in section 12, [Known gap](#known-gap-a-stale-run-can-complete-a-re-submitted-contract). It is not repeated here. Since the round check (section 14) the checkpoints also compare the submission round, so such a stale run stops there.
- **(c) The Terminate message is not recorded for a Cancelled run.** What the run history shows is the **name of the action** ("Stop - contract no longer Pending (stage N)"), so the action names are the way to tell which checkpoint ended a run.

---

## 14. Approval round check (stale run)

### The change (made by hand in the flow designer, not by a script)

In **both** checkpoint conditions ("Is still Pending (stage 1)" and "Is still Pending (stage 2)") a **second row was added, joined with AND**: the `mwf_approvalround` of the contract that the checkpoint just re-read must equal the `mwf_approvalround` of the **trigger** (the contract as it was when the run started). In the code view of the flow the condition is, for N = 1 and 2:

```
and(
  equals(outputs('Get_contract_after_stage_N')?['body/statuscode'], 867640000),
  equals(outputs('Get_contract_after_stage_N')?['body/mwf_approvalround'], triggerOutputs()?['body/mwf_approvalround'])
)
```

- **Idea:** the round goes up on every real submission (ADR-005). A run keeps the round it started with. If the contract was withdrawn and submitted again, the stored round is higher than the run's round, so the condition is False and the existing Terminate action ends the run Cancelled before any write.
- The False branch and the Terminate actions are the ones of section 13; they were not changed. The action names still say "no longer Pending", although they now also cover a stale run (cosmetic, not renamed).
- The trigger (Select columns `mwf_valueusdfrozen`, section 12) was not changed.

### The test

`scripts/test-flow-approvalround.mjs` (flow ON; fictional rows only, TEST-TMP-RND-1):

| Mode | What it does |
|---|---|
| `setup` | creates one counterparty and one Draft contract; Draft to Pending Approval (submission 1, round 1, starts run 1); waits about 20 s; withdraws to Draft; waits about 10 s; Draft to Pending Approval again (submission 2, round 2, starts run 2) |
| `read` | read only: status, state and round of the contract, and counts of the approvals created since the contract was created |
| `cleanup` | deletes the contract (In Force through the bypass of the guard Delete step only) and the counterparty, then check-clean |

The owner then answered the stage 1 request of run 1 (the older), then the requests of run 2.

### Evidence

Marked **(script)** when read by the script and **(owner)** when seen by the owner in Power Automate. No id, host, URL or signature of the run output is recorded here.

- **(script)** Submission 1 at 2026-10-13 16:46:47 UTC gave round 1; the withdraw kept round 1; submission 2 at 16:47:21 UTC gave round 2. After the answers the contract was In Force with round 2.
- **(owner)** **Run 1** (started 19:46 local, 16:46 UTC, submission 1, round 1): after its stage 1 approval was answered, "Get contract after stage 1" succeeded, "Is still Pending (stage 1)" went **False**, "Stop - contract no longer Pending (stage 1)" was executed (green), the condition shows Terminated, Check Stage1 was skipped, and the run status is **Canceled**. The owner did **not** cancel it manually.
- **(owner)** **Run 2** (19:47 local, submission 2, round 2): the stage 1 checkpoint was True (the Stop action skipped), Approval FinanceMgr completed, "Get contract after stage 2" succeeded, "Is still Pending (stage 2)" was True (Stop skipped), Check Stage2 was True, and "Update a row 3" succeeded (0.2 s); its False branch did not execute. Its final status in the run history is **Succeeded** (started 19:47 local, duration 7:23) (owner, Run history).
- **(owner)** The trigger output of run 2 contained `mwf_approvalround` = 2.
- **(script)** Counts only: 3 approvals were created since the test contract (all Completed, result Approve). That is stage 1 of run 1, stage 1 of run 2 and stage 2 of run 2; a stage 2 request for run 1 would have made it 4. This is **consistent** with the owner's observation, **not proof** (it is a count by time window and does not name the contract).
- **(script)** Cleanup: check-clean 0 TEST-TMP contracts, 0 counterparties, 11 contracts.

### Limits

- **Tested once** (one contract, one withdraw and resubmit).
- The final status of run 2 is Succeeded (owner, Run history).
- A contract with Value = 0 enters approval today (accepted, frozen USD 0, round 1). Whether this is intended and which ApprovalMatrix band applies is a business decision, not taken. **Update 2026-10-22:** ADR-007 decides the band (a value of 0 falls on the first band); whether a zero-value contract should enter approval at all stays open.
- Not tested: a withdraw and resubmit that happens after stage 1 was answered (stage 2 checkpoint with a stale round), two concurrent submissions, Rejected to Draft to Pending Approval.
- The short window between the check and the write is not covered by this check (section 13, point a): the guard of ADR-004 still rejects a write that is not allowed, and the run fails loudly.

## Exported source and the flow state

`src/` was exported while the flow was **off** in the environment (during development); the exported flow therefore has state Off. Turning the flow on is done by hand by the owner after an import. The exported flow also carries the placeholders `<APPROVER_TEST_ACCOUNT>` and `<ORG_HOST>` that must be filled in first (see CLAUDE.md).
