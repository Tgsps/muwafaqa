# ADR-008: Security roles of the project

- **Status:** **Accepted (the design) on 2026-10-22.** The four roles were created in the environment and `--mode=verify` passes (see "Result of the creation"). **The behavioral test has NOT been done**: no role is assigned to any user, and nothing has been tested with a real application user yet (the test is prepared, not run: see "Behavioral test"). The design may still change after that test.
- **Date:** 2026-10-22
- **Related:** [ADR-004](ADR-004-contract-state-guard.md) (guard), [ADR-006](ADR-006-contract-number-generator.md) (counter), [ADR-007](ADR-007-approval-chain.md) (chain, flow v2), `scripts/create-security-roles.mjs`, `scripts/lib/security-roles.mjs`.

## Context

Until now every test and every flow runs with the owner's account (a System Administrator). There is no project role, so the solution cannot say who may do what. The data model has one user-owned table (Contract) and five organization-owned tables (Counterparty, Approval Step, Approval Matrix, Approver Assignment, Contract Number Counter), read from the environment metadata (script).

Facts that shape the design (script, from the environment metadata and the plug-in code):

- The plug-ins that write the approval steps, read the matrix and the assignments, freeze the USD value and update the number counter use the **SYSTEM** service (`CreateOrganizationService(null)`). **No user needs any privilege on the steps, the matrix, the assignments or the counter for the submission path to work.**
- The privileges of an organization-owned table of this project exist **only at the Organization (Global) depth** and there are **no Assign or Share privileges** for them. The Contract has User, Business Unit, Parent: Child Business Unit and Organization depths, and it does have Assign and Share.
- Privilege names are `prv` + action + the schema name of the table **with its own letter case** (`prvCreatemwf_Contract`, `prvCreatemwf_approvalmatrix`). The script matches them by name against the `privileges` table; none is typed in.

## Decision

Four roles, created in the root business unit and in the solution, with the privilege levels below (U = User, O = Organization, - = none; C Create, R Read, W Write, D Delete, A Append, AT Append To). **Assign and Share are not granted to any role.**

| Table | Requester | Approver | Finance | Admin |
|---|---|---|---|---|
| Contract (user-owned) | C R W D A AT: **U** | R: **O** | R: **O** | R: **O** |
| Counterparty (org-owned) | R, AT: O | R: O | C R W A AT: O | C R W D A AT: O |
| Approval Step (org-owned) | - | R: O | R: O | R: O |
| Approval Matrix (org-owned) | - | - | R: O | C R W D A AT: O |
| Approver Assignment (org-owned) | - | - | R: O | C R W D A AT: O |
| Contract Number Counter (org-owned) | - | - | - | - |

Rules (all enforced in the code and checked again on the real roles by `--mode=verify`):

1. The steps, the matrix, the assignments, the counterparty and the counter are organization-owned, so their level is **Organization or None** only. Only the Requester has User level, and only on the Contract. No Business Unit or Parent: Child level is used anywhere.
2. **No role holds any privilege on the Contract Number Counter table, the Admin role included**, and **no role holds `prvBypassCustomBusinessLogic` or `prvBypassCustomPlugins`** (or any `prvBypass*` privilege). The administrative bypass used by the cleanup scripts (the header `MSCRM.BypassBusinessLogicExecutionStepIds`, which needs `prvBypassCustomBusinessLogic`; Learn) comes from the **System Administrator** account, not from a project role (owner decision; the account that runs the scripts was not inspected by this ADR).
3. No role can Assign or Share a record.
4. The roles are created with "Direct User (Basic) access level and Team privileges" (`isinherited` 1, the default of the designer).
5. No role is assigned to a user by this work, and no flow is touched (v1 and v2 stay OFF).

Why the Approver and Finance roles only read the Contract: approvers decide in the approval requests of the flow, not by editing the contract, and the guard (ADR-004) locks the business columns after Draft anyway. Why the Requester has User level: a requester sees and edits only own contracts, and the guard already lets only a Draft or Rejected contract be deleted.

## What the plug-ins need, and what the roles therefore do not need

| Action | Done by | Privilege needed by the user |
|---|---|---|
| Number generated on Create, counter updated | plug-in, SYSTEM | none on the counter |
| USD value frozen, currency rate read | plug-in, SYSTEM | none |
| Approval steps built from the matrix and the assignments | plug-in, SYSTEM | none on steps, matrix, assignments |
| Approval requests, step marks, final status | flow, identity of the flow connection | see the trade-off below |

## Trade-offs and what is NOT decided

- **Flow identity.** The flows run with the owner's connection (a manager account). That keeps these roles simple, but all automation depends on one person's account and runs with more power than any project role. Moving the flows to a service identity with a dedicated role is **not decided here**.
- **Column security is not decided.** The financial columns (Value, the frozen USD value, the exchange rate) could be secured with column security profiles. Learn says that a secured column is unreadable for every user without a profile except System Administrators, and that system columns, lookups and primary name columns cannot be secured. **Its effect on the freezing plug-in, on the guard (which reads a PreImage) and on the flow was not tested**, so no column is secured. Deferred.
- **The Requester cannot see the approval steps** of own contracts (owner decision, 2026-10-22). The steps table is organization-owned, so its level can only be Organization or None, and Organization would show every contract's steps to every requester. The cost: no direct steps subgrid on the contract form for a requester. **Plan for the Timeline component (phase 6): it will not read the steps table directly. It will call a Custom API that runs under the SYSTEM identity and returns only the steps of the contracts that the calling user is entitled to read** (the check of the caller's right to read the contract is made inside the Custom API). The Custom API does not exist yet; its design, and how it decides what the caller may read, are not decided here (not built, not tested).
- **Cascade delete of a Draft contract that still has steps** (after a withdrawal the steps of the earlier round stay): whether the Requester's Delete on the Contract is enough, without a Delete privilege on the steps, was **not verified** (Learn pages read do not say). It can only be tested with a test user that has the role; no role is assigned in this work. The worst case is a refused delete of such a Draft.
- **Basic privileges for an app user (not tested).** The roles may lack the core privileges that come in the Basic User role (for example reading the user, organization and business unit tables) and access to the model-driven app. **Which ones are missing will be found by testing with an application user** (the behavioral test records the literal error of anything that fails), and **only what is needed will be added, nothing more** (owner decision). Until then the project roles are not a complete set for an interactive user.
- **Least privilege is relaxed by the platform baseline** (see "Result of the creation"): each role carries nine extra privileges at Organization level that were not requested.
- **Finance maintains the counterparties, the Admin also deletes them.** Both are design choices (least privilege vs convenience); the owner can change the table before the roles are created.
- Because only the Contract is user-owned, the Requester's lookup to a counterparty needs Append on the Contract and Append To on the Counterparty (Learn: Append / Append To); the roles include both. Not tested with a real user.

## What was verified, and how

| Claim | Source |
|---|---|
| Ownership of the six tables; only the Contract is user-owned | script, `EntityDefinitions` |
| Organization-owned tables: privileges exist only at Global, and there are no Assign / Share for them; the Contract has Basic, Local, Deep, Global, Assign, Share | script, flags of the `privileges` rows |
| Privilege names and their letter case | script, `privileges` rows |
| Both bypass privileges exist and can be given only at Global | script; Learn |
| `prvBypassCustomBusinessLogic` is needed by `BypassBusinessLogicExecution` and `BypassBusinessLogicExecutionStepIds`; only System Administrator has it by default; it cannot be added in the role designer | Learn ("Bypass custom Dataverse logic") |
| `AddPrivilegesRole` is bound to `roles(<id>)` with a `Privileges` collection of `RolePrivilege` (`PrivilegeId`, `Depth`, `BusinessUnitId`, `PrivilegeName`); Global is `3` | Learn |
| A role has `name`, `description`, `isinherited`, a `businessunitid` lookup; the privileges are in the navigation `roleprivileges_association` | Learn (role entity type) |
| Table privileges (Create, Read, Write, Delete, Append, Append To, Assign, Share) and the access levels | Learn ("Security roles and privileges") |
| Column security: not applied to System Administrators; a secured column is closed to everyone without a profile; system columns, lookups, primary name columns cannot be secured | Learn ("Column-level security") |
| The design rules (no Assign / Share, no counter privilege, org-owned only Global, User only for the Requester on the Contract) | unit tests, 16 tests |
| Both approval flows OFF; no role named Muwafaqa exists yet; one root business unit; the solution exists | script, `--mode=check` |
| Every one of the 40 grants of the design resolves to one privilege row and is allowed at its depth | script, `--mode=check` |

**Not verified (marked here so that nothing is assumed):** the numbers of Basic / Local / Deep in `Depth` (the SDK enum gives 0, 1, 2; only Global = 3 was read in Learn; this work uses only Basic = 0 and Global = 3); the values of `privilegedepthmask` (1, 2, 4, 8 is the expected mapping; `--mode=verify` fails on any other value instead of assuming); that the header `MSCRM.SolutionUniqueName` puts a role into the solution (it is used for the plug-in steps in this project; `--mode=verify` checks the solution membership of each role, component type 20); that omitting `BusinessUnitId` in `AddPrivilegesRole` is accepted (the Learn example omits it); `ReplacePrivilegesRole` (not used: a role that differs from the design stops the script).

## Result of the creation (2026-10-22)

- **Connection:** a 3-minute window met the environment rule (environment DNS 0 of 36, GET 0 of 36; the neutral host 6 of 36 as a diagnostic only). Both approval flows were read OFF before and after.
- **`--mode=create` (script):** four roles created in the root business unit and in the solution, HTTP 204 for each role and for each `AddPrivilegesRole`, nothing retried: Requester 8 privileges, Approver 3, Finance 9, Admin 20 (40 in total, as approved).
- **First `--mode=verify` failed, as it should:** each role also held **nine privileges that were not in the request**, the same nine in all four roles, all at Organization (Global): `prvReadSdkMessage`, `prvReadSdkMessageProcessingStep`, `prvReadSdkMessageProcessingStepImage`, `prvReadPluginType`, `prvReadPluginAssembly`, `prvReadSharePointDocument`, `prvReadSharePointData`, `prvWriteSharePointData`, `prvCreateSharePointData`. Nothing else differed. The negative check was clean (no `prvBypass*`, no counter privilege, no Assign or Share), the four roles were in the solution, and they had no members. Stored totals 17 / 12 / 18 / 29 = designed + 9.
- **What is known about the nine (script, read only):** they were added after the roles were created (the roles were modified seconds after `createdon`) and not by the `AddPrivilegesRole` request; `prvReadSdkMessage` is held by 121 roles and the two SharePointData write privileges by 124 roles of the environment, so they look like a default of the platform for new roles. **The cause is not documented and was not tested.**
- **Decision (owner): option (a).** The nine are a **platform baseline that new roles get**. `--mode=verify` now tolerates exactly these nine **by name and only at Global depth** (`PLATFORM_BASELINE` in `scripts/lib/security-roles.mjs`, 16 unit tests): any other privilege outside the design fails the verification, and a baseline name at another depth (or at an unknown depth) fails too. They are tolerated, not required, so that the controlled removal below still verifies.
- **Second `--mode=verify` (read only, no write): 18 PASS, 0 FAIL, 0 OBS.** Each role equals its design plus the nine at Global (17 = 8 + 9, 12 = 3 + 9, 18 = 9 + 9, 29 = 20 + 9); the depths stored are User only for the Requester on the Contract and Organization everywhere else; all four roles are in the solution; isinherited is 1; 0 user and 0 team members; the negative check found nothing. The `privilegedepthmask` values read were all in {1, 2, 4, 8}.
- **Concession on least privilege (owner-accepted):** every project role can read the plug-in metadata tables (SdkMessage, SdkMessageProcessingStep and Image, PluginType, PluginAssembly), read the SharePoint document and data tables, and **create and write SharePoint data**, all at Organization level. None of these is a project table. This is wider than the design and is accepted for now.
- **Removing the nine (option b) is postponed as a controlled experiment after the behavioral test with an application user:** remove them from a role, run `--mode=verify` again, and test that the role still works without them. Until then they stay. Whether the platform re-adds them on a later change of a role is not known.
- **Not done:** no role was assigned to any user and no flow was touched.

## Behavioral test (prepared, not run)

`scripts/test-security-roles.mjs` (modes `plan`, `baseline`, `run`, `cleanup`, `--dry-run`) will test each role with a Dataverse **application user** (service principal) that the owner creates. Authentication is the client credentials flow; the tenant id, client id and secret come **only** from the environment variables `MWF_TEST_TENANT_ID`, `MWF_TEST_CLIENT_ID` and `MWF_TEST_CLIENT_SECRET`; their values are never printed, never written to a file or a log, and when one is missing the script prints only the names that are missing. The admin account (the one that runs the other scripts) assigns and unassigns **one project role at a time** to the application user through the Web API, waits for the privilege cache by polling a read as the application user, runs the cases of that role, and always unassigns in a `finally` block. Rows use the prefix `TEST-TMP-SEC`; cleanup uses the admin account (the administrative bypass for a Pending contract) and restores the counters. Both flows stay OFF. Cases and the literal error message of everything that fails because of a missing basic privilege are recorded as PASS, FAIL or OBS; nothing is assumed. See the plan in the script header and in `--mode=plan`.

## Implementation

`scripts/create-security-roles.mjs`, modes:

- `check`: read only. Flows OFF, ownership, every privilege found by name and allowed at its depth, design rules, existing roles, root business unit, solution.
- `create`: runs `check`, then for each role that does not exist posts the role (into the solution) and adds its privileges. Idempotent: a role equal to the design is left alone; a role that differs stops the run. `--dry-run` reads and prints the requests and sends nothing. Needs `--confirm-mutates-environment`.
- `verify`: read only. For each role the privileges and depths really stored (`roleprivileges`), the comparison with the design (plus the nine tolerated platform-baseline privileges, by name and only at Global), the solution membership, 0 user and 0 team members, and the **negative check**: no `prvBypass*`, no privilege on the counter table, no Assign / Share, in any of the four roles.
- `cleanup`: deletes only the four roles named in the design, and only when no user and no team is a member.

Before every write: 3 consecutive successful reads, and a write is never retried. No id, host or address is printed.

## Consequences

- The four roles exist in the environment and in the solution, unassigned. Assigning them to a test user and exercising the submission path with that user is the behavioral test (prepared, not run); it would also settle the cascade-delete and the basic-privilege questions above.
- The roles will appear in `src/` at the next `pac solution sync` (the sync scripts and the scrub step are unchanged). They are not in `src/` yet.
- Open: flow identity, column security, the Timeline Custom API (SYSTEM identity, steps of the contracts the caller may read), cascade delete with a restricted Requester, the basic privileges an app user needs, and the removal of the nine platform-baseline privileges.
