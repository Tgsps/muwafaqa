# Plan for the flow-ON test session

> This file holds the plan of the **v1** session (executed on 2026-10-19) and, at the end, the **session plan for v2** (prepared 2026-10-22, executed the same day: ADR-007, "v2 flow-ON session (2026-10-22): results"). The five v1 scripts are v1 scenarios (v1 was retired on 2026-10-24; the scripts stay as history, four of them with a banner): see the note at the end about which of them can be used with v2.

Status: **executed on 2026-10-19; results at the end of this file.** It covers the five scripts that need the approval flow ON. The flow is turned on and off **by the owner**; no script and no assistant turns it on or off.

Tags: **(from code)** = read from the scripts; **(observed)** = seen in earlier runs recorded in `docs/flow-approval-v1.md` and ADR-005/006; **(estimate)** = a guess from earlier runs, not a measurement.

## The five scripts

All take `--env=<url> --auth=az` and, for anything that writes, `--confirm-mutates-environment`. Each script has a prefix of its own, and no prefix is a prefix of another (from code), so one script never deletes another script's rows.

| # | Script and modes | Prefix | What the owner is asked to do | Expected end state | Cleanup |
|---|---|---|---|---|---|
| 1 | `test-flow-trigger` (one run, no modes) | `TEST-TMP-TRIG` | Nothing during the run. Afterwards: **cancel** the run it leaves Running (do not approve it) | 4 cases (Draft to Pending; Subject edit; same-value save; Subject + same value). The script prints actions and UTC timestamps; it gives **no verdict** because the flow-run table lists finished runs only. The owner reads the run history: 1 run expected for case 1, 0 for the others | Done by the script (withdraw to Draft, delete, counters restored) |
| 2 | `test-flow-approvalround` `--mode=setup`, then `--mode=read`, `--mode=cleanup` | `TEST-TMP-RND-1` | Two stage-1 requests exist for one contract: approve the **older** one (run 1 should stop at the stage-1 checkpoint), then approve the **newer** one and its stage-2 request | Contract In Force with round 2; run 1 Canceled; run 2 Succeeded (observed once on 2026-10-13) | `cleanup` (In Force row deleted with the bypass of the guard Delete step only) |
| 3 | `test-guard-flow` `--mode=part1`, then `--mode=part2` | `TEST-TMP-GFLOW` | "...GFLOW1 normal": approve stage 1 and stage 2. "...GFLOW2 withdrawn" (already withdrawn to Draft): answer its stage-1 request | GFLOW1 In Force, GFLOW2 Draft (observed once on 2026-10-13: one run Canceled, one Succeeded) | `part2` verifies, deletes and restores the counters |
| 4 | `test-flow-checkpoints` `--mode=setup`, `--mode=withdraw3`, `--mode=read`, `--mode=cleanup` | `TEST-TMP-CHK` | In this order: CHK1 approve stage 1, then stage 2. CHK2 approve its stage 1. CHK4 **reject** stage 1. CHK3 approve stage 1 **only**, then **tell the assistant**, who runs `--mode=withdraw3`; then approve CHK3 stage 2 | CHK1 In Force, run Succeeded. CHK2 Draft, run Canceled (checkpoint 1). CHK3 Draft, run Canceled (checkpoint 2). CHK4 Rejected, run Succeeded (observed once: 2 Canceled, 2 Succeeded, none Failed) | `cleanup` |
| 5 | `test-usd-freeze --mode=flow-case`, then `--mode=cleanup` | `TEST-TMP-USD` | Answer the approval request(s) of "...C9-FLOW" by hand and look at the run | Row Pending Approval with the frozen value 1000.00 (the script checks this); the run is judged in the run history | `--mode=cleanup` |

## Rules that decide the order (from code)

1. **Counter restore is LIFO.** Every script snapshots the five counters at its start and restores them only if `counter == snapshot + the numbers it consumed` (`scripts/lib/counter-snapshot.mjs`). If setups run one after the other, the cleanups must run in the **reverse** order, otherwise the helper refuses to restore and prints the numbers.
2. **A single-process script restores inside its own run**, so `test-flow-trigger` must run **before** the others create anything, or the rule fails.
3. **The multi-step scripts print `--counters-before=... --counters-consumed=...`** at the end of their first step. Those two values must be passed to the cleanup step (`--mode=cleanup` or `--mode=part2`). Without them the counters are not restored (a message says so).
4. **No other test may run while the flow is ON** (every move to Pending Approval starts a run and real approval requests).
5. **No activity from the user interface while any test script runs.** Creating or editing a contract in the model-driven app takes a number from the same counter and breaks the counter rule; the helper then refuses to restore (this happened on 2026-10-18, see ADR-006 section E). During the session the owner only answers approvals; no contracts are created or edited in the app.

## Order that needs the fewest owner interventions

0. **Owner:** turns the flow ON. **Assistant:** read-only baseline: flow ON, 0 TEST-TMP rows, 11 contracts, counters 0/0/0/0/0, the 11 legacy rows' `modifiedon` unchanged, connection check passes.
1. **Script 1** (`test-flow-trigger`) alone. No owner action.
2. **Setups, one after the other** (each takes seconds, except step 2.1 which waits about 30 s): 2.1 `flow-approvalround --mode=setup`; 2.2 `guard-flow --mode=part1`; 2.3 `flow-checkpoints --mode=setup`; 2.4 `usd-freeze --mode=flow-case`. The assistant keeps each printed counter handoff line.
3. **Owner: one sitting of answers**, identified by the contract Subject (see the table). One message to the assistant in the middle (CHK3, `withdraw3`).
4. **Owner says the runs are finished.** **Assistant:** the read-only steps first (they do not touch the counters): `flow-approvalround --mode=read` and `flow-checkpoints --mode=read` (retries up to about 3 minutes).
5. **Cleanups in the reverse order of the setups** (each gets its own `--counters-before` / `--counters-consumed` values): 5.1 `usd-freeze --mode=cleanup`; 5.2 `flow-checkpoints --mode=cleanup`; 5.3 `guard-flow --mode=part2` (it first checks GFLOW1 In Force and GFLOW2 Draft, changes nothing if not, then deletes and restores); 5.4 `flow-approvalround --mode=cleanup`.
6. **Owner:** cancels the Running run left by script 1, then turns the flow OFF. **Assistant:** final read-only baseline (0/0/11, counters 0, legacy rows unchanged), then one `src/` sync.

## Time (all estimates)

- Script 1: about 5 minutes (4 cases x 60 s of waiting plus setup). (estimate)
- Setups: about 2 minutes together. (estimate)
- Owner answers: about 15 to 25 minutes for about 14 answers (3 + 3 + 6 + 2). Earlier runs took 7 to 15 minutes each because the owner answered by hand. (estimate)
- Reads and cleanups: about 6 to 8 minutes, the checkpoints read can wait up to about 3 minutes. (estimate)
- **Total: about 30 to 45 minutes.** (estimate)

## Risks

- **Real notifications:** every move to Pending Approval sends approval requests to the approver account configured in the flow. The account was not read. (not checked)
- **A run left Running:** script 1 leaves one run waiting for an approval; if its contract is deleted and the approval is later answered, the run is expected to fail at "Get contract after stage 1" (Failed instead of Canceled). Not tested; cancel the run instead of answering it.
- **Confusing the requests:** all requests look alike; use the contract Subject. The two stage-1 requests of script 2 differ only by creation time (older = run 1).
- **A network fault** (several times, last on 2026-10-19, see the section below): reads are now retried and every wait is followed by a connection recheck, but a long outage still stops the script. If a script stops half-way, do not re-run it: run the cleanup command it prints (`scripts/cleanup-test-rows.mjs`, or the `--mode=cleanup` of that script) and report.
- **Counter rule broken:** if anything else creates a contract during the session, the helper refuses to restore and prints the numbers; the counters are then reset by hand-checked values, never blindly.
- **Mixed-up cleanup order:** see rule 1; the assistant follows the order above.
- **The flow must stay as the owner left it:** no script and no assistant turns it on or off.

## Not tested

All five scripts after the prefix and counter-helper changes; the two-step handoff and restore path in a real session; whether the run of script 1 fails when its approval is answered after the contract was deleted.

## Network incident of 2026-10-19 and what changed

**What happened.** The first attempt of the flow-ON session stopped in `test-flow-trigger` after case 2: the read of the flow runs after the 60 s wait failed with `getaddrinfo ENOTFOUND` (the machine could not resolve the environment's name), and the script's own cleanup failed right after with the same error. The connection was back some time later (3 consecutive GET requests succeeded), and a read-only monitor of 60 cycles (5 minutes: DNS of the environment, DNS of a neutral public host, and a light GET) showed **0 failures** in that window, so the cause is not reproduced. The owner reports the computer was on a public Wi-Fi (owner). Earlier script interruptions with the same `fetch failed` message were recorded on 2026-10-18 (`test-contract-number` cleanup, the first `package-update`, `test-approval-round`): at least four interrupted scripts in all (the owner counted three). The cleanup after the 10-19 interruption was done by a one-time script, outside the project (counters restored by the helper's rule).

**Proved cause of the gap (from the code):** the retry of reads existed only in `requireStableConnection`, which runs **once at the start** of a script. The wait loop of `flow-trigger` called `call()`, a direct `fetch` with no retry, so a drop during or right after a wait was not covered.

**What changed (decided by the owner: options 1, 3 and 4):**
1. **`scripts/lib/resilient-fetch.mjs`, used by every test script's `call()`:** GET is retried on **network errors only** (ENOTFOUND, EAI_AGAIN, ETIMEDOUT, ECONNRESET, a bare "fetch failed"): 5 retries waiting 2, 4, 6, 8 and 10 s. An HTTP answer is never retried. **PATCH and POST are never retried** (the outcome of a write that met a network error is unknown; the error says so). **DELETE is retried only in the cleanup phase**, where a 404 counts as success (already gone). In the cleanup phase GET and DELETE are more patient: 10 retries, up to 10 s apart. Every retry is logged (method, path without ids and query, error code, attempt), never a token, host or id.
2. **Connection recheck after every wait** (`recheckAfterWait`: 3 consecutive GET requests, up to 15 attempts 4 s apart) before the first read or write after the wait, in `test-flow-trigger` (after the 60 s wait), `test-flow-approvalround` setup (after the 20 s and 10 s waits) and the wait loop of `test-flow-checkpoints --mode=read`. If the connection does not come back the script stops with a clear message, **writes nothing after the wait**, and prints the cleanup command.
3. **Patient cleanup:** every cleanup routine enters the cleanup phase first (reads and DELETE retried more patiently), and still reads the state first (idempotent).
4. **`scripts/cleanup-test-rows.mjs`:** a generic cleanup by Subject prefix (must start with `TEST-TMP-`) with the counter restore by the helper's rule; it is the command printed when a script stops half-way.
5. **`scripts/check-connection.mjs`:** the read-only monitor used for the pre-session condition below.

**Tested (script/unit):** 17 unit tests with injected network errors, no network (`node --test scripts/lib/resilient-fetch.test.mjs`): GET retried then succeeds; GET fails for good after the retries; PATCH and POST never retried (also in the cleanup phase); DELETE retried only in the cleanup phase; a 404 on DELETE in the cleanup phase is success (also after a retried DELETE) and a failure outside it; HTTP 404/429/500/503 never retried; a non-network error never retried; the internal no-retry marker is not sent; the log contains no token, host or id; `recheckAfterWait` succeeds after failures and gives up after 15 attempts with the hint, issuing only GET requests. A live run of `test-contract-number --only=T4,T5` (flow OFF) still passed (6 PASS) and restored the counters.

**Not tested:** whether a **whole session survives a real outage** (the retries were exercised only with injected errors, never with a real drop); the recheck inside the live flow-ON scripts; the new cleanup tool against the environment.

## Condition before the session

**Before the session, the connection monitor must report 15 minutes without errors:** run it and start only if it reports 0 failures:

`node scripts/check-connection.mjs --env=<url> --minutes=15`

This is a **practical criterion, not statistically proven**: a clean 15 minutes does not guarantee that no outage happens during a session of 30 to 45 minutes (the connection had dropped several times before). Result before the 2026-10-19 session: 180 cycles, 0 failures in DNS (environment), DNS (neutral host) and GET, median GET time 670 ms, maximum 5095 ms (script). A public Wi-Fi is a risk: use a stable network. The monitor writes nothing.

## Session results, 2026-10-19 (flow ON, executed by the owner and the assistant)

Rules followed: the owner alone turned the flow on and off and cancelled runs; the assistant never touched the flow; one owner action at a time, each followed by a read from Dataverse before the next step; no automatic re-run after an unexpected failure; no UI activity other than answering approvals. Every answer time below is the approval's `completedon` (UTC; the owner's local time is UTC+3). Run states come from the owner's run-history screenshots and, afterwards, from the `flowruns` table (the two agree in status and duration for every run).

**Precondition:** connection monitor 15 minutes, 180 cycles, 0 failures (median GET 670 ms, max 5095 ms) (script). Two approvals of the interrupted `flow-trigger` attempt (`TEST-TMP-TRIG1`) stayed Pending for the whole session and were never answered (cancelling a run does not close its approval).

| Script | Verdicts | Source |
|---|---|---|
| `test-flow-trigger` (second attempt; the first stopped on a DNS failure and was cleaned up by a one-time script) | 4 cases: HTTP 204 each, with the connection recheck passing after every 60 s wait. Run-history reading: **1 / 0 / 0 / 0** runs after cases 1 to 4: **PASS** | the run counts are the **owner's reading of the run history**, not a script verdict (the script gives none: `flowruns` lists finished runs only) |
| `test-flow-approvalround --mode=setup` | submission 1 (round 1), withdraw (round stays 1), submission 2 (round 2): **PASS**. Run 1 (oldest, answered first) ended **Cancelled** (3:18, `errorcode Terminated`); run 2 **Succeeded** (9:19); contract **In Force**, round 2, frozen 1000.00; 3 approvals Completed/Approve, no fourth: **PASS** | script (contract, approvals); owner + `flowruns` (runs) |
| `test-guard-flow --mode=part1` and `part2` | FLOW1 two stages approved: **In Force**; FLOW2 (withdrawn, its approval answered): stays **Draft**, no stage-2 request: **PASS**. Runs: FLOW1 **Succeeded** (5:11), FLOW2 **Cancelled** (6:22, `Terminated`): **PASS** | script + owner + `flowruns` |
| `test-flow-checkpoints` (`setup`, `withdraw3` at 17:46:36 UTC, `read`) | rows MATCH: CHK1 In Force, CHK2 Draft, CHK3 Draft, CHK4 Rejected (state Inactive), all frozen 1000.00. Runs attributed **by end time**: CHK1 Succeeded 3:37; CHK2 **Cancelled** 5:34 (`Terminated`); CHK3 **Cancelled** 14:20 (`Terminated`); CHK4 **Succeeded** 8:58 (`Terminated`, the reject path); 0 Failed: **PASS** | script (rows, approvals); owner + `flowruns` (runs) |
| `test-usd-freeze --mode=flow-case` | Draft to Pending with the flow ON: frozen 1000.00; the flow sent the stage-1 request; both stages approved; contract **In Force**, round 1; run **Succeeded** (13:03, `errorcode` empty): **PASS** | script (contract, approvals); owner + `flowruns` (run) |

**Cleanup (reverse order, each step read before the next):** `usd-freeze --mode=cleanup` (MNT 8 to 7), `flow-checkpoints --mode=cleanup` (7 to 3), `guard-flow --mode=part2` (3 to 1; it first verified FLOW1 In Force and FLOW2 Draft), `flow-approvalround --mode=cleanup` (1 to 0). In Force rows were deleted with the bypass of the guard Delete step only. **Final state (script):** flow OFF, 11 contracts, 0 TEST-TMP, 0 temporary counterparties, counters 0/0/0/0/0, the 11 legacy contracts' latest `modifiedon` still 2026-10-07T17:23:48Z, active approvals: only the two `TEST-TMP-TRIG1` orphans.

**Observations (none is a failure):**
1. **Runs 19:14 and 19:56 local (the two `flow-trigger` runs).** In `flowruns`: 16:14:14 to 17:14:25 UTC (1:00:11) and 16:56:30 to 17:56:37 UTC (1:00:07), both **Cancelled with an empty `errorcode`**, unlike every run cancelled by a checkpoint (`Terminated`, minutes long). Both were left waiting for an approval and cancelled from outside the flow. The owner reports that the 19:56 run was cancelled by hand at about 20:03 and that its displayed duration changed from 7:47 to about 1:00:06 afterwards. **Hypothesis, not proven:** the recorded end of a run cancelled by hand while waiting for an approval appears about an hour after its start. The owner has not confirmed that the 19:14 run was cancelled by hand too. **No evidence of a timeout in the flow definition (`clientdata`, read only: no timeout, limit, retry, duration or delay setting); the cause is unproven. The strongest hypothesis is a manual cancel with the displayed duration changing, based on the 19:56 run, which the owner did cancel (7:47, then 1:00:06), without confirmation for the 19:14 run.** The 45-minute rule (answer every run's approvals within 45 minutes of its start) stays only a precaution.
2. **`errorcode = Terminated` does not identify the checkpoint alone.** The flow has **four** Terminate actions: `Stop - contract no longer Pending (stage 1)` and `(stage 2)` (status Cancelled) and, in the reject paths, `Terminate` and `Terminate_2` (status Succeeded). So CHK4 (a Succeeded run) also has `Terminated`. **Cancelled together with Terminated** points to a checkpoint stop (the only Cancelled Terminate actions), **which of the two stages is not in the table and was not seen.**
3. **`flowruns` lags:** a run appears after it ends (the 19:56 run was missing from the table in the morning because it was not yet recorded as ended); the field `duration` of a run cancelled while waiting (4:04) does not equal end minus start (1:00:11).
4. **The old attribution of runs to contracts was wrong** and was fixed (below): two runs started in the same second (17:34:14), so the start order cannot pair runs with contracts.
5. **`flow-approvalround --mode=read` counted by time window:** it printed 14 approvals (13 Approve, 1 Reject), those of all the scripts of the session, not of its own contract (3 + 3 + 6 + 2 = 14). Fixed (below).
6. **`test-usd-freeze` has no read mode:** `--mode=check-clean` is its only read-only mode, plus a direct read of the row.
7. **One answer was announced before it was given** (USD C9-FLOW, stage 1): the read showed the request still Pending, the assistant stopped, and the owner answered afterwards. The rule "read Dataverse before the next step" caught it.
8. **Network:** a DNS failure (`ENOTFOUND`) during the first `flow-trigger` attempt; none in the second attempt or in the rest of the session, so the new retries and rechecks were **not stressed by a real outage** (the rechecks after the waits did run and passed).

**Fixes made after the session (code):**
- `scripts/test-flow-checkpoints.mjs --mode=read` now attributes runs to contracts **by end time** (the run ends within 5 s after the last approval of its contract; the attribution must be unique in both directions, otherwise no verdict) and no verdict depends on the start order. The logic is in `scripts/lib/run-attribution.mjs` with 8 unit tests built on this session's real timings, including the tie at 17:34:14 (`node --test scripts/lib/run-attribution.test.mjs`: all pass). It also prints the Terminated note above.
- `scripts/test-flow-approvalround.mjs --mode=read` now counts **only the approvals whose title ends with its own Subject** and prints how many approvals of other contracts were excluded.
- `scripts/check-connection.mjs` now prints the median and maximum GET time.

**Not tested:**
- **Which checkpoint (stage 1 or stage 2) ended each Cancelled run:** the action was not seen (screenshots show duration and status only).
- A withdraw and resubmit **after stage 1** with a stale round at the stage-2 checkpoint (still open in ADR-005); two concurrent submissions; Rejected to Draft to Pending.
- What happens if an orphan approval is answered after its contract was deleted (expected: the run fails at "Get contract after stage 1"; not tested; the two orphans were deliberately left alone).
- The **new run attribution and the new approval count against the live environment** (the test rows were deleted before the fixes; the attribution logic is unit-tested on the recorded timings only; the approvalround change is syntax-checked only).
- `scripts/cleanup-test-rows.mjs` against the environment.
- Whether a whole session **survives a real outage**.
- The notifications sent to the approver account (not checked).

---

# Session plan for v2 (prepared 2026-10-22; executed the same day, see ADR-007, "v2 flow-ON session (2026-10-22): results")

Flow: "Muwafaqa - Contract Approval v2" ([flow-approval-v2.md](flow-approval-v2.md), ADR-007). Status of v2 today: created OFF, opened in the designer by the owner (31 actions, Flow checker 0 errors and 0 warnings), **never run** *(state when the plan was written; the session ran later on 2026-10-22)*. Tags: **(from code)**, **(estimate)** = a guess, **(not tested)**.

## Rules (unchanged, and two new ones)

1. **The owner alone turns flows on and off.** The assistant and the scripts never do. **v1 and v2 are never ON together** (two runs for one submission): v1 stays OFF; the owner turns v2 ON at the start and OFF at the end.
2. One owner action at a time, printed alone with the **exact approval title** and the choice (Approve or Reject). After each answer the assistant reads Dataverse (the step rows, the contract) before the next action. The answer time is the approval's `completedon`; UTC is converted to local time (UTC+3) carefully.
3. No UI activity while a script runs (the counter rule). One script at a time; reverse-order cleanup (LIFO) so that the counters are restored by the usual rule.
4. **New:** all five roles point to the **same test account**, so every request lands in one inbox. The owner must tell requests apart by the **title**: `Approve contract: <Subject> (step i of n, <role>)`. The assistant prints the exact title of the next request and the owner answers only that one.
5. **New:** the Inform requests (`For information: contract <Subject> (step i of n, Owner)`) are **not answered by the owner**. See "Inform requests" below.

## Gate before the session

**Owner decision of 2026-10-22 (replaces the 15-minute rule for the v2 session):** `node scripts/check-connection.mjs --env=<url> --minutes=3` (36 cycles) is accepted if there are **at most 2 failures and never two failures in a row** (the `any` line: failures <= 2 and longest consecutive run <= 1). Before every write the usual check of **3 consecutive successful reads** stays. Writes are never retried automatically; reads are retried as before. `check-connection.mjs` is not changed (it already prints both numbers). (The older criterion, for the v1 session, was 0 failures in 15 minutes; a practical rule, not statistically proven.) **Run-time setting (owner, 2026-10-22):** the 3-minute check met the criterion only with `NODE_OPTIONS=--dns-result-order=ipv4first` (1 failure of 36, longest run 1); with `--no-network-family-autoselection` it did not (2 failures in a row, both 10 s request timeouts), and without any setting it did not (5 of 36, twice). So **every command of the v2 session is run with `NODE_OPTIONS=--dns-result-order=ipv4first`, written in the command.** The check succeeded with this setting; it is not shown that this is the cause. Details: ADR-007. If it fails, nothing is started and the failures are shown. The connection has shown isolated `ETIMEDOUT` failures (about 5 in 108 cycles on the default path) on 2026-10-22, so a clean 15 minutes is not guaranteed; the session waits for it.

Baseline (read only): v2 ON and v1 OFF (state read, not changed), 0 TEST-TMP rows, 11 contracts (the 11 legacy rows' `modifiedon` unchanged), 0 temporary counterparties, 0 approval steps, counters 0/0/0/0/0, 110 active matrix rows, 5 active assignments, the unit tests pass.

## Cases

A new script is needed (the five v1 scripts create contracts of USD 1000, which is a ONE-step chain in v2). **Written on 2026-10-22, not yet run against a live flow:** `scripts/test-flow-v2.mjs`, prefix `TEST-TMP-V2`, modes `setup --case=a|b|c|d`, `withdraw-resubmit` (case d), `read --case=...`, `cleanup`; it uses the shared helpers (connection check, counters, run attribution by end time with `tolS` 8 because a run with an Inform step ends a few seconds after the last answer). Only `--mode=plan`, `--mode=baseline` and `--dry-run` were run (they write nothing); see the registration log. **`src/` is synced only AFTER the v2 session** (the flow may change during it), with `scripts/scrub-emails.mjs` before `git add`.

| Case | Contract | Chain (ApprovalMatrix, fictional) | Owner actions, one at a time | Expected end state |
|---|---|---|---|---|
| **A** one step | USD 5,000, Maintenance, Expense | 1 step: Department Head (Approve) | Approve `... (step 1 of 1, Department Head)` | step 1 **Approved** with `mwf_decidedon` and the comment; contract **In Force**; run **Succeeded** |
| **B** two steps, rejection in the second | USD 25,000 | 2 steps: Department Head, Finance Manager | Approve `(step 1 of 2, Department Head)`, then **Reject** `(step 2 of 2, Finance Manager)` | step 1 Approved, step 2 **Rejected**; contract **Rejected** (state Inactive); run **Succeeded**; no further request |
| **C** top band: 4 Approve + Inform | USD 250,000 | 5 steps: Department Head, Finance Manager, General Manager, Regional Office (Approve), Owner (Inform) | Approve steps 1, 2, 3 and 4, in order | steps 1 to 4 Approved; **step 5 Informed**; contract **In Force**; run **Succeeded**; the Inform request exists and stays unanswered. **Inform does not block**: the contract is In Force within seconds of the answer to step 4 (the run does not wait for step 5) |
| **D** withdraw and resubmit during the chain | USD 25,000 | 2 steps | Approve `(step 1 of 2)` of round 1. While step 2 of round 1 is **Waiting**, the script withdraws the contract to Draft and submits it again (round 2). Then the owner answers the **old** request `(step 2 of 2)` of round 1 (it should have no effect), then approves `(step 1 of 2)` and `(step 2 of 2)` of round 2 | run 1 **Cancelled** at the checkpoint after the answer (the round differs); round-1 step 1 Approved, round-1 step 2 **Cancelled** (set by the chain builder, not overwritten); round 2 steps Approved; contract **In Force**; run 2 **Succeeded**. The owner may instead cancel run 1 by hand: either way the contract is not changed by run 1 |

(not tested for all four cases: nothing has run.)

## What is read after each answer (read only)

The step rows of the contract (order, role, action, decision, `mwf_decidedon`, comments), the contract (status, state, round), the new approval requests (title, status), and, after a run ends, the finished runs of the flow (`flowruns` lags: a run appears after it ends) attributed to contracts **by end time** with `scripts/lib/run-attribution.mjs` (unique in both directions, otherwise no verdict).

## Inform requests: they stay Pending, and how they are counted

- In case C, "Create an approval" makes a request in the approvals inbox of the test account and the run goes on without waiting. **The owner does not answer it.** It stays **Pending** (an open request) in the inbox and in `msdyn_flow_approvals` after the contract is deleted (like the two orphan `TEST-TMP-TRIG1` requests of 2026-10-19). Deleting the test contract does not remove it.
- Count (read only): rows of `msdyn_flow_approvals` whose title starts with `For information: contract ` and ends with ` (step 5 of 5, Owner)`, with the Subject of the case (`subjectOfTitle()` and `isInformTitle()` in `scripts/lib/run-attribution.mjs`), grouped by status. Expected: **1 per run of case C, 0 in the other cases**. The count is written in the results, together with how many open requests (Inform or orphan) remain in the inbox after the session.
- Open items for the owner after the session: whether to delete or ignore the open Inform requests (a script does not answer them), and a possible orphan: the old round-1 request of case D if the owner chooses not to answer it.
- Because the Inform request is never answered, the **last completion time** of a contract (used for the run attribution) is the answer to its last **Approve** step; the run ends a few seconds later.

## Order and cleanup

A, then B, then C, then D (each ends with its end state read before the next; D last because it leaves an open round-1 request). Cleanup in reverse order (D, C, B, A): delete the contracts (the steps go with them by the cascade), the counterparty, restore the counters by the rule, check-clean (0 TEST-TMP, 11 contracts, 0 steps, counters 0). Then the owner turns v2 OFF, and the assistant reads the state.

## Time (estimates)

About 5 minutes of owner action for A, 8 for B, 15 for C, 15 for D, plus the gate (15 minutes) and the cleanup. **(estimate)**

## Risks and what the session does NOT cover

- First real run of v2: any failure of an action in the loop makes a run **Failed** and leaves the contract Pending Approval (no automatic recovery). The session records it and stops; it does not retry.
- The Inform step uses "Create an approval"; its first real execution is case C. The field names inside `ApprovalCreationInput` were shown by the designer (the owner's screenshots), the run is the first proof.
- Not covered: a role without an assignment and a missing email (Failed endings; they would need the assignment rows to be changed, which this session does not do), a withdrawal between the Waiting mark and the approval request, notifications, a long wait, Phase 3 delegation.
- The title shown in the approvals inbox could not be checked before the first run (the designer shows a dynamic token for the Subject; the evaluated text is first seen in case A).

## The v1 scripts and v2

| Script | With v2 |
|---|---|
| `test-flow-approvalround` | usable: the contract (USD 1000) has a one-step chain; "stage 1" means "step 1 of 1"; approvals are matched by Subject for both title forms (changed 2026-10-22) |
| `test-flow-checkpoints` | **not as it is**: its scenarios need two stages; the attribution of runs reads both title forms (changed 2026-10-22) |
| `test-flow-trigger`, `test-guard-flow`, `test-usd-freeze --mode=flow-case` | v1 scenarios with stage 1 and stage 2 wording; the trigger test (counts of runs per action) is independent of the stages and could be reused, not checked |

Since 2026-10-24 v1 does not exist. A v2 session needs v2 ON and nothing else: the line "v1 OFF" read before each case now reads "v1 does not exist" (`test-flow-v2` and `test-flow-failures` accept a missing v1 and still refuse a v1 that is ON). `test-flow-checkpoints`, `test-guard-flow`, `test-flow-trigger` and the `flow-case` mode of `test-usd-freeze` carry the banner "v1 scenario, retired"; `test-flow-approvalround` reads both title forms and stays usable.

## Session results for v2, 2026-10-22 (flow ON, executed by the owner and the assistant)

Flow v2 ON and v1 OFF (read before every case), cases A to D one at a time, the connection setting of the owner's decision (`NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000"`). The detail, the comments, the open Inform request and the design note are in ADR-007 ("v2 flow-ON session"). The plan's expectations were all met.

| Case | Contract | Owner actions (one at a time) | Verdict | End state |
|---|---|---|---|---|
| **A** one step | USD 5,000 | Approve `(step 1 of 1, Department Head)` | 6 PASS, 0 FAIL, 1 OBS | step Approved, contract **In Force** |
| **B** reject in the second step | USD 25,000 | Approve step 1 (comment typed), **Reject** step 2 (comment typed) | 6 PASS, 0 FAIL, 1 OBS | step 1 Approved, step 2 Rejected, contract **Rejected** (state Inactive) |
| **C** top band with Inform | USD 250,000 | Approve steps 1 to 4 in order | 6 PASS, 0 FAIL, 2 OBS | steps 1 to 4 Approved, step 5 **Informed**, contract **In Force**; 1 Inform request left open |
| **D** withdraw and resubmit | USD 25,000 | Approve step 1 (round 1); the script withdrew and resubmitted (round 2); the owner answered the OLD step-2 request of round 1, then step 1 and step 2 of round 2 | 7 PASS, 0 FAIL, 1 OBS | round 1: Approved + **Cancelled**; round 2: Approved + Approved; contract **In Force** |

The OBS lines: the attribution of the run to the contract by end time (one run fits the last answer), and in C the measure of "Inform does not block" (below).

| Case | Run start (UTC) | Run end (UTC) | Duration | `flowruns` status | `errorcode` |
|---|---|---|---|---|---|
| A | 02:05:55 | 02:07:20 | 85 s | Succeeded | none |
| B | 02:12:16 | 02:15:00 | 164 s | Succeeded | Terminated (the Terminate Succeeded of the rejection case) |
| C | 02:16:53 | 02:21:37 | 284 s | Succeeded | none |
| D run 1 (the old one) | 02:25:42 | 02:31:02 | 320 s | **Cancelled** | Terminated (the Terminate Cancelled of the closing Switch) |
| D run 2 | 02:29:13 | 02:34:40 | 327 s | Succeeded | none |

`errorcode = Terminated` does not say whether a run succeeded or was cancelled (as with v1): B is Succeeded, D run 1 is Cancelled. `flowruns` showed a run one to two minutes after it ended.

**Open after the session:** one Inform request (`For information: contract TEST-TMP-V2C top band with inform (step 5 of 5, Owner)`), never answered, still in the inbox. **Counted** with `isInformTitle()` and `subjectOfTitle()`: 1 for case C, 0 for A, B and D, as expected.

**Not tested:** the Failed endings (a role without an assignment, a user without an email, no steps), a withdrawal before a step starts, an Inform step that is not last, `mwf_actualapprover` and reassignment, comments in A, C and D, notifications, two contracts in the approval at once, an outage in the middle of a run.

**The `src/` sync** came after the session, with v2 OFF and v1 OFF (see the registration log).


## Connection acceptance rule, update of 2026-10-22 (bulk messages test session)

Owner decision (an English rendering of the owner's Arabic wording): the acceptance rule is applied to the environment only: the GET requests to the environment and the DNS lookup of the environment host (at most 2 failures of 36 for each of them, and never two failures in a row in either). The neutral host stays a diagnostic indicator that is shown in the report but is not counted in the acceptance rule (its 36/36 failure while the environment showed 0/36 means that resolving the name `example.com` does not work on this machine; the cause is not known). The neutral host is not changed and no other host is tried to make a check pass.

`scripts/check-connection.mjs` now applies this rule (`scripts/lib/connection-verdict.mjs`, 8 unit tests): the environment DNS and GET lines first, the neutral host and the old "any" line as diagnostics, and a last line ACCEPTED or NOT accepted that sets the exit code. This replaces the sentence above that said the monitor was not changed and that the `any` line decides. The 3 consecutive reads before every write and the Node setting stay as before. The three windows of the bulk session and the results are in ADR-007 ("Bulk messages session").
