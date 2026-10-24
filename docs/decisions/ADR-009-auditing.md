# ADR-009: Dataverse auditing

- **Status:** **Proposed**, **partly applied**. Research and scripts were written on 2026-10-24. The same day the **table-level** audit flag of the five tables was switched on by `configure-auditing.mjs` (each time: backup, a no-op PUT with no difference, then only `IsAuditEnabled.Value` changed, PublishXml). The lookup columns, the organization switch, the Admin role's two privileges and the behavioral test were **not** done when this text was written; the results of the application are reported separately and this ADR is updated after the owner's review. The first column showed a deviation (next section).
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
4. **Reading:** only the **Admin** role gets `prvReadAuditSummary` and `prvReadRecordAuditHistory`. Both exist and can be given **only at Organization level** (script, metadata of `privileges`). Admin goes from 20 to **22** privileges ([ADR-008](ADR-008-security-roles.md), design updated, **not applied in the environment yet**: `create-security-roles.mjs --mode=verify` fails for the Admin role until `--mode=add-missing --role=Admin` is run). No other role gets them. Nobody gets `prvDeleteRecordChangeHistory`, `prvDeleteAudit` or the partition privileges; deleting audit data stays with the System Administrator account.

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

## Order of work (proposed; nothing is applied)

1. `configure-auditing.mjs --mode=check` (done, read only).
2. `apply --tables=mwf_approvalmatrix` (stop if the definition differs by anything else), `verify`.
3. `apply --tables=mwf_approverassignment,mwf_counterparty,mwf_approvalstep,mwf_contract --columns`, `verify`. No audit row is written yet: the organization switch is still off.
4. `apply --org` (the audit rows start, for our tables and for the 61 platform tables).
5. `create-security-roles.mjs --mode=add-missing --role=Admin` then `--mode=verify`.
6. `test-auditing.mjs --mode=run` (admin account; both flows OFF), report, then decide. Then a `pac solution sync` for the role change.

## Deviation observed on 2026-10-24: the no-op PUT of a column changes `ModifiedOn`

**What happened (script).** The five tables were switched on with the procedure of this ADR: for each, the whole definition was saved outside the repository, a PUT of the unchanged definition left **no difference at all** in the definition read before and after (0 differences), and then the real PUT changed only `IsAuditEnabled.Value` (1 difference, 0 unexpected), followed by PublishXml. For the first lookup column (`mwf_approverassignment.mwf_user`) the same no-op PUT left **one** difference: the **top-level `ModifiedOn`** (from the date the column was created to the time of the PUT). The script stopped as designed and PUT the saved definition back; that restore is itself a PUT, so `ModifiedOn` moved again, and a read showed that the column equalled the backup in everything except `ModifiedOn` and that `IsAuditEnabled` was still false (the real change had not been made).

**What is known and what is not.** Observed: a no-op PUT of a table definition changes nothing; a no-op PUT of a column definition changes `ModifiedOn` and nothing else. Why the two differ is **not confirmed by Learn** (the pages read do not mention `ModifiedOn` in the update samples; the sample responses show it as a property of the column definition), so no explanation is stated here. The single observation is on one column.

**Decision (owner, 2026-10-24).** `ModifiedOn` is treated as a field the platform maintains, in the comparisons of **column** definitions (no-op, after the change, after a restore). The exception is **deliberately narrow**: only the **top-level** property `ModifiedOn`, only for a **column** definition (`relevantDiffs` in `scripts/lib/auditing.mjs`, with a unit test that excuses nothing else: not a nested `ModifiedOn`, not another spelling, not another property, not a table definition). Any other difference stops the script, the saved definition is PUT back, and no other form of the request is tried.

**Cost.** The proof "nothing else changed" is slightly weaker: a real change of `ModifiedOn` itself would be invisible. It is a timestamp with no behavior, which is why the owner accepted it.

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
| `configure-auditing.mjs --mode=check`, `apply --dry-run` for all five tables, `test-auditing.mjs --dry-run`, `add-missing --dry-run` | script runs, nothing written |

## Not tested / not known (nothing is assumed)

- The PUT of a table or column definition (the very first real write will test it), the cast read of a lookup column, PublishXml for these tables, and whether the definition read before and after differs by anything but the flag.
- The real audit delay; which user is recorded for the plug-in changes and for the cascade delete of the steps; whether the plug-in changes share the audit row of the status change; whether the audit rows of a deleted record survive its deletion in our tables.
- The volume written by the 61 platform tables, the log storage used, retention deletion (365 days cannot be observed).
- Changes by a non-admin user or an application user, impersonation, bulk messages, the flows' own changes, read audit, user access audit, the audit of role changes, `DeleteRecordChangeHistory`, export of audit data.
- Whether the organization settings travel with a solution (assumed not), and an import into another environment.
- Whether the Admin role needs more than the two privileges to open "Audit History" in a model-driven app (the interactive path is not tested; the scripts use the Web API).
