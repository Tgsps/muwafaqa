#!/usr/bin/env node
/**
 * Test session of the flow "Muwafaqa - Obligation Alerts" (test variant), ONE window (docs/flow-obligation-alerts.md, section 15).
 * ONE WINDOW HAS BEEN RUN (night of 2026-11-03/04); its cleanup ran on 2026-11-07. At the time of writing (2026-11-07) the first flow was deleted by the owner and the Try/catch definition was created OFF and read back identical; it has never been turned on. `--mode=plan` is offline (no network call); `--mode=baseline` is read only (run on 2026-11-04, passed);
 * `setup` and `cleanup` WRITE and need the owner's explicit approval for a window; `await` and `verdict` are read only.
 * The logic is in scripts/lib/obligation-session.mjs; every other mode is covered by unit tests against a mocked environment only.
 *
 * THE OWNER ALONE TURNS FLOWS ON AND OFF. This script never turns a flow on or off, never saves or publishes a flow, never writes to the table of flows, and never reads a mailbox.
 * FICTIONAL rows only, every name starts with TEST-TMP-OBL-. Obligations need a contract, so setup creates ONE Draft contract (no approval): that consumes ONE number of the
 * contract-number counter. The counters are touched in no mode without --counters-approved (your explicit approval for the window).
 *
 * Modes:
 *   --mode=plan                    offline: the cases, the seeds with their margins, the controls, what the script measures and what only the owner can read
 *   --mode=baseline                read only: 3 consecutive reads, key Active, counts (11 / 110 / 5 / 0 and 0 obligations, 0 alert log rows), no row of this session, every flow OFF, the alerts flow row exists, the counters
 *   --mode=setup                   needs --confirm-mutates-environment and --counters-approved (or --dry-run, which still signs in and reads). Creates the counterparty, one Draft contract, the obligations
 *                                  (due dates relative to the real clock) and the pre-inserted alert log row of case 13; reads everything back; prints READY with the time limit for the ON and the counters hand-off
 *   --mode=await                   READ ONLY: waits until the owner turns the flow ON, prints ON-AT and each claim as it appears, then DONE and TURN THE FLOW OFF NOW, and STILL ON until it is OFF
 *   --mode=verdict --on-at=<ISO> [--off-at=<ISO>]   read only: waits for the flow to be OFF, then PASS / FAIL / INCONCLUSIVE / OBS. --on-at is NEEDED for runs.status (without it that item is INCONCLUSIVE: the ON time is never estimated
 *                                  from the first recorded run). The OFF time is --off-at if given, else the modifiedon of the flow row if the flow is Off now (the source is printed). expected_max = floor((OFF - ON) / interval of the test
 *                                  variant), expected_min = expected_max - 1. The verdict keeps re-reading flowruns (the records arrive late) until the count reaches expected_max, or a run has failed, or 12 minutes after the OFF time (a GUESS).
 *                                  runs.status: FAIL for any Failed, TimedOut or Cancelled run at any time; INCONCLUSIVE for an open run, an unknown expected count, or fewer runs than expected_min; PASS when every recorded run Succeeded and the
 *                                  count is at least expected_min (a count below expected_max is noted as BOUNDARY TOLERANCE USED). Exit code 0 only without FAIL and without INCONCLUSIVE. A "no alert" result counts only if both positive controls fired. Ends with the LINK CHECK pause
 *   --mode=cleanup                 REFUSES while ANY flow is ON (the alerts flow row may be absent: a missing flow cannot run, it is logged and treated as Off; two rows of that name refuse). Needs --confirm-mutates-environment (or --dry-run) and --counters-approved with --counters-before=<prefix>:<n> --counters-consumed=<prefix>:<n>.
 *                                  Deletes the alert log rows whose key starts with the id of an obligation this session created, the contract (the obligations go by the cascade) and the counterparty,
 *                                  restores the counter by the rule of lib/counter-snapshot.mjs, checks that nothing is left
 *
 * Usage (plan, baseline, setup, await and verdict have been run, in one window; its cleanup ran on 2026-11-07):
 *   node scripts/test-flow-obligation-alerts.mjs --mode=plan
 *   node scripts/test-flow-obligation-alerts.mjs --mode=baseline --env=https://<org>.crm4.dynamics.com --auth=az
 *   node scripts/test-flow-obligation-alerts.mjs --mode=setup --env=... --auth=az --confirm-mutates-environment --counters-approved
 *
 * The token stays in memory and is never printed. No id, address, email or token is printed or stored.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planLines, createSession, Stop } from './lib/obligation-session.mjs';

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;   // false when a unit test imports this file
const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const has = (f) => process.argv.includes(f);
export const MODES = ['plan', 'baseline', 'setup', 'await', 'verdict', 'cleanup'];
export const WRITES = ['setup', 'cleanup'];   // await and verdict write nothing

/** "MNT:3,PRC:0" -> { MNT: 3, PRC: 0 }. A bad shape throws. */
export function parseCounters(text) {
  if (!text) return null;
  const o = {};
  for (const kv of String(text).split(',').filter(Boolean)) {
    const m = /^([A-Z]{1,10}):(\d+)$/.exec(kv);
    if (!m) throw new Error(`bad counters value "${kv}" (expected <PREFIX>:<number>)`);
    o[m[1]] = Number(m[2]);
  }
  return o;
}

/** The refusals before any sign-in. @returns {string[]} reasons (empty = go) */
export function refusals({ mode, dry, confirm, countersApproved, auth, onAt, offAt, before, consumed, expect }) {
  const why = [];
  if (!MODES.includes(mode)) { why.push(`Missing or invalid --mode=${MODES.join('|')}`); return why; }
  if (mode === 'plan') return why;
  if (auth && auth !== 'az') why.push("Only --auth=az (the owner's Azure CLI sign-in) is accepted");
  if (WRITES.includes(mode) && !dry && !confirm) why.push(`--mode=${mode} writes to the environment: add --confirm-mutates-environment to run it on purpose, or --dry-run to see what it would do`);
  if (WRITES.includes(mode) && !dry && !countersApproved) why.push(`--mode=${mode} touches the contract-number counter (setup consumes one number, cleanup restores it): add --counters-approved (your explicit approval for this window)`);
  if (mode === 'cleanup' && !dry && countersApproved && (!before || !consumed)) why.push('cleanup needs --counters-before=<prefix>:<n> and --counters-consumed=<prefix>:<n> (printed by setup)');
  if (onAt && Number.isNaN(Date.parse(onAt))) why.push('--on-at must be an ISO UTC time such as 2027-01-01T10:00:00Z');
  if (offAt && Number.isNaN(Date.parse(offAt))) why.push('--off-at must be an ISO UTC time such as 2027-01-01T10:09:00Z');
  if (expect !== undefined && expect !== '' && !/^\d+$/.test(String(expect))) why.push('--expect-contracts must be a whole number');
  return why;
}

if (isMain) {
  const MODE = argOf('mode'); const DRY = has('--dry-run');
  let before = null; let consumed = null;
  try { before = parseCounters(argOf('counters-before')); consumed = parseCounters(argOf('counters-consumed')); } catch (e) { console.error(`${e.message}. Nothing was run.`); process.exit(2); }
  const why = refusals({ mode: MODE, dry: DRY, confirm: has('--confirm-mutates-environment'), countersApproved: has('--counters-approved'), auth: argOf('auth'), onAt: argOf('on-at'), offAt: argOf('off-at'), before, consumed, expect: argOf('expect-contracts') });
  if (why.length) { console.error(`REFUSED. ${why.join('; ')}. Nothing was run.`); process.exit(2); }
  if (MODE === 'plan') { console.log(planLines().join('\n')); process.exit(0); }
  const argv = process.argv.some((a) => a.startsWith('--auth=')) ? process.argv : [...process.argv, '--auth=az'];

  const { parseArgs, openSession, noGuid, sleep } = await import('./lib/dv-session.mjs');
  const { requireStableConnection } = await import('./lib/counter-snapshot.mjs');
  const { enterCleanupPhase } = await import('./lib/resilient-fetch.mjs');
  const { expectContractsOrExit, describeExpectContracts } = await import('./lib/expect-contracts.mjs');
  const { env: ENV, auth: AUTH } = parseArgs(argv);
  const EXPECT = expectContractsOrExit();
  console.log(describeExpectContracts(EXPECT));

  (async () => {
    try {
      const S = await openSession({ env: ENV, auth: AUTH });
      await requireStableConnection(S.call);
      const call = async (m, p, b, x) => { if (m === 'DELETE') enterCleanupPhase(); return S.call(m, p, b, x); };
      const session = createSession({
        call, now: () => Date.now(), sleep, log: (l) => console.log(noGuid(l)), gate: () => requireStableConnection(S.call),
        flags: { dry: DRY, countersApproved: has('--counters-approved'), expectContracts: EXPECT.value, onAt: argOf('on-at'), offAt: argOf('off-at'), handoff: before && consumed ? { before, consumed } : null },
      });
      let ok = true;
      if (MODE === 'baseline') ok = await session.baseline();
      else if (MODE === 'setup') ok = await session.setup();
      else if (MODE === 'await') { const r = await session.awaitWindow(); if (r === 'timeout') process.exit(10); ok = r; }
      else if (MODE === 'verdict') ok = await session.runVerdict();
      else if (MODE === 'cleanup') ok = await session.cleanup();
      process.exit(ok ? 0 : 1);
    } catch (e) {
      console.error(`\nSTOPPED: ${noGuid(e.message)}`);
      if (MODE === 'setup' && !(e instanceof Stop && /counters-approved/.test(e.message))) console.error('If rows were created, clean up with: node scripts/test-flow-obligation-alerts.mjs --mode=cleanup --env=<url> --auth=az --confirm-mutates-environment --counters-approved --counters-before=... --counters-consumed=...  (the owner turns the flow off first if it is on)');
      process.exit(4);
    }
  })();
}
