# ADR-006: Contract number generator (per contract type, plug-in with a counter table)

- **Status:** Accepted (owner decisions of 2026-10-13). Built and tested on the development environment. `src/` was synced on 2026-10-18 (see "Solution source" below).
- **Date:** 2026-10-13
- **Supersedes in part:** ADR-002 (Phase 2 plan: "a plug-in generates the number on create") and ADR-004 question Q4 ("Contract Number is editable in Draft").

Every claim is tagged **(script)** when a script read or tested it on the server, **(unit)** for unit tests, **(from Learn)** when it comes from Microsoft Learn, **(source)** when it comes from this repository, or **(not tested)**.

## Problem

`mwf_contractnumber` was a plain text column that clients filled in by hand or left empty (ADR-002, source). Nothing guaranteed a consistent format or that a number was issued. The owner decided that numbers are issued by the system, per contract type, as `PREFIX-NNNN`.

## Decision (owner)

- Format `PREFIX-NNNN`, one **independent counter per Contract Type**, **minimum 4 digits**, growing beyond 9999. No year and no direction (Income/Expense) in the number.
- Prefixes (confirmed): `MNT` Maintenance, `PRC` Procurement, `INS` Insurance, `SAL` Sales, `SRV` Services.
- A plug-in with a **counter table**. Not the native Autonumber column: it cannot vary the prefix by another column.
- Follow "Approach 3: Pre-lock in a plug-in transaction" of the Microsoft Learn autonumbering example.
- **Test isolation:** no spare test option and no metadata churn. Tests use the real types and a shared helper snapshots each counter before a test and restores it after cleanup **only if** counter == snapshot + the numbers the test consumed (nobody else used a number); otherwise it refuses and reports counts only. A crash in the middle of a test just leaves gaps (allowed).
- **Roles on the counter table (decision, option 1 accepted):** the managed platform roles keep their default privileges on `mwf_contractnumbercounter`; **no project role may ever be granted a privilege on it**.
- A missing Contract Type on Create is rejected in the **guard at PreValidation**, not in plug-in 3. Plug-in 3 itself throws only for unexpected counter errors.
- A wrong Contract Type means: delete the Draft and create a new one.
- The loader `scripts/load-test-data.mjs` and `data/contracts.csv` stop passing numbers (the server generates them).

## Sources

- Microsoft Learn, "Scalable Customization Design: Autonumbering example" (Approach 3: pre-lock in a plug-in transaction): <https://learn.microsoft.com/en-us/power-apps/developer/data-platform/scalable-customization-design/auto-numbering-example> (from Learn).
- `IOrganizationServiceFactory.CreateOrganizationService(null)` returns a service that runs as the **SYSTEM** user (from Learn, plug-in development documentation). ADR-003 already reads the currency table this way (script).
- Microsoft Learn, "Work with alternate keys" (restricted characters, ADR-002) (from Learn).

## Facts checked before the design (read only, script)

| Fact | Result |
|---|---|
| `mwf_contractnumber` | single line of text, max length 100, not required (script) |
| Alternate key | `mwf_ContractNumberKey`, one attribute, index Active (script). A duplicate is rejected with HTTP 412 (script, ADR-002) |
| Restricted characters | `/ < > * % & : \ ? +` break GET/PATCH by key (from Learn, confirmed for `/`, script). `PREFIX-NNNN` uses only letters, digits and a hyphen |
| Existing contracts | 11 rows, numbers in the pattern `AAAA-AA-9999` (the `TEST-CT-` series). 0 start with any of the five prefixes (script, patterns only) |
| `mwf_contracttype` | Choice, ApplicationRequired (UI only: the API accepted a row without it before this change), five options, **local** option set (script) |
| Contract table | UserOwned (script) |

## The three approaches (from Learn)

| Approach | How | Weakness |
|---|---|---|
| 1. Out of a transaction (PreValidation) | Read, increment, write, no lock | Two parallel requests can read the same value and both issue it |
| 2. In a plug-in transaction (read, then update) | Same, inside the platform transaction | Two requests can both take a shared read lock; the upgrade to an exclusive lock then fails or a duplicate is issued |
| **3. Pre-lock in a plug-in transaction** | The first action in the transaction is a **placeholder update** of the counter row; it takes the exclusive write lock and blocks other requests before they read. Then read, increment, write back | Serializes the number issue **and** the record creation (same transaction). Fine when the other work in the transaction is quick. Learn says it is not perfect for every situation and that testing is the owner's responsibility |

**Why approach 3:** it is the one that is correct under concurrency (from Learn); the number and the contract commit or roll back together; the transaction is short (plug-in 1 and no synchronous PostOperation step, source). Trade-off: creates of the same type are serialized by the counter row.

### Alternative considered and rejected: native Autonumber with the prefix swapped in a plug-in

A native Autonumber column keeps **one** shared sequence. A plug-in that swaps the prefix by type would leave the per-type numbers **non-contiguous** (`MNT-0001`, `PRC-0002`, `MNT-0003`...). The platform's support for changing a generated autonumber value in a plug-in was **not confirmed** (not verified). Rejected: the owner wants an independent contiguous counter per type. The native seed has the same per-environment limitation as the counter table (see "ALM").

## Design (as built)

### Counter table `mwf_contractnumbercounter` (script, created 2026-10-13)

- **Organization-owned**, in the `Muwafaqa` solution (script). One row per contract type, seeded by script with `mwf_lastnumber = 0` (script: 5 rows).
- The type is stored as the **numeric option value**, because the option set of `mwf_contracttype` is local (script). Trade-off: no label sync; a new Contract Type option needs a new counter row, and a Create of that type fails with a clear message until it is seeded.

| Column | Type | Notes |
|---|---|---|
| `mwf_name` | text (primary) | the type label, for people only |
| `mwf_contracttypevalue` | Whole Number, required, min 0 | the `mwf_contracttype` option value. **Alternate key** `mwf_ContractNumberCounterKey` (Active, script) |
| `mwf_prefix` | text, required, max 10 | `MNT`, `PRC`, `INS`, `SAL`, `SRV` |
| `mwf_lastnumber` | Whole Number, required, min 0 | the last issued number |
| `mwf_lockstamp` | text, max 50, optional | the pre-lock placeholder: **a new GUID on every write** |

- **Why the stamp is a GUID text, not a date:** the pre-lock write must CHANGE a value every time. An identical write may not take the exclusive lock (not verified), and a Date and Time column has about one second of resolution, so two writes could be identical. The first version of the column was Date and Time; it was deleted and recreated as text (the table had no data in it, script).
- Prefix in the row (not in code): a prefix change is data, not a deployment. Trade-off: an administrator can edit it.

### Plug-in 3 `GenerateContractNumberOnCreate` (assembly 1.0.3.0 at first; 1.0.4.0 since 2026-10-18, plug-in 3 itself unchanged)

Registered: Create of `mwf_contract`, **PreOperation (20)**, synchronous, **rank 10** (plug-in 1 has rank 1), no filtering, no image (script, read back). PreOperation runs inside the database transaction (from Learn). It uses `IOrganizationService` only (no Web API), under the **system user** (`CreateOrganizationService(null)`), so no user needs a privilege on the counter table.

1. If the Target already holds a non-empty number (only possible if the guard step is bypassed on purpose) or has no type, it does nothing (the guard rejects both at PreValidation). It never overwrites a number the caller chose.
2. **Find** the counter row of the type by its alternate key attribute. Only the **id** is read (`ColumnSet(false)`), so no counter value exists before the lock.
3. **Pre-lock:** update `mwf_lockstamp` with a **fresh GUID** (a different value every time). This is the first write and takes the exclusive lock.
4. **Fresh read:** `Retrieve` the counter row (prefix, last number) **after** the lock.
5. `next = last + 1`; the prefix is validated (not empty, no whitespace, none of the restricted characters) **before** anything is written; **write** `mwf_lastnumber = next`.
6. Write `PREFIX-` plus `next` padded to at least 4 digits (`MNT-0007`, `MNT-12345`) into the Target.

It throws only for counter problems: no counter row, more than one row, a null or negative last number, an empty or illegal prefix, an overflow (all (unit)).

### The guard (ADR-004), changed

| Column | Create | Update |
|---|---|---|
| `mwf_contractnumber` | any non-empty value rejected with "Contract Number is generated by the system; leave it empty." (empty string and null count as not supplied) | any change rejected, in every status including Draft ("system-written") |
| `mwf_contracttype` | **required** (absent or null rejected: "Contract Type is required. The contract number is built from it.") | any change rejected, in every status including Draft ("set once", message "Delete the Draft contract and create a new one...") |

A third column category `SetOnce` was added to `LockedColumnsPolicy`, next to "locked after Draft" and "system-written". The Update step already listed both columns in its filtering attributes and PreImage (source), so the registration did not change.

## Results

### Unit tests (unit)

295 tests, 0 failed (`dotnet test`). They cover: the matrix of all guarded columns x 4 statuses x 4 kinds of write (128 cells), the number and type rules above (create with number, empty number, missing type, change in every status, same-value no-op, legacy number), the generator order `find, lock, read, write`, consecutive numbers, independent counters, a **fresh stamp every time and never the stored value**, the counter read after the lock (not before), missing counter row, bad prefixes, negative and overflow, and the format (4 digits, growth beyond 9999).

### Server tests: `scripts/test-contract-number.mjs` (script, flow OFF, Draft creates only)

| # | Test | Result |
|---|---|---|
| T1 | 3 sequential creates of one type | `MNT-0001`, `MNT-0002`, `MNT-0003`; counter 3: PASS |
| T2 | one create of each other type | `PRC-0001`, `INS-0001`, `SAL-0001`, `SRV-0001`; the Maintenance counter did not move: PASS |
| T3 | **20 parallel creates, same type, 3 rounds in a row** | 20/20 created in each round, 0 errors, unique and consecutive (ranges 4..23, 24..43, 44..63), 1.5 to 2.2 s per round: PASS x3 |
| T3m | 20 parallel creates, 10 of each of two types mixed | 0 errors, unique and consecutive per type (MNT 64..73, PRC 2..11): PASS |
| T4 | client-supplied number on Create | HTTP 400 ("Contract Number cannot be changed. It is generated by the system when the contract is created."), no row, counters unchanged: PASS. An empty-string number: HTTP 201 and a number generated: PASS |
| T5 | Contract Number change on a Draft | HTTP 400, number unchanged: PASS |
| T6 | Contract Type change on a Draft | HTTP 400, type and number unchanged: PASS. Another column of the Draft can still be edited (HTTP 204): PASS |
| T7 | Create without a Contract Type | HTTP 400 ("Contract Type is required..."), no row, counters unchanged: PASS |
| T8 | duplicate number, **after the plug-in ran** | the counter was set back by one so the generator issued an existing number: HTTP 412 ("Entity Key Contract Number Key violated..."): PASS |
| T8b | **rollback** | the counter was **unchanged** after the failed create: PASS. So the counter update rolled back with the failed create (script) |

- No duplicate, no deadlock and no 5xx appeared in the parallel runs (script).
- The rollback is shown for a failure at the insert, after the plug-in ran (alternate key). Other failure points after PreOperation were not exercised separately. (not tested)
- **Incident:** in the single run, the connection to the environment dropped (`fetch failed`, a network fault of the machine, other sites were also unreachable for a while) after T8 had passed, during the cleanup. The tests were **not** re-run. The script's `--mode=cleanup` removed the 8 remaining rows and the counterparty and restored the counters by the same rule (counter == snapshot + consumed, with the counts known from the printed numbers). Final state (script): 0 TEST-TMP contracts, 0 counterparties, 11 contracts; counters MNT, PRC, INS, SAL, SRV all 0 (as before the run).

### Registration (script)

Package `mwf_muwafaqaplugins` version 1.0.0 (unchanged), assembly 1.0.3.0, three plug-in types, six steps, all Enabled and solution components. Package SHA-256 `591e13160403fdb615a8c1b81ec3aa29bb4a175375555793433a5e934db2492d`; assembly DLL SHA-256 `b3953a6f7c819f5601248f556e28d6ae611f416ef6e00a1050733de16e8206c5`. The one failing line of the read-back is the known guard PreImage deviation (9 columns, ADR-005, owner decision).

### Security roles on the counter table (script)

Only managed platform roles hold privileges on the table: System Administrator (6), System Customizer (6), Service Writer (5), Service Reader (1), Service Deleter (1). **No project role exists and none was added.** These platform roles cannot be edited (managed).

**Decision (owner, option 1):** accepted. A System Customizer can already change metadata and plug-ins, so the counter table adds no new class of risk; the last safety net against a wrong counter is the alternate key on the contract number (HTTP 412). **Rule:** no project role may be granted a privilege on `mwf_contractnumbercounter`. Whether any real user holds Service Reader, Writer or Deleter was **not checked**. (not tested)

## Manual test in the app (owner, model-driven app UI)

Done by the owner by hand after commit `cb08234`; I did not see the screens. The owner's report:

- (a) A new Maintenance contract saved with an empty Contract Number received **`MNT-0001`**. (owner)
- (b) Changing the Contract Type after saving was rejected with a Business Process Error. (owner)
- (c) A manual number (`XYZ-9999`) on a new contract was rejected and no record was created. (owner)
- (d) **Save after create (owner, second UI test):** a new Maintenance contract with an empty number was saved, then the **Subject** was edited and saved (second save), then a **Value** edit and a third save were attempted. **The Subject edit and the second save succeeded (owner's screenshot; I did not see the screens). The Value edit in a third save: not confirmed from the screenshots.** (Corrected on 2026-10-19: the first wording said that both later saves succeeded.) The contract was then deleted by the owner. Read-only check by script afterwards: no contract with a generated number, 0 TEST-TMP, 0 temporary counterparties, 11 contracts; the Maintenance counter held 1 and was set to 0 by a one-time script outside the project (one manual contract, deleted = 1); the helper's rule is unchanged. Counters 0/0/0/0/0 and the 11 legacy contracts' latest `modifiedon` unchanged (script).
- The test contracts were deleted by the owner afterwards. Read-only check by script: no contract with those names, no contract with a generated number, 11 contracts in total; the Maintenance counter held 1 and was reset to 0 with the helper's rule (counter == snapshot + consumed) (script).
- **Not tested:** an ordinary user without privileges on the counter table creating a contract (including the saves after create); the flow's behaviour with generated numbers; editing the **Subject** of a contract that is **Pending Approval**.

## Solution source (`src/`, synced 2026-10-18)

- `pac solution sync` then `node scripts/scrub-emails.mjs` (script). New: `Entities/mwf_ContractNumberCounter/` (table, its alternate key on `mwf_contracttypevalue`, the five columns, default forms and views generated by the platform), one new step file (plug-in 3: Create, PreOperation 20, rank 10), root components for the table, the sixth step and assembly 1.0.3.0.
- **The state of the alternate key (Active) and the five counter rows do not travel with the solution.** The exported XML defines the key but does not carry its index status; Active was read from the environment (script, 2026-10-13). The five counter rows are data, not solution components. Both are created **per environment by script** (`scripts/create-contractnumbercounter-table.mjs`, idempotent: it creates the key, waits for the index to become Active, and seeds the rows). `mwf_Contract/Entity.xml` did not change (the number and type columns are as before; the set-once and system-written rules live in the guard plug-in, not in the metadata).
- **No data rows** are in `src/` (seed rows are created by `scripts/create-contractnumbercounter-table.mjs` per environment) (script: no seed value found).
- `pac solution pack` of `src/` completed. **An import of the solution was not tested** (nothing was imported, neither into this nor into another environment). Known warning: root component `PluginAssembly` "not defined in customizations" (not tested for import). The plug-in package file stays out of git (`*.nupkg`, ADR-006 / registration log).

## Failure and rollback

| Situation | Behaviour |
|---|---|
| Failure after the counter update, inside the same transaction | The platform rolls back the contract **and** the counter update (from Learn; **shown for the alternate key failure**, script T8b) |
| No counter row for the type | The create is rejected with a clear message (unit); not auto-created (two creates racing to create the row would need their own lock) |
| Empty or illegal prefix, null, negative or maximum last number | Rejected before anything is written (unit) |
| Lock wait under heavy load | Creates of the same type queue. 20 in parallel finished in about 2 s with no error (script). Larger volumes (not tested) |

## Gaps

Numbers are consecutive per type except where a Draft that already got a number is deleted (the counter is never decremented). Rollbacks leave no gap (script). Test runs leave gaps unless the helper restores the counter; the helper only restores when it is safe.

## Test helper

`scripts/lib/counter-snapshot.mjs` (`snapshotCounters`, `readCounters`, `restoreCounters`): snapshot before, restore after the cleanup only if counter == snapshot + consumed; otherwise refuse and print counts. It is used by `scripts/test-contract-number.mjs` and `scripts/verification-api-tests.mjs`. Since 2026-10-18 it is also wired into the seven older test scripts (see "Update 2026-10-18").

## What changed in the scripts (edited mechanically, **not re-run** unless stated)

All stop sending a contract number and find rows by Subject (`mwf_name`):

- `scripts/verification-api-tests.mjs`: re-run after the change for `same-status-save` and `value-zero` (script: counters restored); the other modes were edited but not re-run. `key-tests` is **obsolete** and stops with a note (a client can no longer choose a number); the duplicate-number rejection is covered by T8 above.
- `scripts/test-state-guard.mjs`: the Contract Type and Contract Number rows of its locked-columns matrix were removed (they are tested by `test-contract-number.mjs`); the two observation cases on a number now state that a rejection is expected.
- `scripts/test-usd-freeze.mjs`, `scripts/test-approval-round.mjs`, `scripts/test-flow-approvalround.mjs`, `scripts/test-flow-checkpoints.mjs`, `scripts/test-flow-trigger.mjs`, `scripts/test-guard-flow.mjs`: numbers removed from the create bodies, lookups by number replaced by lookups by Subject. (not re-run; syntax checked only)
- `scripts/load-test-data.mjs` and `data/contracts.csv`: the CSV has no number column any more; contracts are keyed by Subject; the summary prints the generated number as a **pattern** (digits shown as 9). **Not run against the environment** (owner decision).

## ALM

Counter rows are seeded **by script per environment** (`scripts/create-contractnumbercounter-table.mjs`, idempotent). Counter rows are data, not solution components, so a solution import does not carry them. The native autonumber seed has the same per-environment limitation. The alternate key's Active state and the five counter rows are **not** carried by the solution; both are created by the script in each environment. **An import of the solution (including this table) was not tested.** A new environment needs the table (in the solution), the active key and the seed before the first contract is created, otherwise Create fails with the "counters must be seeded" message. The counter table itself is in the solution source `src/` (synced 2026-10-18); the seed rows are not.

## Consequences

- One new table, one new plug-in, one new guard category, assembly 1.0.4.0 (1.0.3.0 until 2026-10-18).
- Every Create of a contract takes an exclusive lock on one counter row until its transaction ends; creates of the same type queue (from Learn; 20 parallel measured, script).
- The Contract Number can no longer be typed in forms or loaded from a file. Legacy rows keep their `TEST-CT-NNNN` numbers; a typo in a legacy number needs the bypass of the guard Update step (administrator action).
- A wrong Contract Type means deleting the Draft and creating a new one. The deleted Draft's number is a gap.

## Open items

1. ~~Rejection text on Create~~ **Closed 2026-10-18** (see "Update 2026-10-18").
2. **Form:** the Contract Number field must become read-only on the form (owner click-work). (not done)
3. **Not tested:** a normal user (without privileges on the counter table) creating a contract; the flow's behaviour with generated numbers; other failure points after PreOperation; volumes beyond 20 parallel creates; an import of a solution containing the table into a clean environment.
4. **Older test scripts:** the counter helper is wired into all seven, but only `test-approval-round.mjs` was (partly) run, interrupted by a network fault; the other six are not tested after the edit (see "Update 2026-10-18").
5. **Business:** the format sorts badly as text beyond 9999 (`MNT-10000` sorts before `MNT-9999`); accepted by the owner's "grows beyond".

## Update 2026-10-18: clearer Create message, counter helper in every test script

### A. Create-time message (assembly 1.0.4.0)

- **Change:** on **Create**, a non-empty Contract Number from the client is now rejected with **"Contract Number is generated by the system; leave it empty."** On **Update** the text is unchanged ("Contract Number cannot be changed. It is generated by the system when the contract is created."). The frozen USD value and the approval round keep their text. Only `LockedColumnsPolicy` changed; plug-in 3 did not.
- **Unit tests:** 296 passed, 0 failed (unit). New: the exact Create text, and the frozen/round texts are unchanged.
- **Build and registration (script):** `dotnet build -c Release`; package SHA-256 `a31d42297fdac6219c7b47f291663f87280f287610e37f8ddfcdc1734df234d5`, assembly DLL SHA-256 `884750d9f941bf736d974b051d42a2e5b2920a2b5a611eb3d681a8d09ce0f615`. `register-plugin-package.mjs --mode=package-update` (package version stays 1.0.0): assembly **1.0.4.0**, three plug-in types present. Read-back of the six steps: all Enabled, solution components; the only failing line is the known guard PreImage deviation (9 columns, ADR-005). The first `package-update` attempt failed with `fetch failed` before anything was sent (a network fault of the machine); the second attempt ran once and passed.
- **Server re-run of T4 and T5** (`test-contract-number.mjs --only=T4,T5`, flow OFF) (script): T4 PASS with the new Create text (HTTP 400) and no "cannot be changed"; T4b PASS (empty string accepted, a number generated); T5 PASS with the unchanged Update text (HTTP 400); T6 and T6b PASS (they share the T5 block). Counters were 0/0/0/0/0 before and after (MNT restored 2 to 0 by the helper's rule). Final: 0 TEST-TMP contracts, 0 counterparties, 11 contracts.
- The open item "improve the rejection text" is **closed**.
- **`src/` is now behind the environment:** `Solution.xml` still names assembly 1.0.3.0 (the environment has 1.0.4.0). A new sync is needed (not done; separate task).

### B. Regression pass of the seven converted scripts

**Review of the automated conversion** (looking for anything that still assumes a fixed number): the lookups by number had all become lookups by Subject, but four leftovers remained and were removed: unused `num` variables and the `number:` argument for the UI rows in `test-state-guard.mjs`; the label "Contract Number set" in `test-usd-freeze.mjs`; the `NUMBER` constant (only in a warning text) in `test-flow-approvalround.mjs`. Scripts that still print `mwf_contractnumber` only display the generated number.

**Counter helper wired into all seven** (`scripts/lib/counter-snapshot.mjs`): `trackCreate` (one line in each script's `call()`, counts committed contract creates per contract type), `snapshotCounters` at the start of a run, and the restore after the cleanup **only if counter == snapshot + consumed**, otherwise it stops and prints the numbers (exit code 6). New safety in the helper: it never restores below a number that still exists on a contract. Scripts that leave rows for a later step print `--counters-before=... --counters-consumed=...` (`printHandoff`) and their cleanup step restores from those two arguments (`restoreFromArgs`).

| Script | Needs the flow | Counter wiring | Run now |
|---|---|---|---|
| `test-approval-round.mjs` | OFF | one process: snapshot, restore after the cleanup | first attempt interrupted by a network fault; second attempt complete: 9 PASS, 0 FAIL, 3 observations (section C) |
| `test-usd-freeze.mjs` | OFF for `update-cases`, `create-case`, `guard-smoke`; ON for `flow-case` | one process; `flow-case` prints the handoff, `cleanup` restores | `update-cases`, `create-case`, `guard-smoke` run, all PASS (section C); `flow-case` not run (needs the flow ON) |
| `test-state-guard.mjs` | OFF | one process; with the three UI rows it prints the handoff (restore only after `--mode=cleanup --include-ui`); with `--skip-ui-rows` it restores | run with `--skip-ui-rows`: 75 PASS, 0 FAIL, 4 observations (section C) |
| `test-flow-approvalround.mjs` | ON | `setup` prints the handoff, `cleanup` restores from the arguments | not run (needs the flow ON, owner) |
| `test-flow-checkpoints.mjs` | ON | same | not run (needs the flow ON, owner) |
| `test-flow-trigger.mjs` | ON | one process | not run (needs the flow ON, owner) |
| `test-guard-flow.mjs` | ON (not checked in code) | `part1` prints the handoff, `part2` restores from the arguments | not run (needs the flow ON and manual approvals, owner) |

Edited, syntax-checked and (for `test-approval-round.mjs`) partly run. The other six: **(not tested)** after the edit.

**Run of `test-approval-round.mjs`** (script, flow OFF, counters 0/0/0/0/0, 0 TEST-TMP, 11 contracts before): cases a to 7 ran, **6 PASS, 0 FAIL, 2 observations**; then the connection dropped (`fetch failed`) in the next step (case 8), and the script's own cleanup failed with the same error. Cases 8 and 9 and the final read of the guard registration did **not** run. The cause is a network fault of the machine (the environment answered slowly, 2 seconds, and an unrelated public site timed out at the same time); it is not a product result. By the rule "stop at the first unexpected failure, no re-run" the first pass was **stopped here**; the second attempt is in section C.

**Cleanup after the interruption** (script, a one-shot cleanup with the shared helper, outside the repository): 2 contracts and 1 counterparty deleted; the Maintenance counter 2 restored to 0 (counter == snapshot + consumed). Final: 0 TEST-TMP contracts, 0 counterparties, 11 contracts, counters 0/0/0/0/0, and the 11 legacy rows (TEST-CT) unchanged (latest `modifiedon` still 2026-10-07).

**Open:** the four scripts that need the flow ON, when the owner turns the flow on. The flow-OFF scripts were run again in section C.

### C. Regression run of the flow-OFF scripts (2026-10-18, second attempt, flow OFF)

**Connection check added first** (`requireStableConnection` in `scripts/lib/counter-snapshot.mjs`, called at the start of the seven scripts, `test-contract-number.mjs` and `verification-api-tests.mjs`): three GET requests in a row must succeed before any write, otherwise the script stops with a clear message and has written nothing. Only these read requests are retried (up to 8 attempts, 2 s apart); **no write is ever retried**. In every run below the check passed at the first three attempts. (script)

Before every script and after its cleanup (script): flow OFF; 0 TEST-TMP contracts, 0 temporary counterparties, 11 contracts; counters MNT, PRC, INS, SAL, SRV all 0; the 11 legacy contracts (the `TEST-CT` series, including the last two) unchanged: the latest `modifiedon` among them stayed 2026-10-07T17:23:48Z.

| Script and mode | Result (script) | Counter consumed, then restored to 0 |
|---|---|---|
| `test-approval-round.mjs` (all cases) | **9 PASS, 0 FAIL, 3 observations**, including cases 8 and 9 and the read of the guard registration (filtering 10 columns, PreImage 9, as documented) | MNT 3 |
| `test-usd-freeze.mjs --mode=update-cases` | **10 PASS, 0 FAIL** (cases 1, 2, 4, 5, 6, 6b, 6c, 7, 8, 10) | MNT 10 |
| `test-usd-freeze.mjs --mode=create-case` | **1 PASS** (case 3, an observation case with no fixed expectation, see below) | MNT 1 |
| `test-usd-freeze.mjs --mode=guard-smoke` | **5 PASS, 0 FAIL** | MNT 1 |
| `test-state-guard.mjs --mode=integration --skip-ui-rows` | **75 PASS, 0 FAIL, 4 observations**: transitions 17, create 6, locked columns 36, combined requests 3, delete 5, plug-in 1 regression 7, bypass 1 (the bypass of the guard Delete step alone works) | MNT 18 |

For each script the helper's rule held (counter == snapshot + consumed), so the restore ran and was never refused. All rows were deleted by the scripts' own cleanup.

**What the observations are** (an observation is a case whose result is reported but has no pass/fail expectation, or whose expectation is known not to hold; none of them is a failure):

- `test-approval-round` **[a]**: a new Draft row has `mwf_approvalround` = **null**, not 0. A Whole Number column has no default value (ADR-005); plug-in 1 treats null as 0. The case only records the value, so it is neither PASS nor FAIL.
- `test-approval-round` **[6]**: a client sends `mwf_approvalround` equal to the stored value (2) on Update. The design said "exactly like the frozen value", where an equal value is a no-op. Observed: **HTTP 400** ("Approval Round cannot be changed..."), row unchanged. The cause is the known guard deviation (ADR-005): the PreImage has 9 columns without the round, so an equal non-null value reads as a change and is rejected (fail closed). It is not PASS because the stated ideal (no-op) does not hold, and not FAIL because the owner decided to keep the 9-column PreImage.
- `test-approval-round` **[9]**: Create directly as Pending Approval through the API. Observed: round 1, frozen value 1000.00, status Pending (as intended). It is an observation case; nothing is claimed about flow runs (the flow is OFF). This case did not run in the interrupted first attempt.
- `test-usd-freeze` **case 3** (create-case): a contract created directly as Pending Approval with no currency got the base currency TRY from the platform, and the frozen value was computed from it (20.41 for Value 1000). The case has no fixed expectation by design.
- `test-state-guard` **[1 transitions]**: Rejected to Draft with `{statecode 0}` alone (what the Activate button may send) is allowed (HTTP 204) and the row becomes Draft.
- `test-state-guard` **[2 create]**: Create with `{statecode 1}` and no status. The case expected a rejection ("the guard reads state 1 as Rejected"); observed **HTTP 204 and a Draft row**: the platform ignores `statecode` on Create, so the guard never sees it.
- `test-state-guard` **[7 observations] x2**: `PATCH mwf_contractnumber ""` is rejected (HTTP 400, the Update text) on a Pending row and on a Draft row, as expected since ADR-006 (the number is system-written). The case labels still said "contract number null" although every row now has a generated number; the labels were corrected after the run (text only).

**Not run, so not tested:** the four scripts that need the flow ON (`test-flow-approvalround`, `test-flow-checkpoints`, `test-flow-trigger`, `test-guard-flow`) and `test-usd-freeze.mjs --mode=flow-case`; the three UI rows of `test-state-guard` (`--skip-ui-rows` was used on purpose, they would keep numbers); the handoff/restore path (`printHandoff`, `restoreFromArgs`) in a real two-step run; `verification-api-tests.mjs` modes `t1` to `t4` after the edit.

**Open:** `src/` still names assembly 1.0.3.0 (the environment has 1.0.4.0): a new sync is needed (separate task).

### D. Approval round made system-only (2026-10-18, assembly 1.0.5.0)

The PreImage deviation noted above (9 columns, 0x80040216) was closed **as a design decision**: the guard now rejects any client write of `mwf_approvalround` whatever the value, without reading the PreImage (ADR-005). Assembly 1.0.5.0 is registered (package SHA-256 `1702ddf1023f2756a303c77daec015b992e79847454dea78d1c59596c806abbd`); the registration read-back now expects filtering 10 / PreImage 9 and passes (script: 15 passed, 0 failed). `test-approval-round` (flow OFF): 12 PASS, 0 FAIL, 2 observations; `test-contract-number --only=T4,T5`: PASS, so the generator is not affected. Test scripts now use one prefix each, none a prefix of another (see `docs/plugin-registration-log.md`). The plan for the flow-ON session is `docs/flow-on-session-plan.md`.

### E. Counter incident: interference of a manual UI contract (2026-10-18)

While `test-state-guard` was running, the owner created a test contract (`www`) in the model-driven app. It took `MNT-0002` from the same counter, so the helper's rule (counter == snapshot + consumed) failed (19 against 0 + 18) and it **refused to restore the counter**, as designed. The contract was deleted by the owner; the counter was then set to 0 by a one-time script after read-only checks of every condition (no generated-number contract, 0 TEST-TMP, 11 contracts). The helper was not changed. **Rule:** no activity from the user interface while any test script runs (they share the counter). The same rule is in `docs/flow-on-session-plan.md`. Results of the `test-usd-freeze` (10 + 1 + 5 PASS) and `test-state-guard` (75 PASS, 0 FAIL, 4 observations) re-runs are in `docs/plugin-registration-log.md`.
