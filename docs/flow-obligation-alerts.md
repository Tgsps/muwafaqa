# Flow Specification: Obligation Alerts

**A SPEC to review before any build. No flow, no generator and no test script exists for it.** Decision and context: [ADR-011](decisions/ADR-011-obligations-and-renewal-alerts.md) (status Proposed). It follows the pattern of [flow-approval-reminders.md](flow-approval-reminders.md) (a scheduled flow, claim first, a hard cap per run, test and production variants, the flow stays OFF except during the owner's tests).

Tags: **(measured)** a value from a run of the environment (see ADR-011, "Measured results of the uniqueness test"); **(estimate)** a number that was not measured; **(assumption)**; **(not proven)**; **(existing)** a pattern that the reminders flow already uses and that ran in the two test windows of 2026-10-29. **Every number in this document that is not marked (measured) is an estimate.**

**Out of scope here, said once:** renewal alerts (`RENEWAL-T90`, `RENEWAL-T30`). The columns they need on the contract (renewal type, notice period) do not exist yet (ADR-011, "Known risks"). This flow handles `OBLIGATION-DUESOON` and `OBLIGATION-OVERDUE` only.

## 1. What the flow does

Every run, for each **Open** obligation whose due date is within the lead time or already past, it **claims** the alert by inserting one row into `mwf_alertlog`, and **only if the insert succeeds** it sends one informational email to the **owner of the contract**. A duplicate-key rejection means "already claimed": nothing is sent. The flow never changes an obligation, a contract or an approval; its only write is the alert log insert.

## 2. Trigger and recurrence

- **Recurrence** trigger. Test variant: every **1 minute** (existing pattern). Production variant: **15 minutes (placeholder, not decided; estimate)**.
- No trigger Concurrency Control (ADR-011 rejects it: irreversible, and the alternate key does the job).
- The interval should be longer than a run. Runs of the reminders flow lasted 16.6 to 84.8 s on a 1-minute interval **(measured, 2026-10-29)**, so overlaps are expected in the test variant; section 11 covers them.

## 3. The query for obligations

One server-side `List rows` on `mwf_obligations` (Dataverse connector), **(existing pattern: the reminders flow reads its candidates the same way)**:

- `$filter`: `mwf_status eq 867640000` (Open) **and** `mwf_duedate le <now + lead time>`. Both bounds are computed once at the start of the run into one variable (`runStartedAt`, as in the reminders flow) so that every obligation of the run is judged against the same instant.
- **Excluded by the filter, not by later logic:** Done (867640001) and **Disputed (867640002)**, per ADR-011 (decision 8: Disputed obligations are not alerted); Open obligations due later than now + lead time.
- `$orderby`: `mwf_duedate asc`; `$top`: **50 (estimate; placeholder)**.
- `$select`: `mwf_obligationid,mwf_name,mwf_duedate,mwf_status,_mwf_contract_value`.
- **Which type:** `mwf_duedate` before the run start = `OBLIGATION-OVERDUE`; otherwise `OBLIGATION-DUESOON`. An obligation that was alerted as due soon and then becomes overdue gets a second alert (a different key), once.
- **Known weakness (not solved here):** an obligation that is overdue and already alerted stays in this query forever (nothing changes on the obligation when it is claimed). With `$orderby mwf_duedate asc` and `$top 50`, **more than 50 old, already-alerted obligations would hide newer ones**, and every run would spend one failed insert on each of them. Options, none chosen: a look-back bound on the due date (needs a business number), or a pre-read of existing keys from the log (needs a query form that was not tried). Open question 4.

## 4. Order of actions (per run)

Top level: initialize `noticesSent` (integer, 0), `duplicates` (integer, 0), `errors` (integer, 0), `runStartedAt`; the key gate (section 12, open); `Get_open_obligations`; one `Foreach` over the result with **concurrency 1** **(existing pattern)**.

Per obligation, in this order:

1. **Cap check** (section 7): if `noticesSent` is already 5, do nothing for this obligation (the alert stays unclaimed and is picked up by a later run).
2. **Read the contract** (`mwf_contractnumber`, `mwf_name`, `_ownerid_value`) and **the owner's address** (`internalemailaddress` of the user in `_ownerid_value`), **before anything is written** **(existing pattern)**. If there is no address, nothing is claimed and nothing is sent; `errors` is incremented (visible, not silent).
3. **Re-read the obligation** (`mwf_status`, `mwf_duedate`) and continue only if it is still Open **and** its due date still equals the one the key will use **(existing pattern of the reminders flow, which re-reads the step)**. No step is atomic: the owner can mark it Done between the read and the claim; the re-read narrows that window, it does not close it.
4. **Build the key** (section 9) and **run the guard** (section 10). If the guard fails: no insert, no email, `errors` + 1.
5. **Claim: insert** one `mwf_alertlog` row (`mwf_alertkey` = the key, `mwf_name` = the same text).
6. **Decide on the result** (section 6): inserted -> go on; duplicate -> skip; any other failure -> `errors` + 1, nothing is sent.
7. **After a successful claim only:** `noticesSent` + 1, **then** send the email. **Claim, then count, then send** is the order of the reminders flow (existing); the claim is never undone, so a failed send loses that alert (ADR-011, "Known risks").

After the loop: if `errors` is above 0, end the run as **Failed** (a Terminate action with status Failed), so a problem is visible in the run history instead of being swallowed. (The reminders flow has no Terminate: a failed action fails its run. Here a handled failure would not, see section 6.)

## 5. Recipient

The **owner of the contract** always, also for obligations of the second party (ADR-011, decision 8). One recipient. **(assumption)** that the contract owner is the right person; who receives the alert when the owner is disabled or has left is an open question (ADR-011, open question 6). In this development environment every address resolves to the test account, so the recipient logic is not distinguishable from "everything goes to one mailbox" **(not proven)**.

## 6. Claim first, and how the duplicate is detected

- The claim is a `Create a new row` (Dataverse connector) into `mwf_alertlogs` with `mwf_alertkey` and `mwf_name` = the key.
- **What the server did, measured directly against the Web API (one run, N = 5, not Power Automate):** a duplicate non-empty key gives **HTTP 412** with `{"error":{"code":"0x80060892","message":"Entity Key Alert Log Key violated. A record with the same value for Alert Key already exists. A duplicate record cannot be created. Select one or more unique values and try again."}}` **(measured)**.
- **The design reads the code `0x80060892` in the body, not the status** (the status is undocumented; one measurement is not a contract, ADR-011 decision 5).
- **How the flow takes the branch:** the action after `Claim` has **run-after = Succeeded and Failed** (a failed action does not stop the iteration). It is a condition:
  - the claim **Succeeded** -> step 7 of section 4;
  - the claim **Failed** and the text of the failed action's outputs **contains `0x80060892`** -> **skip**: `duplicates` + 1, no counter, **no email**;
  - the claim **Failed** for any other reason -> `errors` + 1, no email.
- **(not proven) Three things nobody has seen:** (a) **what the Dataverse connector puts in the outputs of a failed insert** (whether the body, the code or the HTTP status is in `outputs(...)` and in which shape); the condition above is written on a **search of the whole outputs text** because that shape is unknown; (b) **whether the connector retries a 412** before it reports the failure (a retry would not change the outcome but would change the timing); (c) **whether a failure that the run-after handles still marks the iteration or the run as Failed** in the run history. The first build step must therefore be a **discovery run** with a deliberately duplicated key, reading the real failed output before the condition is trusted. If the shape differs, the condition is rewritten; nothing else in this spec depends on it.
- **What is skipped on a duplicate:** the cap counter, the email and any write. Nothing is retried within the run.

## 7. The cap

- **Global 5 per run** (hard-coded, as in ADR-010; **no default to change**). It counts **successful claims** (inserts that returned success), not obligations visited and not duplicates.
- The cap is **checked before the claim** (section 4 step 1) and the counter is **incremented after a successful claim, before the send**. So at most **5 inserts succeed and at most 5 emails are attempted per run**; an obligation that meets the cap is not claimed and waits for a later run.
- **Duplicates and errors do not consume the cap**, so an old, already-claimed obligation never uses up the 5; it costs one failed insert per run instead (section 3, known weakness).
- With **overlapping runs** each run has its own counter, so the two together can exceed 5 within the same minute **(estimate: at most 5 per overlapping run)**.

## 8. The email (informational only)

One text per alert type; sample text, to be edited by the owner (the same status as the reminders flow's texts). Subject prefix `[Muwafaqa test] ` in the test variant only.

- **Due soon:** subject `Obligation due soon: <obligation name> (contract <contract name>)`. Body: the obligation, the contract number, the **due date in UTC (stated as UTC)**, the party (not in the first version unless the owner wants it), and "this is an informational notice; nothing was changed; nobody has to answer".
- **Overdue:** subject `Obligation overdue: <obligation name> (contract <contract name>)`. Body: the same, "the due date has passed and the obligation is still Open".
- A link to the **obligation** record, built like the reminders flow's link to the contract (`https://<ORG_HOST>/main.aspx?etn=mwf_obligation&pagetype=entityrecord&id=<id>`, host replaced in memory at creation and scrubbed in `src/`). **(not proven)** that this link opens the record: the app has no form for the obligation yet (ADR-011, open question 4 is about roles; forms and the model-driven app are not designed at all).
- Email through Office 365 Outlook "Send an email (V2)" with the connection reference of the reminders flow **(existing: 12 messages arrived in the two windows of 2026-10-29)**. The nested parameter keys (`emailMessage/To`, `/Subject`, `/Body`) are the ones that worked there.

## 9. The key expression

`<lower-case obligation GUID>-<TYPE>-<yyyyMMdd of mwf_duedate in UTC>`, for example type `OBLIGATION-OVERDUE`. The rule of ADR-011 ("Key construction in the flow") applies:

1. **The generator emits the expression** (from the same parts as `scripts/lib/alert-key.mjs`: `toLower(guid)`, the TYPE literal chosen by the due-date test of section 3, `formatDateTime(duedate, 'yyyyMMdd')` on the UTC value, joined by `-`).
2. **Offline tests compare the expression's output with `alert-key.mjs`** on samples (lower-case GUID and one in capitals, each TYPE of this flow, an end-of-month date and a leap day) **before any build is applied**. This needs an evaluator for the few expression functions used; if none is written, the gap is stated in the test output.
3. The guard of section 10 runs on the result.

**(not proven)** that `formatDateTime` on the connector's `mwf_duedate` string gives the **UTC** date in every case (the column is Date and Time with user-local behavior and is returned in UTC as an ISO string; no test has run).

## 10. The guard against an empty or out-of-length key

**Measured:** the server **accepts an empty-string key twice and a null key twice (HTTP 204, two rows each)**; ApplicationRequired is not enforced for API writes. The server therefore will not stop a bad key; the flow must. **Before the insert** the flow checks that the key **is not empty**, **is not longer than 100** (the column length), and **has the shape** `<guid>-<TYPE>-<yyyyMMdd>` as far as the expression language allows (length 36 + `-` + a known TYPE + `-` + 8 digits). On failure: no insert, no email, `errors` + 1. The guard is part of the flow, not of the server.

## 11. Overlapping runs

- Protection is **the alternate key**, not the trigger setting. A second run that reaches the same obligation gets the duplicate rejection and skips it. **Measured only directly against the Web API from one client: 5 parallel inserts of one key gave 1 success and 4 rejections (412, `0x80060892`). Not seen from two real flow runs (not proven).**
- Sequential loop (concurrency 1) inside one run, so a run does not race itself.
- The run interval should exceed the run length; in the test variant overlaps are expected (estimate, from the reminders flow).
- Not covered: the cap counts per run (section 7).

## 12. The key must be Active (ADR-011, decision 6)

An insert into `mwf_alertlog` **while the key index is not Active would succeed twice** (uniqueness is not in effect). The scripts refuse to run unless `EntityKeyIndexStatus` is Active. **The flow has no known way yet to do the same: a table row query reads rows, not metadata (not verified that nothing else in the connector can).** Options, none tried: the Dataverse connector's raw HTTP action against `EntityDefinitions(...)/Keys` (**not verified to exist or to be allowed**), or accepting the risk because the key is Active and the flow is built only after that. **Open question 1.** After a solution import the key must be re-checked (ADR-011; import not tested).

## 13. Test variant and production variant

| | test | production |
|---|---|---|
| Recurrence | every 1 minute | 15 minutes (**placeholder; estimate**) |
| Lead time (due soon) | **5 minutes**, a constant of the test variant chosen so that a seeded obligation becomes due-soon within one window (ADR-011, decision 9) | **a required named parameter of the generator, with no default in code**; the generator refuses to build the production variant without it; **the value is an open question for the owner, no number is proposed** |
| Email subject | starts with `[Muwafaqa test] ` | no prefix |

A unit test over the two generated definitions should show that nothing else differs (same as the reminders flow). The flow is created **OFF**; the owner alone turns it on and off.

## 14. Size estimate

**Estimate, not measured:** about **25 actions** (4 variable initializations, the query, the loop, and per obligation about 15: type, contract read, owner read, owner check, recipient, obligation re-read, key, guard, cap check, claim, result check, counter, send, duplicate counter, error counter; plus the final error check and Terminate) and **nesting depth about 6** (loop, guard, cap, result, duplicate branch, counter). Limits for comparison: 500 actions and depth 8 (Learn, limits-and-config, **not re-read in this session**). The reminders flow has 42 actions and depth 7 **(measured, generator)**, so a flow of this shape is plausible **(estimate)**.

## 15. Test plan (one window, owner turns the flow ON and OFF; the scripts never do)

Same discipline as the reminders windows: all test rows carry the prefix `TEST-TMP-OBL-` in `mwf_name`; the script writes only those rows and their alert log rows; baseline first, cleanup last; counters snapshotted and restored by the rule of `scripts/lib/counter-snapshot.mjs` (creating a contract takes a number).

- **Seed:** one fictitious counterparty and one fictitious contract (a state in which it can hold obligations; the guard of ADR-004 is not involved because the flow does not write to the contract), and obligations:
  - **O1 positive control:** Open, due in about 3 minutes (inside the 5-minute lead time) -> one `OBLIGATION-DUESOON` alert. The window is judged only if this one fired.
  - **O2:** Open, already overdue -> one `OBLIGATION-OVERDUE` alert.
  - **O3:** Disputed, overdue -> no alert. **O4:** Done, overdue -> no alert. **O5:** Open, due far in the future -> no alert.
  - **O6 to O12 (7 obligations):** Open, overdue -> **5 alerts in the first run that sees them, the rest in the next** (the cap).
  - **O13:** Open, overdue, with its `mwf_alertlog` row **inserted by the test before the window** (the key built by `alert-key.mjs`) -> **no email, no new row** (the duplicate path). This is the only case that exercises the duplicate branch **inside Power Automate**.
- **Checks by script (read only during the window):** alert log rows per key (exactly one per alerted obligation, none for O3, O4, O5), the keys equal the output of `alert-key.mjs` for each obligation, run history statuses, **no obligation changed** (modifiedon unchanged), no empty key row, the key index still Active.
- **Duplicate-notice check:** the number of emails received (the owner counts them in the mailbox, by eye) must equal the number of **new** alert log rows of the window; no key appears twice; no obligation is mentioned in two emails of the same type.
- **Overlap:** the window runs on a 1-minute interval; if two runs overlap (start and end times from the run history), that fact and the rows they touched are reported; the check above is the verdict on duplicates. If no overlap happens, the overlap case is **not covered** and the report says so.
- **Discovery step before the first window:** one run with a deliberately duplicated key to read the **real output of a failed insert** and the run status it leaves (section 6, three unknowns).
- **Cleanup and baseline restore:** delete the test obligations, the test contract and counterparty, **and the alert log rows whose key starts with the id of a test obligation** (the owner's test account holds the delete privilege that no project role has; the script identifies these rows by the ids it created and by the seeded O13 row, never by guess); counters restored; **final baseline 11 contracts, 110 matrix rows, 5 assignments, 0 steps, 0 obligations, 0 alert log rows, all five flows Off, counters [0,0,0,0,0]**.

## 16. Not proven / open questions

**Not proven (nothing here has run):**
1. Everything in this spec: no flow, generator or session script exists.
2. That the Dataverse connector exposes the code `0x80060892` (or the 412) of a failed insert in a form a condition can read, and **what a handled failed insert does to the run status** (section 6).
3. That the duplicate branch works under overlapping real runs (measured only: 5 parallel direct calls, one run).
4. That the UTC date of `mwf_duedate` formats to the expected `yyyyMMdd` in every case; that the expression for the key equals `alert-key.mjs` (needs the offline comparison of section 9).
5. That the obligation link opens a record (no form or app page for it).
6. That the recipient logic works for more than one user (every address is the test account).
7. The behavior with more than 50 candidates (section 3, known weakness) and after a solution import.
8. The size and depth in section 14 (estimates).

**Open questions (the owner):**
1. **How the flow checks that the key is Active** (section 12), or whether the risk is accepted.
2. **Production lead time** and the **production recurrence** (placeholders).
3. **Repeated overdue alerts** (the key gives one per due date; ADR-011 open question 2).
4. **How to bound the query** for old, already-alerted obligations (section 3).
5. **Who receives** the alert when the contract owner cannot (ADR-011 open question 6).
6. **Email texts**, and whether the party and a link belong in them.
7. **Roles and forms for the obligation** (ADR-011 open question 4): who creates obligations at all, and where.
