# ADR-011: Obligations and renewal / due alerts

- **Status:** **Proposed.** The direction was decided with the owner in chat (2026-11-03); this document is not yet reviewed or approved, and **nothing in it has run against the environment**. The two tables do not exist. The scripts of the section "Offline implementation" are written and unit tested only.
- **Date:** 2026-11-03
- **Related:** [ADR-010](ADR-010-reminders-and-escalation.md) (claim-first, cap per run, overlapping runs), [ADR-004](ADR-004-contract-state-guard.md) (Contract State Guard), [ADR-009](ADR-009-auditing.md) (auditing), [ADR-008](ADR-008-security-roles.md) (roles), [ADR-007](ADR-007-approval-chain.md) (alternate keys on the chain tables).
- Tags: (from Learn), (script), (unit), (assumption), (owner), (not tested). Statements tagged **(from Learn, as stated; not re-read in this session)** were given by the owner with a Learn reference and have not been fetched again while writing this document.

## Context

The project specification asks for alerts on contract renewals and on obligations. The data model lists "Obligation" (child table of the contract), "Renewal Type" and "Notice Period" as later items (`docs/data-model-phase1.md`, priority 3). **Today neither the Obligation table nor the columns "renewal type" and "notice period" exist on the contract** (script, schema read); `mwf_expirydate` (Date Only) and the status In Force exist.

Two alerts need a record that "this alert was already sent":

- the **Contract State Guard** (ADR-004) blocks edits to an approved contract, so a claim column such as `mwf_remindedon` **cannot live on the contract** (it would be rejected, or it would need a bypass);
- **overlapping runs were measured on 2026-10-29**: runs of 16.6 to 84.8 s on a 1-minute interval (script, flow document section 8). Two runs can look at the same candidate.

## Decision

1. **Table `mwf_obligation`** (audit ON): `mwf_contract` (lookup to the contract, DELETE cascade), `mwf_party` (Choice: First Party, Second Party), the description (the primary name column `mwf_name`), `mwf_duedate` (Date and Time, user-local behavior as `mwf_decidedon`, so stored in UTC), `mwf_status` (Choice: Open, Done, Disputed). **"Overdue" is not stored**: it is derived (Open and `mwf_duedate` before now).
2. **Table `mwf_alertlog`** (service table, **audit OFF**, **no project role gets any privilege on it, in particular no delete**): one row per alert. One string column `mwf_alertkey`, set to required level ApplicationRequired (whether the server enforces that level for a Web API write is **unverified**, see "The null and empty key problem") with an **alternate key** `mwf_AlertLogKey` on it. The primary name column `mwf_name` is required by the platform; the flow writes the same text into it, for people only.
3. **The key:** `<sourceGuid>-<TYPE>-<yyyyMMdd>`. TYPE is one of `OBLIGATION-DUESOON`, `OBLIGATION-OVERDUE`, `RENEWAL-T90`, `RENEWAL-T30`. The date is the **due date** (obligations) or the **expiry date** (renewal), so **a changed date gives a new key and the alert is armed again**. The key must **never contain** `/ \ < > * % & : ? + #` and must **never be null or empty**. Builder and validator: `scripts/lib/alert-key.mjs` (unit tested, one test per forbidden character).
4. **Claim = INSERT the AlertLog row first, then send.** A duplicate-key rejection means "already claimed: skip, send nothing". **Concurrency Control is not used** (Learn: it cannot be undone, and removing it needs deleting and re-adding the trigger) **(from Learn, as stated; not re-read in this session)**; the alternate key does the work that the setting would have done.
5. **Duplicate detection reads the error code in the BODY of the response** (`DuplicateRecordEntityKey`, `0x80060892`), **not the HTTP status**. Learn does not document the HTTP status for this error, and its pages disagree for a different duplicate mechanism (412 against 500) **(from Learn, as stated; not re-read in this session)**. The status is to be **MEASURED** by `scripts/test-alertlog-uniqueness.mjs` and recorded here. **This ADR does not claim 412.**
6. **The key index is built asynchronously** (Pending, In Progress, Active, Failed; `ReactivateEntityKey` exists) **(from Learn, as stated; not re-read in this session)**. **Every script and every flow run must refuse to run unless `EntityKeyIndexStatus` is Active.** The scripts do (`keyGate`, unit tested); the flow must do the same before its first claim (not built). After a solution import the key is not in effect until the background job has finished (**not tested here**).
7. **Renewal alerts:** only contracts **In Force**; a contract whose renewal type is none is skipped; the **notice deadline = expiry date minus the notice period in days**; two alerts, at **90 and 30 days BEFORE THE NOTICE DEADLINE** (owner's interpretation). The alternative, counting the 90 and 30 days from the **expiry date**, is **recorded as not chosen**.
8. **Recipient:** the **owner of the contract**, always (also for obligations of the second party). **Disputed obligations are not alerted.** Due dates are entered by hand as **final dates**; there is no working-day calendar.
9. **Parameters:** the due-soon lead time is a **required named parameter per variant with no default in code**. **Test variant: 5 minutes** (a test constant chosen so that a seeded row becomes due-soon within one test window; it is not a business value). **Production variant: OPEN QUESTION for the owner; no number is proposed here.**
10. **Cap of 5 notices per run** and **informational emails only**, as in ADR-010. **An alert never approves, rejects or changes anything.**

## The null and empty key problem

Learn: uniqueness of an alternate key is **not enforced on NULL** **(from Learn, as stated; not re-read in this session)**. The same effect was seen in this project: the server **accepted an empty role** in an Approver Assignment row on 2026-10-25 (script, ADR-009, "Create of the row without a role"). The column `mwf_alertkey` is set to the required level **ApplicationRequired**. **Whether the server enforces that level for a write through the Web API is UNVERIFIED** for this column; this ADR does not claim it. The one earlier observation (the empty role above) is on a different column of a different table and is not evidence for `mwf_alertkey`. It is to be **measured by the empty-key case (and the null-key case) of `scripts/test-alertlog-uniqueness.mjs`**, which records what the server does and passes or fails nothing on it. Defences, independent of that result: the key builder refuses null and empty; the uniqueness test **observes** what the server does with an empty and a null key (two inserts each) and records it, without assuming. Until that is measured, the flow must build the key only through `alert-key.mjs`.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Claim columns on the contract** (as `mwf_remindedon` on the step) | The Contract State Guard blocks edits to approved contracts (ADR-004). A bypass for a flow would weaken the guard the project built on purpose. |
| **Claim columns on the obligation** | Works for obligations, but not for renewals (those are on the contract), so there would be two mechanisms. |
| **Concurrency Control = 1 on the trigger** | Irreversible without deleting and re-adding the trigger **(from Learn, as stated; not re-read in this session)**. The alternate key protects every writer of the log, not only this flow, and does not depend on a trigger setting. |
| **Send first, then write the log** | Can send twice; same trade-off as ADR-010. |
| **A lookup to the source instead of a text key** | A key over a lookup and two more columns would need those columns for two different source tables (contract, obligation); a single text key is simpler and its alternate key is one column. Cost: orphan rows (see the risks). |

## Trade-offs

- **A text key instead of a lookup:** one table and one key for both sources, against no cascade delete (orphan rows stay) and no referential integrity.
- **The date in the key:** a changed due or expiry date re-arms the alert (wanted), against a **second alert for the same obligation when someone edits the date back and forth** (each date has its own row).
- **No delete privilege on the log:** a row cannot be removed by a project role, so an alert cannot be re-sent by accident, against rows that stay forever (growth is not measured; there is no clean-up job).
- **The owner receives every alert** (also for second-party obligations): one rule, against alerts about things the owner of the contract does not control.
- **The production lead time has no default:** a missing value stops the flow instead of silently using a number nobody chose.

## Known risks

- **A lost alert:** if the send fails **after** the claim, the alert is lost (the log says it was sent). Accepted, as in ADR-010.
- **Orphan AlertLog rows** after deleting a contract or an obligation: the key is text, not a lookup. **Tests must clean them** (the uniqueness test sweeps by the `TEST-TMP-ALERT-` prefix).
- **Deleting a log row re-fires the alert.** That is why no project role has the delete privilege.
- **Import untested:** whether the alternate key is active and the privileges are right after a solution import has not been tested (the project has never imported its solution).
- **The HTTP status of the duplicate rejection is unmeasured.**
- **Learn pages disagree on the default degree of parallelism** **(from Learn, as stated; not re-read in this session)**. Irrelevant here: the design does not depend on it and does not use Concurrency Control.
- **The renewal alerts depend on columns that do not exist** (renewal type, notice period): they need their own schema step and their own ADR note once the owner approves their shape.
- **A notice deadline already past** when a contract enters In Force (for example 20 days left: both the 90-day and the 30-day point are behind): not decided (open question 3).
- **Overlapping runs** can still make two runs reach the same candidate; the alternate key rejects the second claim (**not tested**).

## Offline implementation (written, unit tested, NOT run against the environment)

| File | What it is |
|---|---|
| `scripts/lib/alert-key.mjs` (+ test) | The key builder and validator. |
| `scripts/lib/obligation-schema.mjs`, `scripts/lib/obligation-apply.mjs`, `scripts/add-obligation-schema.mjs` (+ tests) | The definition of both tables; `--mode=plan` (default) prints what would be created for a stage and the solution it would use, `--mode=verify` reads. `--mode=apply` is written but **not run**; it needs `--confirm-mutates-environment`, `--auth=az`, `--solution=<name>` (no default) and ONE `--stage` per run: `tables` (both tables, columns, lookup) or `key` (the alternate key, then a bounded poll of `EntityKeyIndexStatus`, which stops on Failed and never starts the uniqueness test). Order: connection gate, solution check, baseline, then writes; the gate again before every write. Resumable: existing objects are read, only what is missing is created, a difference is reported as drift and never overwritten. No delete, PUT or PATCH exists in the code. It creates no security role and no privilege. |
| `scripts/lib/alertlog-uniqueness.mjs`, `scripts/test-alertlog-uniqueness.mjs` (+ test) | The uniqueness test; unit tested against a **mocked** HTTP layer only. Refuses unless the key is Active. |
| `scripts/lib/alert-tables-baseline.mjs` (+ test) | The baseline of both tables (0 rows; absent is an observation), called by `scripts/test-flow-reminders.mjs --mode=baseline` and `scripts/verify-approval-chain-schema.mjs`. The existing counts (11 / 110 / 5 / 0) are unchanged. |

## Not proven

**Nothing in this ADR has run against the environment.** In particular: that the tables can be created as defined (audit flag in the creation request of a table, a default value of the Choice), that the alternate key index becomes Active, that a duplicate is rejected and with which code and HTTP status, what the server does with an empty or a null key, that concurrent inserts give exactly one success, whether ApplicationRequired is enforced for a Web API write of an empty or null `mwf_alertkey`, that a flow can read the error code from the response, the effect of a solution import, and every alert rule (no flow exists).

## Open questions

1. **Production due-soon lead time** (owner). No number is proposed.
2. **Overdue behavior:** the key gives **one** OVERDUE alert per due date. Whether the owner wants repeated overdue reminders is not decided; repeats would need a different key (for example a week number), not designed here.
3. **A notice deadline that is already past** when the contract enters In Force: alert once for the latest missed point, for both, or for none?
4. **Roles for `mwf_obligation`** (who creates and edits obligations): not designed. The table is UserOwned like the contract; ADR-008 has no row for it.
5. **The columns "renewal type" and "notice period"** on the contract: names, types and values are not designed (a "none" value of the renewal type is assumed by decision 7).
6. **Who should receive alerts** if the contract owner leaves or is disabled: not decided (same kind of question as A1 in ADR-010).
