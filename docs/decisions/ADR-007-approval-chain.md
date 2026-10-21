# ADR-007: Approval chain built from the ApprovalMatrix, frozen at submission

- **Status:** Accepted (owner decisions of 2026-10-22). **Batch 1 of 4 is built:** the two tables, the corrected descriptions, the loader and the read-back. The plug-in that builds the chain, the flow loop and the security review are **not built** (later batches).
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

### Rules for the plug-in (design, **not built**, batch 2)

- **When:** the same real submission that sets the frozen USD value and the round (ADR-003, ADR-005). The intended place is the same transaction, so a chain that cannot be built **rolls the submission back** (fail closed). (Not tested.)
- **Band lookup:** the active matrix rows with the contract type and direction of the contract; the band is the one with `Min < value <= Max` (empty Max = no limit); value 0 matches the band with Min 0. Several bands, a gap that leaves the value uncovered, step orders that are not 1..n, or a chain with **no Approve step** are **configuration errors** and reject the submission with a message that names the rule. **Accepted (owner, 2026-10-22):** the no-Approve-step rule. (Built in batch 2; see "Batch 2" below.)
- **Rows:** one `mwf_approvalstep` per matrix row of the band, `Pending`, with the original approver read from `mwf_approverassignment`. **Accepted (owner, 2026-10-22):** the submission is rejected if any role of the chain has **no active assignment row** (missing or inactive). The flow re-reads the approver when each step starts, so an assignment that is deactivated later is caught there too. (Built in batch 2.)
- **A resubmission** (next round) creates the rows of the new round; the rows of the older rounds stay as audit, their open steps set to `Cancelled` (who sets them is decided in batch 2). (Not tested.)

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

## Corrected: the Min description of the ApprovalMatrix

The live description of `mwf_minvalueusd` said "inclusive" while the documentation, the CSV, the loader and the 110 rows use **Min exclusive**. Nothing read the column, so nothing was wrong in behavior. Both descriptions are now: Min "lower bound of the value band, exclusive", Max "upper bound, inclusive; empty means no upper limit" (script, 2026-10-22). The earlier convention "a value of exactly 0 matches no band" is **replaced by decision 2**: 0 falls on the first band.

## What was not tested

- The plug-in that builds the chain (batch 2), including the fail-closed rejections and the rollback.
- The flow loop, the checkpoints inside the loop, and the Reject path of the loop (batch 3).
- The **Inform** path ("Create an approval" without wait) and the assumption that the Owner is only informed.
- A chain with **one step** (the first band): the old flow always had two stages.
- That the flow connection can read the assignment and write the step rows with its own privileges.
- Import of the two tables with the solution into another environment (the pack of `src/` was not run after this batch; `src/` is not synced yet).
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
