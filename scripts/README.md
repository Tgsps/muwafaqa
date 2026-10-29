# Scripts

Two equivalent scripts create the same four `mwf_counterparty` columns. Use one of them.

| Script | Auth | When to use |
|---|---|---|
| `add-counterparty-columns.mjs` (Node 18+) | Device code flow with the public Azure CLI client id. No `az` needed | Used for the actual run |
| `Add-CounterpartyColumns.ps1` (PowerShell) | `az account get-access-token` | Alternative when `az` works |

## add-counterparty-columns.mjs

```bash
node scripts/add-counterparty-columns.mjs --env=https://<org>.crm4.dynamics.com --dry-run   # prints requests, no network
node scripts/add-counterparty-columns.mjs --env=https://<org>.crm4.dynamics.com             # prints a sign-in URL and device code, waits for sign-in
```

Optional: `--solution=<name>` (default `Muwafaqa`), `--tenant=<id|organizations>`.

- A device code is single use and expires in about 15 minutes. Rerun the script for a new one.
- The token is held in memory only. It is never printed or written to disk. `.gitignore` also blocks `*.token`, `*token*.txt`, `*token*.json`, `access_token*`.
- Idempotent: existing columns are skipped, nothing is modified or deleted. Any failure stops the script and prints the full error.
- After creating, it reports (a) the custom columns, (b) the Type options with numeric values, (c) solution membership via `solutioncomponents` (componenttype 2). Result (c) is only conclusive when it returns true: a table added to a solution with all subcomponents may not list its columns as separate rows.

## Add-CounterpartyColumns.ps1

Adds the four remaining columns of `mwf_counterparty` (Type, Commercial Registration, Contact, Email) through the Dataverse Web API, exactly as specified in [docs/data-model-phase1.md](../docs/data-model-phase1.md) section 1.

- **Idempotent:** an existing column is skipped. Nothing is modified or deleted.
- **Scope:** only the table `mwf_counterparty`. It refuses to run if the table is not Organization-owned.
- **Solution:** every request carries `MSCRM.SolutionUniqueName` (default `Muwafaqa`), so the columns are created inside the solution.
- **Choice values:** set explicitly, `867640000` and up (Option Value Prefix `86764`).
- **Auth:** the script calls `az account get-access-token` at run time. The token stays in memory. It is never printed or written to disk. Do not paste tokens into files in this repository.

### Usage

```powershell
az login
./scripts/Add-CounterpartyColumns.ps1 -EnvironmentUrl https://<org>.crm.dynamics.com -DryRun   # prints the requests, no network
./scripts/Add-CounterpartyColumns.ps1 -EnvironmentUrl https://<org>.crm.dynamics.com           # runs
```

Optional: `-SolutionUniqueName <name>` (default `Muwafaqa`).

### Columns

| Display name | Logical name | Type | Required level | Choice values |
|---|---|---|---|---|
| Type | `mwf_counterpartytype` | Choice (local) | Business Required | Supplier 867640000 · Customer 867640001 · Contractor 867640002 · Partner 867640003 · Other 867640004 |
| Commercial Registration | `mwf_commercialregistration` | Single line of text, Text | Optional | n/a |
| Contact | `mwf_contactname` | Single line of text, Text | Optional | n/a |
| Email | `mwf_email` | Single line of text, Email | Optional | n/a |

### Not specified in the data model

- Max length of the text columns: **100** (platform default) is used.

### Not verified

- Web API accepts a local Choice without an explicit option set `Name` and generates one. If Dataverse rejects it, the error is printed and nothing partial remains beyond columns already created.
- The columns appear in the Solution because of the header. Check the solution's table > Columns after running.
- New columns are not added to any form or view by this script. That is click-work.

## create-contract-table.mjs

Creates `mwf_contract` (table, columns, Lookup with Restrict delete), then verifies it and runs an exchange-rate test.

```bash
node scripts/create-contract-table.mjs --env=https://<org>.crm4.dynamics.com [--solution=Muwafaqa] [--export=<zip path outside the repo>] [--skip-fx]
```

- Same auth, idempotency, and stop-on-error rules as `add-counterparty-columns.mjs`. A `STOP:` message (exit code 3) is a deliberate checkpoint, not a crash.
- Stops if `transactioncurrencyid`, `exchangerate`, or `mwf_value_base` do not appear after creating `mwf_value`. It never creates them explicitly.
- Does **not** change Status Reason options (see [data model section 8](../docs/data-model-phase1.md)); it only reads them.
- The FX test creates one test counterparty and two test contracts (100 USD, 100 KWD), reads back the base amounts, and deletes only the rows it created. It needs currency records USD and KWD and creates none.
- Keep any `--export` zip outside the repository (`*.zip` is git-ignored anyway).

## Approval chain scripts (ADR-007)

Run in this order on a new environment. Replace `<org>` with the environment; the examples use `--auth=az` (a token from `az`, kept in memory, never printed). `--auth=device` uses the device code flow instead.

```bash
node scripts/create-approval-chain-tables.mjs --env=https://<org>.crm4.dynamics.com --auth=az --confirm-mutates-environment
node scripts/load-approval-matrix.mjs --mode=load --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment
MWF_APPROVER_TEST_USER=<test account sign-in name> node scripts/load-approver-assignment.mjs --mode=load --env=https://<org>.crm4.dynamics.com --auth=az --confirm-mutates-environment
node scripts/verify-approval-chain-schema.mjs --env=https://<org>.crm4.dynamics.com --auth=az [--cascade-test --confirm-mutates-environment]
```

| Script | What it does |
|---|---|
| `create-approval-chain-tables.mjs` | Creates `mwf_approvalstep` and `mwf_approverassignment` (columns, lookups, alternate keys) in the solution, and corrects the descriptions of `mwf_minvalueusd` and `mwf_maxvalueusd`. Idempotent: existing objects are only read back; descriptions are updated only when they differ. Stops on any error |
| `load-approver-assignment.mjs` | Modes `check`, `load`, `validate`. Loads one row per role. The user comes from the environment variable **`MWF_APPROVER_TEST_USER`** (sign-in name or user id of the development test account); its value, the resolved id and any address are never printed, only counts. `load` never changes an existing row. The rows are data and do not travel with the solution |
| `verify-approval-chain-schema.mjs` | Read-back with PASS / FAIL / OBS: columns, Choice values, lookup delete behavior, alternate keys, approver rows (counts), matrix descriptions, solution membership, the project roles against the ADR-008 design on the two tables (names; depth is checked by create-security-roles verify). With `--cascade-test` it also runs a live test on `TEST-TMP-STEP*` rows (duplicate key rejected, cascade delete), flow must be OFF, counters restored by the helper rule. `--mode=cleanup` removes those rows after a crash |
| `lib/dv-session.mjs` | Shared sign-in and Web API caller of these three scripts (GET retried on network errors only; a write is never retried) |

Notes: the two ApprovalMatrix and approver loaders must both be run once per environment (the rows are not part of the solution). No script here writes an email, id or host into any file.

### Approval chain builder: test and registration (ADR-007, batch 2)

| Script | What it does |
|---|---|
| `register-plugin-package.mjs --mode=steps-chain` | Registers the Update step of `ApprovalChainBuilder` (PostOperation 40, synchronous, rank 1, filtering `statuscode`) with the PreImage `pre` (`statuscode` only). Idempotent by step name. Read-back included. Use `--mode=package-update --nupkg=<path>` first to load the 1.0.6.0 package |
| `test-approval-chain.mjs` | Server tests T1 to T10 on fictional `TEST-TMP-CHAIN*` rows. **The approval flow must be OFF** (the script stops otherwise). Pre-checks: 3 GET requests, 0 TEST-TMP rows, 11 contracts, 0 approval steps, 110 active matrix rows, 5 active assignments. It temporarily deactivates one assignment row (T5) and one matrix row (T9) and always reactivates them in `finally`, reading each back; if a state cannot be confirmed it stops and prints it. Counters are snapshotted and restored by the usual rule. Modes: `run` (needs `--confirm-mutates-environment`), `check-clean`, `cleanup` (after a crash: deletes the rows, reactivates any inactive matrix or assignment row, restores counters from `--counters-before/--counters-consumed`). `--only=T1,T5` runs selected tests |
| `test-bulk-messages.mjs` | Server tests of `CreateMultiple` and `UpdateMultiple` on fictional `TEST-TMP-BULK*` rows (cases C1, C1b, C2 to C8: numbers and counters in a batch, rejection of a whole batch by the guard, chain builder and rounds per contract). **Both approval flows must be OFF** (read first; the script stops otherwise and never touches a flow). Before every case and bulk request: 3 consecutive reads; writes are never retried; a FAIL stops the run, cleans up and prints the details. Modes: `plan` (offline), `baseline` (read only, also lists the registered plug-in steps), `run` (needs `--confirm-mutates-environment`, or `--dry-run`: reads the state and sends nothing), `cleanup` (after a crash, with `--counters-before/--counters-consumed`). Pure helpers: `lib/bulk-messages.mjs` |
| `test-flow-failures.mjs` | Server tests of the Failed endings of flow v2 on fictional `TEST-TMP-FF1` / `TEST-TMP-FF2` rows (F1: no step rows; F2: a step whose role has no active assignment). No approval request is created, so nobody answers anything; the owner turns v2 ON before and OFF after, and the script never touches a flow. The ApprovalChainBuilder Update step is bypassed (header with its id only) at the submission. F2 makes the Department Head assignment Inactive and always reactivates it in `finally` (one PATCH, read back; exit 5 if it cannot be confirmed). Modes: `plan` (offline), `baseline`, `setup`, `await`, `verdict`, `cleanup` (reverse order f2, f1; `--counters-before/--counters-consumed`), `--dry-run`. Helpers: `lib/flow-failures.mjs`. F1 and F2 were run on 2026-10-22 |
| `create-security-roles.mjs` | Creates and verifies the four project security roles (ADR-008): Muwafaqa Requester / Approver / Finance / Admin. Modes `check` (read only: flows OFF, table ownership, every privilege found by name and allowed at its depth, design rules), `create` (needs `--confirm-mutates-environment` or `--dry-run`; idempotent, a role that differs from the design stops the run), `verify` (read only: privileges and depths really stored, solution membership, 0 members, negative check: no `prvBypass*`, no counter-table privilege, no Assign / Share), `cleanup` (only the four roles, only with no members), `add-missing --role=Admin` (one AddPrivilegesRole call for the designed audit-read privileges that the role lacks; never removes anything; applied to the Admin role on 2026-10-24), `remove-baseline --role=...` and `restore-baseline --role=...` (the controlled experiment with the nine platform-baseline privileges: one RemovePrivilegeRole call per privilege / one AddPrivilegesRole call; idempotent; `--dry-run`; a 4xx stops at once). `verify` takes `--expect-baseline=none|all|any` (default none: it fails if any of the nine platform-baseline privileges is present again). Assigns no role to any user, touches no flow. Design and unit tests: `lib/security-roles.mjs`. Not yet run with `create` |
| `test-security-roles.mjs` | Behavioral test of the four project roles with a Dataverse application user (service principal, client credentials). The tenant id, client id and secret come ONLY from `MWF_TEST_TENANT_ID`, `MWF_TEST_CLIENT_ID`, `MWF_TEST_CLIENT_SECRET`; values are never printed or stored (a redactor also removes the host, the organization name and GUIDs), and only the names of missing variables are printed. The admin account assigns ONE role at a time (Web API association), waits for the privilege cache by polling a read as the application user, runs the cases of the role (Requester R1-R12, Approver A1-A6, Finance F1-F7, Admin D1-D6; the literal error of anything that fails is recorded), and always removes the role. Rows `TEST-TMP-SEC*`, both flows OFF, counters restored. Modes `plan` (offline), `baseline`, `run` (needs `--confirm-mutates-environment`, or `--dry-run`; `--roles=Requester,Finance` runs only those phases), `cleanup`. Refusals are recorded after the host, the organization name and the GUIDs are redacted, then cut at 400 characters; the denial of Write on the matrix, the assignments and the counter is tried with a same-value write on an existing row. Pure helpers: `lib/security-test.mjs`. Run on 2026-10-24 with a non-interactive application user: 76 PASS, 0 FAIL, 4 OBS (ADR-008) |
| `configure-auditing.mjs` | Dataverse auditing of the project (ADR-009). Modes `check` (read only: organization settings, table and column state, the plan, the audit read privileges, the 61 platform tables already audited), `apply` (needs `--org` and/or `--tables=<table>[,..]` with optional `--columns`; `--dry-run` or `--confirm-mutates-environment`): for a table or a column it reads the WHOLE definition, changes `IsAuditEnabled.Value` only, writes it with PUT and the header `MSCRM.MergeLabels: true`, reads it again and compares with a deep diff (any other difference stops before anything else is written), then PublishXml; start with `--tables=mwf_approvalmatrix`; the Contract Number Counter is refused), `verify` (read only). 3 consecutive reads before every write; no write is retried. Pure logic: `lib/auditing.mjs`. Applied on 2026-10-24 (ADR-009): the five tables, four lookup columns and the organization switch; `--mode=restore` and `--mode=revert-org` exist to go back; a column definition's `ModifiedOn` is the one tolerated difference |
| `test-auditing.mjs` | Behavioral test of auditing with the admin account (ADR-009): counterparty create/edit/delete, contract create/edit/submit/withdraw/delete, a temporary matrix row (create, edit, delete) and an assignment row renamed and restored (restored in a finally block, read back); waits for the audit rows (poll every 10 s, at most 10 minutes) and records the real delay; checks who, what changed (old and new values), the operation, the plug-in changes and the steps, with the audits table, `RetrieveRecordChangeHistory` and `RetrieveAuditDetails`. Prefix `TEST-TMP-AUD`, flows OFF, counters restored. Modes `plan` (offline), `run`, `cleanup`, `--dry-run`. Run on 2026-10-24: 23 PASS, 0 FAIL, 6 OBS (ADR-009). A change of `mwf_user` is not tested |
| `test-auditing-user-change.mjs` | Audit test of the approver-user lookup `mwf_approverassignment.mwf_user`, with the OWNER's sign-in (device code or `--auth=az`), never an application user. Plan mode by default; `--mode=check` reads only; `--mode=run` (needs `--confirm-mutates-environment`) creates ONE temporary row `TEST-TMP-AUDUSER assignment` (no role: the alternate key allows one row per role and the five real rows use all five values; the server accepted an empty key column on 2026-10-25; the script stops with nothing created if it ever refuses), moves `mwf_user` from user A (the owner) to a user B (an enabled user that is not the owner, SYSTEM, INTEGRATION or named with a leading #; an application or non-interactive user is accepted because the environment has one interactive user, and the output says so in an OBS line; the choice is deterministic and only the type and the first 4 characters of the name are printed), polls the audits table (10 s, at most 3 minutes) and asserts old/new user, the user of the audit row and the Delete row, then deletes the row. The 5 real rows are only counted. **Run on 2026-10-25 (second attempt): 10 PASS, 0 FAIL, 4 OBS** (the server accepted a row with an empty role; the first attempt stopped before creating anything because the lookup bind key was written in lower case; user B was an application user). It stops before writing if no suitable B exists. Pure parts in `lib/user-change-audit.mjs` (14 unit tests) |
| `add-reminder-columns.mjs` | **Run on 2026-10-26** (apply once: both columns created, 10 PASS each at read-back, `--mode=check` 0 failed; ADR-010, "Implementation note"; idempotent, a second run only reads them back). Creates `mwf_remindedon` and `mwf_escalatedon` (Date and Time, user local, audit ON in the creation request) on `mwf_approvalstep`. Default `--mode=plan` is offline (no sign-in, no `--env`, writes nothing); `--mode=check` reads only; `--mode=apply` needs `--confirm-mutates-environment`, is idempotent, never retried, and **never PUTs a column** (an audit flag that reads back OFF is left to `configure-auditing.mjs`, ADR-009). Pure parts in `lib/reminder-schema.mjs` (11 unit tests, including the offline plan run, the refusals and the audit plan) |
| `build-flow-reminders.mjs` | Generates, checks and (on purpose) creates the scheduled flow "Muwafaqa - Approval Reminders" (ADR-010, [flow-approval-reminders.md](../docs/flow-approval-reminders.md)). `--mode=build` (action table), `--mode=check` (45 structural checks per variant, offline), `--mode=create --variant=test\|production` (**dry run by default**, offline, prints the request summary; with `--confirm-mutates-environment` and `--env` it uses the owner's `--auth=az` sign-in, requires 3 consecutive reads, checks that both connection references are in the solution, POSTs ONE row **with no state, so OFF**, never retried, and reads it back), `--mode=verify` (read only), `--mode=replace --variant=test` (the flow of the exact name only; **dry run by default**; before any write: 3 consecutive reads, exactly one row of that name, category 5, OFF, in the solution, every flow OFF, baseline counts 11/110/5/0, the references in the solution, the structural check; then ONE DELETE and ONE POST of the same state-less body, never retried; run once on 2026-10-29). **No code path turns a flow on** (a unit test holds it); no cleanup mode. `--outlook-ref=<logical name>` (default `mwf_sharedoffice365_reminders`, created by the owner on 2026-10-26; never a GUID). 42 actions, depth 7. **The creation mode was run once for real on 2026-10-26 (test variant): one row created OFF, 16 PASS, `--mode=verify` 5 PASS.** 49 unit tests in `build-flow-reminders.test.mjs` (including an injected defect for each check) |
| `lib/reminder-candidates.mjs` | The pure decision of the future reminder flow (ADR-010): which Waiting steps get a reminder or an escalation notice, with the waiting time **derived** (step 1: `createdon`; step k: `mwf_decidedon` of step k-1 in the same round), thresholds, empty `mwf_remindedon` / `mwf_escalatedon`, and skips (never sends) a step of an old round, of a contract not Pending Approval, or with a missing or undecided previous step. Test and production timers (3 and 6, 2880 and 5760 minutes) as constants. `capActions` is the hard cap of one run (N = 5, decided by the owner on 2026-10-26, hard-coded in `MAX_NOTICES_PER_RUN`; the function has no default). 25 unit tests. No flow exists yet |
| `test-flow-reminders.mjs` | The test session R1 to R6 of the reminders flow (docs/flow-approval-reminders.md, section 4), in two windows. **Windows 1 and 2 were run on 2026-10-29 (verdicts 14 PASS / 0 FAIL / 1 OBS and 17 PASS / 0 FAIL / 3 OBS).** v2 is NOT used: **v2 simulated by seeded rows** (the verdict says it does not prove the v2 integration). Modes `plan` (offline), `baseline` (read only; all flows OFF; the five assignments must resolve to the logged-in user), `setup`, `await` (reads, and the timed seeds of window 2), `verdict` (FAILS while the flow is ON), `cleanup` (refuses while the flow is ON). Never turns a flow on or off, never writes to the table of flows. R4a and R4b seed the Waiting step as the last write, after the contract transition, and read it back. A "no notice" result counts only if the positive control of the window fired. 9 unit tests in `test-flow-reminders.test.mjs` |
| `lib/reminder-session.mjs` | The pure parts of the session: the cases and subjects of the two windows, the seeds (the markers), the plan text, the claims per run, the verdict (claims attributed to runs by containment, overlap reported) and the recipients check. 30 unit tests |
| `check-connection.mjs` | Read-only monitor. Acceptance (owner decision 2026-10-22): the environment only (GET and DNS of the environment host, at most 2 failures of each in 36 cycles, never two in a row); the neutral host and the old "any" line are diagnostics. Rule in `lib/connection-verdict.mjs` |


**Known state, so a run is not surprised (2026-10-26):** the contract-number counter of the type Maintenance (MNT) reads **1**, the others 0, because of the owner's manual test of the contract form (a test contract MNT-0001 was created and deleted; a gap is allowed, ADR-006). The restore script puts it back to 0 **before the next test session, with the owner's approval at that time**; until then a script that expects counters 0 will see MNT = 1.

### Expected number of contracts (K5 of docs/rebuild-runbook.md)

The regression scripts check that the environment holds an exact number of contracts before and after a run. That number is one shared setting, read by `lib/expect-contracts.mjs`:

| Source | Form | Precedence |
|---|---|---|
| Argument | `--expect-contracts=N` | 1 (wins) |
| Environment variable | `MWF_EXPECT_CONTRACTS=N` | 2 |
| Default | 11 (the contracts of the current environment) | 3 |

`N` must be a whole number of 0 or more (digits only: no sign, decimals, spaces or leading zeros; an empty value is rejected too). Anything else stops the script with exit code 2 before it reads or writes anything. Every script below prints `INFO  contracts expected in the starting and the final state: N (source: ...)` first. The other starting numbers (110 active matrix rows, 5 active assignments, 0 approval steps, counters 0) are not configurable: a freshly seeded environment has the same ones.

- **Checks that fail on the number:** `test-approval-chain`, `test-auditing`, `test-bulk-messages`, `test-contract-number`, `test-security-roles`, `test-flow-v2`, `test-flow-failures`, `verify-approval-chain-schema --cascade-test`. In the read-only `baseline` mode of `test-flow-v2` and `test-flow-failures` a wrong number prints `MISMATCH contracts: expected X (source), found Y` and exits 1.
- **Message only (the count was never checked):** `test-approval-round`, `test-flow-approvalround`, `test-flow-checkpoints`, `test-flow-trigger`, `test-guard-flow`. Their "expected" text now shows the setting.
- **Not changed:** `verification-api-tests.mjs` reads the seeded `TEST-CT-*` rows as input and does not count them; in an environment without those rows it reports something else. Tested in unit tests (`lib/expect-contracts.test.mjs`, 12 tests) and in the read-only modes on the current environment; **not tested in an environment without contracts**.

### Flow state and the retired flow v1

`approvalFlowState` / `requireFlowOff` / `describeFlowState` (`lib/contract-cleanup.mjs`) read one flow row or several: `on` is true when any row is ON, `known` is false only when the read failed or no row exists (with a `reason`). Flow v1 was retired on 2026-10-24 (ADR-007); four scenarios written for it stay as history with a header banner "v1 scenario, retired": `test-flow-checkpoints.mjs`, `test-guard-flow.mjs`, `test-flow-trigger.mjs` and the `flow-case` mode of `test-usd-freeze.mjs`. `test-flow-approvalround.mjs` reads both title forms and stays usable with v2.

### Flow v2 builder (ADR-007, batch 3)

| Script | What it does |
|---|---|
| `build-flow-v2.mjs` | The definition of "Muwafaqa - Contract Approval v2" as code. `--mode=build` prints the action table (and writes the clientdata JSON to `--out=<path outside the repository>`); `--mode=check` runs the structural checks offline (no network) and exits 1 on a failure; `--mode=create` (needs `--env`, `--confirm-mutates-environment`) sends **one** POST that creates the flow row **OFF** in the solution, never retried, then reads it back (and confirms v1 is unchanged if a v1 row exists); the connection references come from the solution (exactly one per connector); `--mode=verify` (read only) checks that v2 is OFF and in the solution (and that v1 is OFF if it exists). v1 is retired: the expected trigger is the documented constant `EXPECTED_TRIGGER`, no v1 file is read. It never turns a flow on or off and never starts a run. The record link keeps the placeholder `<ORG_HOST>`, replaced in memory by the host of `--env` |
| `build-flow-v2.test.mjs` | 18 unit tests (`node --test scripts/build-flow-v2.test.mjs`): the definition passes and every check fails when the matching defect is introduced |

### Flow v2 session script (ADR-007; run against the live flow on 2026-10-22: cases A to D, 25 PASS, 0 FAIL)

| Script | What it does |
|---|---|
| `test-flow-v2.mjs` | The cases A to D of the v2 session plan (`docs/flow-on-session-plan.md`), prefixes `TEST-TMP-V2A..D`. Modes `plan`, `baseline` (read only), `setup`, `request`, `await`, `steps`, `withdraw-resubmit`, `verdict`, `cleanup`. `--dry-run` prints the writes and sends none. The owner alone turns v2 on (v1 is retired: a missing v1 is accepted, an existing v1 must be OFF). `request` prints the literal instruction for the owner; `await` waits (up to 15 minutes) until that request is really answered and reports nothing before; `verdict` refuses while a required answer is missing. It never answers or deletes an approval request |
| `test-flow-v2.test.mjs` | 7 unit tests: prefixes, the plan against the matrix structure, titles, the owner is never asked to answer an Inform request |

