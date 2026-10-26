# ADR-010: Reminders and escalation of pending approvals

- **Status:** **Proposed.** The design direction was approved by the owner on 2026-10-26 (separate scheduled flow, derived waiting time, two columns, claim-first, informational escalation); **nothing is built or created**: no column, no flow, no flow definition. The data model change must be reviewed by the owner before the columns are created. The notification channel is **not decided**.
- **Date:** 2026-10-26
- **Related:** [ADR-007](ADR-007-approval-chain.md) (chain, flow v2), [ADR-004](ADR-004-contract-state-guard.md) (guard), [ADR-008](ADR-008-security-roles.md) (roles), [ADR-009](ADR-009-auditing.md) (auditing), `scripts/lib/reminder-candidates.mjs`, `scripts/lib/reminder-schema.mjs`, `scripts/add-reminder-columns.mjs` (written, not run).
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

## New columns (proposal; nothing created)

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
6. The data-model review of the two columns by the owner, before `add-reminder-columns.mjs --mode=apply` is ever run.

## Not built, not run

No flow definition, no flow row, no column, no change in `src/`. The schema script and the two pure modules are written and unit tested only (`scripts/lib/reminder-schema.test.mjs`, `scripts/lib/reminder-candidates.test.mjs`); the schema script's default mode is an offline plan.
