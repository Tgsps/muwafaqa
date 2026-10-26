# Flow Specification: Approval Reminders

Decision and context: [ADR-010](decisions/ADR-010-reminders-and-escalation.md) (status Proposed). Every claim is tagged **(script)** when a script checked it, **(unit)** for a unit test, **(from Learn)**, or **(not tested)**.

## 0. Status (2026-10-26)

- **The definition is generated and checked offline.** `scripts/build-flow-reminders.mjs --mode=check` (with `--outlook-ref=mwf_sharedoffice365_reminders`): 43 structural checks pass for each of the two variants (script); 35 unit tests (unit), among them one that injects each defect and shows the matching check failing, and tests of the creation request and of the refusals.
- **The Outlook connection reference exists** (created by the owner in the solution Muwafaqa on 2026-10-26; logical name `mwf_sharedoffice365_reminders`, connector Office 365 Outlook, the owner's existing Outlook connection). **The TEST variant of the flow was created on 2026-10-26, OFF** (`--mode=create --variant=test`, owner's Azure CLI sign-in, one POST, never retried): before it a 3-minute window (environment DNS 0 of 36, GET 0 of 36) and a read-only baseline (11 contracts, 110 matrix rows, 5 assignments, 0 steps, counters [1, 0, 0, 0, 0], all 4 flow rows OFF); the creation made 16 PASS (both references exist once, for the right connector, in the solution and with a connection set; category 5, OFF, in the solution, stored structure and action names, stored reference names, no other flow changed); `--mode=verify` 5 PASS (43 structural checks on the stored definition); the baseline afterwards was identical except for the new row (5 flow rows, all OFF). **It was never turned on and never ran.** The only write the script can make is ONE POST of a row that carries no state; the source has no PATCH, PUT or DELETE (a unit test holds this). The owner alone turns a flow on or off.
- The flow is designed with two variants (test and production); **only the TEST variant exists in the environment and in `src/`** (created OFF on 2026-10-26); the production variant is generated and checked offline only.
- The two columns the flow writes (`mwf_remindedon`, `mwf_escalatedon` on `mwf_approvalstep`) **exist** since 2026-10-26.
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

## 4. Manual test cases (the owner, with the test variant, v2 and this flow turned on by the owner)

Use the existing session scripts to create the contracts and answer the requests as for v2 (fictional data only). The reminder flow needs v2 running, because v2 is what makes a step Waiting. All emails go to the owner's mailbox (the only user). Wait at least 2 scans after each time limit.

| Case | Setup | Expected | Result |
|---|---|---|---|
| **R1** reminder, escalation, once each | one contract, one Approve step, the request is **not** answered | after about 3 min: one reminder mail; `mwf_remindedon` set once. After about 6 min: one escalation mail; `mwf_escalatedon` set once. No second mail of either kind over the next 3 scans. Then the owner answers Approve: the contract goes In Force as in v2 | not run |
| **R2** answered before the time | the same, answered at about 1 minute | no mail, both columns stay empty | not run |
| **R3** idempotency and re-read | after R1's reminder, run the flow by hand twice in a row (Run in the portal) | no extra mail; the columns keep their first values | not run |
| **R4** orphans | a contract whose first chain was left Waiting and was submitted again (a new round), and a contract that is no longer Pending Approval | no mail for the old round's step and none for the non-pending contract | not run |
| **R5** the cap | seven contracts whose steps are all past the reminder time | the first run sends 5 mails and claims 5 steps, the next run the other 2 (the count of mails per run is read from the run history) | not run |
| **R6** (optional) a later step | a two-step chain, step 1 approved, step 2 left waiting | the reminder for step 2 comes about 3 minutes after step 1's answer, **not** 3 minutes after the submission | not run |

Not provable with one user and short timers: a real 48/96 h wait, two overlapping runs, a second approver, delivery to anyone but the owner, the race between a send and an answer.

## 5. Not verified (read before the first turn-on)

- **The parameter keys of Send an email (V2).** Learn ([Office 365 Outlook](https://learn.microsoft.com/en-us/connectors/office365/)) lists flat keys (`To`, `Subject`, `Body`); the designer usually writes `emailMessage/To` and so on. The generator uses the nested style and holds it in one constant (`EMAIL_KEY_STYLE`). The first created row must be opened in the designer and compared; this was the highest-risk item of v2 too.
- Expressions never run: `empty()` of a null column, `formatDateTime(addMinutes(...))` inside the OData filter, `mwf_remindedon ne null`, `IncrementVariable`, `first()` on lists (it is only called after a length check).
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
