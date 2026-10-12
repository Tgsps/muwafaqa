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
