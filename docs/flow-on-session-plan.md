# Plan for the flow-ON test session

Status: **plan only, nothing has been run.** It covers the five scripts that need the approval flow ON. The flow is turned on and off **by the owner**; no script and no assistant turns it on or off.

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
- **A network fault** (seen twice on 2026-10-13/18): the connection check only protects the start of each script. If a script stops half-way, do not re-run it: the assistant cleans up with the `--mode=cleanup` of that script (or the helper) and reports.
- **Counter rule broken:** if anything else creates a contract during the session, the helper refuses to restore and prints the numbers; the counters are then reset by hand-checked values, never blindly.
- **Mixed-up cleanup order:** see rule 1; the assistant follows the order above.
- **The flow must stay as the owner left it:** no script and no assistant turns it on or off.

## Not tested

All five scripts after the prefix and counter-helper changes; the two-step handoff and restore path in a real session; whether the run of script 1 fails when its approval is answered after the contract was deleted.
