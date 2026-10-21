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
| `verify-approval-chain-schema.mjs` | Read-back with PASS / FAIL / OBS: columns, Choice values, lookup delete behavior, alternate keys, approver rows (counts), matrix descriptions, solution membership, roles with privileges on the two tables. With `--cascade-test` it also runs a live test on `TEST-TMP-STEP*` rows (duplicate key rejected, cascade delete), flow must be OFF, counters restored by the helper rule. `--mode=cleanup` removes those rows after a crash |
| `lib/dv-session.mjs` | Shared sign-in and Web API caller of these three scripts (GET retried on network errors only; a write is never retried) |

Notes: the two ApprovalMatrix and approver loaders must both be run once per environment (the rows are not part of the solution). No script here writes an email, id or host into any file.
