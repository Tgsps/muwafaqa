# ADR-008: Security roles of the project

- **Status:** **Accepted; the non-interactive path is tested, with the nine platform-baseline privileges removed.** The design was accepted on 2026-10-22 and the four roles exist and pass `--mode=verify` ("Result of the creation"). The behavioral test with a non-interactive application user was run on 2026-10-24: a first run (76 PASS, 0 FAIL, 4 OBS), then rounds 1 to 3 with the improved test (79 PASS with the nine present; after their removal Requester 40, Approver 22, Finance 25, Admin 28 PASS, 0 FAIL) ("Rounds 1 to 3"). **Not tested:** an interactive user in a model-driven app, the re-addition of the nine when a new role is created or a solution is imported, Share / Assign, secured columns, several roles at once, a business unit other than the root, and the re-reading after 30 minutes and on the next day.
- **Date:** 2026-10-22 (updated 2026-10-24: the Admin role gets the two audit-read privileges, ADR-009)
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
| Audit history (platform privileges `prvReadAuditSummary`, `prvReadRecordAuditHistory`) | - | - | - | R: **O** ([ADR-009](ADR-009-auditing.md); applied 2026-10-24) |

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
- **Cascade delete of a Draft contract that still has steps** (after a withdrawal the steps of the earlier round stay): **tested (script, case R8): the Requester deleted such a Draft with HTTP 204 and no step was left, without any Delete privilege on the steps.** Tested for a non-interactive application user only.
- **Basic privileges for an app user.** The roles may lack the core privileges that come in the Basic User role (for example reading the user, organization and business unit tables) and access to the model-driven app. **The behavioral test found no missing basic privilege for a non-interactive application user: every allowed case worked with the project role alone** (including creating a contract with lookups to the currency and the counterparty). **For an interactive user in a model-driven app this is NOT tested**; the missing ones will be found by testing with such a user and **only what is needed will be added, nothing more** (owner decision).
- **Least privilege and the platform baseline:** the platform added nine privileges at Organization level to each new role (see "Result of the creation"). They were **removed from all four roles and the roles were tested without them** for the non-interactive path ("Rounds 1 to 3"); whether they come back for a new role or after an import is not tested.
- **Finance maintains the counterparties, the Admin also deletes them.** Both are design choices (least privilege vs convenience); the owner can change the table before the roles are created.
- Because only the Contract is user-owned, the Requester's lookup to a counterparty needs Append on the Contract and Append To on the Counterparty (Learn: Append / Append To); the roles include both. Tested with the non-interactive application user (case R1: the contract with the counterparty lookup was created, HTTP 201).

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

**Not verified (marked here so that nothing is assumed):** the numbers of Basic / Local / Deep in `Depth` (the SDK enum gives 0, 1, 2; only Global = 3 was read in Learn; this work uses only Basic = 0 and Global = 3); the values of `privilegedepthmask` (1, 2, 4, 8 is the expected mapping; `--mode=verify` fails on any other value instead of assuming); that the header `MSCRM.SolutionUniqueName` puts a role into the solution (it is used for the plug-in steps in this project; `--mode=verify` checks the solution membership of each role, component type 20); that omitting `BusinessUnitId` in `AddPrivilegesRole` is accepted (the Learn example omits it); `ReplacePrivilegesRole` (not used: a role that differs from the design stops the script). Since the creation: the privilege cache showed a new grant for the application user within 0 to 11 s and a removal within 0 to 6 s in this test (script; not a guarantee).

## Update 2026-10-24: audit read for the Admin role (ADR-009)

Owner decision for [ADR-009](ADR-009-auditing.md): **only the Admin role** gets `prvReadAuditSummary` and `prvReadRecordAuditHistory`; no other role, and nobody gets `prvDeleteRecordChangeHistory`, `prvDeleteAudit` or the partition privileges. Both privileges exist and can be given only at Organization level (script, `privileges` flags). **The design now has 8 / 3 / 9 / 22 privileges** (Requester / Approver / Finance / Admin). It is implemented in `scripts/lib/security-roles.mjs` (`AUDIT_READ`, rule R8: only the Admin role, only those two names, only Organization depth) and checked by `--mode=check` and `--mode=verify`. **Applied on 2026-10-24: the Admin role has 22 privileges in the environment** (`--mode=add-missing --role=Admin`, one `AddPrivilegesRole` call; it never removes anything and refuses if the role differs from its design in anything else). `src/Roles/Muwafaqa Admin.xml` was synchronized in a separate commit and shows the 22 privileges. Not tested: that these two privileges are enough to open "Audit History" in a model-driven app (the scripts use the Web API).

**Applied on 2026-10-24 (script).** `add-missing --role=Admin` added the two audit-read privileges at Organization level (one `AddPrivilegesRole` call). Straight afterwards the Admin role held **26 privileges: the 22 designed plus 4 of the nine platform-baseline privileges that had been removed** (all at Organization): `prvReadSharePointDocument`, `prvReadSharePointData`, `prvWriteSharePointData`, `prvCreateSharePointData`. **The five that concern the plug-ins (SdkMessage, SdkMessageProcessingStep and Image, PluginType, PluginAssembly) did not come back.** The cause is **not known** (for example whether the SharePoint privileges are prerequisites of the audit privileges was not tested). The default `verify` (`--expect-baseline=none`) failed and detected it, as designed. The four were removed again with four `RemovePrivilegeRole` calls (HTTP 204 each); the default `verify` then passed (22 PASS, 0 FAIL; the stored counts are 8 / 3 / 9 / 22). **This answers the question "does the platform put them back when a role is changed later?" only partially: for ONE role and ONE kind of change (`AddPrivilegesRole`), the answer was yes for four of the nine.** Whether other changes (a later `AddPrivilegesRole` on another role, a role import, a solution import) do the same is not tested. `src/Roles/Muwafaqa Admin.xml` was synchronized afterwards (a separate commit) and shows the 22 privileges and none of the nine.

## Result of the creation (2026-10-22)

- **Connection:** a 3-minute window met the environment rule (environment DNS 0 of 36, GET 0 of 36; the neutral host 6 of 36 as a diagnostic only). Both approval flows were read OFF before and after.
- **`--mode=create` (script):** four roles created in the root business unit and in the solution, HTTP 204 for each role and for each `AddPrivilegesRole`, nothing retried: Requester 8 privileges, Approver 3, Finance 9, Admin 20 (40 in total, as approved).
- **First `--mode=verify` failed, as it should:** each role also held **nine privileges that were not in the request**, the same nine in all four roles, all at Organization (Global): `prvReadSdkMessage`, `prvReadSdkMessageProcessingStep`, `prvReadSdkMessageProcessingStepImage`, `prvReadPluginType`, `prvReadPluginAssembly`, `prvReadSharePointDocument`, `prvReadSharePointData`, `prvWriteSharePointData`, `prvCreateSharePointData`. Nothing else differed. The negative check was clean (no `prvBypass*`, no counter privilege, no Assign or Share), the four roles were in the solution, and they had no members. Stored totals 17 / 12 / 18 / 29 = designed + 9.
- **What is known about the nine (script, read only):** they were added after the roles were created (the roles were modified seconds after `createdon`) and not by the `AddPrivilegesRole` request; `prvReadSdkMessage` is held by 121 roles and the two SharePointData write privileges by 124 roles of the environment, so they look like a default of the platform for new roles. **The cause is not documented and was not tested.**
- **Decision (owner) at that time: option (a)** (superseded by the removal described in "Rounds 1 to 3"). The nine are a **platform baseline that new roles get**. `--mode=verify` now tolerates exactly these nine **by name and only at Global depth** (`PLATFORM_BASELINE` in `scripts/lib/security-roles.mjs`, 16 unit tests): any other privilege outside the design fails the verification, and a baseline name at another depth (or at an unknown depth) fails too. They are tolerated, not required, so that the controlled removal below still verifies.
- **Second `--mode=verify` (read only, no write): 18 PASS, 0 FAIL, 0 OBS.** Each role equals its design plus the nine at Global (17 = 8 + 9, 12 = 3 + 9, 18 = 9 + 9, 29 = 20 + 9); the depths stored are User only for the Requester on the Contract and Organization everywhere else; all four roles are in the solution; isinherited is 1; 0 user and 0 team members; the negative check found nothing. The `privilegedepthmask` values read were all in {1, 2, 4, 8}.
- **Concession on least privilege (owner-accepted):** every project role can read the plug-in metadata tables (SdkMessage, SdkMessageProcessingStep and Image, PluginType, PluginAssembly), read the SharePoint document and data tables, and **create and write SharePoint data**, all at Organization level. None of these is a project table. This was wider than the design and was accepted for the first run; it was superseded by the removal in "Rounds 1 to 3".
- **Removing the nine (option b) was done afterwards as a controlled experiment, role by role** ("Rounds 1 to 3"): remove them, run `--mode=verify` again, and test that the role still works without them. It worked for all four roles on the non-interactive path.
- **Not done:** no role was assigned to any user and no flow was touched.

## Behavioral test (non-interactive application user)

`scripts/test-security-roles.mjs` (modes `plan`, `baseline`, `run`, `cleanup`, `--dry-run`) tests each role with a Dataverse **application user** (service principal) created by the owner. Authentication is the client credentials flow; the tenant id, client id and secret come **only** from the environment variables `MWF_TEST_TENANT_ID`, `MWF_TEST_CLIENT_ID` and `MWF_TEST_CLIENT_SECRET`; their values are never printed or stored, and when one is missing only its name is printed. The admin account assigns **one project role at a time** through the Web API (`POST systemusers(<id>)/systemuserroles_association/$ref`), polls a read as the application user until the privilege cache shows the grant, runs the cases of that role, and removes the role in a `finally` block only (`DELETE .../systemuserroles_association/$ref?$id=<absolute url of the role>`, a form Learn documents next to the one with the key in parentheses; a 4xx answer stops the script and no other form is tried). Before each phase the script checks that the user holds nothing besides the role of that phase; the start state accepts no role or the Requester role only. Rows use the prefix `TEST-TMP-SEC`; both flows stay OFF; every write, also the writes of the application user, is preceded by 3 consecutive successful reads and is never retried.

## Result of the behavioral test (non-interactive application user)

Run on 2026-10-24 after a 3-minute connection window that met the environment rule (environment DNS 0 of 36, GET 0 of 36; the neutral host 0 of 36). Both flows were OFF before and after (v1 `modifiedon` unchanged). Authentication, roles, and the cleanup below are from the script output; nothing was retried and no network error occurred.

**Result: 76 PASS, 0 FAIL, 4 OBS.** The four OBS are: the Requester role was already held by the application user at the start (accepted by the start rule), and three denial probes on a record that does not exist (see "Reading the three OBS").

**Application user (read only, before the run):** one user for the client id, enabled, non-interactive (access mode 4), in the root business unit, holding the Requester role only; its team membership is the default owner team of the business unit, which holds no role.

**Per role (the error text of a refusal begins "Principal user (Id=<id>, type=8, roleCount=1, privilegeCount=N, accessMode='4 Non-interactive' ..."; N is the number of privileges of the role, the designed ones plus the nine of the platform baseline):**

| Role | privilegeCount | Allowed cases (all passed) | Refused cases (all refused, 403 unless noted) |
|---|---|---|---|
| Requester | 17 | R1 create a Draft with an existing Counterparty (HTTP 201, the number `PREFIX-NNNN` was generated); R2 read own; R3 edit own Draft; R4 submit; R7 delete an own Draft; R8 withdraw, then delete a Draft that still had steps; R12 read a Counterparty | R5 steps (read); R6 create a Counterparty; R7 delete a Pending contract (HTTP 400 from the guard: "Cannot delete a contract whose status is Pending Approval."); R9 matrix, assignments and counter (read and create); R10 the headers `MSCRM.BypassBusinessLogicExecutionStepIds` and `MSCRM.BypassBusinessLogicExecution: CustomSync`; R11 a contract owned by the admin (by id; the list query returned 0 rows) |
| Approver | 12 | A1 read contracts owned by someone else; A2 read the steps of a contract (2 returned); A3 read a Counterparty | A4 create a contract; A5 write a contract (same value); A6 write a step (same value) |
| Finance | 18 | F1 read the matrix and the assignments; F2 create a Counterparty; F3 edit it; F7 read a contract | F4 delete the Counterparty; F5 create in the matrix, write the matrix, write the assignments (same value); F6 read the counter; F7 write a contract |
| Admin | 29 | D1 create, edit and delete a matrix row; D2 edit an assignment (same value); D4 read a contract; D5 create, edit and delete a Counterparty; D6 read the steps | D3 the counter (read, create, write); D4 create a contract and write a contract |

- **R4 (script, read by the admin):** the submission by the application user returned 204; the contract became Pending Approval, round 1, with the frozen USD value (25,000) and **2 approval steps**. So the chain builder and the USD freeze, which use the SYSTEM service, work when the caller is a non-interactive application user holding only the Requester role. The fixture contract of the admin had its 2 steps in the same way.
- **R8 (script):** the Requester withdrew its Pending contract to Draft (204) and deleted it (204) with **0 steps left**, although the role has no Delete privilege on the steps. The cascade delete does not need that privilege (tested for this user type only).
- **No missing basic privilege:** every allowed case worked with the project role (plus the nine of the platform baseline) alone. In particular R1 created a contract with the lookups to the currency and the counterparty.
- **Bypass headers refused (R10):** both were answered 403 for the Requester, as the design requires.
- **Role switching:** each role was effective for the application user 0 to 11 s after the assignment (a read of contracts answered 200) and the read was refused again 0 to 6 s after the release; the release was read back (no project role held; members of the four roles equal 0) every time.

**Reading the three OBS:** the writes to the matrix, the assignments and the counter by the Requester were tried on a row that does not exist (to be sure that a refusal cannot change data). The platform answered HTTP 404 ("Entity ... With Id = <id> Does Not Exist"), so it looked the row up before checking the Write privilege, and **those three probes do not prove a refusal of Write by themselves**. For the same three tables the Requester's read and create were refused with 403, and the stored role has no privilege on them (verify), so the design is supported, but the direct refusal of Write is **not proven**. See the proposed change (a same-value write on an existing row).

**Cleanup and final state (script):** 3 contract rows and 2 counterparties deleted (the Pending one had been withdrawn to Draft by the test itself), the temporary matrix row had already been deleted by D1, the counter MNT restored 5 to 0 (refused 0); `--mode=cleanup` by the admin afterwards found nothing to remove. Check-clean: no `TEST-TMP-SEC` row, 11 contracts, 0 steps, 110 active matrix rows, 5 active assignments, counters 0. The application user holds **no** role, the four roles have **no** member, v1 and v2 are OFF. One side effect: case D2 wrote the same value into the Owner assignment row, so its `modifiedon` changed.

**Limits of this test (not tested):**
- an **interactive** user in a model-driven app (the basic privileges and the app access it needs);
- **Share and Assign** (forbidden by design; no execution test);
- **secured columns** (column security is not used);
- the **removal of the nine** platform-baseline privileges (done afterwards: "Rounds 1 to 3");
- the business unit hierarchy beyond the root business unit, teams that hold project roles, and users with several roles at once;
- the first run **cut every message at 220 characters**, so the sentence that names the missing privilege was not recorded (fixed in the rounds below: redact, then cut at 400);
- the Web API role association and release calls worked here, but Learn gives no statement about how long the privilege cache may take in general.

## Rounds 1 to 3 of 2026-10-24: improved test, removal of the nine platform-baseline privileges

**Changes to the test before these rounds (unit tested, 136 tests in `scripts/`):** `--roles=` runs only some phases; case R9 now tries a **same-value write on an existing row** of the matrix, the assignments and the counter (a refusal changes nothing, and it proves the refusal of Write directly); the refusal messages are **redacted first (host, organization name, every GUID, secrets) and then cut at 400 characters**, so that the sentence that names the missing privilege is visible. New commands in `scripts/create-security-roles.mjs`: `remove-baseline --role=` (one `RemovePrivilegeRole` call per baseline privilege that is there, idempotent, `--dry-run`, a 4xx stops at once and no other form is tried, nothing is retried) and `restore-baseline --role=` (one `AddPrivilegesRole` call at Global for the missing ones). Every round started with the usual gate: both flows read OFF, the data as in the previous report (11 contracts, 0 steps, 110 matrix rows, 5 assignments, counters 0, no `TEST-TMP` row), a new 3-minute window that met the environment rule (environment DNS 0 of 36 and GET 0 of 36), `NODE_OPTIONS` written in every command, and 3 consecutive successful reads before every write. No network error occurred in these rounds and nothing was retried.

**Round 1 (the nine still present, no role changed): 79 PASS, 0 FAIL, 0 OBS** for the four roles. The two earlier OBS kinds are gone: the user started with no role, so each role was assigned by the script, and the writes to the matrix, the assignments and the counter by the Requester on an **existing row with the same value were refused with HTTP 403**, so the refusal of Write is now proven directly. The refusals name the missing privilege, for example `prvWritemwf_approvalmatrix`, `prvWritemwf_ApproverAssignment`, `prvWritemwf_ContractNumberCounter`, `prvReadmwf_ApprovalStep`, `prvCreatemwf_approvalmatrix`, and for the bypass headers `prvBypassCustomBusinessLogic`. No expected refusal was accepted.

**Removal of the nine (rounds 2 and 3), one role at a time, each with the full cycle remove, verify, behavioral test of that role alone:** `remove-baseline` answered HTTP 204 for each of the 9 calls of each role (36 calls); the `RemovePrivilegeRole` body used is the usual form for an entity parameter (`{"Privilege": {"@odata.type": "Microsoft.Dynamics.CRM.privilege", "privilegeid": ...}}`; Learn names the parameter but gives no sample) and it was accepted at the first call. `verify` with `--expect-baseline=none` then showed none of the nine and the designed privileges unchanged.

| Role | Privileges before | After the removal | Behavioral test of the role | `privilegeCount` in the refusals |
|---|---|---|---|---|
| Requester | 17 | **8** | 40 PASS, 0 FAIL, 0 OBS | 8 (13 messages) |
| Approver | 12 | **3** | 22 PASS, 0 FAIL, 0 OBS | 3 |
| Finance | 18 | **9** | 25 PASS, 0 FAIL, 0 OBS | 9 |
| Admin | 29 | **20** | 28 PASS, 0 FAIL, 0 OBS | 20 |

Every allowed case of every role worked without the nine (including R1, the creation of a contract with the lookups to the currency and the counterparty, R4, the submission with the chain builder and the USD freeze, and R8, the cascade delete), and every expected refusal was refused (no leak). The final `verify --expect-baseline=none` over the four roles (read only, after the last test): 22 PASS, 0 FAIL, the stored counts are 8 / 3 / 9 / 20, none of the nine is present, the roles are in the solution, `isinherited` is 1, no role has a member, the negative check is clean (no `prvBypass*`, no counter privilege, no Assign or Share).

**The platform did not add the nine back within 5 minutes for the Requester** (read again 5 minutes after the removal, and again after the Requester had been assigned and released by the test). For the other three roles the nine were still absent when they were read again at the end of the session, some minutes after each removal. The reads after 30 minutes and on the next day were **not done yet**.

**Decision changed (owner):** the earlier decision "accept the nine as a platform baseline" (option a, above) is replaced by **"the nine were removed from all four roles and the roles were tested without them, for the non-interactive path"**. `verify` still knows the nine by name (`PLATFORM_BASELINE`) and its default is now `--expect-baseline=none`: it fails if any of the nine appears again, so a re-addition is detected; `all` and `any` remain available. The concession on least privilege recorded above no longer applies to the roles as they are now.

**Final state after the rounds (script):** the application user holds no role, the four roles have no member, v1 and v2 are OFF (v1 `modifiedon` unchanged), the test rows are removed (check-clean: no `TEST-TMP-SEC` row, 11 contracts, 0 steps, 110 matrix rows, 5 assignments), the counters are 0. Case D2 wrote the same value into the Owner assignment row in rounds 1 and 3, so its `modifiedon` changed.

**Not tested (limits that remain):**
- an **interactive** user in a model-driven app, with or without the nine (the whole test used a non-interactive application user);
- whether the nine are **added again when a new role is created or when the solution is imported** into another environment (not tested);
- **Share and Assign**, **secured columns**, **users with several roles at once**, and a **business unit other than the root**;
- the **re-reading after 30 minutes and on the next day**, which has not been done.

## Implementation

`scripts/create-security-roles.mjs`, modes:

- `check`: read only. Flows OFF, ownership, every privilege found by name and allowed at its depth, design rules, existing roles, root business unit, solution.
- `create`: runs `check`, then for each role that does not exist posts the role (into the solution) and adds its privileges. Idempotent: a role equal to the design is left alone; a role that differs stops the run. `--dry-run` reads and prints the requests and sends nothing. Needs `--confirm-mutates-environment`.
- `verify`: read only. For each role the privileges and depths really stored (`roleprivileges`), the comparison with the design, the nine platform-baseline privileges by name (`--expect-baseline=none|all|any`; **the default is `none`**: it fails if any of the nine is present, so a re-addition is detected), the solution membership, no member (except the application user of the behavioral test in the Requester role), and the **negative check**: no `prvBypass*`, no privilege on the counter table, no Assign / Share, in any of the four roles.
- `remove-baseline --role=` / `restore-baseline --role=`: the controlled experiment with the nine privileges (one `RemovePrivilegeRole` call per privilege / one `AddPrivilegesRole` call at Global; idempotent; `--dry-run`; a 4xx stops at once and no other form is tried).
- `cleanup`: deletes only the four roles named in the design, and only when no user and no team is a member.

Before every write: 3 consecutive successful reads, and a write is never retried. No id, host or address is printed.

## Consequences

- The four roles exist in the environment and in the solution. At the end of the behavioral test the application user holds **no** role and the four roles have no member. Assigning a role to a real user is a separate decision.
- The roles will appear in `src/` at the next `pac solution sync` (the sync scripts and the scrub step are unchanged). They are not in `src/` yet (the synchronization is prepared separately).
- Open: flow identity, column security, the Timeline Custom API (SYSTEM identity, steps of the contracts the caller may read), the basic privileges of an INTERACTIVE user in a model-driven app, Share and Assign, the re-addition of the nine when a new role is created or a solution is imported (the default `verify` would show it), and the reads after 30 minutes and on the next day.
