# Plug-in registration log: mwf_muwafaqaplugins

Records what was built and what happened at each registration attempt. No secrets, no environment ids.

## Build identity

| Item | Value |
|---|---|
| Source commit | `78114c5b653a54e6dbb28e560cf499f43661bf1c` (feat(plugins): freeze USD value on contract submission) |
| Tree state when built | Clean (`git status` empty for `plugins/`) |
| Build | `dotnet build -c Release`, SDK 10.0.401, target `net48`, 0 warnings, 0 errors |
| Assembly SHA-256 | `f262c5d0c972717f54211712a10fdd06d63b061a48679e558a39a741429e7f09` (identical in two clean builds, so reproducible) |
| Package file | `mwf_muwafaqaplugins.1.0.0.nupkg`, 8,902 bytes |
| Package SHA-256 of the file uploaded in attempt 1 | `71f8cf3488fb9e2452ab7bd52db130e37183ea788c009c0e3beac56d1d61d85c` |
| Unit tests | 32 passed, 0 failed |

The package file is **not** reproducible byte for byte (two clean builds of the same commit gave different package hashes, while the assembly hash was identical). The assembly hash is the stable identity. The package hash identifies the file that was actually uploaded.

## Attempt 1 (2026-10-12): POST /pluginpackages with the solution header

Script: `scripts/register-plugin-package.mjs --mode=package` (device code sign-in, guard flags set).

Read-only preliminaries (all passed):
- solution `Muwafaqa` exists, unmanaged, count 1
- package does not exist (count 0), no assembly with Muwafaqa in the name, no step for the plug-in
- sdkmessage Create and Update: 1 each. sdkmessagefilter on `mwf_contract`: 1 each
- `mwf_valueusdfrozen`: Decimal, precision 2, required level None
- `mwf_value`: Money, MinValue 0, MaxValue 1,000,000,000, ApplicationRequired, PrecisionSource 2
- `transactioncurrencyid`: Lookup, required level None
- exactly one active USD record with a rate greater than zero
- plug-in trace log setting: 0 (Off)

Live currency rates (units per 1 TRY, placeholders): TRY 1, USD 0.020408163265, KWD 0.006666666667 (3 decimals), AED 0.076923076923, SAR 0.076923076923.

Result: **rejected, HTTP 400**, error code `0x80040265`:

> No supported target framework folder found in package. Supported dotnet frameworks are 'net471' and 'net462'. Please check uploaded package

Findings:
- The platform reads the package sent in the `content` column and validates its content. The route itself works up to that validation.
- The package built for `net48` (`lib/net48/`) is **not accepted**. Registration supports `net462` and `net471` folders only. Microsoft Learn recommends 4.8 for plug-in projects, but it also says 4.6.2 through 4.8 are supported for assemblies. The package registration check is narrower than that (this is the observed behavior, not a Learn statement).
- Nothing was created. The failure happened before any record was written (expected for a 400; to be confirmed by the next preliminary run, which must show package count 0).

Next step: not decided. See the report for the proposed change of target framework.

## Build identity after the corrective commit (net462)

| Item | Value |
|---|---|
| Source commit | `614ec2ee176618d778a76a6cef251bf57ba57b16` (fix(plugins): target net462, the only framework the package upload accepts) |
| Tree state when built | Clean (`git status` empty for `plugins/`), `bin/` and `obj/` deleted before the build |
| Build | `dotnet build -c Release`, SDK 10.0.401, target `net462`, 0 warnings, 0 errors |
| Package content | `lib/net462/Muwafaqa.Plugins.dll` (15,872 bytes) |
| Assembly SHA-256 | `d856ce2d11bc86379af03ff068730e68d50ed54946a9583342fca4309152ad5f` |
| Package file | `mwf_muwafaqaplugins.1.0.0.nupkg`, 8,896 bytes |
| Package SHA-256 (file uploaded in attempt 2) | `975a7a7ddc4d17a4e961e8a0a8e34495b332cc3a69678ff0ac49b651475ee40b` |
| Unit tests | 32 passed, 0 failed (test project also on net462) |
| Staged-file scan before the commit | emails 0, tokens 0, local identity 0, GUIDs in added lines 0 (the 2 GUIDs in the staged csproj are the Visual Studio ProjectTypeGuids, unchanged lines) |

## Attempt 2 (2026-10-12): package created, net462

Script: `scripts/register-plugin-package.mjs --mode=package` (device code sign-in, guard flags set). Package file SHA-256 as listed above.

Result: **13 passed, 0 failed.**
- preliminaries: all passed (same as attempt 1; the package count was 0, which confirms that the 400 of attempt 1 created nothing)
- `POST /pluginpackages` accepted with the `MSCRM.SolutionUniqueName` header
- plug-in assembly created from the package automatically: count 1, name `Muwafaqa.Plugins`, version 1.0.0.0, isolation mode 2 (sandbox)
- plug-in type created automatically: `Muwafaqa.Plugins.Contract.FreezeUsdValueOnSubmission` (the script's fallback to create the type was not needed)
- package is a component of the solution Muwafaqa (component type 10041). The assembly is also a solution component (component type 91)

## Phase 1 of steps (2026-10-12): Update step and PreImage

Script: `scripts/register-plugin-package.mjs --mode=steps-update` (device code sign-in, guard flags set).

Result: **5 passed, 0 failed.**
- Update step on `mwf_contract` accepted with the solution header; read back: stage 20 (PreOperation), mode 0 (synchronous), rank 1, deployment Server only, filtering attributes `statuscode`, **state Enabled**
- PreImage read back: count 1, alias `pre`, image type PreImage, message property `Target`, attributes `statuscode`, `mwf_value`, `transactioncurrencyid`
- the step is a component of the solution (component type 92)

Not run yet: integration cases, Create step. Waiting for the confirmation that the approval flow is OFF.

## Integration tests: Update path (2026-10-12, approval flow OFF)

Script: `scripts/test-usd-freeze.mjs --mode=update-cases`. Rates used (live, placeholders): USD 0.020408163265, KWD 0.006666666667, AED 0.076923076923, TRY 1. TEST-TMP-USD rows only. Result: **10 passed, 0 failed.** Cleanup removed 11 rows, check-clean: 0 TEST-TMP rows, total contracts 11 before and after.

| Case | Input | Expected | Actual |
|---|---|---|---|
| 1 | USD Draft 500, one PATCH {Value 1000, status Pending} | 1000.00 (new Value) | 1000.00 |
| 2 | AED 367250, Rejected, PATCH {statecode 0, statuscode Pending} | success, 97433.67 | HTTP 204, 97433.67 |
| 4 | TRY (base) 49000 | 1000.00 | 1000.00 |
| 5 | USD 1000 | 1000.00 | 1000.00 |
| 6 | KWD 6500.255 | 19898.74 | 19898.74 |
| 6b | KWD 750.125 | 2296.30 | 2296.30 |
| 6c | AED 367250 | 97433.67 | 97433.67 |
| 7 | USD 1000, Pending, Draft, edit Value 2500, Pending | 1000.00, kept in Draft, then 2500.00 | 1000.00, 1000.00 (Draft), 1000.00 (after edit), 2500.00 |
| 8 | USD 1000 Pending, edit Value 3000, same-status save | 1000.00 stays | 1000.00, 1000.00, 1000.00 |
| 10 | Draft without Value, PATCH Pending | HTTP 400 "no Value", status Draft, frozen null | HTTP 400 "Cannot submit the contract. The contract has no Value, so its USD value cannot be frozen.", status Draft, frozen null |

Answers to the open questions:
- **Case 1:** the PreImage in the status pass reflected the Value edited in the same request, and the column written in the status pass was persisted.
- **Case 2:** a PATCH with statecode and statuscode together from Rejected to Pending is accepted and the Update step ran.
- **Case 7:** the value is kept after the contract returns to Draft and after a Value edit in Draft, and is recomputed on re-entry.
- **Case 8:** neither a Value edit while Pending nor a same-status save changes the frozen value.
- **Case 10:** the value 0 is not tested here. A negative Value cannot be created (column MinValue is 0).

## Phase 2: Create step (2026-10-12)

Script: `scripts/register-plugin-package.mjs --mode=steps-create`. The first run was interrupted before sign-in and created nothing. The second run: **4 passed, 0 failed.** Create step on `mwf_contract`: stage 20, synchronous, rank 1, no filtering attributes, no image, **Enabled**, a component of the solution (type 92).

## Integration test: case 3 (2026-10-12, approval flow OFF)

Script: `scripts/test-usd-freeze.mjs --mode=create-case`.

| Input | Observation |
|---|---|
| POST a contract with statuscode Pending Approval, Value 1000, **no** `transactioncurrencyid` | HTTP 204. The status Pending Approval was accepted on create. The currency was filled with **TRY** (the base currency) before the plug-in ran. `mwf_valueusdfrozen` = **20.41** (1000 TRY x 0.020408163265 = 20.408163, rounded) |

Cleanup removed 2 rows, check-clean: 0 TEST-TMP rows, total contracts 11.

## Integration test: case 9, the existing approval flow (2026-10-12, approval flow ON)

Script: `scripts/test-usd-freeze.mjs --mode=flow-case`, then `--mode=cleanup`. One TEST-TMP row, kept until the owner had checked the flow run.

| Step | Observation |
|---|---|
| Create, Draft, USD 1000 | `mwf_valueusdfrozen` empty |
| PATCH to Pending Approval, flow ON | status 867640000, `mwf_valueusdfrozen` **1000.00** |
| Flow run | Checked by the **owner** (not read by the script): the run started for the row and the stage 1 approval request arrived. The owner **rejected** it |
| Read after the rejection | state 1 (Inactive), status 2 (Rejected), `mwf_valueusdfrozen` **1000.00** (unchanged by the rejection, as designed) |

Run history (source: the owner's run-history screenshot, not the script): exactly **one** flow run for `TEST-TMP-USD C9-FLOW`, started at 07:44 PM, with no duplicate run.

Cleanup: contract deleted first, then the TEST-TMP counterparty (2 rows). check-clean: 0 TEST-TMP rows, total contracts 11.

Effect on the approval flow runs: every entry into Pending Approval starts one run, as before. The plug-in does not change the number of runs. A rejected request leaves the frozen value in place.

## Notes from the results

- **Case 3.** A contract created directly as Pending Approval without a currency gets the default currency **TRY** (the base currency) filled by the platform **before** the plug-in runs, so the USD value is computed as a TRY contract (Value 1000 gave 20.41). The plug-in does not fail with "no currency" in this case.
- **Case 8.** Editing Value while the contract is Pending Approval leaves the frozen USD value unchanged, so the Value and the frozen USD value can differ while the contract is Pending. Blocking that edit is the next plug-in, "prevent edit of a contract in Pending/In Force" (not started).
- **Case 7.** The frozen value is kept when the contract returns to Draft, so it is authoritative only while the contract is Pending Approval or In Force.

## Status

All integration cases passed: Update path 10 of 10, case 3 (Create), case 9 (flow). Nothing is open for the plug-in itself.

## Phase A, guard release (2026-10-12): package update, three guard steps, smoke test

### Build identity

| Item | Value |
|---|---|
| Source commit | `203aac7cd6c6e5adfca1854df973877f0d68baa5` (chore(plugins): bump assembly version to 1.0.1.0), on top of the guard commit `672566db73f6e0791c0617532fa79ad0447f7dd0` |
| Version | AssemblyVersion and FileVersion 1.0.1.0. PackageId `mwf_muwafaqaplugins` and package Version 1.0.0 unchanged |
| Build | Clean Release, `net462`, 0 warnings, 0 errors. Tests: 233 passed, 0 failed |
| Assembly SHA-256 | `147ad2fe9a794a329c3ba5e366a233bb5519a3e32e81d93a31c74f4ad2092f0a` |
| Package SHA-256 (the file uploaded), 13,231 bytes | `600da03d4cbc9aeaa4b244af4b0b8044ec7f80bc2ae183f2f5a543f3cd957031` |

### Package update (`register-plugin-package.mjs --mode=phase-a`, device code, guard flags set)

Result: **18 passed, 0 failed.**
- `PATCH /pluginpackages(<id>)` with the new content only (no name, no version): accepted. `pac plugin push` was not used.
- Package after the update: name and unique name `mwf_muwafaqaplugins`, version `1.0.0` (unchanged).
- Assembly after the update: `Muwafaqa.Plugins`, version **1.0.1.0** (was 1.0.0.0). The same assembly row was updated (one assembly in the package).
- Plug-in types in the assembly: `Muwafaqa.Plugins.Contract.FreezeUsdValueOnSubmission` and `Muwafaqa.Plugins.Contract.ContractStateGuard`.
- The two plug-in 1 steps (Update, Create) are still **Enabled**, stage 20, and point to the type of the assembly.

### Guard steps (all on `mwf_contract`, PreValidation, synchronous, rank 1, deployment Server only, solution header set)

| Step | Stage | Mode | Rank | State | Filtering attributes | Image | In solution |
|---|---|---|---|---|---|---|---|
| ContractStateGuard: Update | 10 | 0 (sync) | 1 | Enabled | 9 columns: `statuscode, statecode, mwf_value, transactioncurrencyid, mwf_contracttype, mwf_direction, mwf_counterpartyid, mwf_contractnumber, mwf_valueusdfrozen` | `pre`, PreImage, Target, the same 9 columns | yes |
| ContractStateGuard: Create | 10 | 0 (sync) | 1 | Enabled | none | none | yes |
| ContractStateGuard: Delete | 10 | 0 (sync) | 1 | Enabled | not applicable | `pre`, PreImage, Target, `statuscode` only | yes |

All three read back as expected and point to the `ContractStateGuard` type.

### Smoke test (`test-usd-freeze.mjs --mode=guard-smoke`), no Pending and no In Force row

Result: **5 passed, 0 failed.** Cleanup removed 1 row (the TEST-TMP counterparty). check-clean: 0 TEST-TMP rows, total contracts 11.

| Step | Request | HTTP | Observation |
|---|---|---|---|
| a | POST a Draft (USD, Value 1000, Contract Number set) | 204 | Create step ran without error |
| b | PATCH {statuscode: In Force} on the Draft | **400** | "Cannot change the contract status from Draft to In Force. Allowed next status: Pending Approval." The row stayed Draft (status 1) |
| c | PATCH {mwf_name} only | 204 | Subject is editable |
| d | PATCH {mwf_value: 2000} on the Draft | 204 | Value read back 2000 (Draft is editable) |
| e | DELETE the Draft | 204 | The row is gone (GET returned 404). The Delete step with the PreImage ran without error |

### Not tested in this phase

Everything that needs a Pending or In Force row (locked columns, Pending delete, the transitions from Pending), the Activate and Deactivate buttons (SetState path), the empty string against null, and the bypass by step id. The guard is **live** (all three steps Enabled) in the environment.

### Rollback

`register-plugin-package.mjs --mode=steps-disable` disables only the three ContractStateGuard steps (PATCH of the step state) and `--mode=steps-enable` enables them again. Plug-in 1 steps are not touched.

## Phase B, guard release (2026-10-12): full integration tests of the Contract State Guard

Script: `scripts/test-state-guard.mjs --mode=integration` (device code sign-in, guard flags set). The approval flow was OFF. All rows had the prefix `TEST-TMP-GUARD`, with two fictional counterparties. After every rejected PATCH the row was read back and compared with its state before the request.

**Result: 89 PASS, 0 FAIL, 7 observations.**

| Group | PASS | FAIL | OBS | What it covers |
|---|---|---|---|---|
| 1 transitions | 17 | 0 | 1 | Every allowed and every rejected status change by PATCH, same-status save, state-only requests |
| 2 create | 6 | 0 | 1 | Draft, Pending (frozen value written by plug-in 1), In Force and Rejected rejected, non-null frozen column rejected |
| 3 locked columns | 50 | 0 | 0 | 6 columns x Pending, In Force, Rejected (different value 400 and unchanged, identical value 204), frozen column, Subject; Draft editable |
| 4 combined requests | 3 | 0 | 0 | One PATCH {Value, Pending} from Draft allowed with the new frozen value; one PATCH {Value, Draft} from Pending rejected, row unchanged |
| 5 delete | 5 | 0 | 0 | Draft and Rejected deleted; Pending and In Force rejected and the row still exists; Pending withdrawn to Draft then deleted |
| 6 plug-in 1 regression | 7 | 0 | 0 | Cases 1, 7, 8 and the old case 2 behind the guard |
| 7 observations | 0 | 0 | 2 | Empty string against null |
| 8 bypass | 1 | 0 | 0 | Delete of an In Force row with the bypass header |
| UI rows | 0 | 0 | 3 | Three rows left for the manual test |

### Observations

- **Activate-like request.** A Rejected row with `{statecode: 0}` alone: HTTP **204**, the row became **Draft** (statecode 0, statuscode 1). The platform applied the default status of the state and the guard allowed it (Rejected to Draft). The full form `{statecode: 0, statuscode: 1}` was also allowed on another row.
- **Create with `{statecode: 1}` and no statuscode.** HTTP **204** and the row was created as **Draft** (statecode 0, statuscode 1). The platform ignored `statecode` on create, so the guard had nothing to reject. No Rejected row can be created this way.
- **Empty string against null, Pending row with a null Contract Number.** `PATCH {mwf_contractnumber: ""}` returned HTTP **400** ("Cannot change Contract Number while the contract status is Pending Approval. Return the contract to Draft first."). The strict comparison of ADR-004 decision 2 is confirmed on the server: the guard treats `""` as a change.
- **Empty string against null, Draft row.** HTTP **204**, and the Contract Number read back as **null**: the platform stores `""` as null. So the strict rule is a harmless false positive in a locked status (a write that would not change the stored value is still rejected).
- **The platform did not block writes on Rejected rows.** Identical-value PATCH of the six columns and the Subject PATCH on a Rejected row all returned 204.

### Bypass

`DELETE` of an In Force row with the header `MSCRM.BypassBusinessLogicExecutionStepIds` set to the id of the guard Delete step: HTTP **204**, the row is gone. **The bypass works with the account used here.** The guard cannot stop a caller that sends this header, and the account has the privilege that allows it. The In Force TEST rows were deleted with it during cleanup.

### UI checks by the owner (2026-10-12, approval flow OFF)

Three fictional rows were left for the owner after the API run:

| Row (Subject) | State before | Action in the app | Result |
|---|---|---|---|
| TEST-TMP-GUARD-UI A Draft deactivate me | Draft | Deactivate | **Blocked** with "Cannot change the contract status from Draft to Rejected. Allowed next status: Pending Approval." The row stayed Draft |
| TEST-TMP-GUARD-UI B Rejected activate me | Rejected | Activate | **Succeeded**. The row is now Draft (the dialog sent Status Reason = Draft) |
| TEST-TMP-GUARD-UI C Pending edit me | Pending Approval | Edit Value and save | **Blocked** with "Cannot change Value while the contract status is Pending Approval. Return the contract to Draft first." The row stayed Pending |
| TEST-TMP-GUARD-UI C Pending edit me | Pending Approval | Delete | **Blocked** with "Cannot delete a contract whose status is Pending Approval." The row still exists. The owner closed the form without saving |

4 UI checks, no failure. They close the "SetState path" question for the Deactivate and Activate buttons: the Update step ran for Deactivate (the guard message came from it), and Activate gave Draft. No step on the SetState message is needed, at least for those two buttons.

### Cleanup of the UI rows

`test-state-guard.mjs --mode=cleanup --include-ui` (device code sign-in, guard flags set). Only rows with the prefix `TEST-TMP-GUARD`. The Pending row was withdrawn to Draft first, then deleted. Result: removed 4 (three contracts and the last fictional counterparty), none left. Remaining rows with the prefix: 0. Total contracts: **11** (the number before the guard tests).

### Not tested

- The guard with the approval flow ON, end to end (next phase).
- Assign (change of owner) and bulk messages such as `UpdateMultiple`.
- Whether the platform runs the guard once or twice for a combined request at PreValidation. The combined requests behave correctly either way.

### Risk recorded

The bypass works for the administrator account used in the tests (a DELETE of an In Force row with the step id of the guard Delete step returned 204). Only the System Administrator role holds the privilege by default. It must not be granted to any other role (ADR-004).

## Phase C: end-to-end with the approval flow ON (2026-10-12 to 2026-10-13)

Script: `scripts/test-guard-flow.mjs` (`--mode=part1`, then `--mode=part2`), device code sign-in, guard flags set. The approval flow "Muwafaqa - Contract Approval v1" was **ON**. Fictional rows only, prefix `TEST-TMP-GUARD-FLOW`.

### Setup (part 1, 2026-10-12)

- One fictional counterparty and two contracts: `TEST-TMP-GUARD-FLOW1 normal` and `TEST-TMP-GUARD-FLOW2 withdrawn`. Both Draft, USD, Value 1000, Contract Type Maintenance, Direction Expense, with distinct Contract Numbers.
- Both moved to Pending Approval by PATCH. Read back: status Pending Approval and `mwf_valueusdfrozen` **1000.00** for both. The flow started one run for each.
- FLOW2 was **withdrawn to Draft** (PATCH) while its approval was left outstanding. Read back: Draft, `mwf_valueusdfrozen` 1000.00 (kept).

### Run results (observed by the owner in the Power Automate UI, not readable by the script)

- Two runs started on 2026-10-12 at 21:21 (local time). Both stayed Running for about 19 h 57 min, waiting for approvals, and finished after the owner approved stage 1 and stage 2 on 2026-10-13.
- **One run Succeeded. The other run Failed.**
- The failed run: action `Update_a_row_3` (inside Check Stage2, True branch) failed with BadRequest and this message: "Cannot change the contract status from Draft to In Force. Allowed next status: Pending Approval."
- **The run-to-contract mapping is inferred.** The run page did not show which run belongs to which contract by name. It is inferred from the message (Draft to In Force) and from the rows read afterwards.
- Side finding: the approvals and the runs were still valid after about 20 hours of waiting (they did not expire in that time). This is what was observed, not a general statement.

### Rows read after the approvals (part 2, 2026-10-13)

| Contract | Status | State | `mwf_valueusdfrozen` | Expected |
|---|---|---|---|---|
| `TEST-TMP-GUARD-FLOW1 normal` | **In Force** | 0 | 1000.00 | In Force (the flow's write Pending to In Force is allowed) |
| `TEST-TMP-GUARD-FLOW2 withdrawn` | **Draft** | 0 | 1000.00 | Draft (the late write of In Force is rejected by the guard) |

### Cleanup

- FLOW1 (In Force) deleted with the bypass of the guard **Delete step only** (`MSCRM.BypassBusinessLogicExecutionStepIds`). **No step was disabled.** HTTP 204.
- FLOW2 (Draft) deleted, HTTP 204. The fictional counterparty deleted, HTTP 204.
- check-clean: TEST-TMP contracts **0**, TEST-TMP counterparties **0**, total contracts **11**.

### Result and what it shows

- The flow's legitimate write (Pending Approval to In Force) goes through the guard.
- The flow's late write of In Force over a withdrawn Draft is **rejected**, the row stays Draft, and that run fails. In the experiments of 2026-10-11, before the guard, the same situation overwrote the Draft.
- The frozen USD value stayed 1000.00 on both rows.

### Not proven

- **The run-to-contract mapping is inferred** (see above).
- **The guard's rejection of the flow's write is proven by the message** in the failed run, **not by the script**, which does not read the run history. The script read only the final rows.
- Nothing is known about approvals that wait longer than about 20 hours.
- The flow has no deliberate handling of the failed action (flow step 4, open).

## Script updates for the guard (2026-10-13)

The old scripts were changed so that they only use transitions the Contract State Guard allows (ADR-004, follow-up 1). The approval flow was OFF for every run below (each script that moves a contract to Pending Approval reads the flow state first and stops if it is ON).

### What changed

- **New shared helper `scripts/lib/contract-cleanup.mjs`.** Cleanup of contract rows: Pending is withdrawn to Draft and then deleted; Draft and Rejected are deleted; In Force is deleted with the bypass of the guard **Delete step alone** (no step is disabled). It also reads the approval flow state (read only). Every script that deletes contract rows uses it.
- **`test-usd-freeze.mjs`.** Case 2 (Rejected to Pending) is now a **negative** test (the row reaches Rejected by Draft to Pending to Rejected, the guard returns 400, the row is unchanged). Case 8 expects the Value edit while Pending to be rejected.
- **`verification-api-tests.mjs`.** t4 reaches Rejected through Pending. `delete-by-subject` and the cleanup use the helper.
- **`load-test-data.mjs`.** In Force and Rejected are reached by Draft to Pending Approval to the status. It now needs `--confirm-mutates-environment` (same behavior and wording as the other mutating scripts) and it checks that the approval flow is OFF. Idempotency (alternate key on Contract Number) and the loaded data are unchanged.
- **`test-state-guard.mjs`.** Cleanup uses the helper; the flow state is checked; `--skip-ui-rows` skips the three rows for the manual UI test.
- **`test-guard-flow.mjs`.** Part 2 deletes through the helper.

### What was run on the server (2026-10-13)

| Script | Result |
|---|---|
| `test-usd-freeze.mjs --mode=update-cases` | **10 passed, 0 failed** (11 rows cleaned, Pending rows withdrawn first) |
| `test-usd-freeze.mjs --mode=create-case` | 1 passed, 0 failed |
| `test-usd-freeze.mjs --mode=guard-smoke` | 5 passed, 0 failed |
| `verification-api-tests.mjs` | **Partial:** `snapshot`, `t2`, `t4`, `key-tests`, `quick-toggle`, `delete-by-subject` (default subjects and `--prefix=TEST-TMP-KEY-`) and `check-clean` completed. The Pending row left by `quick-toggle` was withdrawn to Draft and deleted (HTTP 204) |
| `test-state-guard.mjs --mode=integration --skip-ui-rows` | **89 passed, 0 failed, 4 observations.** Cleanup removed 16 rows (contracts and both counterparties). The UI rows were **skipped** (they need the owner's clicks) |
| check-clean after the runs | TEST-TMP contracts **0**, TEST-TMP counterparties **0**, total contracts **11** |

Note on the first run of case 2: it failed because the expected message in the script said "to Pending." while the guard says "to Pending Approval.". The behavior was correct; the expected text was corrected and the whole run repeated (10 of 10). No assertion was weakened.

### What was NOT run

- **`load-test-data.mjs`.** Not run against the server (it would touch the 11 baseline contracts). Verified by `node --check`, by reading the code, and by checking that it refuses to run without `--confirm-mutates-environment` (exit code 2, nothing sent).
- **`test-guard-flow.mjs` part 2.** Not run: it needs the approval flow ON. It only changed to use the shared helper for its deletes.
- **`verification-api-tests.mjs` t1 and t3.** Not run. They change metadata (a spare Status Reason option) and a currency rate temporarily, and the guard does not touch what they do.

### Known gap

`verification-api-tests.mjs same-status-save` depends on a row (`TEST-TMP-FLOW-01 edited`) that no longer exists. It stops by design with "expected exactly 1 contract ... found 0. Nothing was sent." It needs a new row to be useful.

### New side effect to know about

Rows loaded to Pending Approval, In Force or Rejected by `load-test-data.mjs` now get a **frozen USD value** from plug-in 1 (`mwf_valueusdfrozen`), because they pass through Pending Approval. This did not happen before the plug-in and the guard. It does not change the CSV data that is loaded.

## Flow trigger test (2026-10-13)

`scripts/test-flow-trigger.mjs` checked how many approval flow runs each action starts with the new trigger (Select columns `mwf_valueusdfrozen`, Filter rows `statuscode eq 867640000`). Observed by the owner in the run history: exactly one new run, belonging to the Draft to Pending Approval action; the three other actions started none. The script could not count runs itself (the `flowruns` table lists finished runs only). Results, limits and the known gap are in `docs/flow-approval-v1.md`, section 12.

## Flow checkpoints test (2026-10-13)

`scripts/test-flow-checkpoints.mjs` tested the two checkpoints added to the approval flow (a run for a withdrawn contract ends Cancelled before any write). Four fictional contracts: normal, withdrawn before stage 1, withdrawn after stage 1, rejected. Rows ended In Force, Draft, Draft and Rejected; 4 runs finished (2 Succeeded, 2 Cancelled, none Failed). Evidence, mapping of runs to contracts (partly inferred) and what is not covered: `docs/flow-approval-v1.md`, section 13. The test rows were deleted (CHK1 In Force with the bypass of the guard Delete step alone); check-clean: 0 TEST-TMP rows, 11 contracts.

## Approval round (2026-10-13)

The column `mwf_approvalround` (Whole Number) was added to `mwf_contract`, plug-in 1 now increments it on each real submission, and the guard locks it for clients (ADR-005). Closes the plug-in side of the "stale run after withdraw and resubmit" gap in `docs/flow-approval-v1.md`; the flow check is **not done**.

| Item | Result |
|---|---|
| Column | created by `scripts/add-approvalround-column.mjs`; metadata read back (script): Whole Number, min 0, max 2147483647, not required. A Whole Number column has no default value, so a new row holds null |
| Solution | the column belongs to the solution through the table (include all subcomponents), like the other custom columns |
| Package | updated with the content PATCH (assembly 1.0.2.0, package version 1.0.0 unchanged). Assembly SHA-256 `ecabaa8a95073cb15030c0e9b6f27ff200c6e6356151a7732c47eef9efe4004f`, package file 13,635 bytes SHA-256 `f14d12d8295541c25b5cf53f39d884687dfea679aab01240fa0535ee9a62d1ea` |
| Unit tests | 262 passed, 0 failed (233 before) |
| Guard Update step | filtering attributes updated to **10** columns (with `mwf_approvalround`) |
| Guard Update PreImage | **still 9 columns** (without `mwf_approvalround`): the update of the image attributes was refused with HTTP 400, code 0x80040216, "An unexpected error occurred". **The cause was not investigated.** Decision: keep it (owner, option a). Effect: a client Update with a non-null `mwf_approvalround` is always rejected, even equal to the stored value (fail closed) |
| Integration tests `scripts/test-approval-round.mjs` | (script) 9 passed, 0 failed, 3 observations; flow OFF; cleanup with the shared helper; check-clean 0 TEST-TMP contracts, 0 counterparties, 11 contracts |

Observations (script): a new Draft row holds null; the equal-value client write is rejected (HTTP 400); a contract created directly as Pending Approval through the API gets round 1 (nothing is claimed about runs, the flow was OFF).

The guard Update step registration was read again after the tests: filtering 10, PreImage 9, unchanged.

Not done: `pac solution sync` to `src/` (the column is not in `src/` yet) and the flow change.

## Approval round check in the flow (2026-10-13)

The two checkpoint conditions of the flow were extended by hand with a comparison of `mwf_approvalround` (the contract re-read after the stage against the trigger). Test with `scripts/test-flow-approvalround.mjs` (setup, read, cleanup; flow ON): submission 1 (round 1), withdraw, submission 2 (round 2). **(owner)** Run 1 stopped at "Stop - contract no longer Pending (stage 1)" and ended Canceled, without a manual cancel; run 2 passed both checkpoints and "Update a row 3" succeeded; the final status of run 2 was not seen. **(script)** The contract ended In Force with round 2, 3 approvals Completed (counts only), check-clean 0 TEST-TMP rows and 11 contracts. Tested once. Details, expressions and limits: `docs/flow-approval-v1.md`, section 14; open points: ADR-005.

## src/ synced with the environment (2026-10-13)

Procedure (the same as before, no new one): `pac solution sync` from the repository root (project `Muwafaqa.cdsproj`, solution `Muwafaqa`), then `node scripts/scrub-emails.mjs` before `git add` (CLAUDE.md). The direction is environment to source only; nothing was imported.

### What changed in `src/` (script: counts from `git status` and the diff)

| Area | Change |
|---|---|
| `Entities/mwf_Contract/Entity.xml` | the column `mwf_approvalround` (int, min 0, max 2147483647, not required, audit enabled, display name "Approval Round") |
| `SdkMessageProcessingSteps/` | 5 new files: plug-in 1 (Update: filtering `statuscode`, PreImage of 3 columns; Create) and the guard (Update: filtering 10 columns, PreImage 9 columns; Create; Delete with a PreImage of `statuscode`) |
| `pluginpackages/mwf_muwafaqaplugins/pluginpackage.xml` | new (package version 1.0.0) |
| `Other/Solution.xml` | 1 root component for the assembly (version 1.0.2.0) and 5 for the steps |
| `Other/Customizations.xml` | the version stamp and an empty `SdkMessageProcessingSteps` element |
| `Workflows/` (the approval flow) | 9 to 15 actions: the two "Get contract after stage N" actions, the two "Is still Pending (stage N)" conditions with the round comparison, the two "Stop - contract no longer Pending (stage N)" Terminate actions; `Check Stage1` and `Check Stage2` were moved under the conditions; trigger Select columns `mwf_valueusdfrozen` |
| forms and views | no change |

### Scrub

`scripts/scrub-emails.mjs` now also replaces the host of the record link in the flow (`WebhookApprovalCreationInput/itemLink`, found by the URL pattern in front of `/main.aspx?etn=`) with `<ORG_HOST>`. The host is not written in the script; `--env=<url>` may be passed to replace other occurrences of exactly that host. `--self-test` checks the replacement with fictional values and prints only PASS/FAIL. Result (script): 2 host replacements in the flow file, 0 hosts and 0 email-like values (outside OData annotations) remain in `src/`, the flow JSON still parses, and a second run replaces nothing.

### Packing `src/` from a clean clone

There is **no script** for the plug-in build (the `pipelines/` folder is empty). The real steps used in this project are:

1. Build the package from `plugins/`: `dotnet build -c Release` in `plugins/Muwafaqa.Plugins`. The package is written to `bin/Release/mwf_muwafaqaplugins.1.0.0.nupkg`.
2. Copy it to `src/pluginpackages/mwf_muwafaqaplugins/package/mwf_muwafaqaplugins.nupkg` (the file name that `pluginpackage.xml` expects). That folder is ignored by git (`*.nupkg`), so the package is **not** in the repository.
3. `pac solution pack --zipfile <a folder outside the repository>/Muwafaqa.zip --folder src --packagetype Unmanaged`.

Notes:
- A rebuilt package is not byte for byte the same as the published one (the assembly hash is reproducible, the package hash is not, see the build identity sections of this log). **The SHA-256 of each published package is recorded in this log.**
- The flow in `src/` has two placeholders, `<APPROVER_TEST_ACCOUNT>` and `<ORG_HOST>`; both must be filled in before an import.

### Local pack check

(script) `pac solution pack` of `src/` into a temporary folder outside the repository completed ("Packed Solution", unmanaged); the output was deleted afterwards. It printed one warning: `Following root components are not defined in customizations: Type='PluginAssembly'`. **(not tested for import):** nothing was imported, so it is not known whether an import of this source accepts it.

### Open items

- The pack warning about the `PluginAssembly` root component (not tested for import).
- The package is not in the repository (option b above); the steps above are manual.
- The environment host exists in an earlier commit: `docs/pre-publish-checklist.md`.

## Small test gaps closed (2026-10-13)

All results below were produced by test scripts against the development environment. The row counts after every run were checked by script: 0 TEST-TMP contracts, 0 TEST-TMP counterparties, 11 contracts in total.

### Guard with the flow ON: `scripts/test-guard-flow.mjs` part 1 and part 2

Part 2 reads rows that part 1 created and that the owner answered by hand, so part 1 was run first (flow ON).

| Case | Expected | Actual | Result |
|---|---|---|---|
| Two Draft contracts moved to Pending Approval with the flow ON | Pending Approval, frozen USD value 1000.00 | Pending Approval, 1000.00 (both) | PASS (script) |
| Second contract withdrawn to Draft while its approval was outstanding | Draft | Draft | PASS (script) |
| First contract after the owner answered the approvals | In Force | In Force, frozen value 1000.00 | PASS (script) |
| Withdrawn contract after the owner answered its approval | Draft (not overwritten by the stale run) | Draft, frozen value 1000.00 | PASS (script) |
| Cleanup | all rows deleted | In Force row deleted with the bypass of the guard Delete step only (HTTP 204), Draft row deleted (HTTP 204), counterparty deleted (HTTP 204) | PASS (script) |

- **(owner)** Run history at 20:29 local showed two new runs: one **Canceled** (duration 1:01) and one **Succeeded** (duration 2:11); none Running or Failed. The mapping to FLOW2 (Canceled) and FLOW1 (Succeeded) is **inferred** from the status and the duration; the run pages were not opened. The scripts do not read the run history.

### `scripts/verification-api-tests.mjs` (flow OFF)

- **`same-status-save` fixed:** it no longer depends on a left-over row. It creates its own contract, moves it to Pending Approval, sends a `statuscode` PATCH with the same value, and deletes the rows. Observed (script): HTTP 204; status, frozen USD value (1000) and approval round (1) unchanged; `modifiedon` unchanged (same second).
- **`t1` (spare Status Reason option):** the spare option was inserted (HTTP 200) and deleted (HTTP 204); the four real options were unchanged afterwards (script). It does not write contract rows, so the guard does not apply to it.
- **`t3` (exchange rate change):** all steps ran under the current guard on Draft rows (script). The AED rate was changed to a temporary value and restored (restored = true); the two existing AED test contracts were unchanged. Observed: an existing row keeps its rate and base amount after the currency rate changes; a Value edit on the row refreshes its rate and base amount; a PATCH of `exchangerate` through the API returned HTTP 204 and the stored rate did not change (script).
- **`value-zero` (new):** a real Draft to Pending Approval submission with Value = 0.

  | | Intended (from the code, `UsdValueCalculator` and plug-in 1) | Actual (script) |
  |---|---|---|
  | Create with Value 0 | accepted | accepted, frozen value null, round null |
  | Submission | accepted, frozen USD value 0.00, round 1 | HTTP 204, status Pending Approval, frozen USD value 0, round 1 |

  Only a negative or a missing Value is rejected by plug-in 1; a Value of 0 is accepted and frozen as 0. The zero case of the calculator is also covered by a unit test. Whether a zero-value contract should be allowed to enter approval is a business decision and was **not** decided here; the approval matrix and the flow behaviour for a frozen value of 0 were **not tested**.

### Still open

- The run-to-contract mapping of the guard-flow test is inferred (owner, Run history), not read from the run pages.
- A contract with Value = 0 enters approval today (accepted, frozen USD 0, round 1). Whether this is intended and which ApprovalMatrix band applies is a business decision, not taken.
- The flow behaviour for a frozen USD value of 0 (which matrix row applies). (not tested)
