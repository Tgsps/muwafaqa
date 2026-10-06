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
