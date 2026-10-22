# ADR-007: Approval chain built from the ApprovalMatrix, frozen at submission

- **Status:** Accepted (owner decisions of 2026-10-22). **Batch 1 of 4 is built and committed:** the two tables, the corrected descriptions, the loader and the read-back. **Batch 2 is built (not yet committed):** the plug-in `ApprovalChainBuilder`, assembly 1.0.6.0. The flow loop (batch 3) and the security review (batch 4) are **not built**.
- **Date:** 2026-10-22

Every claim below is marked **(script)** when a script checked it on the server, **(unit)** for a unit test, **(owner)** for a decision or observation of the owner, **(from Learn)** for a Microsoft Learn statement, or **(not tested)**.

## Problem

The approval flow of Phase 1 has two fixed stages with one fixed approver address in both (`docs/flow-approval-v1.md`). It does not read the ApprovalMatrix (110 fictional rows, `docs/data-model-phase1.md`), so the amount, the contract type and the direction do not change who approves. The matrix holds a chain per value band: up to 5 steps, 4 of the 5 roles approve and the last (Owner) is informed (script, read-only inventory before this ADR). The roles are only a Choice column; nothing maps a role to a user. Phase 3 (delegation) needs an audit row per step to build on.

## Decision (owner)

1. **The plug-in builds the chain at the real submission** (Draft to Pending Approval) and saves it as rows in `mwf_approvalstep`. The flow walks those rows in a loop. The chain is **frozen at submission**, like the USD value (ADR-003) and with the same approval round (ADR-005).
2. **Bands are (min, max]:** Min exclusive, Max inclusive ("up to X"), an empty Max means no upper limit. The value is the **frozen USD value**. **Value 0 falls on the band whose Min is 0 (the first one).** A **negative** value, or a value that matches **no band**, **rejects the submission with a clear message** (fail closed).
3. **`mwf_approverassignment` maps a role to a user** and is read by the flow when each step starts. In development all five roles point to **one test account**, resolved at run time from an environment variable; no email and no id is in the repository. Delegation (Phase 3) is added on top later.
4. **Inform = the "Create an approval" action, no wait.** It does not stop the flow and uses the same connector (from Learn: "Start and wait for an approval" holds the flow until the approval is answered; "Create an approval" creates the same records and notifications but does **not** hold the flow; source: [Differences between flow approval actions](https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-automate/approvals/differences-between-flow-approval-actions)). **Temporary assumption, changeable:** the Owner *is informed*; the Owner does not approve and does not block the contract.
5. **Rejection and the checkpoints stay as they are inside the loop:** after every step the flow re-reads the contract and stops if it is no longer Pending Approval or if its approval round differs from the one of the trigger (ADR-005); a Reject answer sets the contract to Rejected and ends the run.
6. **No reassignment by the approver (owner, 2026-10-22):** `enableReassignment = false` in `Request_approval_for_step` and in `Send_information_approval`. Why: the approver is decided by the role and its Approver Assignment; Yes would let the approver pass the request to anyone and bypass the chain; `mwf_actualapprover` is not written yet, so a reassignment would leave no trace; delegation with a limit is Phase 3. Trade-off: an absent approver cannot pass the request on; the Approver Assignment is changed for the next rounds instead (a request already sent keeps its approver). v1 had `true` in both stages. `--mode=check` and unit tests keep `true` from coming back.

## Alternatives considered (and the trade-off)

| Alternative | Why not | What the chosen design costs |
|---|---|---|
| **The flow reads the ApprovalMatrix directly** (rejected by the owner) | The chain could change in the middle of a run if someone edits the matrix. The band logic would live in a flow, which cannot be unit tested and is hard to review. No per-step audit | One more table, and a plug-in that must be maintained and tested. Every approval needs the plug-in to have built the rows first |
| **Chain stored as one JSON text column on the contract** | No alternate key, no query by step, no per-step decision or audit, no relation for Phase 3 | Many small rows instead of one text value |
| **A text key column `mwf_stepkey` (contract id, round, order)** | Needed only if a Lookup cannot be in an alternate key. **It can** (from Learn, "Work with alternate keys": Lookup is a valid key column type), and the key was created and enforced on the server (script, S4, S9b) | Null key columns do not enforce uniqueness (from Learn); the plug-in always writes all three, and the columns are required at application level only |
| **Role-to-user as a column on the matrix** | A matrix row is per band and step, so the same role would repeat its user in up to 110 rows | A second small table and one read per step |
| **Security roles or teams as the source of the approver** | The environment has no custom role, no team named after a role and no department table (read-only inventory before this ADR) | A table to fill per environment |

## Design

### `mwf_approvalstep` (Organization-owned, no notes, no activities; script, created 2026-10-22)

| Column | Type | Required | Note |
|---|---|---|---|
| `mwf_name` | Text 200 (primary) | ApplicationRequired | For people only |
| `mwf_contract` | Lookup to `mwf_contract` | ApplicationRequired | **Delete: Cascade**. Assign, Share, Unshare, Reparent, Merge, RollupView: NoCascade |
| `mwf_approvalround` | Whole number, min 1 | ApplicationRequired | The round of the contract when the chain was built |
| `mwf_steporder` | Whole number, min 1 | ApplicationRequired | Position in the chain, 1 = first |
| `mwf_approverrole` | Choice (local) | ApplicationRequired | Department Head 867640000, Finance Manager ...01, General Manager ...02, Regional Office ...03, Owner ...04 (same values as the matrix) |
| `mwf_actiontype` | Choice (local) | ApplicationRequired | Approve 867640000, Inform 867640001 |
| `mwf_decision` | Choice (local) | ApplicationRequired | Pending 867640000, Waiting ...01, Approved ...02, Rejected ...03, Informed ...04, Cancelled ...05 |
| `mwf_originalapprover` | Lookup to `systemuser` | None | Remove link on delete |
| `mwf_actualapprover` | Lookup to `systemuser` | None | Remove link on delete. Differs from the original after a delegation |
| `mwf_decidedon` | Date and Time (UserLocal behavior) | None | The completion time of the approval |
| `mwf_comments` | Multiple lines, 4000 | None | |
| `mwf_delegated` | Yes/No, default No | None | Phase 3 |

**Alternate key `mwf_ApprovalStepKey` on (`mwf_contract`, `mwf_approvalround`, `mwf_steporder`):** no duplicate step in a round. Index status Active (script).

**Cascade, and why:** deleting a Draft contract deletes its steps, so a deleted draft leaves nothing behind. Only a Draft or Rejected contract can be deleted (the guard, ADR-004), so a chain of a submitted contract is never deleted by a cascade. The audit of a live contract is kept. Trade-off: the steps of a Rejected contract that is deleted are lost with it. **Accepted trade-off (owner, 2026-10-22):** deleting a Rejected contract deletes the record of its decisions with it. The real audit trail is the job of the security phase (Dataverse auditing on the step table and the contract), not of these rows.

### `mwf_approverassignment` (Organization-owned; script, created 2026-10-22)

| Column | Type | Required | Note |
|---|---|---|---|
| `mwf_name` | Text 200 (primary) | ApplicationRequired | |
| `mwf_approverrole` | Choice (local), same values | ApplicationRequired | |
| `mwf_user` | Lookup to `systemuser` | ApplicationRequired | Remove link on delete |

**Alternate key `mwf_ApproverAssignmentKey` on `mwf_approverrole`:** one row per role (script, Active). The key does not look at the state: an inactive row still holds the role. To change the approver, **update the row**; do not add a second one. Trade-off: no history of past assignments in this table (Phase 3 and the step rows hold the history).

### Loader `scripts/load-approver-assignment.mjs` (script)

Modes `check`, `load`, `validate`. The user comes from the environment variable **`MWF_APPROVER_TEST_USER`** (sign-in name or user id of the test account). The script never prints the value, the resolved id or any address; it prints counts. `load` creates a row per missing role and never changes an existing row. **The rows are data: they do not travel with the solution.** Same for the 110 ApprovalMatrix rows (`scripts/load-approval-matrix.mjs`): each environment needs both loaders run once.

### Plug-in `ApprovalChainBuilder` (built in batch 2, assembly 1.0.6.0)

| Property | Value |
|---|---|
| Step | Update of `mwf_contract`, **PostOperation (40), synchronous**, rank 1, filtering attribute `statuscode` only |
| PreImage | `pre`, **`statuscode` only** (one column; the 9-column image problem of ADR-005 is not touched) |
| Runs | only on a real submission: previous status not Pending Approval, new status Pending Approval (`SubmissionDetector`, the same definition as plug-in 1). Nothing otherwise |
| Identity | SYSTEM (`CreateOrganizationService(null)`), so no user needs a privilege on the chain tables |
| Rollback | an exception in a synchronous stage inside the transaction rolls the whole transaction back (from Learn, [Event Framework](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/event-framework): "An exception thrown by your code at any synchronous stage within the database transaction causes the entire transaction to roll back"; PreOperation and PostOperation are inside the transaction). **Tested on the server (T5): the contract stays Draft, and the PreOperation writes of plug-in 1 (frozen value, round) are rolled back too** |
| Read | the contract (number, type, direction, frozen USD value, round), the ACTIVE matrix rows of its type and direction, the ACTIVE assignment rows |
| Pure logic | `ApprovalChainPlanner.Plan(value, rows, rolesWithActiveAssignment)`: no Dataverse types, 38 unit tests |

Rules (all accepted by the owner):

- **Band:** `Min < value <= Max` (empty Max = no limit); value 0 matches the band with Min 0. No band (also a value above a closed last band or in a gap), more than one band covering the value, a negative value, or an empty frozen value: **rejected** with a message that starts "Cannot submit the contract." and names the cause.
- **Rows of the band** must have step orders exactly 1..n (no gap, no duplicate, starting at 1). A row with a missing Min, step order, role or action, a Max not above its Min, or an action other than Approve/Inform is a configuration error and **rejects** (all active rows of the type and direction are checked, not only the chosen band).
- **A chain with no Approve step is rejected.** A chain whose role has **no active assignment row** (missing or inactive) is rejected, and every missing role is named.
- **Rows created:** one `mwf_approvalstep` per matrix row of the band: round = `mwf_approvalround` of the contract (set by plug-in 1 in the same operation), role, action, decision `Pending`, original approver = the user of the role's active assignment, name `<contract number> R<round> S<order> <role>`.
- **Older rounds:** the steps of earlier rounds that are still `Pending` or `Waiting` are set to `Cancelled` in the same transaction. Approved, Rejected and Informed steps are left as they are. **Nothing is deleted.**
- **Repeated call:** if steps of the current round already exist (the platform can call an Update step twice in some cases, from Learn "Behavior of specialized update operations"), the plug-in does nothing. (Not tested; no way found to provoke a repeated call.)

Order of the pipeline on a submission: guard (PreValidation 10), then plug-in 1 (PreOperation 20: frozen value and round), then the update, then the chain builder (PostOperation 40) in the same transaction. The approval flow starts after the commit, so the steps exist when it runs.

### The flow v2 (batch 3: written, checked offline; redesigned on 2026-10-22 after the first Turn on failed; never run)

Full specification, action table, expressions, differences from v1, error handling and the list of what could not be checked: [flow-approval-v2.md](../flow-approval-v2.md). Summary of the **current definition** (50 actions, depth 6):

- A new flow "Muwafaqa - Contract Approval v2" with the **same trigger as v1** (checked against the v1 source). It reads the steps of the contract and the round of the trigger, ordered by step order. **No steps: Failed** (fail closed).
- **First Turn on, refused by the platform (owner, literal):** `InvalidWorkflowRunAction: "The workflow run action 'Stop_contract_not_pending_before_step' has type 'Terminate' that could not be nested under an action of type 'foreach'."` Learn (Logic Apps workflow definition reference, Terminate action): a Terminate "can't appear inside Foreach and Until loops, including sequential loops". **The Flow checker (0 errors, 0 warnings) did not catch it, and neither did my structural check (it did not know the rule). The platform validates it at Turn on, so Turn on is the decisive validation.** It was **not** among the items listed as not confirmed; it should have been (the designer and the Flow checker are not the last word on validity).
- **Redesign, behaviour unchanged (owner decision):** four string variables at the top of the flow (`endKind`, `endMessage`, and two helpers of mine, `approverEmail` and `approverUserId`, so that no action reads the output of an action in another group's condition); **no Terminate under the loop**: a problem inside the loop sets `endKind` (`Cancelled`, `Rejected`, `Failed`) and `endMessage`; every group of the loop runs only while `endKind` is empty, so nothing else runs in that iteration or the next ones; the loop stays sequential (concurrency 1; Set variable in a loop needs it); one **Switch on `endKind` right after the loop**: Cancelled ends Cancelled, Rejected ends Succeeded (as v1 for a rejection), Failed ends Failed with the message of `endMessage`, and the default carries on with the last checkpoint and then In Force.
- **Approve** steps are marked Waiting, then "Start and wait for an approval" (Basic), a checkpoint after the answer, and the step is marked Approved or Rejected (time and comments); a rejection sets the contract Rejected and `endKind` = Rejected. **Inform** steps use "Create an approval" without waiting and are marked Informed. No reassignment (decision 6).
- The approval title is unified: `Approve contract: <Subject> (step i of n, <role>)`. The test tools that find approvals by the text after the last colon were updated (batch 4 preparation).
- **Built as code** (`scripts/build-flow-v2.mjs`): `--mode=check` runs **35** structural checks (script) and **31** unit tests prove that the checker catches defects, including a copy of the first design. New rules: no Terminate under Foreach or Until at any depth; variables initialized at the top level and before use; every group of the loop gated on `endKind`; the closing Switch. **Learn items checked for the redesign:** Terminate not allowed in Foreach/Until (read); Initialize variable only at the workflow top level, not in scopes, conditions or loops, and Set variable in a loop wants a sequential loop (read); Switch structure with cases and default (read); Logic Apps limits of 8 nesting levels and 500 actions per workflow (read; Power Automate's own limits were not read). **Not checked:** other placement rules of Power Automate for the approval actions, and anything that only the platform's validation at Turn on reveals.
- **State of the environment:** the row that exists is the **first design** (31 actions, OFF); it cannot be turned on. The recreation with the new definition (`--mode=cleanup`, `--mode=create`, `--mode=verify`) was stopped by the connection criterion (3 minutes with `NODE_OPTIONS=--dns-result-order=ipv4first`: 8 failures of 36, longest run 3). Nothing was changed in the environment.
- **Not written by v2:** `mwf_actualapprover` and `mwf_delegated` (OBS: writing a lookup on a custom table through the connector could not be verified without the designer). They are filled when Phase 3 needs them.
- **Designer check of the FIRST design (owner, 2026-10-22; screenshots not in the repository; superseded by the redesign above):** v2 opens without errors, 31 actions with the expected names (8 directly inside the loop), **Flow checker 0 errors and 0 warnings**, the fields of both approval actions are shown with values and the designer knows the field names inside `ApprovalCreationInput`, `Mark_step_Waiting` and both connections are bound. Enable reassignment was Yes on the Approve request (the v1 value, copied) and No on the Inform request; the owner then decided **No on both** (decision 6). v2 was not run and not turned on; v1 and v2 are OFF; the stored definition did not change.
- **Still not confirmed:** any real run; the evaluated approval title (the designer shows the Subject as a "Body" token); the False branch under `Check_contract_after_step`; an Inform request left Pending in the approvals inbox. Session plan: `docs/flow-on-session-plan.md`, "Session plan for v2".
- **`src/` sync:** the live v2 contains the real host in its record links; the sync needs `scripts/scrub-emails.mjs` (it matches those links) before `git add`.
- **Highest-risk unverified item (reduced; the field names inside `ApprovalCreationInput` are now accepted by the designer):** the operation id `CreateAnApproval`, the parameter `approvalType` and the dynamic field `ApprovalCreationInput`, and the output fields `completionDate`, `responses.comments` and `responses.responder.email` are confirmed by the owner from Microsoft Learn. The field names **inside** `ApprovalCreationInput` are still inferred from the v1 names.

## Verified (batch 1, script, 2026-10-22, flow OFF)

`scripts/verify-approval-chain-schema.mjs` (read-only part and the live part with `--cascade-test`):

| Check | Result |
|---|---|
| Columns, types and required levels of both tables (15 columns expected) | PASS |
| Choice values, local option sets (role 5, action 2, decision 6) | PASS |
| Lookups: targets and delete behavior in the relationship metadata (Cascade, RemoveLink; no assign/share/reparent cascade) | PASS |
| Both alternate keys, index Active | PASS |
| 5 approver rows, one per role, Active, each with a user; 1 distinct user (OBS); the user exists and is enabled | PASS / OBS |
| ApprovalMatrix descriptions corrected | PASS |
| Both tables are components of the solution | PASS |
| No project (non-managed) security role holds a privilege on the two tables (20 privileges read, 0 custom roles) | PASS |
| Managed platform roles do hold privileges on the two tables (names: System Administrator, System Customizer, Service Reader, Service Writer, Service Deleter, Approvals Administrator, Approvals User, Flow-RP Role, Environment Maker, Support User) | OBS (the same effect as for the counter table, ADR-006) |
| Live: 2 steps for one contract and round; a duplicate (contract, round, order) rejected (HTTP 412, "Entity Key ... violated"); the same order in another round accepted | PASS |
| Live: deleting the Draft contract deleted all 3 of its steps (CASCADE) | PASS |
| Live cleanup: 11 contracts, 0 TEST-TMP, 0 temporary counterparties, 0 temporary steps; counter MNT restored 1 to 0, the others unchanged | PASS |

## Verified (batch 2, plug-in, 2026-10-22, flow OFF)

**Unit (338 passed, 0 failed; 38 new in `ApprovalChainPlannerTests`):** boundaries 10,000 / 10,000.01 / 50,000 / 50,000.01 / 100,000 / 100,000.01 (and 1, 9,999.99, a very large value), zero, 0.00, 0.01, negatives, empty value, a gap, an overlap, two bands from 0, step orders (gap, duplicate, not starting at 1, starting at 0, unsorted input), no Approve step, an Inform step after an Approve step, missing assignments (named, all named, only the roles of the chosen band), incomplete rows, Max not above Min, unknown action, role names.

**Registration (script `register-plugin-package.mjs --mode=package-update`, then `--mode=steps-chain`):** assembly **1.0.6.0**, package version unchanged at 1.0.0, package SHA-256 `dadebf5c24b7b187d170900f0c79ef54a1991d19b67e8a1338d222633500bb46`, DLL SHA-256 `0f900e6adefba4d2a9d66b1b87899c83143e2806aab5c924f7d626df59094e96`. Read-back: 12 passed, 0 failed (four plug-in types, seven steps all solution components, the chain step as above). The read-back before the step existed correctly showed the 3 expected failures.

**Server (script `test-approval-chain.mjs`, flow OFF, prefix `TEST-TMP-CHAIN`): 37 PASS, 0 FAIL, 3 OBS**

| Test | Result |
|---|---|
| T1 the four bands (5,000 / 25,000 / 75,000 / 250,000, Maintenance, Expense): 1, 2, 3 and 5 steps; roles and orders; the last step of the top band is Inform and the others Approve; all Pending, round 1, original approver set, names as designed | PASS |
| T1x the other four types with direction Income at 25,000: 2 steps each | PASS |
| T2 boundaries 10,000 (1 step), 10,000.01 (2), 50,000 (2), 50,000.01 (3), 100,000 (3), 100,000.01 (5); frozen value equal to the input | PASS |
| T3 value 0: first band, 1 step, Department Head | PASS |
| T4 a negative Value cannot be created (the Value column minimum is 0, HTTP 400) | PASS + OBS: the negative branch of the planner is reachable only by unit tests |
| T5 Finance Manager assignment deactivated: a 25,000 submission is rejected (HTTP 400, "Cannot submit the contract. No active Approver Assignment for: Finance Manager."); **rollback proved**: the contract is Draft, round and frozen value empty, no steps; a 5,000 submission (Department Head only) still works; after reactivation the same contract is accepted (round 1, 2 steps); 5 active assignments read back | PASS |
| T6 resubmission: round 2, 4 rows; the Waiting step of round 1 is Cancelled, the Approved one stays Approved; a third submission cancels the Pending steps of round 2 | PASS |
| T7 Pending to Rejected to Draft to Pending: round 2, the 3 steps of round 1 Cancelled, 3 new Pending | PASS |
| T8 no steps for a Draft edit, a same-status save on Pending, a Subject edit on Pending, nor a Value change on Pending (rejected by the guard, HTTP 400); same round and frozen value; withdraw and a Draft edit add nothing | PASS (+ OBS with the HTTP codes) |
| T9 the chain is frozen: with one matching matrix row deactivated the steps are unchanged, and after reactivation too; 110 active matrix rows read back | PASS |
| T10 five parallel submissions (1, 2, 3, 5, 2 steps): all HTTP 204, each contract has exactly its own chain, about 1 s | PASS |
| Cleanup: 26 contracts deleted, their steps deleted by the cascade (0 steps left); counterparty deleted; counters restored (MNT 22 to 0, the others 1 to 0); 11 contracts, 0 TEST-TMP, 110 active matrix rows, 5 active assignments | PASS |

## Regression pass of the flow-OFF scripts (2026-10-22, assembly 1.0.6.0, chain step enabled)

Flow OFF, one script at a time. Before the pass: 338 + 25 unit tests passed; 3 GET requests; 11 contracts (latest `modifiedon` 2026-10-07T17:23:48Z); 0 TEST-TMP; counters 0/0/0/0/0; 0 steps; 110 active matrix rows; 5 active assignments. After **each** script the same state was read again and was identical. No old test was edited, and no matrix or assignment row was touched by these scripts.

| Script (mode) | Result now | Previous result | Verdict |
|---|---|---|---|
| unit tests (`dotnet test`, `node --test` of the two lib test files) | 338 passed + 25 passed | 300 + 25 | PASS (38 new tests) |
| `test-approval-round` | 12 PASS, 0 FAIL, 2 OBS | 12 / 0 / 2 | same |
| `test-usd-freeze --mode=update-cases` | 10 PASS | 10 | same |
| `test-usd-freeze --mode=create-case` | 1 PASS | 1 | same |
| `test-usd-freeze --mode=guard-smoke` | 5 PASS | 5 | same |
| `test-state-guard --mode=integration --skip-ui-rows` | 75 PASS, 0 FAIL, 4 OBS (the same 4 observations) | 75 / 0 / 4 | same |
| `test-contract-number` (full) | 18 PASS, 0 FAIL | no recorded total for a full run to compare (the T4/T5 subset passed before) | PASS |
| `verification-api-tests same-status-save` | completed, HTTP 204, status, frozen value (1000) and round (1) unchanged | HTTP 204, same values | same, one difference below |
| `verification-api-tests value-zero` | HTTP 204, frozen 0, round 1 | same | same |
| `verification-api-tests t4` | completed (Rejected row back to Draft through the API, renamed) | edited, not re-run before | PASS (an observation script: no verdict lines) |

**No failure.** Each script that submits a contract now builds a chain in the same transaction; none of them was rejected by the new rules, and each deleted its rows (the steps went with the cascade) and restored the counters (`refused 0`).

### Two observations from the pass (not failures, nothing was changed)

1. **`same-status-save` and `modifiedon`:** the earlier record says `modifiedon` was "unchanged (same second)". This time it differed by one second. A separate probe (scratch script, not in the repository) showed that a same-status save **does** update `modifiedon` (about 10 s after the submission, `modifiedon` moved to the time of the save), while nothing changes it in between. So the earlier "unchanged" was a timing artifact of a very fast run, not a rule of the platform, and the chain builder does not write to the contract. The status, frozen value and round are unchanged, as before. The old record is not rewritten; this note corrects its reading.
2. **A contract created directly as Pending Approval gets round 1 and a frozen value, but NO chain.** Probe (script outside the repository, flow OFF): a Create with `statuscode` Pending Approval was accepted (HTTP 2xx), round 1, frozen 1000, **0 approval steps**. Reason: the chain builder is registered on **Update** only, while the guard and plug-in 1 also accept a Create as Pending (`test-approval-round` [9] and `test-usd-freeze` case 3 observe the same entry path). With the flow, such a contract would have no steps to loop over. This is a **gap**, found by the regression pass and **not fixed**: options are (a) also register the builder on Create (PostOperation, no image), (b) make the guard reject a Create as Pending (changes ADR-004), (c) accept it and let the flow fail closed on an empty chain. To be decided by the owner before batch 3.

   **Resolved on 2026-10-22 (option b, assembly 1.0.7.0):** the guard now rejects any Create that is not Draft, so a contract can only enter approval through the Draft to Pending Update, where the chain is built. See ADR-004, "Update 2026-10-22".

The probe consumed two Maintenance numbers because it did not register its creates with the counter helper; the counter was put back from 2 to 0 afterwards by the helper rule (now == snapshot 0 + consumed 2, no contract with that prefix exists). Final state read again: flow OFF, 11 contracts, 0 TEST-TMP, 0 temporary counterparties, counters 0/0/0/0/0, 0 steps.

## Corrected: the Min description of the ApprovalMatrix

The live description of `mwf_minvalueusd` said "inclusive" while the documentation, the CSV, the loader and the 110 rows use **Min exclusive**. Nothing read the column, so nothing was wrong in behavior. Both descriptions are now: Min "lower bound of the value band, exclusive", Max "upper bound, inclusive; empty means no upper limit" (script, 2026-10-22). The earlier convention "a value of exactly 0 matches no band" is **replaced by decision 2**: 0 falls on the first band.

## What was not tested

- The flow loop, the checkpoints inside the loop, and the Reject path of the loop: v2 is written and checked offline only; no run, no designer, no Flow checker, and its row is not created yet (batch 3, flow-approval-v2.md, sections 7 and 10).
- The **Inform** path ("Create an approval" without wait) and the assumption that the Owner is only informed.
- A chain with **one step** in the flow (the plug-in builds it, T1 at 5,000; the old flow always had two stages).
- That the flow connection can read the assignment and write the step rows with its own privileges.
- A repeated call of the same Update operation (the idempotence guard of the plug-in) and a concurrent submission of the **same** contract by two clients (T10 submits five different contracts).
- The planner branches for a negative or empty frozen value, no matrix rows, an invalid row, overlapping bands and non-contiguous step orders **on the server** (unit tests only; the server tests used the real, valid fictional matrix, plus the missing-assignment case).
- A real matrix with a gap or an overlap: validated only by unit tests.
- The flow-ON scripts (`test-guard-flow`, `test-flow-trigger`, `test-flow-checkpoints`, `test-flow-approvalround`, `test-usd-freeze --mode=flow-case`) and `verification-api-tests` modes `quick-toggle`, `t1`, `t2`, `t3` were **not re-run** after the plug-in step (the first need the flow ON; `t1`/`t3` change option and exchange-rate metadata unrelated to the chain). The other flow-OFF scripts were re-run, see the regression section.
- A Create as Pending Approval no longer exists (rejected by the guard since assembly 1.0.7.0, ADR-004). The chain builder has no Create step by design; a bulk `CreateMultiple` is not covered by the guard (as before).
- Import of the two tables and of the new plug-in step with the solution into another environment (`src/` is not synced; the pack was not run).
- The delegation columns (`mwf_delegated`, `mwf_actualapprover`) are created but nothing writes them.

## Consequences

- **The data does not travel with the solution.** The 110 matrix rows and the 5 assignment rows are loaded per environment by scripts. A fresh environment without them rejects every submission once batch 2 exists (fail closed).
- Two more tables in the solution; `src/` is synced **after all four batches**, not now.
- The Value = 0 question of ADR-005 is answered by decision 2 (first band), pending the owner's confirmation that a zero-value contract should enter approval at all.
- The step table keeps the history of every round; it grows with resubmissions.

## Open items

- ~~Create as Pending Approval has no chain~~ **Closed 2026-10-22:** the guard rejects it (ADR-004 update; option b chosen by the owner).

- **Security (decided in the security phase):** the read privilege of the submitter's roles on `mwf_approvalstep` is decided there. **No project role is given write privilege on either table.** Who writes: the plug-in (system) and the identity of the flow connection; that identity's privileges are to be defined in the same phase.
- ~~Whether an Inform-only chain, or a missing assignment, should reject~~ Accepted by the owner on 2026-10-22: both reject.
- Whether the Owner should only be informed (assumption 4) in the real organization.
- Real thresholds and real roles replace the fictional ones before anything is used for real.
- Which approval type to use when a role later maps to a team or to several users.
- **Connection criterion for the v2 flow-ON session (owner, 2026-10-22):** a 3-minute `check-connection` run (36 cycles) is accepted with at most 2 failures and no two failures in a row, instead of 15 clean minutes (15-minute run of the same day: 14 of 180 GET cycles `ETIMEDOUT`, DNS 0 failures). The check of 3 consecutive successful reads before every write stays; writes are not retried automatically. Trade-off: a session can still meet an isolated failure in the middle; it then stops and is cleaned up.  The first 3-minute check under this criterion **failed**: 5 of 36 GET cycles `ETIMEDOUT`, longest run 2 (DNS 0 failures); the session was not started. Earlier 3-minute windows of 2026-10-22 gave 2/36, 2/36 and 1/36 failures. The owner then changed the network and the check is repeated once.
- **Run-time setting for the v2 session (owner, 2026-10-22; no code change):** the 3-minute check, same criterion (at most 2 failures of 36 and never two in a row), was run with two Node settings, read only. Node v22.23.3 (read from `node --version`). Confirmed: in the running Node the family autoselection is on and its attempt timeout is 250 ms (`net.getDefaultAutoSelectFamily()` and `net.getDefaultAutoSelectFamilyAttemptTimeout()`), the default DNS order is `verbatim`; the flags `--dns-result-order`, `--no-network-family-autoselection` and `--network-family-autoselection-attempt-timeout` exist (`node --help`, and the Node CLI documentation: `--dns-result-order` default `verbatim`, `ipv6first` supported since v22.1.0; autoselection flags since v18.18.0/v19.4.0; the timeout flag since v22.1.0). Not confirmed: the defaults the documentation page states for the autoselection flags (not stated on the part of the page that I read; the last 53,000 characters were not read).

  | Setting | Failures of 36 | Longest run | Failure times | Code | Criterion |
  |---|---|---|---|---|---|
  | none (earlier, same day) | 5, and 5 | 2, and 2 | 262 to 269 ms (and 439 ms once) | `ETIMEDOUT` | not met |
  | `NODE_OPTIONS=--dns-result-order=ipv4first` | **1** (cycle 30) | **1** | 266 ms | `ETIMEDOUT` | **met** |
  | `NODE_OPTIONS=--no-network-family-autoselection` | 2 (cycles 15 and 16) | 2 | 10,002 and 10,006 ms (the 10 s request limit) | `23` (the request timeout) | **not met** (two in a row); one successful request took 7,796 ms |

  The check succeeded with `--dns-result-order=ipv4first`; the other setting did not. **This does not show that the address family is the cause**: one window per setting, an earlier window of 2/36 and 1/36 without any setting, and the failures of the unset runs all took about 265 ms, which is close to the 250 ms attempt timeout of the autoselection (an observation; not tested, so not a conclusion). Decision: every command of the v2 session is run with `NODE_OPTIONS=--dns-result-order=ipv4first` written in the command. Writes are still never retried automatically.

## v2 flow-ON session (2026-10-22): results

The first Turn on of v2 was refused by the platform (a Terminate inside the loop; see the flow section), v2 was redesigned and created again OFF, and the owner then turned it on. The cases of the session plan (`docs/flow-on-session-plan.md`, "Session plan for v2") ran one at a time with `scripts/test-flow-v2.mjs`: the owner answered each request by hand, one at a time, only after the assistant printed its literal title; no result was reported before the owner wrote that the request was answered. The assistant never turned a flow on or off.

| Case | Contract | Owner actions (one at a time) | Verdict | End state |
|---|---|---|---|---|
| **A** one step | USD 5,000 | Approve `(step 1 of 1, Department Head)` | 6 PASS, 0 FAIL, 1 OBS | step Approved, contract **In Force** |
| **B** reject in the second step | USD 25,000 | Approve step 1 (comment typed), **Reject** step 2 (comment typed) | 6 PASS, 0 FAIL, 1 OBS | step 1 Approved, step 2 Rejected, contract **Rejected** (state Inactive) |
| **C** top band with Inform | USD 250,000 | Approve steps 1 to 4 in order | 6 PASS, 0 FAIL, 2 OBS | steps 1 to 4 Approved, step 5 **Informed**, contract **In Force**; 1 Inform request left open |
| **D** withdraw and resubmit | USD 25,000 | Approve step 1 (round 1); the script withdrew and resubmitted (round 2); the owner answered the OLD step-2 request of round 1, then step 1 and step 2 of round 2 | 7 PASS, 0 FAIL, 1 OBS | round 1: Approved + **Cancelled**; round 2: Approved + Approved; contract **In Force** |

The OBS lines: the attribution of the run to the contract by end time (one run fits the last answer), and in C the measure of "Inform does not block" (below).

**Runs (`flowruns`, finished runs, UTC):**

| Case | Run start (UTC) | Run end (UTC) | Duration | `flowruns` status | `errorcode` |
|---|---|---|---|---|---|
| A | 02:05:55 | 02:07:20 | 85 s | Succeeded | none |
| B | 02:12:16 | 02:15:00 | 164 s | Succeeded | Terminated (the Terminate Succeeded of the rejection case) |
| C | 02:16:53 | 02:21:37 | 284 s | Succeeded | none |
| D run 1 (the old one) | 02:25:42 | 02:31:02 | 320 s | **Cancelled** | Terminated (the Terminate Cancelled of the closing Switch) |
| D run 2 | 02:29:13 | 02:34:40 | 327 s | Succeeded | none |

`errorcode = Terminated` does not say whether a run succeeded or was cancelled (as with v1): B is Succeeded, D run 1 is Cancelled. `flowruns` showed a run one to two minutes after it ended.

**What was checked beyond the verdicts (script, read only):**
- **Comments (B):** copied exactly: step 1 "اختبار تعليق الاعتماد" and step 2 "اختبار تعليق الرفض" (typed by the owner as the test text). Cases A, C and D had no comment typed, so the column stayed empty there.
- **Inform does not block (C):** the owner answered step 4 at 02:21:30Z (05:21:30 UTC+3); step 5 was marked Informed at 02:21:34Z; the contract became In Force at 02:21:37Z (7 s after the answer) and the run ended Succeeded at the same time. The run did not wait for the Inform request.
- **The old request (D):** the owner answered the round-1 step-2 request at 02:30:58Z (05:30:58 UTC+3). Nothing changed on the contract: the round-1 step stayed Cancelled (not Approved), the contract stayed Pending in round 2. The old run ended **Cancelled** at 02:31:02Z, 4 s after the answer (the checkpoint after the answer saw another round).
- **Evaluated approval title** (as stored in the approvals table), exactly as designed: `Approve contract: TEST-TMP-V2A one step (step 1 of 1, Department Head)`, and for Inform `For information: contract TEST-TMP-V2C top band with inform (step 5 of 5, Owner)`. So the "Body" token of the designer evaluated to the Subject, and the inline role-label expression worked. The details text and the item link inside the request were not read.
- **Reassignment** was off in both approval actions (not exercised: the owner did not try to reassign).
- **Answer times (completedon, UTC / UTC+3):** A 02:07:15 / 05:07:15. B 02:13:35 / 05:13:35 and 02:14:56 / 05:14:56. C 02:18:03 / 05:18:03, 02:19:07 / 05:19:07, 02:20:11 / 05:20:11, 02:21:30 / 05:21:30. D 02:28:40 / 05:28:40, 02:30:58 / 05:30:58, 02:33:41 / 05:33:41, 02:34:36 / 05:34:36.
- **Left open after the session:** one request, `For information: contract TEST-TMP-V2C top band with inform (step 5 of 5, Owner)`, created 02:21:33Z, never answered (as planned). It stays in the inbox after the test contract was deleted. The other 11 requests with a TEST-TMP-V2 title were answered.
- **Network:** no network error in the four cases. Every command ran with `NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000"`; the check of 3 consecutive reads passed before every command and after every wait. Writes were not retried (none needed it). Before the session the 3-minute check had failed twice (8 of 36 and 5 of 36 with other settings) and passed with this setting (0 of 36); one window, not shown to be the cause.
- **Cleanup** after each case: the contract (its steps by the cascade) and the counterparty deleted; MNT restored 1 to 0 each time (`refused 0`); no approval request touched. Final: 11 contracts (the 11 legacy rows untouched, latest `modifiedon` 2026-10-07T17:23:48Z), 0 steps, 0 TEST-TMP rows, counters 0/0/0/0/0, 110 active matrix rows, 5 active assignments.
- **The owner turned v2 ON before the session and OFF after it; v1 stayed OFF.** Read after the shutdown: v1 OFF, v2 OFF (one row).

**Not tested (also from this session):**
- The Failed endings: a role without an active assignment, a user without an email address, a round without steps. They need the assignment rows to be changed; this session did not.
- Cancelled by a withdrawal before a step starts (the checkpoint before the step) and before the final write; only the cancellation after an answer was exercised (D).
- A chain of one step with Inform, or an Inform step that is not last.
- `mwf_actualapprover` (not written by design; it stayed empty), the delegation columns, and any reassignment.
- The comment on cases A, C and D; the comment on an Inform request.
- The notifications sent to the approver account; the details text and the item link in the request.
- Two contracts in the approval at once (the cases ran one at a time), concurrent submissions of the same contract, and a long wait for an answer.
- Turning the flow on while contracts are already Pending (no run exists for them).
- An outage of the connection in the middle of a run on the platform side.

**Design note: Inform leaves an open Approve/Reject request.** "Create an approval" makes a normal approval request with the Approve and Reject buttons, and nothing in v2 waits for it or ever answers it. In case C the Owner's request `For information: ...` stayed **Pending** in the approver's inbox after the run had ended; it also stays after the contract is deleted. A real approver would see an open request that does nothing when answered. This is a consequence of the owner's decision to implement Inform with "Create an approval" (ADR-007, decision 4). Alternatives to consider, **none of them checked against Microsoft Learn yet** (so none is a recommendation): custom response options on the approval (for example a single "Acknowledge" response), a notification (an email or a Teams message) instead of an approval, or a later step that closes or cancels the request when the run ends. Each has a cost (a different connector or action, or work in the flow), and each needs verification of what the Approvals connector supports. A decision is open; v2 keeps the current behavior.

