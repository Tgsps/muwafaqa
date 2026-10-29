# Flow Specification: Approval Reminders

Decision and context: [ADR-010](decisions/ADR-010-reminders-and-escalation.md) (status Proposed). Every claim is tagged **(script)** when a script checked it, **(unit)** for a unit test, **(from Learn)**, or **(not tested)**.

## 0. Status (2026-10-26)

- **The definition is generated and checked offline.** `scripts/build-flow-reminders.mjs --mode=check` (with `--outlook-ref=mwf_sharedoffice365_reminders`): 45 structural checks pass for each of the two variants (script); 40 unit tests (unit), among them one that injects each defect and shows the matching check failing, and tests of the creation request and of the refusals.
- **The Outlook connection reference exists** (created by the owner in the solution Muwafaqa on 2026-10-26; logical name `mwf_sharedoffice365_reminders`, connector Office 365 Outlook, the owner's existing Outlook connection). **The TEST variant of the flow was created on 2026-10-26, OFF** (`--mode=create --variant=test`, owner's Azure CLI sign-in, one POST, never retried): before it a 3-minute window (environment DNS 0 of 36, GET 0 of 36) and a read-only baseline (11 contracts, 110 matrix rows, 5 assignments, 0 steps, counters [1, 0, 0, 0, 0], all 4 flow rows OFF); the creation made 16 PASS (both references exist once, for the right connector, in the solution and with a connection set; category 5, OFF, in the solution, stored structure and action names, stored reference names, no other flow changed); `--mode=verify` 5 PASS (43 structural checks on the stored definition); the baseline afterwards was identical except for the new row (5 flow rows, all OFF). **The owner did not turn it on, but it was later found ON and failing (section 7); it has never run successfully.** The only write the script can make is ONE POST of a row that carries no state; the source has no PATCH, PUT or DELETE (a unit test holds this). The owner alone turns a flow on or off.
- The flow is designed with two variants (test and production); **only the TEST variant exists in the environment and in `src/`** (created OFF on 2026-10-26); the production variant is generated and checked offline only.
- The two columns the flow writes (`mwf_remindedon`, `mwf_escalatedon` on `mwf_approvalstep`) **exist** since 2026-10-26.
- **The test session script** `scripts/test-flow-reminders.mjs` (with `scripts/lib/reminder-session.mjs`) is written and its pure parts and refusals are unit tested (27 tests); **no window has been run**. v2 is not used: v2 is simulated by seeded rows (section 4).
- Size of the generated definition (script): **42 actions, nesting depth 7** (limits 500 and 8, Learn [limits-and-config](https://learn.microsoft.com/en-us/power-automate/limits-and-config)); the Recurrence trigger is not counted. This flow is separate from v2 (v2 stays at 50 actions, depth 6).

## 1. What the flow does

Every run (test: every minute; production: every 15 minutes, a placeholder):

1. Reads the contracts that are **Pending Approval** (server side, oldest `modifiedon` first, at most 50).
2. For each contract, reads its **Waiting Approve steps of the current round** that may need a notice (server side).
3. For each such step, **derives the waiting time**: step 1 from the `createdon` of the step row; step k > 1 from the `mwf_decidedon` of step k-1 of the same contract and round, **only if** that step exists, is Approved or Informed, and has a `decidedon`. Otherwise the step is skipped and nothing is sent.
4. Decides: no reminder yet and waiting at least the reminder time: **remind**; reminded, not escalated and waiting at least the escalation time: **escalate**; otherwise nothing.
5. Resolves the recipient **before** anything is written: reminder to the user of the assigned role (`internalemailaddress`, assumption A2); escalation to the owner of the contract (assumption A1). No address: skipped, not claimed.
6. Reads the step again; continues only if it is still Waiting and the notice is still unsent.
7. **Claims** (writes `mwf_remindedon` or `mwf_escalatedon` = now), counts the notice (hard cap **5 per run**, owner decision), **then sends** the email (Office 365 Outlook, Send an email (V2)).

A failed send after the claim loses that notice and never repeats it (claim-first, ADR-010). The flow never approves, rejects, skips or reassigns anything and writes only the two columns.

## 2. The two variants (the only differences)

| | test | production |
|---|---|---|
| Recurrence | every 1 minute | every 15 minutes (**placeholder**, not decided) |
| Reminder after | 3 minutes | 2880 minutes = 48 h (placeholder) |
| Escalation after | 6 minutes | 5760 minutes = 96 h (placeholder) |
| Email subject | starts with `[Muwafaqa test] ` | no prefix |

A unit test over the two generated definitions shows that nothing else differs (unit).

## 3. Which logic lives where, and what the unit tests do NOT cover

`pickCandidates` and `capActions` (`scripts/lib/reminder-candidates.mjs`) are unit tested, **but the flow does not run them**: it re-implements the same rules in Power Automate expressions. **None of the following is covered by any test of the JS functions** (the generator tests check the structure and the constants, not the results):

- the server-side `$filter` of the steps and its time cut (a necessary condition: waiting since is never earlier than the `createdon` of the row, so no due step is lost);
- the derived waiting time and the fail-safe when the previous step is missing, undecided or has no `decidedon`;
- the elapsed minutes (`ticks` arithmetic) and the remind-or-escalate expression (`Set_action`);
- the re-read before the claim, the claim writes, the counter and the cap;
- the **order**: the flow visits contracts by `modifiedon` ascending and steps by step order. This **approximates** "oldest waiting first" (a later step of an old contract can have started recently); the exact order of `capActions` is not what the flow does;
- the email texts, and the keys of the Send an email (V2) parameters.

## 4. Test session R1 to R6 (the owner turns the flow ON and OFF; v2 is NOT needed)

**v2 simulated by seeded rows: this session does NOT prove the integration with v2 (no real approval request, no real answer, no real Mark_step_Waiting).** The steps are made Waiting (or answered) by a direct write, as v2 would write them, and v2 stays OFF the whole time. Read-only checks showed no plug-in on the step table and writable `mwf_decision`, `mwf_decidedon`, `mwf_remindedon` and `mwf_escalatedon`; `createdon` cannot be written. What the seeding skips: the real `Mark_step_Waiting` of v2, the approval requests and their emails, the real answer and its `completionDate`, the move to In Force, and any race with v2. An optional later session R7 (v2 and this flow ON, `test-flow-v2` case a, the owner answers) would cover that integration.

**Every case waits in REAL time from the submission of its contract.** The flow keeps a step only if its `createdon` is older than 3 minutes (reminder) or 6 minutes (escalation); `createdon` cannot be written, and a `decidedon` older than the `createdon` does not make a step due earlier. Only the later step of a chain (R6) counts from the `decidedon` of the step before it. Time limits: a notice is not expected earlier than its due time (minus 5 s) and not later than 3 minutes after it was due or after the flow was turned on.

The session script is `scripts/test-flow-reminders.mjs` (modes plan, baseline, setup, await, verdict, cleanup; **written, no window has been run**). It never turns a flow on or off and never saves or publishes one (Publish in the designer turned the flow ON on 2026-10-28), reads the state of the reminders flow itself, and prints STILL ON until it is OFF. The verdict FAILS if the flow is still ON, and the cleanup deletes nothing while it is ON.

### Window 1 (about 9 minutes ON): R5, R3, R4a, R4b. Prefix `TEST-TMP-REM1-`

| Case | Data | Expected | Checked by |
|---|---|---|---|
| **R5** the cap (the positive control of the window) | 7 contracts, USD 5,000 (1 step), created and submitted in parallel; step 1 Waiting; `mwf_escalatedon` set to the marker 2001-01-01 so that only reminders can happen | each step gets ONE reminder at about submission + 3 min; no run claims more than 5; a run that had 5 or more steps due claims exactly 5 (usually 5, then 2) | script: columns, claims per run, run statuses; the owner: the mailbox (7 reminders), the run history |
| **R3** escalation only, idempotency | 1 contract, 1 step Waiting, `mwf_remindedon` set to the marker | ONE escalation at about submission + 6 min; `mwf_remindedon` unchanged; nothing more in the next scans | script; the owner: 1 escalation mail |
| **R4a** a Waiting step of an OLD round | 1 contract, USD 25,000 (2 steps): step 1 answered, withdrawn to Draft, submitted again (round 2); **last write**: step 2 of ROUND 1 made Waiting, read back | no mail; both columns stay empty. When the flow scans it: the contract is Pending in round 2, the step is Waiting, round 1, older than 3 minutes (it would be due if the round were current); the step query filters on round 2 | script (the shape is checked again at verdict time) |
| **R4b** a Waiting step of a contract that is not Pending | 1 contract, USD 5,000: submitted, set to Rejected; **last write**: its step made Waiting, read back | no mail; both columns stay empty. The contract query never lists a Rejected contract | script |

The legacy Pending contract (empty approval round) must not break any run: no run may end Failed. Window 1 sends 7 reminders and 1 escalation: **8 emails**, all to the owner's mailbox.

### Window 2 (about 11 minutes ON): R1, R2, R6. Prefix `TEST-TMP-REM2-`

| Case | Data | Expected | Checked by |
|---|---|---|---|
| **R1** reminder, escalation, once each (the positive control) | 1 contract, USD 5,000, step 1 Waiting from the submission S0 | ONE reminder in [S0+3, S0+6] min and ONE escalation in [S0+6, S0+9] min, then nothing more | script; the owner: 2 mails |
| **R2** answered before the time | the same; at S0+60 s the await step writes the answer (Approved, `decidedon` now) | no mail at any time; both columns empty | script |
| **R6** a later step | 1 contract, USD 25,000; at S0+150 s the await step writes step 1 Approved (`decidedon` = D) and step 2 Waiting | NO reminder before D + 3 min (the key check: the time counts from the answer, not from the submission); reminder in [D+3, D+6]; escalation in [D+6, D+9] | script; the owner: 2 mails |

Window 2 sends 4 emails.

### Rules of the verdict

- A "no notice" result (R2, R4a, R4b) counts as PASS **only if the positive control of the same window fired** (R5 in window 1, R1 in window 2). Otherwise it is printed as INCONCLUSIVE and the control itself FAILS.
- The seeded shape must still hold at verdict time (the old-round step still Waiting in round 1, the Rejected contract, the answered step): silence must not come from a step that changed.
- **Window 2, the flow turned ON late:** if the owner turns the flow ON later than S0 + 2:30 (the exact ON time is the `modifiedon` of the flow row, printed by the await step and passed to the verdict with `--on-at`), the timing checks of R1 and R6 are INCONCLUSIVE (OBS) and say why; the existence of the notices is still checked, and the other checks are not affected.
- Claims are attributed to the runs of the flow by CONTAINMENT in the start and end time of each run; a claim inside several overlapping runs is reported as ambiguous, one inside no run as unattributed (both OBS), and with overlap the cap check is reported as weaker (ADR-010, "Known risk: overlapping runs").
- After the verdict of window 2 the session stops with `LINK CHECK WINDOW: contracts still exist, say 'link checked' to continue`: the owner matches the contract numbers and names printed at READY with the emails, then the cleanup runs.
- The verdict prints, at its start and at its end: **v2 simulated by seeded rows: this session does NOT prove the integration with v2 (no real approval request, no real answer, no real Mark_step_Waiting).**
- Not provable with one user and short timers: a real 48/96 h wait, two overlapping runs, a second approver, delivery to anyone but the owner, the race between a send and an answer, and the email actually being delivered (the mailbox is read by the owner, not by the script).

### Order of the owner's actions (per window)

1. The script: `--mode=baseline`, then `--mode=setup --window=N` (no UI activity). It prints READY.
2. The owner turns the reminders flow **ON** (and does nothing else in the UI; no designer, no Publish).
3. The script: `--mode=await --window=N` (reads only, plus the timed seeds of window 2). It prints DONE and TURN THE FLOW OFF NOW.
4. The owner turns the flow **OFF**; the script prints STILL ON until it is.
5. The script: `--mode=verdict --window=N`, then `--mode=cleanup --window=N` with the counters hand-off printed by the setup.

**Design property, not tested:** the cap counts all notices of a run and contracts are visited oldest first, so escalations of older contracts can use the cap before the reminders of newer ones, which then wait for the next scan. R5 isolates reminders (the escalation marker) and does not test this.

## 5. Not verified (read before the first turn-on)

- **The parameter keys of Send an email (V2).** Learn ([Office 365 Outlook](https://learn.microsoft.com/en-us/connectors/office365/)) lists flat keys (`To`, `Subject`, `Body`); the designer usually writes `emailMessage/To` and so on. The generator uses the nested style and holds it in one constant (`EMAIL_KEY_STYLE`). The first created row must be opened in the designer and compared; this was the highest-risk item of v2 too.
- Expressions never run **successfully end to end**: the first live runs failed at the step query of the legacy contract (HTTP 400, section 7), so everything after it (the derived time, the decision, the re-read, the claim, the counter, the email) has never run. Not even tried before: `empty()` of a null column, `formatDateTime(addMinutes(...))` inside the OData filter, `mwf_remindedon ne null`, `IncrementVariable`, `first()` on lists (it is only called after a length check).
- The owner of a contract can be a team; then no user is found, no address, and the notice is skipped (not claimed).
- More than 50 Pending Approval contracts: the newest are not scanned. The production interval of 15 minutes is a placeholder.
- The trigger's concurrency control is **not** set (whether the Recurrence trigger offers it was not verified); overlapping runs are limited by the interval, the re-read before the claim and the cap.
- The number of actions run per day against the license entitlements was not checked.
- The reminder flow failing silently (turned off or broken) means nobody is reminded; there is no alert.

## 6. Creating the Outlook connection and the connection reference (the owner, in the maker portal)

The flow needs its own **connection reference** (a solution component) for Office 365 Outlook. **The owner created it on 2026-10-26 with the logical name `mwf_sharedoffice365_reminders`** (display name as proposed below, connector Office 365 Outlook, the existing Outlook connection). The generator takes the **logical name as a parameter** (`--outlook-ref=<logical name>`, default `mwf_sharedoffice365_reminders`); whatever the portal shows is the name to pass. The steps below are kept as the record of what was done.

1. Open make.powerapps.com and select the Muwafaqa development environment (top right).
2. Left menu: **Connections** (under Data, or More > Connections). **New connection**, search **Office 365 Outlook**, select it, **Create**, and sign in with the owner's account (the one with the mailbox). Wait until it shows as **Connected**.
3. Left menu: **Solutions**, open **Muwafaqa**.
4. **New**, **More**, **Connection reference**.
5. **Display name:** `Muwafaqa Outlook (reminders)`. **Name:** `mwf_sharedoffice365_reminders` if the field is editable (it carries the publisher prefix `mwf_`); if the portal generates it, leave it. **Connector:** Office 365 Outlook. **Connection:** the one from step 2. **Description:** `Sends the reminder and escalation notices of ADR-010`. **Create**.
6. In the solution list, find the new row and read its **Name** (the logical name; add the column from the column chooser if it is hidden). **Send that exact name to the assistant.**
7. Check that the reference is listed **inside Muwafaqa** (and not only in the default solution) and that its connector is Office 365 Outlook.
8. **Do not** create a flow, do not turn anything on, do not edit the other two references (Dataverse and Approvals).

(Learn: [Use a connection reference in a solution](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/create-connection-reference). The labels of the portal may differ slightly; the page was not re-read for this document.)

## 7. Findings after the designer review and the first live runs (2026-10-28)

The creation of 2026-10-26 passed every structural check and every unit test, and the flow was still wrong in two ways that **only the designer and the live runs showed**. Both are now covered by a check and by unit tests, and the lesson is recorded in [ADR-010](decisions/ADR-010-reminders-and-escalation.md).

1. **Designer validation (found by opening the flow in the designer).** Three Set variable actions (`Reset_sinceUtc`, `Reset_action`, `Reset_recipientEmail`) showed "Invalid parameters" because their Value was an empty string ("'Value' is required"). **The 43 structural checks and the unit tests did not catch it**: they never ask what the designer accepts. The owner entered the expression `string('')` in the designer; the designer stored `@string('')`. The generator now uses it, and a new check ("no Set variable action has an empty or missing literal as its value") fails on any empty literal. **Shown on the old definition:** the new check fails on the committed definition of 2026-10-26 (script, `git show` of the file).
2. **What the designer changed in the stored definition** (programmatic comparison of the committed file with the file synced afterwards, key by key; 12 differing paths out of about 259, **the same 42 actions in the same order**):
   - the three resets above: `""` became `"@string('')"` (3 values);
   - the empty `"runAfter": {}` was **removed** from the first action of 8 nested scopes (`Get_due_steps`, `Set_proceed`, `Get_previous_step`, `Get_assignment_of_role`, `Get_approver_user_list`, `Get_owner_user_list`, `Get_step_before_claim`, `Branch_claim`); the first action of the whole flow keeps it; the generator now emits the same shape;
   - `properties.definition.description` was **added** (a copy of the flow description).
   - **Nothing else changed**: no expression, filter, parameter or email key was altered. The nested keys of Send an email (V2) (`emailMessage/To`, `Subject`, `Body`) were **recognized and mapped by the designer** (owner's review: To is the recipient variable, connection reference "Muwafaqa Outlook (reminders)"), and the Flow checker showed 0 errors and 0 warnings. Together with the `templateName` that Dataverse adds, the generated test definition now equals the stored one except for three paths (a unit test holds this).
3. **The flow was ON and failing (found by the sync, read only).** After the owner's save and publish in the designer the row is Activated (`statecode 1`, `statuscode 2`, last change 2026-10-28 17:59 UTC), although the owner had not turned it on. **Publish in the designer on a solution-aware flow appears to have turned the flow ON (observed 2026-10-28 17:59Z, cause inferred from timing, not proven); the flow then ran about every minute and failed with HTTP 400 on a legacy Pending contract with null mwf_approvalround; found only because the flow ran.** The owner turned it OFF on 2026-10-29 (read: `statecode 0`); the synced `data.xml` shows the state as well. It ran every minute and **every run failed** (more than 100 runs, all `ActionFailed`; the run record gives no action name). Cause, **replayed by read-only GET requests**: the one Pending Approval contract of the environment is a **legacy row whose approval round is empty** (it never went through the plug-in); the flow built the step filter `mwf_approvalround eq  and ...` and Dataverse answered **HTTP 400, "Syntax error"**. Why nothing was sent or claimed (script, read only): no approval step row exists (0), so no step could be due, and the claim and the send come after the filter. The assistant never changes the state of a flow; the owner turns it off.
   - **Fix in the generator:** the contract query now also requires `mwf_approvalround ne null`, a new check holds it, and `pickCandidates` already skips a contract whose round differs from the step's (a new unit test covers a null round). **The deployed flow had the old filter**, and the script had no update mode, so a `--mode=replace` was added (test variant only, guarded, ONE DELETE and ONE POST). On 2026-10-29 the stored flow was REPLACED with the generator's current definition (`--mode=replace --variant=test`, owner's Azure CLI sign-in, ONE DELETE then ONE POST, no retry): before it a 3-minute window (environment DNS 0 of 36, GET 0 of 36), a read-only baseline (11 contracts, 110 matrix rows, 5 assignments, 0 steps, counters [1, 0, 0, 0, 0]) and the guards (exactly one row of the exact name, category 5, OFF, in the solution, every flow OFF, the two connection references in the solution); after it 19 PASS (the new row is OFF, in the solution, stored structure and reference names as sent, no other flow changed, baseline unchanged) and `--mode=verify` 5 PASS (45 structural checks on the stored definition). The new row has a **new id**, the new contract filter (`mwf_approvalround ne null`), the designer-valid resets and the designer's runAfter shape. **It was never turned on and never ran.**
   - **Lesson:** the structural check cannot know the data. A flow that reads live rows needs a run against the real rows of the environment (with the flow's state controlled by the owner) before it counts as tested.
