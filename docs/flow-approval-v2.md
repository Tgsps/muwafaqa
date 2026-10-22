# Flow Specification — Contract Approval v2

Decision and context: [ADR-007](decisions/ADR-007-approval-chain.md) (batch 3 of 4). v1 is described in [flow-approval-v1.md](flow-approval-v1.md) and **is not changed**.

Every claim is marked **(script)** when a script checked it, **(unit)** for a unit test, **(from Learn)**, or **(not tested)**.

## 0. Status

| Item | State |
|---|---|
| The definition | Written as code in `scripts/build-flow-v2.mjs` (no id, address or host is stored; the record link keeps the placeholder `<ORG_HOST>`). **Redesigned on 2026-10-22** after the first Turn on failed (section 0b): 50 actions, depth 6 |
| Structural check, offline | **35 PASS, 0 FAIL** (`--mode=check`, script) and 31 unit tests that prove the checker catches defects (`scripts/build-flow-v2.test.mjs`, unit) |
| Row "Muwafaqa - Contract Approval v2" in Dataverse | **The redesigned definition was created on 2026-10-22, OFF** (script: 3-minute connection check with 0 failures of 36, `--mode=cleanup` of the OFF first-design row, one POST HTTP 204, `--mode=verify`: one row, OFF, in the solution, stored clientdata 16,992 bytes, 35 structural checks pass on the stored definition, 50 stored action names equal the built ones, v1 OFF and unchanged). **Not opened in the designer, not turned on, never run** |
| Turned on | **It was turned on by the owner and ran in the session of 2026-10-22** (cases A to D passed; ADR-007, "v2 flow-ON session"), then turned OFF by the owner. v1 stayed OFF and unchanged throughout. Only the owner turns flows on and off |
| Opened in the designer / Flow checker | The owner opened the first design (0 errors, 0 warnings, section 7); the redesigned definition has not been opened |

## 0b. Why the definition was redesigned (2026-10-22)

**The error (owner, Turn on of v2, literal):** `InvalidWorkflowRunAction: "The workflow run action 'Stop_contract_not_pending_before_step' has type 'Terminate' that could not be nested under an action of type 'foreach'."` The row stayed OFF and no run started.

**The rule (from Learn, Logic Apps workflow definition reference, "Terminate action"):** the Terminate action "can't appear inside Foreach and Until loops, including sequential loops". **The Flow checker (0 errors, 0 warnings) did not catch it and my structural check did not know the rule.** The platform checks it when the flow is turned on, so **Turn on is the decisive validation**. This was **not** in the list of things not confirmed: the list named run-time behaviour and a few connector details, and it should have said that the designer and the Flow checker are not the last word on validity.

**What changed (behaviour unchanged):**
- Four variables are initialized at the top of the flow (Learn, "Create variables": a variable is declared only at the workflow global level, not in scopes, conditions or loops): `endKind` and `endMessage` (strings, empty at the start; the values `Cancelled`, `Rejected`, `Failed`), plus `approverEmail` and `approverUserId`. The last two are mine, not the owner's: they carry the approver found in one group of the loop to the group that sends the request, so that no action reads the output of an action inside another group's condition (a reference whose validity I could not confirm).
- **No Terminate anywhere under the loop.** Where the first design ended the run inside the loop, the loop now sets `endKind` and `endMessage` (Set variable inside a sequential loop; Learn: set variables in a loop only when the loop runs sequentially, and it does, concurrency 1).
- **Every group of the loop is a condition "endKind is empty"** (`Gate_...`), so after a problem is recorded nothing else runs in that iteration or in the next ones: the checkpoint reads, the assignment and user reads, `Mark_step_Waiting`, the approval request, and the rest.
- **One Switch on `endKind` right after the loop, outside it:** `Cancelled` ends the run Cancelled; `Rejected` ends it Succeeded (as v1 did for a rejection); `Failed` ends it Failed with `runError.message` taken from `endMessage`; the default (empty) carries on as before: last checkpoint (Cancelled if the contract is no longer Pending in the same round), then the contract is set In Force.
- The role label `Role_name` Compose is gone; the label is an inline expression where it is used.
- Nesting depth is 6 (limit 8, Learn "Limits and configuration": actions nesting depth 8, 500 actions per workflow; these are the Logic Apps limits, the limits of Power Automate itself were not read).

**New checks (script, offline):** no Terminate under a Foreach or Until at any depth; the variables exist, are initialized only at the top level and before use; every direct child of the loop is a gate on `endKind`; the Switch is right after the loop with the three end kinds and the old default; `endKind` is set only inside the loop. Ten unit tests make each of them fail on the matching defect, including a copy of the first design.

## 1. What it does

A contract enters Pending Approval (Draft to Pending Update). In the same transaction the plug-in `ApprovalChainBuilder` created one `mwf_approvalstep` row per step of the chain (ADR-007). v2 walks those rows in order:

```
variables (top of the flow): endKind, endMessage, approverEmail, approverUserId   (all empty strings)
trigger: contract modified (frozen USD value written) and status = Pending Approval
  Get_steps_of_this_round                    steps of THIS contract and THIS round, ordered by step order ascending
  Check_steps_exist  -- none --> Terminate Failed ("No Approval Step rows ...")                      (fail closed; outside the loop)
  Apply_to_each_step   (sequential, concurrency 1)       NO Terminate inside; each group runs only while endKind is empty
    Gate_checkpoint_before_step: contract still Pending and same round?  no --> endKind = Cancelled
    Gate_find_assignment:  active Approver Assignment of the role?       none --> endKind = Failed; yes --> approverUserId
    Gate_find_user:        the user's email --> approverEmail           empty --> endKind = Failed
    Gate_send_request:
      Approve:  Mark_step_Waiting
                Request_approval_for_step   (Start and wait for an approval, Basic Approve/Reject, no reassignment)
                checkpoint AFTER the answer: not Pending / other round --> endKind = Cancelled
                Gate_after_step: outcome
                   Approve: Mark_step_Approved (decision, time, comments)
                   Reject:  Mark_step_Rejected, Set_contract_Rejected (state 1 / status 2), endKind = Rejected
      Inform:   Send_information_approval  (Create an approval, no waiting), Mark_step_Informed
  Switch_on_end_kind  (outside the loop)
     Cancelled --> Terminate Cancelled
     Rejected  --> Terminate Succeeded
     Failed    --> Terminate Failed, message = endMessage
     (empty)   --> last checkpoint (not Pending / other round --> Terminate Cancelled), then Set_contract_In_Force
```

## 2. Actions (50, depth 6; `--mode=build` prints the same table)

| # | Action | Type | Purpose |
|---|---|---|---|
| T | `When_a_contract_enters_Pending_Approval` | trigger, `SubscribeWebhookTrigger` | **Identical to v1**: message 3, table `mwf_contract`, scope 4, filtering column `mwf_valueusdfrozen`, filter `statuscode eq 867640000` (compared by the check against the v1 source, script) |
| 0 | `Init_endKind`, `Init_endMessage`, `Init_approverEmail`, `Init_approverUserId` | InitializeVariable (top level) | the four string variables |
| 1 | `Get_steps_of_this_round` | `ListRecords` | `mwf_approvalsteps`, `$filter` contract = trigger contract and round = trigger round, `$orderby mwf_steporder asc` |
| 2 | `Check_steps_exist` / `Fail_no_approval_steps` | If / Terminate | no steps: **Failed**, code `NoApprovalSteps` (top level, allowed) |
| 3 | `Apply_to_each_step` | Foreach | over the list, **concurrency 1**; its direct children are the 4 gates below |
| 3.1 | `Gate_checkpoint_before_step`: `Get_contract_before_step`, `Check_contract_before_step` (+ 2 Set variable in its else) | If / GetItem / If / SetVariable | checkpoint before the step; problem: `endKind` = Cancelled |
| 3.2 | `Gate_find_assignment`: `Get_assignment_of_role`, `Check_assignment_exists` (true: `Set_approver_user_id`; else 2 Set variable) | If / ListRecords / If / SetVariable | active assignment of the role (`$top 1`); none: `endKind` = Failed |
| 3.3 | `Gate_find_user`: `Get_approver_user`, `Set_approver_email`, `Check_approver_email` (+ 2 Set variable in its else) | If / GetItem / SetVariable / If | the user's `internalemailaddress`; empty: `endKind` = Failed |
| 3.4 | `Gate_send_request` > `Branch_on_action_type` | If | action type = Approve (867640000), else Inform |
| 3.4a | `Mark_step_Waiting`, `Request_approval_for_step`, `Get_contract_after_step`, `Check_contract_after_step` (+ 2 Set variable in its else), `Gate_after_step` > `Check_step_outcome` > `Mark_step_Approved` or (`Mark_step_Rejected`, `Set_contract_Rejected`, `Reject_end_kind`, `Reject_end_message`) | UpdateOnlyRecord / StartAndWaitForAnApproval / GetItem / If / SetVariable | Approve step; Reject: step Rejected, contract Rejected, `endKind` = Rejected |
| 3.4b | `Send_information_approval`, `Mark_step_Informed` | CreateAnApproval / UpdateOnlyRecord | Inform: **no waiting**; the Owner is only informed (ADR-007, assumption 4) |
| 4 | `Switch_on_end_kind` | Switch | `Case_Cancelled`: `Stop_run_cancelled`; `Case_Rejected`: `Stop_run_after_rejection` (Succeeded); `Case_Failed`: `Stop_run_failed` (message from `endMessage`); default: `Get_contract_before_final`, `Check_contract_before_final` (+ `Stop_contract_not_pending_before_final`), `Set_contract_In_Force` |

## 3. Expressions used

| Where | Expression |
|---|---|
| Steps query filter | `_mwf_contract_value eq @{triggerOutputs()?['body/mwf_contractid']} and mwf_approvalround eq @{triggerOutputs()?['body/mwf_approvalround']}` |
| Loop input | `@outputs('Get_steps_of_this_round')?['body/value']` |
| Number of steps (n) | `length(outputs('Get_steps_of_this_round')?['body/value'])` |
| Step index (i) | `items('Apply_to_each_step')?['mwf_steporder']` (the order is 1..n without gaps, ADR-007) |
| Gate of a group of the loop | `@variables('endKind')` equals the empty string |
| End of a problem | Set variable `endKind` (`Cancelled`, `Rejected` or `Failed`) and `endMessage` (text) |
| Closing Switch | `@variables('endKind')`; the Failed case: `runError.message` = `@variables('endMessage')` |
| Approver found for the step | `approverUserId` = `first(outputs('Get_assignment_of_role')?['body/value'])?['_mwf_user_value']`; `approverEmail` = `coalesce(outputs('Get_approver_user')?['body/internalemailaddress'], '')`; `assignedTo` = `@{variables('approverEmail')};` |
| Role label | `json('{"867640000":"Department Head", ...}')?[string(items('Apply_to_each_step')?['mwf_approverrole'])]`, chosen over the formatted-value annotation because it does not depend on which annotations the connector returns |
| Checkpoint | status equals 867640000 **and** `outputs('Get_contract_…')?['body/mwf_approvalround']` equals `triggerOutputs()?['body/mwf_approvalround']` (the v1 checkpoint of ADR-005) |
| Assignment filter | `mwf_approverrole eq @{items(…)?['mwf_approverrole']} and statecode eq 0` |
| User | `first(outputs('Get_assignment_of_role')?['body/value'])?['_mwf_user_value']` as the id of a `GetItem` on `systemusers` |
| Assigned to | `@{outputs('Get_approver_user')?['body/internalemailaddress']};` (a trailing `;` as in v1) |
| Reassignment by the approver | allowed (`true` in both stages) | **not allowed** (`false` in both approval actions; owner decision 2026-10-22) |
| Approval title | `Approve contract: @{triggerOutputs()?['body/mwf_name']} (step @{i} of @{n}, @{<role label>})` |
| Inform title | `For information: contract @{triggerOutputs()?['body/mwf_name']} (step @{i} of @{n}, @{<role label>})` |
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

**Done (script, offline, `--mode=check`, 35 checks; 31 unit tests prove each check can fail):** the table lists the groups of checks.

| Check | Result |
|---|---|
| Action and trigger names unique across the flow; characters and length | PASS |
| No name of a v1 action | PASS |
| Every `runAfter` points to a sibling in the same scope, with valid statuses; none missing; no cycle | PASS |
| Every `outputs()` / `body()` / `actions()` reference points to an earlier action of the same or an enclosing scope; every `items()` is inside its Foreach | PASS |
| Variables: initialized only at the top level and before use; `endKind` and `endMessage` exist; Set variable in a loop only in a sequential loop | PASS |
| **No Terminate under a Foreach or Until at any depth** (added after the failed Turn on) | PASS |
| The Switch on `endKind` is right after the loop, with the three end kinds and the old default; every direct child of the loop is a gate on `endKind`; `endKind` is set only inside the loop | PASS |
| Parentheses, quotes and braces balanced in every expression | PASS |
| Every `connectionName` exists in `connectionReferences`; the two references are those of v1 | PASS |
| Depth 6 (limit 8), 50 actions (limit 500) | PASS |
| Loop concurrency 1; the loop reads the steps query | PASS |
| Every Terminate Failed has code and message; two Terminate Cancelled, both outside the loop | PASS |
| No email, id or token; `<ORG_HOST>` is the only host | PASS |
| Trigger equals the v1 trigger in `src/Workflows` | PASS |

**Not possible outside the designer (not tested):**
- **The platform's own validation at Turn on.** It refused the first design (section 0b) although the Flow checker showed 0 errors and 0 warnings. The checks above encode the rules I know from Learn (Terminate, variables, nesting, Switch); other rules I do not know cannot be checked, so **Turn on of the new design is the decisive test** and may find more.
- The real Flow checker for the redesigned definition (it validates against the connector's live schema: parameter names, required fields, types, dynamic content).
- Not read: restrictions of Power Automate itself on the placement of other actions (the approval actions inside a loop and conditions, a Switch inside the flow), the Power Automate limits page, and whether a reference to the output of an action in the enclosing branch scope is always accepted (the design avoids references across sibling groups on purpose).
- The names of the fields **inside** the dynamic field `ApprovalCreationInput` of "Create an approval" (`title`, `assignedTo`, `details`, `itemLink`, `itemLinkDescription`, `enableNotifications`, `enableReassignment`). They are inferred from the `WebhookApprovalCreationInput/...` names of "Start and wait" in v1 and are **not confirmed**. **Highest-risk item that remains** (see "Connector facts from Learn" below for what is confirmed).
- That `GetItem` accepts `$select` on `systemusers`, that `ListRecords` accepts `$top` as a number, and the `json(...)?[...]` indexing, in the designer's expression editor.
- That the approval output carries `completionDate` and `responses[].comments` as written (the v1 flow only used `outcome`).
- That Dataverse accepts this `clientdata` for a new cloud flow row and that the flow can be turned on (the connection references must be bound to working connections by the owner).
- Any behaviour at run time: nothing ran.

### Connector facts from Microsoft Learn (checked by the owner, 2026-10-22; I did not re-read the page, so this is the owner's report)

| Fact | Source | Effect on v2 |
|---|---|---|
| The operation id of "Create an approval" is **`CreateAnApproval`** | (from Learn, reference of the Approvals connector) | confirms the operation id used in `Send_information_approval` |
| Its parameters are **`approvalType`** and a dynamic field **`ApprovalCreationInput`** | (from Learn) | confirms `approvalType` (v2 sends `Basic`); the dynamic field is how the other inputs are sent |
| The output of the waiting action has **`responses.responder.email`**, **`responses.comments`** and **`completionDate`** | (from Learn) | confirms the `completionDate` and `responses[].comments` used by `Mark_step_Approved` / `Mark_step_Rejected`; `responses.responder.email` would allow resolving the actual approver later |
| **Still not confirmed:** the field names inside `ApprovalCreationInput` | inferred from the v1 names | the Inform step may need its inputs re-bound in the designer |

This lowers the risk of the Inform step from "operation id and parameter names guessed" to "only the inner field names guessed". Nothing was run, so it remains **not tested**.

### The designer, as seen by the owner (2026-10-22; screenshots are NOT in the repository) - this is about the FIRST design, before the redesign of section 0b

Reported by the owner after opening v2 (I did not see the screenshots; this is the owner's report):

| Seen | Result |
|---|---|
| The flow opens with no error | confirmed |
| Actions | 31, with the expected names; **8 directly inside the loop** (the 8 first actions of `Apply_to_each_step`; the others are inside its conditions), as built |
| Flow checker | **0 errors, 0 warnings** (this is the check I could not do from the command line) |
| `Request_approval_for_step` and `Send_information_approval` | every field is shown with its value, and the designer knows the field names inside `ApprovalCreationInput` (so the names inferred from v1 are **accepted by the designer**) |
| `Mark_step_Waiting`, and the connections (Approvals and Dataverse) | bound |
| Enable reassignment (first build) | **Yes** on the Approve request, **No** on the Inform request. Changed by the owner's decision below: **No** on both |
| State | v2 not run, not turned on; v1 and v2 OFF. A read after the designer visit shows the stored `clientdata` unchanged (13,392 bytes, 31 action names, the 25 structural checks pass): the designer was used to look, not to save (script, read only) |

**Reassignment (owner decision, 2026-10-22): disabled in both approval actions.** v1 has `enableReassignment = true` in both stages (read from the live v1 and from the exported source, read only). The designer showed the first build of v2 with Yes on the Approve request (the v1 value, copied) and No on the Inform request. The owner decided that **Yes is wrong for v2**: the approver is fixed by the role and its Approver Assignment, Yes would let the approver pass the request on and so bypass the chain, `mwf_actualapprover` is not written yet (so a reassignment would not even be recorded), and delegation with a limit is Phase 3. `Request_approval_for_step` is now `false` as well (`Send_information_approval` was already `false`). The structural check has a rule for it and two unit tests keep `true` from coming back. **Trade-off:** an absent approver cannot pass the request on; that is handled by changing the Approver Assignment for the next rounds (a request already sent keeps its approver; the contract is withdrawn and submitted again to get a new round).

**Still NOT confirmed (nothing has run):**
- any run time behavior: the loop, the checkpoints, the Failed endings, the Reject path, a chain of one step;
- the text of the approval **title** as it is evaluated: the designer shows the Subject as a dynamic token (the owner saw a token named "Body"), but the evaluated title is first seen in the inbox (case A of the v2 session plan);
- the **False branch under `Check_contract_after_step`** (`Stop_contract_not_pending_after_step`): not looked at in the designer, so only the script's structural check covers it;
- the **Inform request left Pending** in the approvals inbox: that it is created, that it does not block, and how it looks (case C);
- that `Mark_step_Approved` writes the completion date and the comment as expected (`completionDate` and `responses.comments` are in the Learn reference; the written values are unseen).

**Exported source:** the record link (`itemLink`) of the **live** flow contains the **real host** of the environment (the script replaced the placeholder when it created the row). When `src/` is synced, the exported v2 file has to be scrubbed with `node scripts/scrub-emails.mjs`: its record-link pattern (the host in front of `/main.aspx?etn=`) matches the two links of v2 (`WebhookApprovalCreationInput/itemLink` and `ApprovalCreationInput/itemLink`). Checked offline on the built definition with a fictional host (script logic copied, not run on `src/`): email-like matches 0, record-link host matches 2, no other occurrence of the host. v2 has no approver address in its definition (the address comes from the assignment at run time), so the scrub has no email to replace there. A scrubbed v2 is not importable until `<ORG_HOST>` is filled in again.

## 8. Creating the row (first design created on 2026-10-22; recreation of the redesigned definition pending)

**Status after the redesign:** recreated and verified (see section 0). The first attempt was stopped by the connection criterion (3 minutes with `NODE_OPTIONS=--dns-result-order=ipv4first`: 8 failures of 36, longest run 3, nothing changed). A second check with `NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000"` (accepted by Node 22.23.3 inside NODE_OPTIONS; attempt timeout 2000 ms) gave 0 failures of 36 (GET median 764 ms, max 1494 ms), and the recreation ran at once with the same setting. One window; it is not shown that the setting is the cause.

**First creation:**

**Result (script):** prior read: v2 absent, v1 OFF. Connection gate: one 1-minute window of 12 cycles, 0 failures, on the first attempt. Then one POST (HTTP 204, not retried). Read back by `--mode=verify`: v2 exists once, OFF, in the solution; stored `clientdata` 13,392 bytes; the 25 structural checks pass on the stored definition; the 31 stored action names equal the built ones; the stored record link no longer has the placeholder; v1 OFF with the same `modifiedon`. The stored size is close to, but I did not show it equal to, the size of what was sent (Dataverse may normalize the text); the action names and the structure are equal. **Not done:** the designer, the Flow checker, turning on, any run.

Commands (for another environment):

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

## 11. Session of 2026-10-22 (summary)

Cases A to D passed (6, 6, 6 and 7 PASS; 0 FAIL). The comment of an approval and of a rejection is copied to `mwf_comments`; Inform does not block (the contract was In Force 7 s after the last Approve answer); a withdrawn and resubmitted contract cancels the old run at the checkpoint and the old request has no effect. Tables, run times and the list of what was not tested: ADR-007.

**Design note: Inform leaves an open Approve/Reject request.** "Create an approval" makes a normal approval request with the Approve and Reject buttons, and nothing in v2 waits for it or ever answers it. In case C the Owner's request `For information: ...` stayed **Pending** in the approver's inbox after the run had ended; it also stays after the contract is deleted. A real approver would see an open request that does nothing when answered. This is a consequence of the owner's decision to implement Inform with "Create an approval" (ADR-007, decision 4). Alternatives to consider, **none of them checked against Microsoft Learn yet** (so none is a recommendation): custom response options on the approval (for example a single "Acknowledge" response), a notification (an email or a Teams message) instead of an approval, or a later step that closes or cancels the request when the run ends. Each has a cost (a different connector or action, or work in the flow), and each needs verification of what the Approvals connector supports. A decision is open; v2 keeps the current behavior.

## 12. Failed endings at run time (session of 2026-10-22)

- **F1, no step rows for the round: verified.** The run ended **Failed** (`errorcode` `Terminated`, `errormessage` with `NoApprovalSteps` and the message "No Approval Step rows exist for this contract and approval round. The contract stays Pending Approval."); the contract stayed Pending Approval, no approval request was created, the verdict was 7 PASS, 0 FAIL. The case used the administrative bypass of the ApprovalChainBuilder Update step only. Detail, times and cleanup: ADR-007, "Failed endings session". This covers the first row of the table in section 5.
- **F2, role without an active assignment: deferred.** It was stopped by the connection gate before any write (nothing created, the assignment untouched). The planned sequence is unchanged and written in ADR-007 and in `scripts/test-flow-failures.mjs --mode=plan`: create the Draft contract, create one step row by hand, make the Department Head assignment Inactive, submit with the builder bypassed (the submission is the trigger), wait for the run, always reactivate the assignment (read back). Expected: Failed, `ApprovalStepFailed`, "The approver role of this step has no active Approver Assignment row."
- **Still not tested at run time:** the Failed ending for a user without an email address (`ApproverHasNoEmail`), F2, and a Failed ending after earlier steps were already answered.
