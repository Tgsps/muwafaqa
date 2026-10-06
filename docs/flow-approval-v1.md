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
| Select columns | leave empty |
| Filter rows | `statuscode eq <PENDING_APPROVAL_VALUE>` |
| Filter columns | `statuscode` |

Notes:
- **Filter columns** limits which column changes fire the trigger. Only `statuscode` is listed.
- **Filter rows** is an OData expression evaluated on the server. It is the condition "Status Reason = Pending Approval".
- Both are required. See section 6 for why Filter columns alone is not enough.

**Optional second guard** (Settings → Trigger conditions), redundant with Filter rows, kept as a defence in depth:

```
@equals(triggerOutputs()?['body/statuscode'], <PENDING_APPROVAL_VALUE>)
```

Settings for the trigger: **Concurrency control = On, degree of parallelism = 1** (**not verified** that this fully prevents overlapping runs on the same row; see section 6).

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
   - Status Reason: `Rejected` (dropdown shows the label; if you must enter it as a value use `<REJECTED_VALUE>`)
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
1. *Update a row* → Status Reason = `Rejected`, Row ID `@{triggerOutputs()?['body/mwf_contractid']}`
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

**Not verified:**
- Whether a save that sets Pending Approval on a row already Pending Approval counts as a modification and fires the trigger again.
- Whether a user moving Pending Approval → Draft → Pending Approval quickly produces two overlapping runs, and whether concurrency = 1 queues or drops the second.
- Whether the platform applies any loop-breaking protection to cloud-flow-triggered updates. Do not rely on it.
- Whether the trigger evaluates Filter rows against the post-update row (assumed).

**Race condition left open in v1.** If someone moves the contract from Pending Approval back to Draft while an approval is outstanding, the flow still finishes and overwrites the status when the approver responds. Optional hardening: before each *Update a row*, add *Get a row by ID* and a condition that `statuscode` is still `<PENDING_APPROVAL_VALUE>`. Not included in v1 to keep the click-work small.

---

## 7. Open technical points (not verified)

- Whether *Update a row* with only Status Reason set also sets State correctly for this custom table (expected: yes, derived from the Status Reason). If not, also set Status (State) explicitly.
- Whether updating a row into the Inactive state (Rejected) works through the connector as the flow's connection identity.
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
| No hardening against concurrent status changes (v1) | Fewer actions | Race condition described in section 6 |

---

## 9. Test plan

Prerequisite: test data imported ([data/README.md](../data/README.md)), the flow turned **on** after the import, two test accounts available to act as approvers, and a way to inspect flow run history. Use a contract that is **Draft** (e.g. `TEST-CT-0009`). Note: after Scenario 2 or 3 the contract is Rejected and Inactive. Reactivate (see verification checklist, Rejected → Draft) or use a different Draft contract for the next scenario.

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

Record deviations (especially extra runs, wrong State, or an approval sent after a rejection) in [verification-checklist.md](verification-checklist.md) under the flow items.
