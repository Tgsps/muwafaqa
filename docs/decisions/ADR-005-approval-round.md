# ADR-005: Approval round, to tell a stale approval run from the current submission

- **Status:** Proposed. The plug-in side is built and tested on the server (script). The flow check was built **manually in the flow** and tested **once** (owner, in the run history).
- **Date:** 2026-10-13

Every claim below is marked **(script)** when a test script checked it on the server, **(unit)** when a unit test checked it, or **(not tested)**.

## Problem

A contract can be withdrawn to Draft and submitted again while the first approval run still waits for approvals. The flow then has two runs for one contract. The checkpoints of the flow (flow spec, section 13) only check that the contract is Pending Approval, and a resubmitted contract is Pending Approval again, so the stale run passes them and can write its decision over the new submission. A status check cannot tell the two submissions apart. This is the "Known gap" of `docs/flow-approval-v1.md`, section 12.

## Decision

- A new column `mwf_approvalround` on `mwf_contract`: **Whole Number**, minimum 0, not required. Description: "Incremented by plug-in on each real Draft -> Pending Approval submission. Read-only for clients."
- **Plug-in 1** (the one that writes the frozen USD value) also sets `mwf_approvalround = (current value or 0) + 1`, in the same place and under the **same condition** (the contract enters Pending Approval). The current value is **retrieved from the stored row**, never taken from the client Target.
- **The guard** (ADR-004) treats the column as **system-written only**: it cannot be set on Create (any non-null value, including 0), and **any client Update that includes the column in its Target is rejected, whatever the value** (different, equal to the stored one, or null), in every status. The guard does not read the PreImage for this column. (This replaced "exactly like the frozen USD value", whose equal-value no-op needed the column in the PreImage; see the design decision below.) Plug-in 1 writes at PreOperation, after the guard, so its write is not blocked. The frozen USD value is unchanged: an equal value is still a no-op.
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
| A client write of a value **equal** to the stored one (2) on Update is rejected (HTTP 400), and so is a write of **null**; the row is unchanged | (script, 2026-10-18, assembly 1.0.5.0) |
| An Update that does not include the column is not rejected (a save of another column, a same-status save) | (script, `test-approval-round` cases 4 and 2; unit) |
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
- A client can never send the column, including a value equal to the stored one (by design, see the decision below). The form does not need to show it.
- The assembly version is now 1.0.5.0 (1.0.2.0 when the round was introduced); the package version stays 1.0.0 (ADR-003).

### Design decision: the guard PreImage has 9 columns, and the round does not need to be in it (closed as a design decision, not as a fix)

The guard Update step has the round in its **filtering attributes** (10 columns) so that the guard runs when a client sends it, but its PreImage `pre` has **9** columns, without `mwf_approvalround`. An attempt to add the column to the image failed with HTTP 400, code **0x80040216**, message "An unexpected error occurred." (first on 2026-10-13, reproduced on 2026-10-18).

**What was established (script, read only unless said):**
- The failing request: `PATCH /sdkmessageprocessingstepimages(<id>)` with the body `{"attributes":"<the 9 current columns>,mwf_approvalround"}`. The full response is only the code and that message (no inner error, no detail). The image stayed unchanged (9 columns) after the failure, so no rollback was needed.
- The step is enabled and not managed (PreValidation, synchronous, rank 1), and its filtering attributes already hold the 10 columns including `mwf_approvalround`.
- `mwf_approvalround` is a normal Integer column, valid for read, create and update, the same kind of column as `mwf_valueusdfrozen` which is in the image. The attributes string has no spaces and the same comma format as the filtering string.
- Other images in the environment (system images) hold up to 13 attributes, so 10 is not a limit.

**What was not established:** the cause. In particular it is not known whether *any* update of this image fails, whether *creating* an image with 10 columns would work, or whether the Plug-in Registration Tool would behave differently. The experiments that would answer this (a temporary second image on the same step) were **deliberately not run**.

**Sources (Microsoft Learn):**
- [web service error codes](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes): 0x80040216 is **UnExpected**, "An unexpected error occurred.", a generic code.
- [sdkmessageprocessingstepimage table reference](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/sdkmessageprocessingstepimage): `attributes` is a plain comma-separated text column (max 100000 characters, not required); Update by `PATCH` is a supported operation. No restriction is documented on the columns or on their count, and none ties them to the step's filtering attributes.
- [Register a plug-in](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/register-plug-in): images are supported for Update, and only the columns the logic needs should be included. No rule is given that would explain the failure. An additional search found no similar report.

**Decision (owner, 2026-10-18):** do not chase the cause. The design is changed so that the image is **not needed** for the round: the guard rejects any client write of `mwf_approvalround` whenever it is in the Target, whatever the value, **without reading the PreImage** (assembly 1.0.5.0; category `SystemOnly` in `LockedColumnsPolicy`). The image therefore stays at 9 columns **on purpose**.

**Effect:**
- Before: a write of an equal value was rejected only because the column was missing from the image (an accident of the registration, reported as a deviation). Now it is rejected by rule, and a write of null is rejected too.
- `mwf_valueusdfrozen` is unchanged (it is in the image; an equal value is still a no-op).
- Plug-in 1 is not affected: it writes at PreOperation, and the guard (PreValidation) never sees that write.
- The registration read-back (`register-plugin-package.mjs --mode=readback`) now expects filtering 10 / PreImage 9 and passes (script); `test-approval-round` case 6 is an intended expectation (HTTP 400, PASS), not an observation.
- This closes the item **as a design decision, not as a fix**: the platform error remains unexplained.

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
