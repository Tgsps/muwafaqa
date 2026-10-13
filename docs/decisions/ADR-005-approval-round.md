# ADR-005: Approval round, to tell a stale approval run from the current submission

- **Status:** Proposed. The plug-in side is built and tested on the server (script). The flow check was built **manually in the flow** and tested **once** (owner, in the run history).
- **Date:** 2026-10-13

Every claim below is marked **(script)** when a test script checked it on the server, **(unit)** when a unit test checked it, or **(not tested)**.

## Problem

A contract can be withdrawn to Draft and submitted again while the first approval run still waits for approvals. The flow then has two runs for one contract. The checkpoints of the flow (flow spec, section 13) only check that the contract is Pending Approval, and a resubmitted contract is Pending Approval again, so the stale run passes them and can write its decision over the new submission. A status check cannot tell the two submissions apart. This is the "Known gap" of `docs/flow-approval-v1.md`, section 12.

## Decision

- A new column `mwf_approvalround` on `mwf_contract`: **Whole Number**, minimum 0, not required. Description: "Incremented by plug-in on each real Draft -> Pending Approval submission. Read-only for clients."
- **Plug-in 1** (the one that writes the frozen USD value) also sets `mwf_approvalround = (current value or 0) + 1`, in the same place and under the **same condition** (the contract enters Pending Approval). The current value is **retrieved from the stored row**, never taken from the client Target.
- **The guard** (ADR-004) locks the column for clients exactly like the frozen USD value: it cannot be set on Create (any non-null value, including 0) or changed on Update, in any status. Plug-in 1 writes at PreOperation, after the guard, so its write is not blocked.
- **The flow** compares the round of the trigger (the contract as it was when the run started) with the stored round, read again at each checkpoint. **Built manually in the designer, tested once (owner).** See `docs/flow-approval-v1.md`, section 14. It does not compare again just before each write: that short window is open (see below).

## What was verified

| Claim | Result |
|---|---|
| The column exists: Whole Number, min 0, max 2147483647, not required, the description above | (script) metadata read back |
| A new Draft row holds **null** (a Whole Number column has no default value in the metadata; Learn lists none for `IntegerAttributeMetadata`) | (script) |
| Draft to Pending Approval sets round 1 (and the frozen value 1000.00) | (script) |
| Pending to Draft keeps round 1 | (script) |
| Draft to Pending Approval again sets round 2 | (script) |
| A same-status save (Pending to Pending) keeps round 2 | (script) |
| Pending to In Force keeps round 2 | (script) |
| A client write of a different value on Update is rejected (HTTP 400, "Approval Round cannot be changed..."), the row is unchanged: in Pending and in Draft | (script) |
| A client write of 5 or of 0 on Create is rejected (HTTP 400), no row is created | (script) |
| A contract created directly as Pending Approval through the API gets round 1 | (script, observation) |
| A stale run (submission 1, round 1) stops at "Stop - contract no longer Pending (stage 1)" after its stage 1 approval is answered, once the contract was withdrawn and submitted again (round 2); its status is Canceled and the owner did not cancel it | (owner), one test |
| The run of the second submission (round 2) passes both checkpoints and runs Update a row 3 (succeeded). Its final status in the run history is **Succeeded** (started 19:47 local, duration 7:23) | (owner, Run history) |
| After the answers the contract was In Force with round 2; 3 approvals were created (consistent with the above, not proof) | (script, counts) |
| `ApprovalRound.Next`: null or 0 gives 1, 1 gives 2, a negative stored value counts as 0, int.MaxValue overflows loudly | (unit) |
| The guard matrix includes the column (4 statuses x changed, unchanged, null to value, value to null) | (unit) |
| Plug-in 1 sets the round under the same condition as the frozen value (`SubmissionDetector`) | (unit, condition only; the shell is covered by the server tests above) |

## Alternatives considered

| Option | Upside | Downside |
|---|---|---|
| **Round column written by plug-in 1 (chosen)** | A number the flow can compare, set in the same transaction as the submission. Also a cleaner trigger column than the frozen value | One more column, one more locked column, one more read (Retrieve) in plug-in 1, and a flow change |
| Compare timestamps (the flow stores its start time, the contract carries the submission time) | No new column if a submission time existed | There is no submission time column. `modifiedon` changes on every edit (Subject, for example), so it does not identify a submission. The clocks of the flow and of Dataverse are two clocks |
| A separate round table (one row per submission with its own id) | A full history of submissions | A new table, a relationship, a plug-in that creates rows, cleanup rules. Much more than the need (compare one number) |
| Do nothing | No work | The gap stays: a stale run can complete a resubmitted contract. Only the owner can notice it |

## Consequences

- Plug-in 1 reads the stored row on every submission (one more Retrieve in System context). It does **not** use the PreImage for this, so it does not depend on the image registration.
- The round is null until the first submission, and only goes up. A rejection and a return to Draft do not reset it (the round counts submissions).
- A client can never set the column, including a value equal to the stored one (see the deviation below). The form does not need to show it.
- The assembly version is now 1.0.2.0; the package version stays 1.0.0 (ADR-003).

### Known deviation: the guard PreImage has 9 columns, not 10

The guard Update step has the column in its filtering attributes (10 columns), but its PreImage `pre` still has **9** columns, without `mwf_approvalround`. The update of the image attributes was refused by the server with HTTP 400, code 0x80040216, "An unexpected error occurred". **The cause was not investigated.** The owner decided to keep the image at 9 columns (no delete and recreate, no step disabled).

- **Effect (script):** a client Update that sends a non-null `mwf_approvalround` is **always rejected**, **even if it equals the stored value** (the column is absent from the image, so it reads as null). Observed on the server: an equal value (2) was rejected with HTTP 400.
- This is stricter than "exactly like the frozen value" in that one corner. It is fail closed, and no legitimate client writes this column.
- To close the deviation, the image has to be recreated with 10 columns (a registration change, with the risk that the guard has no image for a moment). Not done.

## What stays open

- **A short race between the check and the write:** the round is compared at the checkpoint, not again just before the write. If the contract is withdrawn and resubmitted inside that window, the guard still rejects a write that is not allowed, otherwise the stale run could write. (not tested)
- **The final status of the run of submission 2:** Succeeded (owner, Run history).
- **Value = 0:** A contract with Value = 0 enters approval today (accepted, frozen USD 0, round 1). Whether this is intended and which ApprovalMatrix band applies is a business decision, not taken.
- **The Terminate action names** still say "no longer Pending" although they now also cover a stale run (cosmetic, not renamed).
- **Two submissions at the same instant:** the round is read and written in two steps (Retrieve, then the write of the PreOperation). (not tested) whether two concurrent updates could produce the same round.
- **Rejected to Draft to Pending Approval:** the round should go up like any other resubmission. (not tested)
- **Other messages:** bulk messages and an owner change were not exercised. (not tested)
- **`src/`:** synced on 2026-10-13 (script): the column, the steps and the flow are in the solution source. See `docs/plugin-registration-log.md`. The pack warning about the `PluginAssembly` root component is not tested for import.
- **Flow trigger:** the trigger still uses `mwf_valueusdfrozen` as its Select columns. Using the round instead is possible and not done.
