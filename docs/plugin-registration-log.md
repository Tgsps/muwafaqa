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
