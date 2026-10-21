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

### The flow (design, **not built**, batch 3)

A loop over the steps of the round, ordered by `mwf_steporder`: read the assignment, mark the step `Waiting`, then start the approval (Approve steps: "Start and wait for an approval"; Inform steps: "Create an approval", step marked `Informed`), write the decision, the actual approver, the time and the comments, run the two checkpoints, and stop on Reject. **The flow loop, the Inform path and a chain with a single step are not tested.**

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

## Corrected: the Min description of the ApprovalMatrix

The live description of `mwf_minvalueusd` said "inclusive" while the documentation, the CSV, the loader and the 110 rows use **Min exclusive**. Nothing read the column, so nothing was wrong in behavior. Both descriptions are now: Min "lower bound of the value band, exclusive", Max "upper bound, inclusive; empty means no upper limit" (script, 2026-10-22). The earlier convention "a value of exactly 0 matches no band" is **replaced by decision 2**: 0 falls on the first band.

## What was not tested

- The flow loop, the checkpoints inside the loop, and the Reject path of the loop (batch 3).
- The **Inform** path ("Create an approval" without wait) and the assumption that the Owner is only informed.
- A chain with **one step** in the flow (the plug-in builds it, T1 at 5,000; the old flow always had two stages).
- That the flow connection can read the assignment and write the step rows with its own privileges.
- A repeated call of the same Update operation (the idempotence guard of the plug-in) and a concurrent submission of the **same** contract by two clients (T10 submits five different contracts).
- The planner branches for a negative or empty frozen value, no matrix rows, an invalid row, overlapping bands and non-contiguous step orders **on the server** (unit tests only; the server tests used the real, valid fictional matrix, plus the missing-assignment case).
- A real matrix with a gap or an overlap: validated only by unit tests.
- The older flow-OFF test scripts (`test-usd-freeze`, `test-state-guard`, `test-approval-round`, ...) were **not re-run** with the new step active. They submit contracts, so each now builds a chain; whether any of them submits a contract that the new rules reject was not checked.
- Import of the two tables and of the new plug-in step with the solution into another environment (`src/` is not synced; the pack was not run).
- The delegation columns (`mwf_delegated`, `mwf_actualapprover`) are created but nothing writes them.

## Consequences

- **The data does not travel with the solution.** The 110 matrix rows and the 5 assignment rows are loaded per environment by scripts. A fresh environment without them rejects every submission once batch 2 exists (fail closed).
- Two more tables in the solution; `src/` is synced **after all four batches**, not now.
- The Value = 0 question of ADR-005 is answered by decision 2 (first band), pending the owner's confirmation that a zero-value contract should enter approval at all.
- The step table keeps the history of every round; it grows with resubmissions.

## Open items

- **Security (decided in the security phase):** the read privilege of the submitter's roles on `mwf_approvalstep` is decided there. **No project role is given write privilege on either table.** Who writes: the plug-in (system) and the identity of the flow connection; that identity's privileges are to be defined in the same phase.
- ~~Whether an Inform-only chain, or a missing assignment, should reject~~ Accepted by the owner on 2026-10-22: both reject.
- Whether the Owner should only be informed (assumption 4) in the real organization.
- Real thresholds and real roles replace the fictional ones before anything is used for real.
- Which approval type to use when a role later maps to a team or to several users.
