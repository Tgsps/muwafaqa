# Rebuild runbook: Muwafaqa in a new, empty environment

Status: **draft, written 2026-10-24. Nothing in this document has been run end to end.** It is assembled from the repository and from Microsoft Learn pages read on the date above. The environment was only read while writing it.

## 0. Why, deadline, and how to read this document

The current environment is an **unmanaged Developer environment**. Learn ("Automatic deletion of Power Platform environments", page dated 2026-10-08): "Regardless of activity, unmanaged developer environments are suspended starting December 15, 2026 and deleted starting January 15, 2027." On 2026-10-24 that is **52 days** to the suspension. The same page says developer environments that are **managed environments** are not affected by this deprecation (60-day inactivity schedule). Whether a managed developer environment, a sandbox or a production environment is available in our tenant, and which license that needs, was **not checked**.

Every step carries one tag:

| Tag | Meaning |
|---|---|
| **[TESTED]** | The step as written was done before in the current environment. It was **not** done in a rebuilt environment. |
| **[FROM DOCS: page]** | Not done by us; taken from the named Microsoft Learn page. |
| **[NOT TESTED]** | Neither. Treat as a hypothesis. |

"Owner" = click-work in the browser. "Assistant" = a script or a command written by the assistant and run on the owner's machine.

**The solution import was never tested.** `pac solution pack` of `src/` completed (several times); nothing was ever imported, anywhere (ADR-006, plug-in registration log).

## 1. Inventory

### 1.1 Inside the solution `Muwafaqa` (unpacked in `src/`)

Solution unique name `Muwafaqa`, version 1.0.0.0, publisher `MuwafaqaDev`, prefix `mwf`, option value prefix 86764 (`src/Other/Solution.xml`).

| Component | What is in `src/` | Source |
|---|---|---|
| Tables (6) | `mwf_counterparty` (organization-owned), `mwf_contract` (user-owned), `mwf_approvalmatrix`, `mwf_approverassignment`, `mwf_approvalstep`, `mwf_contractnumbercounter` (all organization-owned); plus `systemuser` as a shell root component (behavior 1) | `src/Entities`, `src/Other/Solution.xml` |
| Columns, local Choices, Status Reason mapping | All custom columns and local option sets, `statuscode` with Draft / Pending Approval / In Force / Rejected, the Currency column set on Contract | `docs/data-model-phase1.md`, Entity.xml files |
| Relationships | Counterparty to Contract (Restrict on delete); Approval Step to Contract (Cascade); lookups from Approval Step (two) and Approver Assignment to `systemuser` (remove link) | data model, ADR-007 |
| Alternate keys (4) | `mwf_ContractNumberKey` (contract number), `mwf_ContractNumberCounterKey` (type value), `mwf_ApprovalStepKey` (contract, round, step order), `mwf_ApproverAssignmentKey` (role) | Entity.xml `EntityKeys` |
| Audit flags | `IsAuditEnabled` is 1 on five tables and on four lookup columns; 0 on the counter table and on `mwf_approvalstep.mwf_contract` | `src/Entities` (synced 2026-10-24) |
| Security roles (4) | Requester (8 privileges), Approver (3), Finance (9), Admin (22, including `prvReadAuditSummary` and `prvReadRecordAuditHistory`); none holds any of the nine platform baseline privileges | `src/Roles`, ADR-008 |
| Forms and views | Per table: 1 main, 1 quick and 1 card form. Views: Contract 11, every other table 7 | `src/Entities/*/FormXml`, `SavedQueries` |
| Model-driven app | `Muwafaqa Contracts` (`mwf_MuwafaqaContracts`), its site map and its icon web resource | `src/AppModules`, `src/AppModuleSiteMaps`, `src/WebResources` |
| Cloud flows (2) | `Muwafaqa - Contract Approval v1` (legacy, stays OFF) and `v2` (chain driven by `mwf_approvalstep`); both exported as OFF | `src/Workflows` |
| Connection reference (1) | The Approvals reference (`mwf_sharedapprovals_*`) is a component of the solution | `src/Other/Customizations.xml` |
| Plug-in package | `mwf_muwafaqaplugins` (package version 1.0.0, assembly version 1.0.7.0, sandbox) with four plug-in classes: freeze USD value, state guard, contract number generator, approval chain builder | `src/pluginpackages`, `plugins/` |
| Plug-in steps (7) | Freeze USD: Update (PreOperation, filtering `statuscode`, PreImage) and Create; State guard: Create, Update (PreImage) and Delete (PreImage); Contract number: Create (PreOperation, rank 10); Chain builder: Update (PostOperation 40, filtering `statuscode`, PreImage) | `src/SdkMessageProcessingSteps`, ADR-003 to ADR-007 |
| Search settings | Two `dvtablesearchentity` rows and one `dvtablesearch` row | `src/` (purpose not analysed) |

### 1.2 Outside the solution (must be recreated, copied or re-checked)

| Item | Why it does not travel | How to recreate | Tag |
|---|---|---|---|
| **The plug-in package file** | `*.nupkg` is git-ignored; the `src/pluginpackages/.../package` folder of a fresh clone has no file | Build it (step R04). The assembly hash is reproducible, the package hash is not; hashes of the packages published so far are in `docs/plugin-registration-log.md` | [TESTED] |
| **Dataverse connection reference** `new_sharedcommondataserviceforapps_*` | Both flows use it, but it is not a component of the solution: `Solution.xml` lists it under `MissingDependencies` with the solution `Active` (the default solution) | Unknown how an import reacts. See risk K1 | [NOT TESTED] |
| **Connections** (the Approvals connection and the Dataverse connection of the owner) | Connection references hold no credentials (Learn, "Use a connection reference in a solution") | Owner creates or selects them at import or in Power Automate | [FROM DOCS: Use a connection reference in a solution with Microsoft Dataverse] |
| **Flow placeholders** | `src/Workflows` was scrubbed: `<ORG_HOST>` (2 in v1, 2 in v2) and `<APPROVER_TEST_ACCOUNT>` (2 in v1, 0 in v2) | Step R05 | [NOT TESTED] |
| **Currency records** | Rows of `transactioncurrency`, data | USD, KWD (precision 3), AED and SAR, with the placeholder rates in `docs/data-model-phase1.md` section 8 (units per 1 TRY; not market rates). TRY is the base currency of the environment | [NOT TESTED] (only KWD creation is described in `docs/verification-checklist.md`) |
| **Base currency TRY and base language English** | Fixed when the environment is created (ADR-001); changing the base currency is a heavy process | Choose them in step R01 | [FROM DOCS: trial-environments] |
| **Contract number counters** (5 rows) | Rows are data. The alternate key index status (Active) is not carried in the XML (ADR-006) | `scripts/create-contractnumbercounter-table.mjs` (creates the key if absent, waits for Active, seeds 5 rows at 0) | [TESTED] |
| **Approval matrix** (110 rows) | Data | `data/approval-matrix.csv` through `scripts/load-approval-matrix.mjs` | [TESTED] |
| **Approver assignments** (5 rows, one per role) | Data; each points at a user of the environment | `scripts/load-approver-assignment.mjs`, user from `MWF_APPROVER_TEST_USER` | [TESTED] |
| **Demo counterparties and contracts** | Data, `data/counterparties.csv` (5) and `data/contracts.csv` (10) | See risk K5: the loader predates the state guard and was last run on 2026-10-06 | [NOT TESTED] |
| **Organization audit settings** | `isauditenabled`, retention (365 days, provisional), read audit off, user access audit off live on the organization row, not on a table. Learn does not say they are transported | `configure-auditing.mjs --mode=apply --org` | [TESTED] |
| **Existing audit rows** | Audit logs are not exportable from the UI (Learn: "Exporting audit logs isn't currently supported"). They will not move | Accept the loss (test data only) | [FROM DOCS: Manage Dataverse auditing] |
| **Application user** for `test-security-roles.mjs` | Created in the environment, per environment | Owner adds the existing Entra app registration as an application user and keeps it with no role; the three `MWF_TEST_*` variables are set on the machine | [TESTED] (in the current environment) |
| **Test account / approvers** | Users are per tenant/environment | The user named in `MWF_APPROVER_TEST_USER` must exist and be licensed in the new environment before step R14 | [TESTED] |
| **The "11 legacy contracts"** | Rows created on 2026-10-06 before the plug-ins; the regression scripts require them (risk K5) | Not recorded how the 11th row came to exist | [NOT TESTED] |

## 2. Prerequisites on the build machine

- `git`, `node` 18 or later, `dotnet` SDK (10.0.401 was used for the plug-in builds), `pac` (2.12.2 was used when this was written), `az` (Azure CLI) signed in to the tenant. [TESTED]
- Environment variables used by the scripts: `MWF_APPROVER_TEST_USER`; `MWF_TEST_TENANT_ID`, `MWF_TEST_CLIENT_ID`, `MWF_TEST_CLIENT_SECRET` (only for `test-security-roles.mjs`). Values are never written to a file. [TESTED]
- Optional, used here because of the network of the owner: `NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000"`. [TESTED]
- Placeholders in this document: `<ENV_URL>` (the environment URL), `<ORG>`, `<TENANT>`, `<OUT>` (a work folder **outside** the repository).

## 3. Steps in order

Rule that applies to every step: **both flows stay OFF** until step R18, and only the owner turns a flow on or off.

| # | Who | What | Tag |
|---|---|---|---|
| R01 | Owner | **Create the environment** in the Power Platform admin center: Manage, Environments, New. Type: the chosen target (see section 0), region, **Create a database: Yes**, **language English**, **currency TRY**, **Enable Dynamics 365 apps: No**, sample data No. Note that for a Trial (standard) environment the settings list on Learn has no URL field. | [FROM DOCS: About trial environments] |
| R02 | Owner | `az login --tenant <TENANT>`; `pac auth create --environment <ENV_URL>`; `pac auth list` shows the new profile active. Add the environment to `--env=` of every script below. | [TESTED] |
| R03 | Assistant | Connection gate before any write: `node scripts/check-connection.mjs --env=<ENV_URL> --minutes=3`. The scripts also run their own 3-reads rule. | [TESTED] |
| R04 | Assistant | **Build the plug-in package.** In `plugins/Muwafaqa.Plugins`: `dotnet build -c Release`; the package is `bin/Release/mwf_muwafaqaplugins.1.0.0.nupkg`; copy it to `src/pluginpackages/mwf_muwafaqaplugins/package/mwf_muwafaqaplugins.nupkg` (git-ignored). Unit tests: `dotnet test` in `plugins/Muwafaqa.Plugins.Tests` (last recorded in ADR-006: 295 passed; not re-counted for this document). Compare the assembly SHA-256 with the log. | [TESTED] |
| R05 | Assistant | **Prepare a pack copy of `src/` outside the repository** (`<OUT>/src-pack`) and fill the placeholders **in the copy only**. List where they are without showing any value with the helper under the table (run on 2026-10-24: v2 has two paths, both `itemLink` parameters under `Request_approval_for_step` and `Send_information_approval`; v1 has two `itemLink` paths and two approver fields). `<ORG_HOST>` is the host of `<ENV_URL>` without `https://`; `<APPROVER_TEST_ACCOUNT>` is the approver account's sign-in name. The substitution itself has not been scripted or tried. | [NOT TESTED] |
| R06 | Assistant | **Pack:** `pac solution pack --zipfile <OUT>/Muwafaqa.zip --folder <OUT>/src-pack --packagetype Unmanaged`. Expected: "Packed Solution" and one warning that root component `PluginAssembly` is "not defined in customizations". | [TESTED] (pack only) |
| R07 | Owner | **Create the connections** that the flows need: an Approvals connection and a Dataverse connection owned by the account that will turn the flows on. | [FROM DOCS: Use a connection reference in a solution with Microsoft Dataverse] |
| R08 | Owner | **Import the zip.** Preferred first attempt: make.powerapps.com, Solutions, Import solution, because the import wizard offers the connections for the connection references (Learn). Alternative: `pac solution import --path <OUT>/Muwafaqa.zip --publish-changes --async`. **Do not pass `--activate-plugins`** (it activates plug-ins and workflows). Learn says that when every connection reference gets a connection at import, "flows can be turned on automatically after the import"; see R09 and K3. Record the duration and every message. | [NOT TESTED] |
| R09 | Owner, then assistant | **Check the flows are OFF** right after the import (owner looks in Power Automate; the assistant runs `node scripts/create-security-roles.mjs --env=<ENV_URL> --auth=az --mode=check`, whose first check is "both approval flows are OFF"). If a flow is ON the owner turns it OFF. No contract exists yet, so a run cannot start. | [TESTED] (the check); [NOT TESTED] (what the import does to the flow state) |
| R10 | Owner | `pac solution publish` or Publish all customizations in the maker portal. | [FROM DOCS: pac solution command group] |
| R11 | Assistant | **Read-only comparison with the design:** `node scripts/register-plugin-package.mjs --mode=prelim --env=<ENV_URL> --auth=az` (solution, package, assembly, steps), `node scripts/verify-approval-chain-schema.mjs --env=<ENV_URL> --auth=az` (columns, Choice values, lookups, the two alternate keys, roles). Expected result in a rebuilt environment is unknown; this step decides which of R12 to R13 are needed. | [TESTED] (the scripts) |
| R12 | Assistant | **Register the plug-in only for what is missing.** The tested modes, in the order used originally: `package` (needs `--nupkg=<path>`), `steps-update`, `steps-create`, `steps-guard`, `guard-columns`, `steps-number`, `steps-chain`; each needs `--confirm-mutates-environment`; the log shows which flags each used. Read back with `--mode=readback` or `--mode=prelim`. Run as one fresh sequence, in a new environment, this has not been done. | [NOT TESTED] |
| R13 | Owner | **Currency records:** create USD, KWD (precision 3), AED, SAR in the new environment with the placeholder rates of `docs/data-model-phase1.md` section 8. Do **not** run `configure-currency-and-status.mjs`: it also renames Status Reason options (an undocumented operation) and was a one-time step. | [NOT TESTED] |
| R14 | Assistant | **Seed data.** In this order: (1) `node scripts/create-contractnumbercounter-table.mjs --env=<ENV_URL> --auth=az --confirm-mutates-environment`; (2) `node scripts/load-approval-matrix.mjs --mode=check`, then `--mode=load --confirm-mutates-environment`, then `--mode=validate` (expect 110 rows); (3) `MWF_APPROVER_TEST_USER=<TEST_ACCOUNT_SIGN_IN> node scripts/load-approver-assignment.mjs --mode=load --confirm-mutates-environment` (expect 5 rows). All three take `--env=<ENV_URL>`; check each header for `--auth`. | [TESTED] |
| R15 | Assistant | **Roles:** `node scripts/create-security-roles.mjs --env=<ENV_URL> --auth=az --mode=verify` (default `--expect-baseline=none`). Expected 4 roles, 8 / 3 / 9 / 22 privileges, none of the nine. If a role is absent, `--mode=create`; if Admin lacks the two audit privileges, `--mode=add-missing --role=Admin` (see K2). | [TESTED] |
| R16 | Assistant | **Auditing:** `node scripts/configure-auditing.mjs --env=<ENV_URL> --auth=az --mode=check`. The table and column flags may already be on from the import; apply only what `check` reports as off, first `--org`, then `--tables=<table>` one at a time and `--columns`/`--column-list` for the four lookups, each with `--confirm-mutates-environment`. Finish with `--mode=verify`. Backups go to `<temp>/muwafaqa-audit-backups`. | [TESTED] (the scripts); [NOT TESTED] (whether the flags arrive with the import) |
| R17 | Assistant | **Regression tests that need both flows OFF**, one at a time, each preceded by its own read-only baseline and followed by its check-clean: `test-state-guard.mjs`, `test-usd-freeze.mjs`, `test-contract-number.mjs`, `test-approval-round.mjs`, `test-approval-chain.mjs`, `test-bulk-messages.mjs`, `test-security-roles.mjs` (application user, env vars), `test-auditing.mjs` (admin account). Read each script's header for its modes and flags; `test-security-roles.mjs --mode=plan` prints its sequence. In an environment without the 11 contracts pass `--expect-contracts=0` (or set `MWF_EXPECT_CONTRACTS=0`); see K5. | [TESTED] (in the current environment); [NOT TESTED] (in a rebuilt one) |
| R18 | Owner, with assistant | **Flow-ON session:** the owner binds the connection references, turns **v2 ON** (v1 stays OFF) and, after each part, turns it OFF. The assistant runs `test-flow-v2.mjs` (`--mode=plan` first; modes `baseline`, `setup`, `request`, `await`, `steps`, `withdraw-resubmit`, `verdict`, `cleanup`) and `test-flow-failures.mjs`. The owner answers the approval requests. Plan: `docs/flow-on-session-plan.md`. | [TESTED] (in the current environment, 2026-10-22) |
| R19 | Assistant | **Drift check:** `pac solution sync` into a **temporary copy** of the repository, then `node scripts/scrub-emails.mjs`, then `git diff` against the committed `src/`. A clean diff (apart from version stamps) is the acceptance test for the import. Sync is an export; nothing is written to the environment. | [NOT TESTED] |
| R20 | Owner | Keep the old environment until R19 passes; then let it be suspended. Before that, decide whether any data in it is worth exporting (audit rows are not). | [NOT TESTED] |

Helper for R05 (Git Bash, run from the repository root; prints file prefix and JSON path only, never a value) **[TESTED]**:

```bash
node -e "const fs=require('fs');for(const f of fs.readdirSync('src/Workflows').filter(x=>x.endsWith('.json'))){const j=JSON.parse(fs.readFileSync('src/Workflows/'+f,'utf8'));const w=(o,p)=>{if(typeof o==='string'){if(o.includes('<ORG_HOST>')||o.includes('<APPROVER_TEST_ACCOUNT>'))console.log(f.slice(0,32)+' '+p)}else if(o&&typeof o==='object')for(const k of Object.keys(o))w(o[k],p+'/'+k)};w(j,'')}"
```

## 4. Known risks

- **K1, the Dataverse connection reference is outside the solution.** Both flows reference `new_sharedcommondataserviceforapps_*` from the `Active` solution, and `Solution.xml` lists it as a missing dependency. An import into an empty environment may fail on it, or may ask for it; this is **not known**. The least risky fix is to add that connection reference to the `Muwafaqa` solution **in the current environment** and sync again before the deadline. That is one write (adding an existing component to a solution) and needs the owner's decision. The same `MissingDependencies` block lists a default app icon web resource (`AppModuleWebResources` 2.5) and a setting definition `AppChannel` (`msdyn_AppFrameworkInfraExtensions`); whether a new environment already has them is **not known**.
- **K2, the nine platform privileges.** The platform adds nine read/SharePoint privileges to custom roles on its own (`prvReadSdkMessage`, `prvReadSdkMessageProcessingStep`, `prvReadSdkMessageProcessingStepImage`, `prvReadPluginType`, `prvReadPluginAssembly`, `prvReadSharePointDocument`, `prvReadSharePointData`, `prvWriteSharePointData`, `prvCreateSharePointData`). ADR-008 removed them and tested the four roles without them. **Whether they come back when roles are created by an import is not tested.** Also, on 2026-10-24 `add-missing` on the Admin role brought back **four** of them (the SharePoint ones) and not the five plug-in ones; the cause is unknown. After every role operation run the default `verify`, which fails if any of the nine is present.
- **K3, flows may turn on by themselves at import.** Learn: with a connection for every connection reference, flows "can be turned on automatically after the import completes". That conflicts with the rule that only the owner turns flows on. Mitigation: R09 right after the import. Residual exposure: a flow only starts when a contract enters Pending Approval, and none exists yet. Whether the exported `StateCode 0` of the flow files is honoured by the import is **not tested**.
- **K4, the exported flows are not importable as they are** (placeholders, section 1.2). **The Flow checker does not prove that a flow is valid:** on 2026-10-22 it reported 0 errors and 0 warnings for the first v2 design that then failed on Turn on (a Terminate action inside a loop). After the import, a flow is only proved by turning it on and running the cases of R18.
- **K5, the regression scripts expect the exact starting state of the current environment: SOLVED with option (a), tested in unit tests and in read-only modes only, NOT tested in an environment without contracts.** The expected number of contracts is now one setting, shared by 13 scripts through `scripts/lib/expect-contracts.mjs`: `--expect-contracts=N`, else the variable `MWF_EXPECT_CONTRACTS`, else the default 11; anything but a whole number of 0 or more is rejected before the script does anything. The other starting numbers stay fixed because a freshly seeded environment has the same ones: 110 active matrix rows, 5 active assignments, 0 approval steps, counters 0. Each script prints the value and its source (argument, environment variable, default) first. Evidence: 12 new unit tests (180 pass; 168 before); on the current environment `test-flow-v2.mjs` and `test-flow-failures.mjs` in `--mode=baseline` still pass without the setting and stop with `MISMATCH contracts: expected 0 (argument), found 11` under `--expect-contracts=0`. **Not changed and still open:** `scripts/verification-api-tests.mjs` (an old script, partly obsolete since ADR-006) uses the seeded `TEST-CT-*` rows as input (it reads them, and one step reads `TEST-CT-0001`), so in an environment without them it will fail or report empty results in another way. For a rebuilt environment run the regression scripts with `--expect-contracts=0` (or the variable) and expect the first full run there to be the real test of this change. The old workaround (b), recreating the 11 legacy rows, stays unreliable: they were loaded on 2026-10-06 before the state guard existed, and the origin of the 11th row is not recorded in the documents I read.
- **K6, pack warning.** `Following root components are not defined in customizations: Type='PluginAssembly'`. Whether the import accepts a plug-in package whose assembly root component is declared like this is **not tested**. The registration scripts of R12 are the fallback.
- **K7, alternate keys build asynchronously.** An import creates the keys from the XML, but their index status is not in the XML; loaders and tests must wait for Active (the counter script does; for the other three keys use `verify-approval-chain-schema`).
- **K8, audit configuration.** The organization settings are not tied to the solution (Learn only says to manage table and column audit settings "as part of a solution"); nothing in Learn says they travel. Audit rows appear 18 to 58 seconds after an operation in the current environment (upper bounds, ADR-009); allow for it in the tests.
- **K9, API behaviour I could not confirm for a new environment:** whether the Contract table's Status Reason values arrive as in `src/` (draft 1, pending 867640000, in force 867640001, rejected 2) and whether the Currency column keeps its calculated base column; read them back with R11 before seeding.

## 5. What I do not know

| Question | Why it matters | How to find out |
|---|---|---|
| Does the import work at all? | The whole plan depends on it | Rehearsal (section 6) |
| Which permanent environment type and license do we have? | Section 0 only quotes the deadline | Admin center, owner; Learn page "Managed Environments" not read |
| Does the import bring `IsAuditEnabled` for tables and columns? | Decides what `configure-auditing --mode=apply` must still do | R16 `check` after the import |
| Do the nine privileges come back on import? | ADR-008 invariant | R15 default `verify` |
| What does the import do with the flow state and with the missing Dataverse connection reference? | K1, K3 | R08, R09 |
| Does the exported v2 accept a filled-in placeholder and then turn on? | K4 | R18 |
| Does a fresh registration of the plug-in (R12) give the same seven steps and images? | Plug-in behaviour is the core of the design | `register-plugin-package.mjs --mode=prelim` and the R17 tests |
| Are `src/` forms, views and the app complete without the default icon web resource and the `AppChannel` setting definition? | K1 | R08 messages, then open the app |
| How many minutes does each step take? | Planning | Rehearsal timings |
| Does the Developer plan or a trial allow the application user and the premium features we use? | R17, R18 | Rehearsal |
| What does a 60-day or 30-day inactivity rule mean for the permanent environment we pick? | Section 0 | Learn page above |
| Is the SHA-256 of a rebuilt assembly equal to the logged one? | Reproducibility | R04 |
| What other state exists in the old environment that is neither in `src/` nor in `data/`? | Completeness | A final read-only sweep before the deadline |

## 6. Rehearsal plan in a Trial environment

**Trial (standard) facts (Learn, "About trial environments"):** a trial lasts **30 days**, then the environment is "disabled and deleted"; one self-service extension of 30 days from the original expiration date, only in the last 7 days; a standard trial with no database activity for 30 days is deleted; "A 30-day trial can only be created and deleted; it can't be reset, backed up, restored, or copied"; it does not consume paid capacity and can be converted to production. Consequence: **one rehearsal per trial**, so each attempt must be planned and recorded, and a failed import cannot be rolled back, only the whole environment deleted and a new trial created (limits on how many trials a user can create were not found).

Who can create it: a user with "a suitable license"; whether our tenant allows it is **not checked**.

Suggested sequence:

1. R01 (Trial, TRY, English, no Dynamics 365 apps), R02, R03.
2. R04 to R06 on the build machine, in a clean clone of the repository (this also tests that `README` and this runbook are enough from the repository alone).
3. R08 with a stopwatch. Stop at the first error; record the full message. Do **not** work around it before writing it down.
4. R09 to R16. Save the output of every read-only step.
5. R17 with `--expect-contracts=0` (K5); the first run of these scripts in an environment without contracts is itself part of the rehearsal.
6. R18 only if R17 passed; it needs the owner for roughly one session (the 2026-10-22 v2 session length is in `docs/flow-on-session-plan.md`; no new estimate is made here).
7. R19.

What to measure and record in a table (columns left blank on purpose):

| Step | Minutes (wall clock) | Owner or assistant | Manual interventions | Messages / failures | Tag changed to |
|---|---|---|---|---|---|

Record in particular: the duration of the import and of the alternate key activation; every dialog the import wizard shows; which of K1 to K9 occurred; the state of both flows right after the import; the roles' privilege counts and the nine; whether `IsAuditEnabled` arrived; the diff of R19; every script that stopped on a baseline (K5).

After the rehearsal: change the tags in this document to **[TESTED]** only for steps that ran as written, put the failures in section 4, and keep the rehearsal environment until the real rebuild is done or it expires.

## Sources (Microsoft Learn, read 2026-10-24)

- Automatic deletion of Power Platform environments (power-platform/admin/automatic-environment-cleanup)
- About trial environments: standard and subscription-based (power-platform/admin/trial-environments)
- Use a connection reference in a solution with Microsoft Dataverse (power-apps/maker/data-platform/create-connection-reference)
- Manage Dataverse auditing (power-platform/admin/manage-dataverse-auditing)
- Microsoft Power Platform CLI solution command group (power-platform/developer/cli/reference/solution)
