# Flow Specification: Obligation Alerts

**A SPEC to review before any build. No flow exists for it and nothing has been created in the environment.** The generator `scripts/build-flow-obligation-alerts.mjs` (modes `check` and `plan` only, offline) emits the definition this document describes. Decision and context: [ADR-011](decisions/ADR-011-obligations-and-renewal-alerts.md) (status Proposed). It follows the pattern of [flow-approval-reminders.md](flow-approval-reminders.md): a scheduled flow, claim first, a hard cap per run, test and production variants, the flow stays OFF except during the owner's tests.

Tags: **(measured)** a value from a run of the environment (ADR-011, "Measured results of the uniqueness test"); **(estimate)**; **(assumption)**; **(not proven)**; **(existing)** a pattern the reminders flow already uses and that ran in the two test windows of 2026-10-29; **(not verified)** a name or behavior not checked against the connector. **Every number in this document that is not marked (measured) is an estimate or a stated constant.**

**Out of scope here, said once:** renewal alerts (`RENEWAL-T90`, `RENEWAL-T30`). The columns they need on the contract (renewal type, notice period) do not exist yet (ADR-011, "Known risks"). This flow handles `OBLIGATION-DUESOON` and `OBLIGATION-OVERDUE` only.

## 1. What the flow does

Every run, for each **Open** obligation whose due date lies inside the **window** `[now - lookback, now + lead time]`, it **claims** the alert by inserting one row into `mwf_alertlog`; **only if the insert succeeds** it sends one informational email to the **owner of the contract**. Any failed insert, a duplicate (412) or anything else, skips the email (fail closed). The flow never changes an obligation, a contract or an approval; its only write is the alert log insert.

## 2. Trigger and recurrence

- **Recurrence** trigger. Test variant: every **1 minute** (a test constant). Production variant: **a required parameter with no default**; no number is proposed (open question 2).
- No trigger Concurrency Control (ADR-011 rejects it: irreversible, and the alternate key does the job).
- Runs of the reminders flow lasted 16.6 to 84.8 s on a 1-minute interval **(measured, 2026-10-29)**, so overlaps are expected in the test variant; section 11.

## 3. The window and the query

**Three named parameters per variant, no default in code** (section 13): the **lead time** (how long before the due date the due-soon alert is due), the **lookback window** (how far back an overdue obligation is still looked at) and the **recurrence interval**.

One server-side `List rows` on `mwf_obligations` (Dataverse connector) **(existing pattern)**:

- `$filter`: `mwf_status eq 867640000` (Open) **and** `mwf_duedate ge <runStart - lookback>` **and** `mwf_duedate le <runStart + lead>`. The bounds are computed from one `runStartedAt` taken at the start of the run, so every obligation of the run is judged against the same instant.
- **Excluded by the filter:** Done (867640001) and **Disputed (867640002)**, per ADR-011 decision 8; Open obligations due later than `now + lead`; **Open obligations overdue for longer than the lookback window**.
- `$orderby`: `mwf_duedate asc`; `$top`: **50 (estimate; placeholder)**; `$select`: `mwf_obligationid,mwf_name,mwf_duedate,_mwf_contract_value`.
- **Exactly what `$top` leaves out (documented, not fixed):** the query is ordered by **due date ascending** and takes the **first 50**. With more than 50 Open obligations inside the window, the rows **never reached** are the ones with the **latest due dates** inside the window: the due-soon obligations and the most recently overdue ones, that is, the obligations whose alert is the **newest**. The oldest-due obligations, **including those already alerted**, keep filling the 50 until they leave the window (they age past the lookback), each costing one failed insert per run. The flow does not page (no skip token) and does not count the candidates, so **nothing reports that rows were not reached**. Which obligations are missed is therefore a function of the window and of how many are in it.
- **Which type:** the due date before the run start = `OBLIGATION-OVERDUE`; otherwise `OBLIGATION-DUESOON`. An obligation alerted as due soon that then becomes overdue gets a second alert (a different key), once.
- **Dates compared as text in `Check_obligation_still_due` (what each side must look like):** the check is `equals` of two **strings**: `outputs('Get_obligation_before_claim')?['body/mwf_duedate']` (the `Get a row by ID` result) and `items('Apply_to_each_obligation')?['mwf_duedate']` (the `List rows` result). **Both are expected as the ISO 8601 UTC text the Dataverse Web API gives for a Date and Time column: `yyyy-MM-ddTHH:mm:ssZ`, for example `2027-03-31T10:00:00Z`: seconds present, no fractional seconds, `Z` and no offset.** That is the usual form of the Web API for Date and Time columns; it was **not re-measured in this step, not measured through the connector, and not measured for `mwf_duedate`** (the column holds no row yet). **If the two sides differ in text** (fractional seconds on one side, an offset, another precision) the check is false for every obligation: **nothing is claimed, no email is sent, no alert log row is written, and the flow itself reports nothing** (the false branch is empty, and it is not counted as an error). **The test session makes this visible:** the obligations seeded as due-soon and as overdue-inside-lookback are positive controls; if they produce **no alert**, the verdict is **FAIL** ("positive control did not fire") with this mismatch **named as a possible cause**, and every "no alert" result of the window is reported as **inconclusive**, never as a pass. In **production** nothing would show it: a systematic mismatch would silently stop all alerts. A later change (compare `ticks` instead of text, or count the false branch) is **not made here** (open question 7).
- **No new column on Obligation.** Nothing records that an alert was missed or sent; the alert log is the only record.
- **What the lookback costs (accepted):** an obligation that has been overdue for **longer than the window because the flow was down** (turned off, failing runs, an outage) **never gets its alert**, and one that was due soon during a downtime longer than the lead time never gets its due-soon alert either. Nothing detects or repairs this. A downtime shorter than the lookback loses nothing. Recovery by hand is not designed.
- **What the lookback fixes, and what it does not:** an old, already-alerted obligation leaves the query when it ages past the window, instead of staying in it forever and costing one failed insert per run. **Inside the window**, already-alerted obligations are still read and still attempt one insert each per run (they fail; section 6). With more than 50 obligations inside the window the oldest 50 hide the rest; the window must be chosen with that in mind **(not solved)**.
- **Constraint enforced by the generator:** `lookback >= interval`; otherwise an obligation whose due date passes between two runs could fall out of the window before any run sees it.

## 4. Order of actions

Numbered as the generator emits them (a unit test compares this list with the generated definition: same names, none missing, none extra). Names are the real action names; variables are `runStartedAt`, `noticesSent`, `claimFailures`, `errors`, `proceed`, `alertType`, `alertKey`, `recipientEmail`.

Top level:
1. `Init_runStartedAt` (string, `utcNow()`)
2. `Init_noticesSent` (integer 0)
3. `Init_claimFailures` (integer 0)
4. `Init_errors` (integer 0)
5. `Init_proceed`, 6. `Init_alertType`, 7. `Init_alertKey`, 8. `Init_recipientEmail` (strings)
9. `Get_open_obligations` (the query of section 3)
10. `Apply_to_each_obligation` (Foreach, concurrency 1 **(existing pattern)**) containing, in this order:
    1. `Set_proceed`: the **cap check** (section 7): `yes` only while `noticesSent` is below 5
    2. `Reset_alertType`, 3. `Reset_alertKey`, 4. `Reset_recipientEmail` (Set variable to `string('')`, never an empty literal)
    5. `Gate_prepare` (If `proceed` is `yes`) containing:
        1. `Set_alertType` (overdue or due soon, section 3)
        2. `Get_contract` (a `List rows` on `mwf_contracts` by id: `mwf_name`, `mwf_contractnumber`, `_ownerid_value`; the same read pattern as the reminders flow)
        3. `Check_contract_found` (If a contract came back) containing 1. `Get_owner_user_list` (the address of the contract owner) and 2. `Set_recipient_owner`: **before anything is written** **(existing pattern)**
        4. `Set_alertKey` (the generated key expression, section 9)
        5. `Gate_guard` (If the recipient is not empty **and** the key passes the guard, section 10):
            - true: 1. `Get_obligation_before_claim` (`mwf_status`, `mwf_duedate`), then 2. `Check_obligation_still_due` (If still Open and the due date unchanged) containing:
                1. `Insert_claim`: **the claim** (section 6)
                2. `Increment_noticesSent`: runs **only after `Insert_claim` Succeeded**
                3. `Send_alert_email`: runs **only after `Increment_noticesSent` Succeeded**, so only on the success path of the claim
                4. `Compose_claim_failure`: runs **only after `Insert_claim` Failed or TimedOut**; records the real outputs of the failed insert
                5. `Increment_claimFailures` (after `Compose_claim_failure`)
            - false: `Increment_errors` (nothing is inserted, nothing is sent)
11. `Check_errors` (If `errors` is above 0) containing `Terminate_run_failed` (status Failed). **After** the loop and **not inside any loop**.

**Order of the three decisive writes:** claim (insert), then count, then send; a claim is never undone, so a failed send loses that alert (ADR-011, "Known risks"). The real action count and the nesting depth are computed by the generator from this definition (section 14).

## 5. Recipient

The **owner of the contract** always, also for obligations of the second party (ADR-011 decision 8). **(assumption)** that the contract owner is the right person; who receives the alert when the owner is disabled or has left is open (ADR-011 open question 6). In this development environment every address resolves to the test account, so the recipient logic cannot be told apart from "everything goes to one mailbox" **(not proven)**. An empty address blocks the claim and counts as an error.

## 6. Claim first, fail closed, and what is recorded

- **The claim** is `Insert_claim`: a `Add a new row` (Dataverse connector) into `mwf_alertlogs` with `mwf_alertkey` and `mwf_name` = the key. `mwf_alertlog` is the only table the flow writes. **Microsoft Learn** ([Microsoft Dataverse connector](https://learn.microsoft.com/en-us/connectors/commondataserviceforapps/), read 2026-11-04) documents **Operation ID `CreateRecord`** for "Add a new row", with the parameter **`entityName`** (Table name, required) and one further dynamic object parameter for the row, **without a key name**; the page does **not** document the `item/<column>` form. The flow uses `item/<column>` keys because that is how the designer exports the same dynamic row parameter of **`UpdateOnlyRecord`** ("Update a row", the operation both existing flows use and that ran; in Learn **`UpdateRecord` is "Upsert a row"**, not "Update a row"). `ListRecords` (`entityName`, `$select`, `$filter`, `$orderby`, `$top`) and `GetItem` (`entityName`, `recordId`, `$select`) are as Learn lists them. **(not verified)**: the `item/<column>` keys for `CreateRecord` specifically; the first created row must be opened in the designer and compared.
- **What the server did, measured directly against the Web API (one run, N = 5, not Power Automate):** a duplicate non-empty key gives **HTTP 412** with `{"error":{"code":"0x80060892","message":"Entity Key Alert Log Key violated. A record with the same value for Alert Key already exists. A duplicate record cannot be created. Select one or more unique values and try again."}}` **(measured)**.
- **Fail closed (decision, test variant and production variant alike):** **no email unless the claim insert succeeded.** The email action is reachable only through actions whose `runAfter` is `Succeeded` back to `Insert_claim`. **Any failure of the insert, a 412, any other status, a timeout, skips the send.** The flow does **not** try to tell a duplicate from another failure in order to decide anything: both skip.
- **Recorded separately:** on a failed insert `Compose_claim_failure` stores the status, the error and the outputs of `Insert_claim` and the key, and `claimFailures` is incremented. These are visible in the run history. They are not an error of the run (a duplicate is the normal case for an obligation alerted before and still inside the window), so they do **not** end the run as Failed; other problems (`errors`: no recipient, a key that fails the guard) do, after the loop.
- **No separate discovery flow.** The shape of a failed insert is learned in **test case 13** (section 15): an obligation whose alert log row was inserted beforehand, so the flow's own insert is rejected inside a real run.
- **Unknown until test case 13 (not proven):** (a) **the real output shape of a failed insert** in Power Automate (which fields of `actions('Insert_claim')` carry the status, the code and the message); (b) **whether the connector retries** a 412 before it reports the failure; (c) **whether a failure handled by `runAfter` still marks the iteration or the run as Failed** in the run history. The design does not depend on the answers (fail closed either way); the **diagnosis** does: if the run turns out to be marked Failed for every duplicate, the run history is noise and the design needs another way to record duplicates. That would be a finding, not a surprise to hide.
- **What is skipped on a failed insert:** the counter, the email, and every later step for that obligation. Nothing is retried within the run.

## 7. The cap

- **Global 5 per run** (hard-coded, as in ADR-010; no default to change). It counts **successful claims only**: `Increment_noticesSent` runs only after `Insert_claim` Succeeded.
- **Skipped duplicates do NOT count toward the cap**, and neither do failed inserts, guard failures or obligations that changed. An old, already-claimed obligation therefore never uses up the 5; it costs one failed insert per run while it is inside the window.
- The cap is **checked before the claim** (`Set_proceed`, first action of each iteration): at 5, the obligation is not claimed and waits for a later run (while it is still inside the window). So at most **5 inserts succeed and at most 5 emails are attempted per run**.
- With **overlapping runs** each run has its own counter, so two together can exceed 5 within the same minute **(estimate: at most 5 per overlapping run)**.

## 8. The email (informational only)

One generated text, with the due-soon or overdue wording chosen by `alertType`; sample text, to be edited by the owner. Subject prefix `[Muwafaqa test] ` in the test variant only.

- **Due soon:** subject `Obligation due soon: <obligation name> (contract <contract name>)`. **Overdue:** `Obligation overdue: <obligation name> (contract <contract name>)`. Body: the obligation, the contract number, the **due date in UTC (stated as UTC)**, and "this is an informational notice; nothing was changed; nobody has to answer".
- A link to the **obligation** record built like the reminders flow's link to the contract (`https://<ORG_HOST>/main.aspx?etn=mwf_obligation&pagetype=entityrecord&id=<id>`; the host is replaced in memory at creation and scrubbed in `src/`). **(not proven)** that it opens a record: there is no form or app page for the obligation yet.
- Office 365 Outlook "Send an email (V2)", the connection reference of the reminders flow, the nested keys (`emailMessage/To`, `/Subject`, `/Body`) **(existing: 12 messages arrived in the two windows of 2026-10-29)**.

## 9. The key expression

`<lower-case obligation GUID>-<TYPE>-<yyyyMMdd of mwf_duedate in UTC>`. The rule of ADR-011 ("Key construction in the flow") applies:

1. **The generator emits the expression** (never typed in the designer): `concat(toLower(string(<obligation id>)), '-', <alertType>, '-', formatDateTime(<due date>, 'yyyyMMdd'))`.
2. **Offline tests compare the expression's output with `scripts/lib/alert-key.mjs`** on samples: a lower-case GUID and one in capitals, a date as `yyyyMMdd` (including an end-of-month and a leap day), **each of the four TYPE values**, and cases that must be rejected (empty, too long). They run through a **small evaluator** of the expression subset used (`scripts/lib/flow-expression-eval.mjs`). **Its limits:** it implements only the functions this flow uses; `formatDateTime` is implemented for the formats `yyyyMMdd` and `yyyy-MM-ddTHH:mm:ssZ` on ISO UTC strings; it is **not** Power Automate, so it proves the **expression text** against `alert-key.mjs`, not the behavior of the real engine.
3. The guard of section 10 runs on the result.

**(not proven)** that `formatDateTime` on the connector's `mwf_duedate` string gives the **UTC** date in every case (no run has tested it).

## 10. The guard against an empty or out-of-length key

**Measured:** the server **accepts an empty-string key twice and a null key twice (HTTP 204, two rows each)**; ApplicationRequired is not enforced for API writes. The flow must therefore stop a bad key. `Gate_guard` lets the iteration go on only if the key **is not empty**, its **length is exactly the length of a valid key of this flow** (64 for both types of this flow: 36 + 1 + 18 + 1 + 8, derived by the generator from `alert-key.mjs`), the key **contains `-<alertType>-`**, and the recipient is not empty. On failure nothing is inserted and nothing is sent, and `errors` is incremented (the run ends Failed after the loop). The guard checks emptiness, length and the type segment only; it does not check that the other 8 characters are digits or that the GUID is well formed **(limit)**.

## 11. Overlapping runs

- Protection is **the alternate key**, not the trigger setting. A second run that reaches the same obligation gets a failed insert and skips the email. **Measured only directly against the Web API from one client: 5 parallel inserts of one key gave 1 success and 4 rejections (412, `0x80060892`). Not seen from two real flow runs (not proven).**
- Sequential loop (concurrency 1) inside one run.
- The run interval should exceed the run length; in the test variant overlaps are expected **(estimate)**.
- The cap counts per run (section 7).

## 12. The key must be Active: an accepted, documented risk

An insert into `mwf_alertlog` **while the key index is not Active would succeed twice** (uniqueness not in effect). The scripts refuse to run unless `EntityKeyIndexStatus` is Active. **The flow cannot check this from inside, as far as we know** (a row query reads rows, not metadata; not verified that nothing else in the connector can). **Decision: this is an accepted, documented risk.** What reduces it: the key is Active now; the flow is built only after that; and **after a solution import the owner checks the key before turning the flow on** (runbook step R16b in [rebuild-runbook.md](rebuild-runbook.md), **[NOT TESTED]**). Nothing in the flow protects against a key that is Pending or Failed after an import.

## 13. Test variant and production variant

One generator, two variants. They differ **only** in the three parameters and the subject prefix; a unit test enforces it.

| | test | production |
|---|---|---|
| Recurrence interval | **1 minute (test constant)** | **required parameter `--interval-minutes`, no default** |
| Lead time (due soon) | **5 minutes (test constant**, chosen so that a seeded obligation becomes due-soon within one window; ADR-011 decision 9) | **required parameter `--lead-minutes`, no default; open question 1** |
| Lookback window | **30 minutes (test constant**, chosen so that an obligation due 10 minutes ago is inside and one due 2 hours ago is outside) | **required parameter `--lookback-minutes`, no default; open question 1** |
| Email subject | starts with `[Muwafaqa test] ` | no prefix |

The generator **refuses to emit a production definition** unless all three are given as whole minutes (at least 1, at most 525600 as a sanity limit that is not a business rule) with `lookback >= interval`. The flow is created OFF; the owner alone turns it on and off. The generator has **no create, verify or replace mode**: nothing can be created from it yet.

## 14. Size

**Real numbers, computed by `scripts/build-flow-obligation-alerts.mjs --mode=plan` from the generated definition (not estimates): 32 actions, nesting depth 5**, the same for the test and a production variant. The limits are 500 actions and nesting depth 8 (Learn, limits-and-config, **not re-read in this session**); the generator's check fails above either. For comparison the reminders flow has 42 actions and depth 7 **(measured, generator)**. A unit test holds the two numbers, so a change of the definition is noticed. They say that the definition is far from the limits; they say nothing about whether it works.

## 15. Test plan (one window; the owner turns the flow ON and OFF; the scripts never do)

Same discipline as the reminders windows. Rows carry the prefix `TEST-TMP-OBL-` in `mwf_name`; the script writes only those rows and their alert log rows; baseline first, cleanup last; counters snapshotted and restored by the rule of `scripts/lib/counter-snapshot.mjs` (creating a contract takes a number). Test constants: lead 5 minutes, lookback 30 minutes, interval 1 minute. Nothing here is written yet: the session script does not exist.

- **Seed:** one fictitious counterparty and one fictitious contract, and obligations:
  - **O1 positive control:** Open, due in about 3 minutes (inside the lead time) -> one `OBLIGATION-DUESOON` alert. The window is judged only if this fired.
  - **O2:** Open, due 10 minutes ago (inside the lookback) -> one `OBLIGATION-OVERDUE` alert.
  - **O3:** Disputed, due 10 minutes ago -> no alert. **O4:** Done, due 10 minutes ago -> no alert. **O5:** Open, due in 2 hours -> no alert.
  - **O6 to O12 (7 obligations):** Open, due 10 minutes ago -> **5 alerts in the first run that sees them, the other 2 in the next run (the cap).**
  - **O13:** Open, due 10 minutes ago, with its `mwf_alertlog` row **inserted by the test before the window** (key built by `alert-key.mjs`) -> **no email, no new row**. The flow's own insert fails here: **this is where the real output shape of a failed insert, a possible retry, and the run status are observed** (section 6). The run history of that run is read by the owner.
  - **O14:** Open, due 2 hours ago (outside the lookback) -> **no alert**, on purpose: it shows the cost of the lookback (section 3).
- **Checks by script (read only during the window):** alert log rows per key (exactly one for each alerted obligation, none for O3, O4, O5, O14; the pre-inserted row of O13 only), each key equals the output of `alert-key.mjs` for its obligation, no empty key row, no obligation changed (`modifiedon`), the key index still Active, the run statuses.
- **Duplicate-notice check:** the emails received (the owner counts them in the mailbox, by eye) must equal the number of **new** alert log rows of the window; no key appears twice; no obligation is in two emails of the same type.
- **Overlap:** if two runs overlap (start and end times from the run history), that and the rows they touched are reported; the duplicate check is the verdict. If none overlaps, the overlap case is **not covered** and the report says so.
- **Cleanup and baseline restore:** delete the test obligations, contract and counterparty, **and the alert log rows whose key starts with the id of a test obligation** (the owner's test account holds the delete privilege no project role has; rows are identified by the ids the script created, never by guess); counters restored; **final baseline 11 contracts, 110 matrix rows, 5 assignments, 0 steps, 0 obligations, 0 alert log rows, all five flows Off, counters [0,0,0,0,0]**.

## 16. Not proven / open questions

**Not proven (nothing here has run; the generator is offline):**
1. Everything in this spec: no flow exists and the session script is not written.
2. **The output shape of a failed insert in Power Automate, whether the connector retries, and whether a handled failure marks the run Failed** (until test case 13).
3. That the keys `item/mwf_alertkey` and `item/mwf_name` are right for `CreateRecord`: Learn documents the operation id `CreateRecord` and `entityName` but not the `item/<column>` form (section 6); the existing flows use only `ListRecords`, `GetItem` and `UpdateOnlyRecord`.
4. That `formatDateTime` gives the UTC date of `mwf_duedate` in every case, and that the generated expression equals `alert-key.mjs` **in the real engine** (the offline evaluator proves the text, not the engine); that the due date read by `List rows` and the one read again by `Get item` are written in the same way, because `Check_obligation_still_due` compares them as text (if they differ, no alert is ever claimed: visible, not silent).
5. That the duplicate path works under overlapping real runs (measured only: 5 parallel direct calls, one run).
6. That the obligation link opens a record; that the recipient logic works for more than one user.
7. The behavior with more than 50 obligations inside the window; after a solution import; with the key not Active (accepted risk, section 12).

**Open questions (the owner):**
1. **Production lead time and lookback window.** The lookback decides which downtimes lose alerts (section 3). No number is proposed.
2. **Production recurrence interval** (required parameter, no number proposed).
3. **Repeated overdue alerts** (the key gives one per due date; ADR-011 open question 2).
4. **Who receives** the alert when the contract owner cannot (ADR-011 open question 6).
5. **Email texts**, and whether the party and a link belong in them.
6. **Roles and forms for the obligation** (ADR-011 open question 4).
7. **The empty false branch of `Check_obligation_still_due`** (section 3): leave it silent, count it, or compare `ticks` instead of text.
