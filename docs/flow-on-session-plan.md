# Plan for the flow-ON test session

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
