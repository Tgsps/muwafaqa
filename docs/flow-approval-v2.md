# Flow Specification — Contract Approval v2

Decision and context: [ADR-007](decisions/ADR-007-approval-chain.md) (batch 3 of 4). v1 is described in [flow-approval-v1.md](flow-approval-v1.md) and **is not changed**.

Every claim is marked **(script)** when a script checked it, **(unit)** for a unit test, **(from Learn)**, or **(not tested)**.

## 0. Status

| Item | State |
|---|---|
| The definition | Written as code in `scripts/build-flow-v2.mjs` (no id, address or host is stored; the record link keeps the placeholder `<ORG_HOST>`) |
| Structural check, offline | **25 PASS, 0 FAIL** (`--mode=check`, script) and 18 unit tests that prove the checker catches defects (`scripts/build-flow-v2.test.mjs`, unit) |
| Row "Muwafaqa - Contract Approval v2" in Dataverse | **NOT created yet.** Network faults (see the registration log) made the single POST unsafe; it is run on purpose after a clean connection check (section 8) |
| Turned on | **No.** v2 is created OFF (a new cloud flow row is Draft), and v1 stays OFF. Only the owner turns flows on |
| Opened in the designer / Flow checker | **Not done** (section 7) |

## 1. What it does

A contract enters Pending Approval (Draft to Pending Update). In the same transaction the plug-in `ApprovalChainBuilder` created one `mwf_approvalstep` row per step of the chain (ADR-007). v2 walks those rows in order:

```
trigger: contract modified (frozen USD value written) and status = Pending Approval
  Get_steps_of_this_round                    steps of THIS contract and THIS round, ordered by step order ascending
  Check_steps_exist  -- none --> Terminate Failed ("No Approval Step rows ...")                       (fail closed)
  Apply_to_each_step   (sequential, concurrency 1)
    checkpoint BEFORE the step: contract still Pending and same round? no --> Terminate Cancelled
    Role_name                       (label of the role, from the role value)
    Get_assignment_of_role          active Approver Assignment of the role
    Check_assignment_exists -- none --> Terminate Failed
    Get_approver_user               the user of the assignment (email address)
    Check_approver_email   -- empty --> Terminate Failed
    Branch_on_action_type
      Approve:  Mark_step_Waiting
                Request_approval_for_step   (Start and wait for an approval, Basic Approve/Reject)
                checkpoint AFTER the answer: not Pending / other round --> Terminate Cancelled
                Check_step_outcome
                   Approve: Mark_step_Approved (decision, time, comments)
                   Reject:  Mark_step_Rejected, Set_contract_Rejected (state 1 / status 2), Terminate Succeeded
      Inform:   Send_information_approval  (Create an approval, no waiting)
                Mark_step_Informed
  checkpoint before the final write: not Pending / other round --> Terminate Cancelled
  Set_contract_In_Force
```

## 2. Actions (31, depth 4; `--mode=build` prints the same table)

| # | Action | Type | Purpose |
|---|---|---|---|
| T | `When_a_contract_enters_Pending_Approval` | trigger, `SubscribeWebhookTrigger` | **Identical to v1**: message 3 (added or modified), table `mwf_contract`, scope 4, filtering column `mwf_valueusdfrozen`, filter `statuscode eq 867640000` (compared by the check against the v1 source, script) |
| 1 | `Get_steps_of_this_round` | `ListRecords` | `mwf_approvalsteps`, `$filter` contract = trigger contract and round = trigger round, `$orderby mwf_steporder asc`, `$select` id, name, order, role, action type, decision |
| 2 | `Check_steps_exist` / `Fail_no_approval_steps` | If / Terminate | length of the list greater than 0, else **Failed**, code `NoApprovalSteps` |
| 3 | `Apply_to_each_step` | Foreach | over the list, **concurrency 1** |
| 3.1 | `Get_contract_before_step`, `Check_contract_before_step`, `Stop_contract_not_pending_before_step` | GetItem / If / Terminate | checkpoint before the step; **Cancelled** (as in v1) |
| 3.2 | `Role_name` | Compose | role label from the role value |
| 3.3 | `Get_assignment_of_role`, `Check_assignment_exists`, `Fail_no_active_assignment` | ListRecords / If / Terminate | active assignment of the role (`$top 1`); none: **Failed**, code `NoActiveAssignment` |
| 3.4 | `Get_approver_user`, `Check_approver_email`, `Fail_approver_has_no_email` | GetItem / If / Terminate | the user's `internalemailaddress`; empty: **Failed**, code `ApproverHasNoEmail` |
| 3.5 | `Branch_on_action_type` | If | action type = Approve (867640000), else Inform |
| 3.5a | `Mark_step_Waiting` | UpdateOnlyRecord | step decision = Waiting |
| 3.5a | `Request_approval_for_step` | StartAndWaitForAnApproval | Basic Approve/Reject; see section 3 |
| 3.5a | `Get_contract_after_step`, `Check_contract_after_step`, `Stop_contract_not_pending_after_step` | GetItem / If / Terminate | checkpoint after the answer; **Cancelled** |
| 3.5a | `Check_step_outcome` | If | outcome equals Approve |
| 3.5a | `Mark_step_Approved` | UpdateOnlyRecord | decision Approved, `mwf_decidedon` = completion date, `mwf_comments` = first response comment |
| 3.5a | `Mark_step_Rejected`, `Set_contract_Rejected`, `End_run_after_rejection` | UpdateOnlyRecord x2 / Terminate | step Rejected; contract state 1 / status 2 (Rejected); run ends **Succeeded** (as v1) |
| 3.5b | `Send_information_approval` | CreateAnApproval | **no waiting**; the Owner is only informed (ADR-007, assumption 4) |
| 3.5b | `Mark_step_Informed` | UpdateOnlyRecord | decision Informed, `mwf_decidedon` = `utcNow()` |
| 4 | `Get_contract_before_final`, `Check_contract_before_final`, `Stop_contract_not_pending_before_final` | GetItem / If / Terminate | last checkpoint; **Cancelled** |
| 5 | `Set_contract_In_Force` | UpdateOnlyRecord | status 867640001 (In Force) |

## 3. Expressions used

| Where | Expression |
|---|---|
| Steps query filter | `_mwf_contract_value eq @{triggerOutputs()?['body/mwf_contractid']} and mwf_approvalround eq @{triggerOutputs()?['body/mwf_approvalround']}` |
| Loop input | `@outputs('Get_steps_of_this_round')?['body/value']` |
| Number of steps (n) | `length(outputs('Get_steps_of_this_round')?['body/value'])` |
| Step index (i) | `items('Apply_to_each_step')?['mwf_steporder']` (the order is 1..n without gaps, ADR-007) |
| Role label | `json('{"867640000":"Department Head", ...}')?[string(items('Apply_to_each_step')?['mwf_approverrole'])]`, chosen over the formatted-value annotation because it does not depend on which annotations the connector returns |
| Checkpoint | status equals 867640000 **and** `outputs('Get_contract_…')?['body/mwf_approvalround']` equals `triggerOutputs()?['body/mwf_approvalround']` (the v1 checkpoint of ADR-005) |
| Assignment filter | `mwf_approverrole eq @{items(…)?['mwf_approverrole']} and statecode eq 0` |
| User | `first(outputs('Get_assignment_of_role')?['body/value'])?['_mwf_user_value']` as the id of a `GetItem` on `systemusers` |
| Assigned to | `@{outputs('Get_approver_user')?['body/internalemailaddress']};` (a trailing `;` as in v1) |
| Approval title | `Approve contract: @{triggerOutputs()?['body/mwf_name']} (step @{i} of @{n}, @{outputs('Role_name')})` |
| Inform title | `For information: contract @{triggerOutputs()?['body/mwf_name']} (step @{i} of @{n}, @{outputs('Role_name')})` |
| Details | Markdown lines: Contract, Number, **Value (USD, frozen)** from `mwf_valueusdfrozen`, Step i of n (role), Approval round |
| Outcome | `outputs('Request_approval_for_step')?['body/outcome']` equals `Approve` |
| Decision time | `outputs('Request_approval_for_step')?['body/completionDate']`; for Inform `utcNow()` |
| Comment | `coalesce(first(outputs('Request_approval_for_step')?['body/responses'])?['comments'], '')` |

## 4. Differences from v1

| | v1 | v2 |
|---|---|---|
| Approvers | one fixed address, two fixed stages | role from the chain, user from the Approver Assignment, read when each step starts |
| Number of stages | always 2 | 1 to 5, as the ApprovalMatrix band says |
| Inform | none | "Create an approval", no waiting |
| Audit | none | each step row is updated: Waiting, Approved, Rejected, Informed, time, comments |
| Value shown | base amount in TRY | **frozen USD value** (the one the band was chosen with) |
| Approval title | `Approve contract : <Subject>` (stage 1, with a space) and `Approve contract: <Subject>` (stage 2) | **unified**: `Approve contract: <Subject> (step i of n, <role>)` |
| Names | `Approval_DeptHead`, `Check_Stage1`, ... | none of them is reused (checked, script) |
| Checkpoints | after stage 1 and stage 2 | before every step, after every answer, and before the final write (3 distinct Cancelled terminations) |
| No chain | not possible | **Failed** (fail closed) |
| Trigger | as in section 1 of v1 | **identical** |

**Only one of v1 and v2 may be ON.** With both on, a submission starts two runs. v2 is created OFF; v1 is OFF now; the owner decides which to turn on.

## 5. Errors and what the contract does

| Situation | Run status | Contract | Step rows |
|---|---|---|---|
| No step rows for the round | **Failed** (`NoApprovalSteps`) | stays Pending Approval | none |
| Role without an active assignment | **Failed** (`NoActiveAssignment`) | stays Pending Approval | earlier steps keep their decisions |
| Assigned user has no email | **Failed** (`ApproverHasNoEmail`) | stays Pending Approval | same |
| Contract withdrawn or resubmitted (not Pending, or another round) | **Cancelled** at the next checkpoint | as set by the user | a withdrawn chain is closed by the builder at the next submission (Pending/Waiting of older rounds become Cancelled) |
| An approver rejects | **Succeeded** | Rejected | that step Rejected; later steps stay Pending |
| An action fails (connector, throttling) | **Failed** by the platform | stays Pending Approval | partly updated |
| All steps answered | Succeeded | In Force | all Approved/Informed |

A contract that stays Pending Approval after a Failed run has to be withdrawn to Draft and submitted again (a new round, a new chain). There is no automatic retry or notification in v2.

## 6. Observations and limits that are known now

- **Actual approver is not written.** `mwf_actualapprover` (and `mwf_delegated`) stay empty. Resolving the responder to a user needs one more query and the connector's syntax for writing a lookup on a custom table, which I could not verify without the designer; a wrong guess would risk the whole flow. **OBS.** The responder's identity is in the approval itself (`msdyn_flow_approval`) and can be added when Phase 3 needs it.
- **The step of a rejection that was answered by someone other than the assigned user** is still marked with the original approver only.
- Titles changed (section 4): the test scripts that attribute approvals to a contract by "the text after the last colon" no longer match; see section 9.
- The role label table lives in the flow (a JSON string); a sixth role needs a change in the flow and in the choice.

## 7. Verification without running (what was and was not possible)

**Done (script, offline, `--mode=check`; unit tests prove each check can fail):**

| Check | Result |
|---|---|
| Action and trigger names unique across the flow; characters and length | PASS |
| No name of a v1 action | PASS |
| Every `runAfter` points to a sibling in the same scope, with valid statuses; none missing; no cycle | PASS |
| Every `outputs()` / `body()` / `actions()` reference points to an earlier action of the same or an enclosing scope; every `items()` is inside its Foreach | PASS |
| No variables used, so none can be undefined | PASS |
| Parentheses, quotes and braces balanced in every expression | PASS |
| Every `connectionName` exists in `connectionReferences`; the two references are those of v1 | PASS |
| Depth 4 (limit 8), 31 actions (limit 500) | PASS |
| Loop concurrency 1; the loop reads the steps query | PASS |
| Every Terminate Failed has code and message; exactly three Cancelled checkpoints | PASS |
| No email, id or token; `<ORG_HOST>` is the only host | PASS |
| Trigger equals the v1 trigger in `src/Workflows` | PASS |

**Not possible outside the designer (not tested):**
- The real Flow checker (it validates against the connector's live schema: parameter names, required fields, types, dynamic content).
- That `CreateAnApproval` is the operation id of "Create an approval" and that its parameters are named `ApprovalCreationInput/...` (taken from the naming pattern of `StartAndWaitForAnApproval`, whose `WebhookApprovalCreationInput/...` names are those of v1). **Highest-risk item.**
- That `GetItem` accepts `$select` on `systemusers`, that `ListRecords` accepts `$top` as a number, and the `json(...)?[...]` indexing, in the designer's expression editor.
- That the approval output carries `completionDate` and `responses[].comments` as written (the v1 flow only used `outcome`).
- That Dataverse accepts this `clientdata` for a new cloud flow row and that the flow can be turned on (the connection references must be bound to working connections by the owner).
- Any behaviour at run time: nothing ran.

## 8. Creating the row (when the connection is clean)

```bash
node scripts/build-flow-v2.mjs --mode=check
node scripts/check-connection.mjs --env=https://<org>.crm4.dynamics.com --minutes=3
node scripts/build-flow-v2.mjs --mode=create --env=https://<org>.crm4.dynamics.com --auth=az --confirm-mutates-environment
node scripts/build-flow-v2.mjs --mode=verify --env=https://<org>.crm4.dynamics.com --auth=az
```

`create` makes 3 GET requests first, stops if v2 exists, reads the connection references of v1 (read only), sends **one** POST (never retried; after a network error it only reads whether the row exists and prints that), then reads back: category, OFF, solution membership, the structure as stored, and that v1 is unchanged. It never turns anything on. `src/` is synced only after all four batches.

## 9. Test scripts that need an update before the first run of v2 (not changed now)

| Script | Why |
|---|---|
| `scripts/lib/run-attribution.mjs` (+ its test) | takes the Subject as "the text after the last colon" of the approval title; v2 titles end with ` (step i of n, <role>)` |
| `scripts/test-flow-approvalround.mjs` | counts the approvals of a contract the same way |
| `scripts/test-flow-checkpoints.mjs` | uses the attribution above |
| the plan `docs/flow-on-session-plan.md` | the expected number of approvals per contract and the stage-1 / stage-2 title convention |

A new flow-ON session for v2 also needs its own cases (chains of 1, 2, 3 and 5 steps, an Inform step, a withdrawal between steps, a missing assignment).

## 10. Not tested (summary)

Everything at run time; the designer and the Flow checker; the Inform path; a chain of one step in the flow; the loop with real approvals; the checkpoints inside the loop; the Failed endings; the connector parameter names listed in section 7; turning v2 on.
