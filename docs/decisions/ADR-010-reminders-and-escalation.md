# ADR-010: Reminders and escalation of pending approvals

- **Status:** **Proposed.** The design direction was approved by the owner on 2026-10-26 (separate scheduled flow, derived waiting time, two columns, claim-first, informational escalation). **Only the two columns exist** (created on 2026-10-26, see "Implementation note"); **no flow row exists**; the definition of the flow is generated and checked **offline** (see "Flow definition"). The notification channel is Office 365 Outlook (owner, 2026-10-26; the mailbox exists), and its connection reference does not exist yet.
- **Date:** 2026-10-26
- **Related:** [ADR-007](ADR-007-approval-chain.md) (chain, flow v2), [ADR-004](ADR-004-contract-state-guard.md) (guard), [ADR-008](ADR-008-security-roles.md) (roles), [ADR-009](ADR-009-auditing.md) (auditing), `scripts/lib/reminder-candidates.mjs`, `scripts/lib/reminder-schema.mjs`, `scripts/add-reminder-columns.mjs` (run once on 2026-10-26).
- Tags: (from Learn), (script), (unit), (assumption), (not tested).

## Context

A step of the chain waits in flow v2 inside "Start and wait for an approval". The project specification has a reminder after 48 h and an escalation after 96 h. **These hours are placeholders, not business decisions, and the escalation target is an open question.** The environment has one interactive user and no Copilot Studio credits, so no agent feature is used.

What v2 writes when a step becomes Waiting: only `mwf_decision` = Waiting (`Mark_step_Waiting`, `scripts/build-flow-v2.mjs`). **Nothing records when the waiting began** (script, source read). `mwf_decidedon` is the completion time of an answered step.

## Decision

1. **A separate scheduled flow** (not part of v2) scans the waiting steps and sends a reminder and, later, an escalation notice. v2 is not changed.
2. **"Waiting since" is derived** from columns that exist: step 1 waits since the `createdon` of its row (the chain is built at submission); step k > 1 waits since the `mwf_decidedon` of step k-1 of the same contract and round (found through the alternate key `mwf_ApprovalStepKey`), when that step is Approved or Informed. A missing or undecided previous step means the chain is not in the shape the flow produces: the step is **skipped, never sent** (fail-safe).
3. **Two new columns on `mwf_approvalstep`**, Date and Time, audit ON: `mwf_remindedon` and `mwf_escalatedon`. Empty means "not sent". No counter column is needed: one reminder and one escalation per step.
4. **Claim-first:** the flow writes `mwf_remindedon` / `mwf_escalatedon` **before** it sends. This is the only protection against a second notice.
5. **Escalation (assumption A1):** one **informational** notice to the **owner of the contract** (the requester). It never approves, rejects, skips, reassigns or adds an approver; the step stays Waiting and the contract stays Pending Approval.
6. **Timers are constants** in the builder: production 2880 and 5760 minutes (48 h and 96 h, placeholders), test 3 and 6 minutes. A unit test (`scripts/lib/reminder-candidates.test.mjs`) shows that the two variants have the same keys and differ only in these two numbers; the same test for the **generated flow definitions** comes with the builder, which does not exist yet.
7. **The decision logic is a pure function** (`pickCandidates`), unit tested; the flow reads the rows and acts on its result.

## Alternatives rejected, with the evidence

| Alternative | Why rejected |
|---|---|
| **A parallel branch with a Delay inside v2** | Learn ([Handle workflow errors, "run after"](https://learn.microsoft.com/en-us/azure/logic-apps/error-exception-handling)): an action that needs several predecessors runs only when all of them have finished, so the step after the parallel block would wait for the delay branch too, **after the approver has already answered**. The same page says a run is marked Failed if any branch ends in failure. It changes a definition that passed the live cases A to D. (Logic Apps page; the behavior in Power Automate was not tested.) |
| **A timeout on the approval action and an Until loop that re-issues the approval** | The limits page of Power Automate ([limits-and-config](https://learn.microsoft.com/en-us/power-automate/limits-and-config)) gives 500 actions per flow and nesting depth **8**; v2 is at depth 6 (script `--mode=check`). An Until with a condition inside the loop would add two levels, to the limit (estimate, not measured). It would also create a new approval request every time, with a new email, and cancel the old one. |
| **`modifiedon` of the step row as "waiting since"** | Any later write to the row resets it, including the claim write of this very design. |
| **An explicit `mwf_waitingsince` column written by v2** | Exact and simpler to query, but it changes v2 (one field in `Mark_step_Waiting`, no new action) and needs a new Turn-on and a re-run of the live cases. Kept as the **fallback** if the derived time proves wrong (see below). |
| **The approval request's own creation time in the platform approval table** | It cannot be joined to a step except through the title text. Not reliable. |

## Trade-offs

- **Derived waiting time:** no change to v2 and no column for it, against one extra read per candidate (the previous step) and a few seconds of error (the flow starts after the chain is built; the next step starts after the previous answer is written). Both are negligible against 48 h. It is wrong if someone edits `mwf_decidedon` by hand.
- **Separate flow:** v2 stays as tested, but there is a second flow to turn on, to own and to import, and **a second flow that fails independently**: if the reminder flow is off or broken, approvals still work and nobody is reminded, silently. Monitoring of that flow is not designed here.
- **Claim-first (at most once):** a failure between the claim and the send **loses that notice** (the column says it was sent). The alternative, send-first, can send twice: Learn ([Office 365 Outlook connector](https://learn.microsoft.com/en-us/connectors/office365/)) says a 504 gateway timeout does not mean the send failed, and a retry can duplicate the email. The owner chose at most once. The cost is a missing reminder, never a duplicate.
- **A race remains:** between the scan, the claim and the send the approver can answer. The flow reads the step and the contract again before the claim and skips a step that is no longer Waiting, but **no step is atomic** (the Dataverse connector's Update a row has no documented concurrency check) and a reminder can reach someone seconds after the answer. Accepted.
- **Overlapping runs of the scan** could both claim a step. Protection planned: a run interval longer than a run, and the trigger's Concurrency Control (Learn: off by default, set in the trigger settings; whether the Recurrence trigger offers it was **not verified**).

## The 30-day edge (not covered)

Learn (limits-and-config): a flow **run lasts at most 30 days, including pending approvals; after 30 days any pending step times out.** A step of v2 that waits longer than 30 days times out **in v2 itself**. A reminder at 48 h and an escalation at 96 h do nothing about it, and this design does not handle what happens to the contract then (it would stay Pending Approval with no live run). This is a separate problem; it is listed in the open questions.

## Assumptions (not business rules)

- **A1:** the escalation target is the **contract owner**, informed only. This is an assumption, **not** a business rule. The alternative the business may want (notify a higher role from `ApproverAssignment`) is not decided; in this environment every role probably points to the same user, so it could not be tested anyway.
- **A2:** the reminder goes to the user assigned to the role, at the same address v2 uses to address the approval (`internalemailaddress` of the assigned user). Whether that is the right address for a reminder was not checked.
- **A3:** the placeholders 48 h and 96 h, the scan interval and the working-hours question (are weekends counted?) are not decided. This design counts calendar time.

## New columns (created on 2026-10-26, see the implementation note)

| Column | Type | Table | Audit | Written by |
|---|---|---|---|---|
| `mwf_remindedon` | Date and Time (user local, like `mwf_decidedon`) | `mwf_approvalstep` | ON (created ON; to be added to the audit plan of `lib/auditing.mjs` after creation) | the reminder flow, before it sends |
| `mwf_escalatedon` | Date and Time (user local) | `mwf_approvalstep` | ON | the reminder flow, before it sends |

- **Guard (ADR-004):** works on the contract only: no change. **Plug-in `ApprovalChainBuilder`:** creates the rows without these columns, so they stay empty: no change (the source was not re-read line by line for this ADR). **Roles (ADR-008):** the flow runs with the owner's connection (System Administrator): no change; if the connection ever moves to an account without write access to the step table, that privilege is needed.
- **Audit:** the script creates the columns with audit ON in the creation request and **never PUTs a column definition** (ADR-009: the no-op PUT of a column changes `ModifiedOn`, and a whole-definition PUT can change more than the flag). If a column reads back with audit OFF, `scripts/configure-auditing.mjs` is the only path used. Whether a column created with audit ON in the request reads back ON on this table is **not tested** (the script checks it and says so if not).
- **Solution:** the table is in the solution with all subcomponents; whether the new columns appear as components was **not checked**. `src/` will need `pac solution sync` and `scrub-emails.mjs` after creation.

## Channel (open)

| | Office 365 Outlook "Send an email (V2)" | An informational approval (as the Inform steps do) |
|---|---|---|
| Class (Learn) | Standard | Standard (the Approvals connector) |
| Needs | a new connection reference in the solution (the risk of K1), and **a mailbox for the owner's account, which was not checked** | nothing new (the Approvals connection exists) |
| Downside | the mail leaves the connection owner's mailbox; limits on calls per connection (Learn) | adds a request to the approver's list that can be answered by mistake |

The Dataverse connector is **Premium** (Learn); v2 already uses it, so this flow adds no new class. The licensing of the owner's account for a flow of its own was not checked.

## What the single-user test proves, and does not

Method: the builder is run with the **test** timers (3 and 6 minutes), the scan interval is the minimum Learn allows (60 s), and the owner is the only user. Cases: R1 a step is not answered (reminder, then escalation, each once, then the owner answers and the contract goes In Force); R2 the owner answers before the time (nothing is sent); R3 two scans in a row (one notice); R4 an orphan step (old round) gets nothing.

- **Proves:** the filters, the derived time, the columns written once, no duplicate in sequential scans, the decision path of v2 untouched.
- **Does not prove:** a real 48 h or 96 h wait (only the arithmetic, by unit tests); behavior over days; the race between the send and an answer; two overlapping runs; delivery to anyone other than the owner; a second approver; that the escalation target is right; that the derived time equals the true start of a step after the first: the gap between the previous answer and the real start was **not measured** (it is expected to be seconds).

## Open questions

1. Channel: Outlook or an informational approval (needs the owner's answer, and a check that the account has a mailbox).
2. **Escalation target is an assumption (A1)**, not a business rule.
3. **The reminder and escalation hours (48 h, 96 h) are placeholders**; also whether weekends count.
4. **The 30-day run limit:** what must happen to a contract whose step waits longer.
5. Monitoring of the reminder flow itself (a silent failure means silent approvals).
6. The columns were created on the owner's explicit approval of 2026-10-26; a formal data-model review (the step table in ADR-007 does not list them yet) is still to be done.
7. (Decided on 2026-10-26: the cap is 5 notices per run, hard-coded.)
8. The parameter keys of Send an email (V2) in the flow definition (Learn lists flat keys, the designer usually nested ones): to be compared in the designer after the first creation.
9. The production scan interval (15 minutes is a placeholder) and the limit of 50 Pending Approval contracts per scan.

## Flow definition (generated offline, 2026-10-26)

`scripts/build-flow-reminders.mjs` generates the definition of the flow **"Muwafaqa - Approval Reminders"** (spec, manual cases and the list of what is not verified: [flow-approval-reminders.md](../flow-approval-reminders.md)). Its creation mode (dry run by default; the only write is ONE POST of a row that carries no state, so the row is OFF) was run once on 2026-10-26 for the **test** variant: the row exists, OFF, in the solution, and has never been turned on or run (details in the flow document). No code path turns a flow on. The flow is designed with two variants (test and production); **only the TEST variant exists in the environment and in `src/`** (created OFF on 2026-10-26); the production variant is generated and checked offline only.

- **Shape:** a Recurrence trigger; the Pending Approval contracts (server side, 50 at most); per contract, the Waiting Approve steps of its **current round** that may need a notice (server side, with a time cut that is a necessary condition, so nothing due is lost); per step, the derived waiting time, the decision, the recipient, a re-read, the claim, the counter, then the email. **42 actions, nesting depth 7** (limits 500 and 8); separate from v2.
- **Variants:** test (every 1 minute, 3 and 6 minutes, subject prefix `[Muwafaqa test] `) and production (every 15 minutes, 2880 and 5760 minutes). A unit test over the two generated definitions shows they differ in nothing else. The 15 minutes of production is a **placeholder**.
- **Connection references:** the Outlook reference was created by the owner in the solution on 2026-10-26 (logical name `mwf_sharedoffice365_reminders`); it is a **parameter** of the generator (`--outlook-ref`), never a GUID. The Dataverse reference is the one v2 uses.
- **Server side versus client side:** the filtering of contracts and steps is an OData `$filter`; the exact time test, the remind-or-escalate decision, the re-read, the claim and the cap are Power Automate expressions. **These expressions are not covered by the unit tests of `pickCandidates` and `capActions`**; they are covered by the manual cases R1 to R6 of the flow document. The generator tests (40) check structure and constants only, with an injected defect for each check.
- **Order is approximate:** contracts are visited by `modifiedon` ascending and steps by step order, which approximates "oldest waiting first"; `capActions` (exact order) is not what the flow does.
- **Why contracts first, then steps:** a single query over all Waiting steps would reach orphan steps (an old round, a contract no longer Pending) first and, with a limit, could starve the live ones. Starting from the Pending contracts and their current round makes orphans unreachable. The cost is one read per contract and a limit of 50 contracts.

### Lesson of 2026-10-28: designer validation and the live data were not caught by the checks

**Publish in the designer on a solution-aware flow appears to have turned the flow ON (observed 2026-10-28 17:59Z, cause inferred from timing, not proven); the flow then ran about every minute and failed with HTTP 400 on a legacy Pending contract with null mwf_approvalround; found only because the flow ran.** Consequence for the process: after any save or publish in the designer, the state of the row is read (read only) before anything else, and a flow is never assumed to be OFF.

The designer rejected three Set variable actions whose Value was an empty string ("'Value' is required"). **This was not caught by the 43 structural checks or by the unit tests; it was found by opening the flow in the designer.** The first live runs then failed because a legacy Pending Approval contract has an empty approval round, which makes the step filter a syntax error (HTTP 400, replayed by read-only requests). Both are fixed in the generator (45 checks, 40 generator tests), not yet in the deployed flow; the details, the list of what the designer normalized and the finding that the flow was found ON are in [flow-approval-reminders.md](../flow-approval-reminders.md), section 7. A structural check cannot replace the designer and a run against the real data.

## Hard cap per run, and the flow stays OFF (owner decision of 2026-10-26: N = 5, hard-coded)

- **Cap:** the scan sends at most **N notices per run**, reminders and escalations together, the longest waiting first (`capActions` in `scripts/lib/reminder-candidates.mjs`, unit tested). **N = 5, hard-coded** (`MAX_NOTICES_PER_RUN`; the function itself has no default and throws when N is not given, so an unset cap can never mean "no cap"). Why 5: with one user and a handful of steps it never limits a normal run, and if the scan was off for days and many steps become due together, it bounds the mails of one run to 5.
- **What a cap costs:** the rest waits for the next scan (one interval later). A step that is left over is **not claimed** in this run, so nothing is lost; with 60 s between scans, 50 due steps take 10 minutes to be notified.
- **OFF by default:** the flow row is created **OFF**, the owner alone turns it on, only for a test, and turns it off after it (as for v2; no script turns a flow on or off). A cap is a limit on damage, not a reason to leave the flow on.
- **Not designed:** a kill switch inside the flow (for example a configuration row it reads first), and an alert when a run hits the cap.

## Implementation note (2026-10-26)

Run with the owner's account (Azure CLI sign-in), flow v2 OFF, the owner not using the portal. **The two columns were created** on `mwf_approvalstep` with `scripts/add-reminder-columns.mjs --mode=apply`; the flow, the notification channel and the scan do **not** exist.

- **Gate:** a 3-minute window with the project's Node settings: environment DNS 0 of 36, environment GET 0 of 36 (accepted).
- **Baseline before and after (script, read only):** 11 contracts, 110 active matrix rows, 5 active assignments, 0 approval steps, 4 flow rows all OFF, counters [1, 0, 0, 0, 0] (MNT, PRC, INS, SAL, SRV by the order the API returned them); identical before and after. The MNT counter is 1 and not 0 because of the owner's manual test of the contract form earlier on 2026-10-26 (a contract was created and deleted; a gap is allowed, ADR-006); the contract count is 11 and no contract has the MNT prefix. This is an inference from the counter's `modifiedon` (2026-10-26 09:16 UTC) and the owner's statement, not something this script observed.
- **Create (script):** both columns created with the solution header and audit ON in the request; read back: 10 PASS each (type Date and Time, user local, not required, audit ON, valid for create and update, labels as specified). `--mode=check` afterwards: 0 failed checks.
- **Audit (script):** `configure-auditing.mjs --mode=apply` for the two columns made **no write** ("audit already ON"); `--mode=verify`: 9 PASS, 0 FAIL, 1 OBS; `mwf_approvalstep` has 13 of 14 custom columns audited (off: `mwf_contract`, on purpose); the counter table stays off. The two columns are now in `COLUMN_ENABLE` (`lib/auditing.mjs`).
- **Schema verifier (script, read only, no `--cascade-test`):** 35 PASS, 0 FAIL, 3 OBS with the script as it was (the same as the earlier read-only run); after teaching it the two columns: **37 PASS, 0 FAIL, 3 OBS**. The cascade test was not run.
- **In the solution:** the table `mwf_approvalstep` is a component of Muwafaqa with all subcomponents (`rootcomponentbehavior` 0) and the two columns have no component row of their own, exactly like `mwf_decidedon`. So they belong to the solution by that rule (the same inference as for `mwf_approvalround`), **not proven by a row**. The `pac solution sync` that followed (script) exported both columns into `src/Entities/mwf_ApprovalStep/Entity.xml` (+80 lines, nothing else changed; `Solution.xml` unchanged), which shows that they travel with the solution; the import of that file into another environment was not tested.
- **Not tested:** that a flow can write the columns (nothing writes them yet); that the guard, the chain builder and the roles are unaffected (no row was created in this session; the plug-in unit tests do not touch these columns); an import into another environment.
