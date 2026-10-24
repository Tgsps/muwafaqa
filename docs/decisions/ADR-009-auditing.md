# ADR-009: Dataverse auditing

- **Status:** **Accepted: applied and tested with the admin account on 2026-10-24.** Organization on (retention 365 days, provisional), the five tables and the four lookup columns audited, the Admin role holds the two audit-read privileges; `test-auditing.mjs` gave 23 PASS, 0 FAIL, 6 OBS ("Result of the behavioral test"). **Not tested:** a change of `mwf_approverassignment.mwf_user`, changes by a non-admin user or an application user, the volume of the 61 platform tables under real use (measured in quiet periods only), and the other items at the end. The solution files in `src/` are synchronized in a separate commit.
- **Date:** 2026-10-24
- **Related:** [ADR-004](ADR-004-contract-state-guard.md) (guard), [ADR-007](ADR-007-approval-chain.md) (chain, flow v2), [ADR-008](ADR-008-security-roles.md) (roles), `scripts/lib/auditing.mjs`.

## Context

The contracts, the approval steps, the approval matrix, the approver assignments and the counterparties carry decisions with money and authority behind them. Today nothing records who changed what. The environment state read on 2026-10-24 (script, read only):

- The organization switch is **off** (`isauditenabled` false), the retention period is **not set** (null), read audit and user access audit are off.
- None of the five project tables is audited (`IsAuditEnabled` false, `CanBeChanged` true). **Every custom column is already audited, except the five lookups** (`mwf_counterpartyid` of the contract, `mwf_contract`, `mwf_actualapprover` and `mwf_originalapprover` of the step, `mwf_user` of the assignment). Of the system columns, `ownerid`, `statecode`, `statuscode`, `transactioncurrencyid` and `exchangerate` are on; `createdon`, `modifiedon`, `createdby`, `modifiedby` and the primary keys cannot be audited (`CanBeChanged` false).
- **61 tables of the platform are audited already** (for example the approvals table that the flows use). Turning the organization switch on makes all of them write audit rows too.
- The audits table is empty and readable by the admin account.

## Decision (owner, 2026-10-24; changeable if something below prevents it)

1. **Organization:** `isauditenabled` = true; `auditretentionperiodv2` = **365** days (a **provisional** assumption, stated here on purpose); `isreadauditenabled` = false; `isuseraccessauditenabled` = false.
2. **Tables:** `mwf_contract`, `mwf_approvalstep`, `mwf_approvalmatrix`, `mwf_approverassignment`, `mwf_counterparty`. **Not** the Contract Number Counter: the SYSTEM plug-in writes it on every contract creation (high volume, no business value); its effect is visible in the number of each contract.
3. **Columns** (the principle: every column the design defines is audited; what is left out is named with the reason):
   - **Turn on (4 lookups, off today):** `mwf_contract.mwf_counterpartyid` (who the contract is with), `mwf_approvalstep.mwf_actualapprover` (who decided), `mwf_approvalstep.mwf_originalapprover` (who the step was assigned to), `mwf_approverassignment.mwf_user` (who approves for a role: the most sensitive configuration of the chain).
   - **Left off on purpose:** `mwf_approvalstep.mwf_contract`: the link to the parent contract is set once by the plug-in when the step is created and never changes.
   - **Already on, not touched:** all the other custom columns, and the system columns `ownerid`, `statecode`, `statuscode`, `transactioncurrencyid`, `exchangerate`. The system columns `importsequencenumber`, `overriddencreatedon`, `owningbusinessunit`, `organizationid` are on and left as they are (they do not change in normal operation; fewer writes). `mwf_value_base` (the base-currency amount, derived from `mwf_value`) stays on: it adds some noise and is not turned off, to change as little as possible.
   - **Cannot be audited:** `createdon`, `modifiedon`, `createdby`, `modifiedby`, the primary keys (`CanBeChanged` false). The audit row itself records who and when.
4. **Reading:** only the **Admin** role gets `prvReadAuditSummary` and `prvReadRecordAuditHistory`. Both exist and can be given **only at Organization level** (script, metadata of `privileges`). Admin goes from 20 to **22** privileges ([ADR-008](ADR-008-security-roles.md); **applied on 2026-10-24** with `--mode=add-missing --role=Admin`; four of the removed baseline privileges came back and were removed again, see ADR-008). No other role gets them. Nobody gets `prvDeleteRecordChangeHistory`, `prvDeleteAudit` or the partition privileges; deleting audit data stays with the System Administrator account.

## What Learn says about changing the configuration (read 2026-10-24; literal where it matters)

- **A table or a column is changed with PUT of the whole definition, not PATCH.** Tables: "You can't use the `PATCH` method to update data model entities. ... you must use the `PUT` method when updating data model entities and be careful to include all the existing properties that you don't intend to change. You can't update individual properties." Columns: "data model entities are updated using the HTTP `PUT` method with the entire JSON definition of the current item. This pattern applies to entity attributes and entities."
- **`MSCRM.MergeLabels`:** "include a custom `MSCRM.MergeLabels` request header to control how any labels in the update are handled ... If you don't include a `MSCRM.MergeLabels` header, the default behavior is as if the value were `false` and your update removes any other localized labels." Set it to `true` (Learn's sample does).
- **The definition is read first, changed, and sent back whole:** "Typically, you retrieve the JSON definition of the table or column definition and modify the properties before you send it back." For a column the sample reads with the cast: `GET .../EntityDefinitions(LogicalName='new_bankaccount')/Attributes(LogicalName='new_boolean')/Microsoft.Dynamics.CRM.BooleanAttributeMetadata` and writes `PUT .../EntityDefinitions(LogicalName='new_bankaccount')/Attributes(LogicalName='new_boolean')` with `"@odata.type": "Microsoft.Dynamics.CRM.BooleanAttributeMetadata"` in the body. The table form is `PUT .../EntityDefinitions(LogicalName='new_bankaccount')`.
- **The property:** `IsAuditEnabled` is a managed property: `"IsAuditEnabled": { "Value": true, "CanBeChanged": true, "ManagedPropertyLogicalName": "canmodifyauditsettings" }`. Only `Value` is changed.
- **Publishing:** "Changes don't take effect until you publish the table customizations": `POST .../PublishXml` with `{ "ParameterXml": "<importexportxml><entities><entity>account</entity></entities></importexportxml>" }`, HTTP 204.
- **Organization settings** are plain properties of the single Organization row: `PATCH [Organization URI]/api/data/v9.2/organizations([Organization ID])` with `If-Match: *` (Learn's sample sets `auditsettings`; `isauditenabled`, `auditretentionperiodv2`, `isreadauditenabled`, `isuseraccessauditenabled` are columns of the same table). Valid retention: 1 to 365,000 days, -1 for forever, default 30. You need the System Administrator or System Customizer role; the changes to the audit configuration are themselves audited.
- **Reading the history:** `audits` table (columns `operation` 1 Create, 2 Update, 3 Delete, 4 Access; `action`; `createdon`; `_userid_value`; `_callinguserid_value` when impersonating; `_objectid_value`; `objecttypecode`; `transactionid`); `RetrieveRecordChangeHistory(Target=@target,PagingInfo=@paginginfo)` with the aliases in the query string; `audits(<id>)/Microsoft.Dynamics.CRM.RetrieveAuditDetails` for the old and new values (`AttributeAuditDetail.OldValue/NewValue`). Learn warns that **the Web API result of `RetrieveRecordChangeHistory` does not include the `AuditRecord`**, so the user and the time come from the audits table. The privileges for these calls are `prvReadAuditSummary` (the audits table) and `prvReadRecordAuditHistory`.
- **Deleting audit data:** the audits table cannot be deleted from directly; `DeleteRecordChangeHistory` (privilege `prvDeleteRecordChangeHistory`), `BulkDelete` on the audits table, and `DeleteAuditData` (for customer-managed encryption keys, partitions by quarter) exist. Audit rows of a record are not removed by deleting the record (Learn: not stated; the test will show it for our tables).
- **Retention:** "Each audit log is stamped with the currently active retention period. Changing the retention period here doesn't change the retention period for already existing records." Logs are deleted continuously once they exceed the period.
- **Delay and storage:** "Audit logs might show up with a delay ... because audit logs are stored in the Dataverse log storage and no longer in the database storage"; audit logs "consume log storage capacity". Audit data is not available through the TDS endpoint.
- **Solutions:** Learn's note says to manage the table and column audit configuration "as part of a solution" (add the tables to the solution, publish, export). **It does not say that the organization settings travel with a solution**; they are properties of the Organization row. **Not verified**, so this ADR assumes they do NOT travel and the script applies them again in each environment.

## Trade-offs and consequences

- **Storage and cost.** Audit rows use log capacity. The 365-day retention is provisional (nothing in the data shows what is right); it applies only to rows written after it is set. The volume of **our** rows should be small (configuration and contract changes), but turning the organization switch on also starts the audit rows of **61 platform tables** that are audited by default, among them the approvals table that the flows write (request and response, which can carry comments). That volume is not measured; the test records how many audit rows the whole environment wrote during the test. Review the log storage after a week.
- **Deleting audit data is deliberately hard.** Only special messages delete it, and nobody but the System Administrator account is meant to. Consequence for the tests: the audit rows of test records stay in the audits table; they are not deleted by the scripts.
- **Delay.** Rows are not instant (Learn says they can appear with a delay). The real delay is measured by `test-auditing.mjs` (it polls every 10 s, at most 10 minutes) and recorded; no code or process may assume an immediate row.
- **Who is recorded for plug-in changes is not known yet.** The plug-ins write the round, the frozen USD value and the steps (with the SYSTEM service for the steps). Whether those appear in the same audit row as the user's status change, and under which user, is exactly what the test must show; it is not assumed.
- **Changing a definition is a whole-definition PUT**: a mistake can change more than the audit flag. The script therefore reads the whole definition, changes only `IsAuditEnabled.Value`, writes it, reads it again and compares with a deep diff; **any other difference stops the script before anything else is written**. It starts with one low-risk table (the matrix). The PUT of a whole definition and the cast read of a column follow Learn's samples and are **not tested yet**; a refusal (4xx) stops the script and no other form is tried.
- **PublishXml** publishes the customizations of that table. If the table had unpublished customizations they would be published too (none are expected).
- **The roles are audited only if the `role` table is audited**, which this ADR does not do; the privilege changes of the project roles are therefore recorded by the scripts' logs and ADR-008, not by Dataverse.
- **Audit settings in other environments.** The table and column flags are in the table and column definitions, so they come with the solution (per Learn's note; not tested by an import). The organization settings and the Admin role's two privileges (a role is exported with its privileges, `src/Roles/`) must be checked after an import; `configure-auditing.mjs --mode=check` does it.

## Deviation observed on 2026-10-24: the no-op PUT of a column changes `ModifiedOn`

**What happened (script).** The five tables were switched on with the procedure of this ADR: for each, the whole definition was saved outside the repository, a PUT of the unchanged definition left **no difference at all** in the definition read before and after (0 differences), and then the real PUT changed only `IsAuditEnabled.Value` (1 difference, 0 unexpected), followed by PublishXml. For the first lookup column (`mwf_approverassignment.mwf_user`) the same no-op PUT left **one** difference: the **top-level `ModifiedOn`** (from the date the column was created to the time of the PUT). The script stopped as designed and PUT the saved definition back; that restore is itself a PUT, so `ModifiedOn` moved again, and a read showed that the column equalled the backup in everything except `ModifiedOn` and that `IsAuditEnabled` was still false (the real change had not been made).

**What is known and what is not.** Observed: a no-op PUT of a table definition changes nothing; a no-op PUT of a column definition changes `ModifiedOn` and nothing else. Why the two differ is **not confirmed by Learn** (the pages read do not mention `ModifiedOn` in the update samples; the sample responses show it as a property of the column definition), so no explanation is stated here. The single observation is on one column.

**Decision (owner, 2026-10-24).** `ModifiedOn` is treated as a field the platform maintains, in the comparisons of **column** definitions (no-op, after the change, after a restore). The exception is **deliberately narrow**: only the **top-level** property `ModifiedOn`, only for a **column** definition (`relevantDiffs` in `scripts/lib/auditing.mjs`, with a unit test that excuses nothing else: not a nested `ModifiedOn`, not another spelling, not another property, not a table definition). Any other difference stops the script, the saved definition is PUT back, and no other form of the request is tried.

**Cost.** The proof "nothing else changed" is slightly weaker: a real change of `ModifiedOn` itself would be invisible. It is a timestamp with no behavior, which is why the owner accepted it.

## Result of the application (2026-10-24, admin account, both flows OFF)

Every write went through the gate of this project (a fresh 3-minute window that met the environment rule, 3 consecutive successful reads before each write, no write retried, no network error). For every table and column definition: the whole definition was saved outside the repository, a PUT of the unchanged definition was made, then only `IsAuditEnabled.Value` was changed, the definition was read again and compared with a deep diff, then PublishXml.

| Step | Result (script) |
|---|---|
| `mwf_approvalmatrix` (first, low risk) | no-op PUT: 0 differences; the change: 1 difference (`IsAuditEnabled.Value`), 0 unexpected; PublishXml; read back ON |
| `mwf_approverassignment`, `mwf_counterparty`, `mwf_approvalstep`, `mwf_contract` | the same four checks, one table at a time: all passed |
| Lookup columns `mwf_approverassignment.mwf_user`, `mwf_contract.mwf_counterpartyid`, `mwf_approvalstep.mwf_actualapprover`, `mwf_approvalstep.mwf_originalapprover` | the first attempt on `mwf_user` stopped at the no-op PUT (only `ModifiedOn` differed; see the deviation above); after the narrow `ModifiedOn` rule, all four passed with 0 relevant differences in the no-op PUT and one difference (`IsAuditEnabled.Value`) in the change |
| Organization | `isauditenabled` true, `auditretentionperiodv2` 365, `isreadauditenabled` false, `isuseraccessauditenabled` false (read back) |
| Noise of the platform tables, 3 minutes after the switch (flows OFF, no activity) | 1 audit row in the whole environment: the organization change itself ("Audit Change at Org Level"); 0 rows from the 61 platform tables and 0 from ours |
| Admin role | `add-missing --role=Admin` added `prvReadAuditSummary` and `prvReadRecordAuditHistory` at Organization level (22 designed privileges); four of the nine removed baseline privileges came back and were removed again (see [ADR-008](ADR-008-security-roles.md)); the default `verify` passes (22 PASS, 0 FAIL) |

State after the application (`configure-auditing.mjs --mode=verify`: 9 PASS, 0 FAIL, 1 OBS): organization on; the five tables ON; the four lookup columns ON; `mwf_approvalstep.mwf_contract` and the Contract Number Counter table off on purpose. **`mwf_approverassignment.mwf_user` is audited, but a change of it was NOT tried** (nothing may change who approves).

## Result of the behavioral test (`scripts/test-auditing.mjs`, admin account)

**23 PASS, 0 FAIL, 6 OBS.** A temporary matrix row (create, edit, delete) was used instead of a real one; the assignment row was renamed and restored (restored and read back); a counterparty and a contract went through create, edit, submit, withdraw and delete. Cleanup and check-clean passed (no `TEST-TMP-AUD` row, 11 contracts, 0 steps, 110 matrix rows, 5 assignments, counters restored).

The six OBS, as printed:

1. `plugin: the plug-in changes (round, frozen USD) are in the SAME audit row as the status change [true]` The approval round, the frozen USD value and the status of the submission are in one `Update` row.
2. `plugin: the audit row that shows the plug-in change was made by [admin]` That row carries the **admin account** as user, not SYSTEM: the PreOperation writes of the plug-ins that run inside the user's own Update are recorded as the user's change.
3. `history: the details returned include a name change [true]` `RetrieveRecordChangeHistory` returned the name change; it returned 5 details for the 5 audit rows of the contract. Its Web API result has no `AuditRecord` (Learn), so who and when come from the audits table.
4. `steps: the steps deleted by the cascade have Delete audit rows [2 of 2; by admin,admin]` The cascade delete of the two steps is audited, under the admin account.
5. `lag: the real delay between an operation (audit createdon) and the moment the poll first saw its row [18 rows: min 18 s, median 35 s, max 58 s (polling every 10 s, so the figures are rounded up to that)]` The real delay. The poll started after the operations ended, so these are **upper bounds**, not the shortest possible delay: in each phase the poll finished with all expected rows within 83 and 86 seconds.
6. `volume: audit rows written in the whole environment during the test (ours included) [18 (ours: 18); the rest comes from the platform tables that are audited by default]` 18 rows in the whole environment, all ours, so the platform tables wrote 0 during the test.

**Who made each change.** Every direct change (counterparty, contract, temporary matrix row, assignment, and the deletes of the contract and the counterparty) is recorded under the admin account. **The two approval steps created by the chain builder (SYSTEM service)** have `Create` rows under the **SYSTEM user with the calling user set** (impersonation); their cascade deletes are recorded under the admin account.

**What changed.** The old and new values were read with `RetrieveAuditDetails` for: the counterparty name; the contract name; the contract value (1,000 to 25,000); the status (Draft to Pending, then back); the approval round (empty to 1); the frozen USD value (empty to 25,000); the temporary matrix row name; the assignment name (changed and restored).

**Rows seen (18):** counterparty Create, Update, Delete; contract Create, Update ×4, Delete; approval steps Create ×2, Delete ×2; matrix row Create, Update, Delete; assignment Update ×2.

**Noise of the 61 platform tables: measured only in quiet periods.** 0 rows in the 3 minutes after the organization switch and 0 during the test (about 3 minutes of activity of ours, flows OFF). This says nothing about the volume under real use (flows running, approvals, users).

## Order of work (as proposed; all steps were carried out on 2026-10-24)

1. `configure-auditing.mjs --mode=check`; 2. the matrix; 3. the other four tables; 4. the four lookup columns; 5. the organization; 6. `add-missing --role=Admin` and `verify`; 7. `test-auditing.mjs --mode=run`; 8. `pac solution sync` (separate commit). The tables were switched on before the organization on purpose: no audit row is written until the organization switch is on.

## Not tested / not known (nothing is assumed)

- **A change of `mwf_approverassignment.mwf_user`** (the column is audited; changing it was deliberately not tried).
- Changes by a **non-admin user or an application user**; whether the audit row then carries that user; impersonation of other kinds; bulk messages (`CreateMultiple`, `UpdateMultiple`); the **flows' own changes**.
- The volume of the **61 platform tables under real use**, the log storage used, retention deletion (365 days cannot be observed now).
- Read audit and user access audit (off), the audit of role or privilege changes (the `role` table is not audited), `DeleteRecordChangeHistory`, export of audit data, audit through the model-driven app.
- Whether the **organization settings travel with a solution** (assumed not) and an import into another environment.
- Whether the Admin role needs more than the two privileges to open "Audit History" in a model-driven app (the interactive path is not tested; the scripts use the Web API).
- Whether the audit rows of a deleted record survive a long time or are removed with the record: they were still readable minutes after the deletes, nothing more is known.

## What was verified, and how

| Claim | Source |
|---|---|
| Organization settings now (audit off, retention null, read audit off, user access off) | script, `organizations` |
| The five tables are not audited and can be changed; the counter too | script, `EntityDefinitions` |
| Which columns are on or off today, which cannot be audited | script, `Attributes` |
| 61 platform tables are audited already | script, `EntityDefinitions` filter |
| The two privileges exist and can be given only at Organization level | script, `privileges` flags |
| PUT of the whole definition, MergeLabels, PublishXml, the managed property, the organization PATCH, the audits columns and the read functions | Learn (pages listed above) |
| The pure logic (target, plan, definition diff, PublishXml body, audit-row reading) | unit tests, 23 |
| The role design with the two extra privileges (22 for Admin; only Admin; only those two; Organization depth) | unit tests, 158 in `scripts/` |
| `configure-auditing.mjs --mode=check`, `apply --dry-run` for all five tables, `test-auditing.mjs --dry-run`, `add-missing --dry-run` | script runs, nothing written (before the application) |
| The PUT of the whole definition of a table and of a column, with `MSCRM.MergeLabels`, then PublishXml, works; a no-op PUT of a table changes nothing; of a column changes only `ModifiedOn` | script, 9 definitions on 2026-10-24 |
| Audit rows appear 18 to 58 seconds after the operations (upper bounds); the plug-in changes are in the status row under the admin account; the steps of the builder are under the SYSTEM user with the calling user set | script, `test-auditing.mjs` |
