#!/usr/bin/env node
/**
 * Test session of the flow "Muwafaqa - Approval Reminders" (test variant): the cases R1 to R6 of docs/flow-approval-reminders.md in two windows.
 * WRITTEN FOR REVIEW. NO WINDOW HAS BEEN RUN. Every mode that writes needs --confirm-mutates-environment (or --dry-run, which still signs in and reads).
 * FICTIONAL rows only, prefixes TEST-TMP-REM1- (window 1) and TEST-TMP-REM2- (window 2).
 *
 * v2 IS SIMULATED BY SEEDED ROWS: the steps are made Waiting (or answered) by a direct write, as v2 would write them. v2 does not run, so v2 stays OFF the whole time.
 * This session does NOT prove the integration with v2.
 *
 * THE OWNER ALONE TURNS FLOWS ON AND OFF. This script never turns a flow on or off, never saves or publishes a flow, never writes to the table of flows.
 * It reads the state of the reminders flow itself (the helper of the other scripts only knows the flows named "Contract Approval").
 *
 * Window 1 (about 9 minutes ON): R5 the cap (7 contracts; the positive control), R3 escalation only, R4a a Waiting step of an old round, R4b a Waiting step of a contract that is no longer Pending.
 * Window 2 (about 11 minutes ON): R1 reminder then escalation (the positive control), R2 answered before the time, R6 a later step counts from the answer to the step before it.
 * Every case waits in REAL time from its submission: reminder after 3 minutes, escalation after 6 (see lib/reminder-session.mjs).
 *
 * Modes:
 *   --mode=plan                           offline: the plan of both windows (no sign-in, no --env)
 *   --mode=baseline                       read only: 3 consecutive reads, the counts, ALL flows OFF, the five assignments resolve to the logged-in user (FAILS otherwise), the legacy contract, no row of this session
 *   --mode=setup --window=1|2             creates the counterparty and the contracts, submits them, seeds the steps; for R4a and R4b the Waiting seed is the LAST write, after the contract
 *                                         transition, and is read back (the setup STOPS if it is not Waiting in the expected round). Prints the READY line and the counters hand-off
 *   --mode=await --window=1|2             waits (reads only) until the owner turns the flow ON, writes the TIMED seeds of window 2 (R2 at +60 s, R6 at +150 s), prints each claim as it
 *                                         appears, then prints DONE and TURN THE FLOW OFF NOW, and prints STILL ON until the flow is OFF. Silent otherwise
 *   --mode=verdict --window=1|2           read only: waits for the flow to be OFF (prints STILL ON; FAILS if it is not), then PASS / FAIL / OBS. A "no notice" result counts only if the control fired
 *   --mode=cleanup --window=1|2 [--counters-before=... --counters-consumed=...]
 *                                         REFUSES while the flow is ON (prints STILL ON, deletes nothing). Deletes the contracts of the window (the steps go by the cascade) and the counterparty,
 *                                         restores the counters by the rule of lib/counter-snapshot.mjs, checks that nothing is left
 *
 * During a window the owner does not use the UI except to turn the flow ON and OFF: Publish in the designer turned the flow ON on 2026-10-28.
 *
 * Usage (never run so far):
 *   node scripts/test-flow-reminders.mjs --mode=plan
 *   node scripts/test-flow-reminders.mjs --mode=baseline --env=https://<org>.crm4.dynamics.com --auth=az
 *   node scripts/test-flow-reminders.mjs --mode=setup --window=1 --env=... --auth=az --confirm-mutates-environment [--dry-run]
 *
 * The token stays in memory and is never printed. No id, address, email or token is printed or stored.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  WINDOWS, CASES, FAMILY, FLOW_NAME, STATUS, SEED, TIMED, SIMULATION_SENTENCE, subjectsOf, planLines, verdict, summarize, recipientsVerdict,
} from './lib/reminder-session.mjs';
import { DECISION } from './lib/reminder-candidates.mjs';

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;   // false when a unit test imports this file
const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const has = (f) => process.argv.includes(f);
const MODES = ['plan', 'baseline', 'setup', 'await', 'verdict', 'cleanup'];
const WRITES = ['setup', 'await', 'cleanup'];
const q = encodeURIComponent;
const EXPECTED_CONTRACT_FILTER = `statuscode eq ${STATUS.Pending} and mwf_approvalround ne null`;

if (isMain) {
  const MODE = argOf('mode'); const WIN = Number(argOf('window')); const DRY = has('--dry-run');
  if (!MODES.includes(MODE)) { console.error(`Missing or invalid --mode=${MODES.join('|')}. Nothing was run.`); process.exit(2); }
  if (MODE === 'plan') {
    console.log(SIMULATION_SENTENCE + '\n');
    for (const id of [1, 2]) console.log(planLines(id).join('\n') + '\n');
    process.exit(0);
  }
  if (['setup', 'await', 'verdict', 'cleanup'].includes(MODE) && !WINDOWS[WIN]) { console.error('Missing or invalid --window=1|2. Nothing was run.'); process.exit(2); }
  if (WRITES.includes(MODE) && !DRY && !has('--confirm-mutates-environment')) {
    console.error(`WARNING: --mode=${MODE} writes to the environment (rows with the prefix ${FAMILY}). Add --confirm-mutates-environment to run it on purpose, or --dry-run to see what it would do. Nothing was run.`);
    process.exit(2);
  }
  if (argOf('auth') && argOf('auth') !== 'az') { console.error('Only --auth=az (the owner\'s Azure CLI sign-in) is accepted. Nothing was run.'); process.exit(2); }
  const argv = process.argv.some((a) => a.startsWith('--auth=')) ? process.argv : [...process.argv, '--auth=az'];

  const { parseArgs, openSession, noGuid, sleep, Stop } = await import('./lib/dv-session.mjs');
  const { snapshotCounters, ctrIo, trackCreate, restoreFromArgs, printHandoff, requireStableConnection } = await import('./lib/counter-snapshot.mjs');
  const { deleteContracts } = await import('./lib/contract-cleanup.mjs');
  const { enterCleanupPhase, recheckAfterWait } = await import('./lib/resilient-fetch.mjs');
  const { expectContractsOrExit, describeExpectContracts, contractsVerdict } = await import('./lib/expect-contracts.mjs');
  const { env: ENV, auth: AUTH } = parseArgs(argv);
  const EXPECT = expectContractsOrExit();
  console.log(describeExpectContracts(EXPECT));

  let S; let snap = null; let failed = 0;
  const out = (id, status, name, detail = '') => { if (status === 'FAIL') failed++; console.log(`${status.padEnd(4)}  ${String(id).padEnd(14)} ${name}${detail ? `  [${detail}]` : ''}`); };
  const check = (id, name, ok, detail) => out(id, ok ? 'PASS' : 'FAIL', name, detail);
  const get = async (p) => (await S.must('GET', p)).j;
  const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  /** Every write goes through here: in a dry run it only prints what it would send. Never to the table of flows. */
  async function write(method, path, body, extra) {
    if (/^workflows/.test(path)) throw new Stop('refused: this script never writes to the table of flows');
    if (DRY) { console.log(`DRY-RUN  would ${method} ${noGuid(path).slice(0, 70)}${body ? ' ' + JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => !k.includes('@odata')))) : ''}`); return { ok: true, status: 0, j: {}, id: '00000000-0000-4000-8000-000000000000', dry: true }; }
    return S.callT(method, path, body, extra);
  }
  async function open() {
    S = await openSession({ env: ENV, auth: AUTH });
    const raw = S.call;
    S.callT = async (m, p, b, x) => { const r = await raw(m, p, b, x); trackCreate(m, p, b, r.ok); return r; };
    S.ctr = ctrIo(S.callT);
    await requireStableConnection(raw);
  }

  // ------------------------------------------------------------------------------------------------ reads
  async function allFlows() { return (await get(`workflows?$select=name,statecode,workflowid,modifiedon&$filter=${q('category eq 5')}&$top=200`)).value; }
  async function reminderFlow() {
    const rows = (await get(`workflows?$select=name,statecode,workflowid,modifiedon,clientdata&$filter=${q(`name eq '${FLOW_NAME}' and category eq 5`)}`)).value.filter((r) => r.name === FLOW_NAME);
    if (rows.length !== 1) throw new Stop(`Expected exactly one flow row named "${FLOW_NAME}", found ${rows.length}.`);
    return rows[0];
  }
  async function contractsOf(prefix) { return (await get(`mwf_contracts?$select=mwf_contractid,mwf_name,mwf_contractnumber,statuscode,statecode,mwf_approvalround,modifiedon&$filter=${q(`startswith(mwf_name,'${prefix}-')`)}&$top=100`)).value; }
  async function stepsOf(contractId) {
    return (await get(`mwf_approvalsteps?$select=mwf_approvalstepid,_mwf_contract_value,mwf_approvalround,mwf_steporder,mwf_decision,mwf_actiontype,createdon,mwf_decidedon,mwf_remindedon,mwf_escalatedon&$filter=_mwf_contract_value eq ${contractId}&$orderby=mwf_approvalround asc,mwf_steporder asc`)).value;
  }
  async function stepsOfAll(contracts) { const all = []; for (const c of contracts) all.push(...await stepsOf(c.mwf_contractid)); return all; }
  async function counts() {
    const n = async (set, id, filter) => (await get(`${set}?$select=${id}&$count=true&$top=1${filter ? `&$filter=${q(filter)}` : ''}`))['@odata.count'];
    return { contracts: await n('mwf_contracts', 'mwf_contractid'), matrix: await n('mwf_approvalmatrixes', 'mwf_approvalmatrixid', 'statecode eq 0'), assignments: await n('mwf_approverassignments', 'mwf_approverassignmentid', 'statecode eq 0'), steps: await n('mwf_approvalsteps', 'mwf_approvalstepid') };
  }

  /** Polls the state of the reminders flow (read only) and prints STILL ON until it is OFF. Returns true when OFF. */
  async function waitForOff(maxSeconds, every = 10) {
    const end = Date.now() + maxSeconds * 1000; let first = true;
    for (;;) {
      const f = await reminderFlow();
      if (f.statecode === 0) { console.log(first ? 'INFO  the reminders flow is OFF (read only)' : 'INFO  the reminders flow is now OFF'); return true; }
      console.log(`STILL ON: the reminders flow is ON. The owner must turn it OFF (Power Automate > "${FLOW_NAME}" > Turn off). This script cannot and will not do it.`);
      first = false;
      if (Date.now() >= end) return false;
      await sleep(every * 1000); await recheckAfterWait(S.call, 'This is a read step; nothing is written by it.');
    }
  }

  // ------------------------------------------------------------------------------------------------ baseline
  async function baseline() {
    const c = await counts();
    const family = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${FAMILY}')`)}`)).value.length;
    const familyCp = (await get(`mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${FAMILY}')`)}`)).value.length;
    check('counts', `contracts ${EXPECT.value}, active matrix rows 110, active assignments 5, approval steps 0`, c.contracts === EXPECT.value && c.matrix === 110 && c.assignments === 5 && c.steps === 0, JSON.stringify(c));
    if (c.contracts !== EXPECT.value) console.log(`MISMATCH ${contractsVerdict(EXPECT, c.contracts).text}`);
    check('rows', `no contract and no counterparty of this session (${FAMILY}...) exists`, family === 0 && familyCp === 0, `${family} contract(s), ${familyCp} counterparty(ies)`);
    const flows = await allFlows();
    check('flows', 'EVERY flow row of the environment is OFF', flows.length > 0 && flows.every((f) => f.statecode === 0), flows.map((f) => `${f.name.slice(0, 28)}=${f.statecode === 0 ? 'OFF' : 'ON'}`).join('; '));
    const fl = await reminderFlow();
    check('flow-def', 'the stored reminders flow leaves out contracts with an empty approval round', JSON.parse(fl.clientdata).properties.definition.actions.Get_pending_contracts?.inputs?.parameters?.$filter === EXPECTED_CONTRACT_FILTER);
    // E: the recipients. All five assignments must resolve to the logged-in user
    const me = (await get('WhoAmI')).UserId;
    const meRow = await get(`systemusers(${me})?$select=internalemailaddress`);
    const asg = (await get(`mwf_approverassignments?$select=mwf_approverrole,_mwf_user_value&$filter=${q('statecode eq 0')}`)).value;
    const rv = recipientsVerdict({ assignments: asg, meId: me, meHasEmail: !!meRow.internalemailaddress });
    check('recipients', 'all 5 ApproverAssignment rows resolve to the logged-in user, who has an address (so every notice goes to the owner\'s own mailbox)', rv.ok, rv.ok ? '5 of 5' : rv.reasons.join('; '));
    const legacy = (await get(`mwf_contracts?$select=mwf_name,mwf_approvalround,statuscode,modifiedon&$filter=${q(`statuscode eq ${STATUS.Pending}`)}`)).value;
    out('legacy', 'OBS', 'Pending Approval contracts that exist before the session (the one with an empty round must stay untouched)', legacy.map((x) => `round ${x.mwf_approvalround}, modifiedon ${x.modifiedon}`).join(' | ') || 'none');
    const k = await snapshotCounters(S.ctr);
    console.log(`INFO  counters: ${Object.values(k.byType).map((x) => `${x.prefix}=${x.last}`).join(' ')}`);
    return failed === 0;
  }

  // ------------------------------------------------------------------------------------------------ setup
  let usdId = null; let cpId = null;
  async function newContract(subject, value) {
    const body = { mwf_name: subject, mwf_contracttype: 867640000, mwf_direction: 867640001, mwf_value: value,
      'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${cpId})`, 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${usdId})` };
    const r = await write('POST', 'mwf_contracts?$select=mwf_contractid', body, { Prefer: 'return=representation' });
    if (!r.ok) throw new Stop(`contract create failed HTTP ${r.status} ${S.msgOf(r)}`);
    return r.j?.mwf_contractid || r.id;
  }
  const patchContract = async (id, body) => { const r = await write('PATCH', `mwf_contracts(${id})`, body, { 'If-Match': '*' }); if (!r.ok) throw new Stop(`contract update failed HTTP ${r.status} ${S.msgOf(r)}`); };
  const patchStep = async (id, body) => { const r = await write('PATCH', `mwf_approvalsteps(${id})`, body, { 'If-Match': '*' }); if (!r.ok) throw new Stop(`step update failed HTTP ${r.status} ${S.msgOf(r)}`); };
  const submit = (id) => patchContract(id, { statuscode: STATUS.Pending });
  async function builtSteps(id, expectedCount, round = 1) {
    if (DRY) return Array.from({ length: expectedCount }, (_, i) => ({ mwf_approvalstepid: '00000000-0000-4000-8000-000000000000', mwf_steporder: i + 1, mwf_approvalround: round }));   // nothing was created in a dry run
    await sleep(2500);
    const steps = (await stepsOf(id)).filter((s) => s.mwf_approvalround === round);
    if (steps.length !== expectedCount) throw new Stop(`expected ${expectedCount} step(s) of round ${round}, found ${steps.length}. Run --mode=cleanup --window=${WIN}.`);
    return steps;
  }

  async function setup() {
    const flows = await allFlows();
    if (!(flows.length > 0 && flows.every((f) => f.statecode === 0))) throw new Stop('Every flow must be OFF before the setup (v2 would start a run for each submission). The owner turns them off. Nothing was created.');
    if (!(await baseline())) throw new Stop('The baseline is not clean (see the lines above). Nothing was created.');
    const w = WINDOWS[WIN];
    const usd = (await get("transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0")).value;
    if (usd.length !== 1) throw new Stop(`active USD currency: expected 1, found ${usd.length}`);
    usdId = usd[0].transactioncurrencyid;
    snap = await snapshotCounters(S.ctr);
    const cpOpt = (await get("EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)")).OptionSet.Options[0].Value;
    const cp = await write('POST', 'mwf_counterparties', { mwf_name: `${w.prefix}-Counterparty (delete me)`, mwf_counterpartytype: cpOpt });
    if (!cp.ok) throw new Stop(`counterparty create failed HTTP ${cp.status} ${S.msgOf(cp)}`);
    cpId = cp.id;
    console.log(`INFO  setup of window ${WIN} started at ${nowIso()} (UTC) ${DRY ? '(dry run)' : ''}`);
    const seen = [];   // lines for "what the flow will see"

    if (WIN === 1) {
      // R5: 7 contracts created and submitted in parallel (their createdon differ by seconds), step 1 Waiting + the escalation marker
      const ids = await Promise.all(subjectsOf('r5').map((s) => newContract(s, CASES.r5.value)));
      await Promise.all(ids.map(submit));
      const firsts = []; for (const id of ids) firsts.push((await builtSteps(id, 1))[0]);
      await Promise.all(firsts.map((s) => patchStep(s.mwf_approvalstepid, SEED.waitingEscalatedMarker())));
      seen.push('R5: 7 contracts, step 1 of each Waiting, mwf_escalatedon = the marker, mwf_remindedon empty');
      // R3: Waiting + the reminder marker (already reminded)
      const r3 = await newContract(subjectsOf('r3')[0], CASES.r3.value); await submit(r3);
      await patchStep((await builtSteps(r3, 1))[0].mwf_approvalstepid, SEED.waitingRemindedMarker());
      seen.push('R3: step 1 Waiting, mwf_remindedon = the marker, mwf_escalatedon empty');
      // R4b: the contract goes to Rejected, and ONLY THEN the step is made Waiting (the last write)
      const r4b = await newContract(subjectsOf('r4b')[0], CASES.r4b.value); await submit(r4b);
      const s4b = (await builtSteps(r4b, 1))[0];
      await patchContract(r4b, { statecode: 1, statuscode: STATUS.Rejected });
      await patchStep(s4b.mwf_approvalstepid, SEED.waiting());
      // R4a: step 1 answered, withdraw, submit again (round 2), and ONLY THEN step 2 of ROUND 1 is made Waiting (the last write)
      const r4a = await newContract(subjectsOf('r4a')[0], CASES.r4a.value); await submit(r4a);
      const s4a = await builtSteps(r4a, 2, 1);
      await patchStep(s4a[0].mwf_approvalstepid, SEED.approvedAt(nowIso()));
      await patchContract(r4a, { statuscode: STATUS.Draft });
      await patchContract(r4a, { statuscode: STATUS.Pending });
      await builtSteps(r4a, 2, 2);
      await patchStep(s4a[1].mwf_approvalstepid, SEED.waiting());
      if (!DRY) {
        const b = (await contractsOf(w.prefix)).find((c) => c.mwf_name === subjectsOf('r4b')[0]); const sb = (await stepsOf(b.mwf_contractid))[0];
        check('R4b.seed', 'READ BACK: the contract is Rejected and its step is Waiting, round 1, step order 1', b.statuscode === STATUS.Rejected && sb.mwf_decision === DECISION.Waiting && sb.mwf_approvalround === 1 && sb.mwf_steporder === 1, `contract status ${b.statuscode}, step ${sb.mwf_decision}`);
        const a = (await contractsOf(w.prefix)).find((c) => c.mwf_name === subjectsOf('r4a')[0]); const sa = (await stepsOf(a.mwf_contractid));
        const old2 = sa.find((s) => s.mwf_approvalround === 1 && s.mwf_steporder === 2);
        check('R4a.seed', 'READ BACK: the contract is Pending Approval in round 2 and the step 2 of ROUND 1 is Waiting', a.statuscode === STATUS.Pending && a.mwf_approvalround === 2 && !!old2 && old2.mwf_decision === DECISION.Waiting, `contract round ${a.mwf_approvalround}, status ${a.statuscode}, old step ${old2?.mwf_decision}`);
        if (failed) throw new Stop('A seed was not in place after the last write. Nothing is ON yet. Run --mode=cleanup --window=1.');
      }
      seen.push('R4b: when the flow scans it, the contract is Rejected (the contract query never lists it); its step is Approve, Waiting, round 1, both columns empty');
      seen.push('R4a: when the flow scans it, the contract is Pending Approval in round 2; the step is Approve, Waiting, round 1, step order 2, both columns empty; the step query filters on round 2, so it is never read');
    } else {
      const r1 = await newContract(subjectsOf('r1')[0], CASES.r1.value); await submit(r1); await patchStep((await builtSteps(r1, 1))[0].mwf_approvalstepid, SEED.waiting());
      const r2 = await newContract(subjectsOf('r2')[0], CASES.r2.value); await submit(r2); await patchStep((await builtSteps(r2, 1))[0].mwf_approvalstepid, SEED.waiting());
      const r6 = await newContract(subjectsOf('r6')[0], CASES.r6.value); await submit(r6); await builtSteps(r6, 2);
      seen.push('R1: step 1 Waiting; R2: step 1 Waiting (answered by the await step at +60 s); R6: both steps Pending (the await step writes step 1 Approved and step 2 Waiting at +150 s)');
    }
    for (const l of seen) console.log(`INFO  ${l}`);
    if (!DRY) printHandoff(snap);
    console.log(`\nREADY at ${nowIso()} (UTC). NEXT: the owner turns the flow ON now (no other UI activity), then: node scripts/test-flow-reminders.mjs --mode=await --window=${WIN} --env=... --auth=az --confirm-mutates-environment`);
    return failed === 0;
  }

  // ------------------------------------------------------------------------------------------------ await
  const claimLine = (name, s) => `${name} step ${s.mwf_steporder}: ${s.mwf_remindedon && Date.parse(s.mwf_remindedon) !== Date.parse('2001-01-01T00:00:00Z') ? 'reminded ' + s.mwf_remindedon : ''}${s.mwf_escalatedon && Date.parse(s.mwf_escalatedon) !== Date.parse('2001-01-01T00:00:00Z') ? ' escalated ' + s.mwf_escalatedon : ''}`;
  async function awaitWindow() {
    const w = WINDOWS[WIN];
    console.log('INFO  nothing is written by this step except the TIMED seeds of window 2; the owner must not touch the UI except to turn the flow ON and, at the end, OFF.');
    let waited = 0;
    while ((await reminderFlow()).statecode !== 1) {
      if (waited === 0 || waited % 60 === 0) console.log('WAITING FOR THE OWNER TO TURN THE FLOW ON (read only polling every 10 s, for at most 10 minutes)');
      if (waited >= 600) { console.log('The flow was not turned ON within 10 minutes. Nothing was changed. Exit 10.'); process.exit(10); }
      await sleep(10000); waited += 10;
    }
    console.log(`INFO  the flow is ON at ${nowIso()} (UTC)`);
    const done = { r2: false, r6: false }; const printed = new Set(); let lastClaimAt = Date.now(); const start = Date.now();
    for (;;) {
      const contracts = await contractsOf(w.prefix); const steps = await stepsOfAll(contracts);
      const nameOf = (s) => contracts.find((c) => c.mwf_contractid === s._mwf_contract_value)?.mwf_name;
      const created = (name) => { const c = contracts.find((x) => x.mwf_name === name); const ss = c ? steps.filter((s) => s._mwf_contract_value === c.mwf_contractid) : []; return ss.length ? Math.min(...ss.map((s) => Date.parse(s.createdon))) : null; };
      if (WIN === 2) {   // the timed seeds
        const c2 = contracts.find((c) => c.mwf_name === subjectsOf('r2')[0]); const c6 = contracts.find((c) => c.mwf_name === subjectsOf('r6')[0]);
        if (!done.r2 && c2 && Date.now() >= created(c2.mwf_name) + TIMED.r2AnswerAfterS * 1000) {
          const s = steps.find((x) => x._mwf_contract_value === c2.mwf_contractid && x.mwf_steporder === 1); await patchStep(s.mwf_approvalstepid, SEED.approvedAt(nowIso())); done.r2 = true; console.log(`INFO  R2: the answer was written at ${nowIso()} (UTC)`);
        }
        if (!done.r6 && c6 && Date.now() >= created(c6.mwf_name) + TIMED.r6AnswerAfterS * 1000) {
          const s1 = steps.find((x) => x._mwf_contract_value === c6.mwf_contractid && x.mwf_steporder === 1); const s2 = steps.find((x) => x._mwf_contract_value === c6.mwf_contractid && x.mwf_steporder === 2);
          const D = nowIso(); await patchStep(s1.mwf_approvalstepid, SEED.approvedAt(D)); await patchStep(s2.mwf_approvalstepid, SEED.waiting()); done.r6 = true; console.log(`INFO  R6: step 1 answered (D) at ${D} (UTC) and step 2 made Waiting`);
        }
      }
      for (const s of steps) {
        const line = claimLine(nameOf(s), s);
        const key = `${s.mwf_approvalstepid}|${line}`;
        if (/reminded|escalated/.test(line) && !printed.has(key)) { printed.add(key); lastClaimAt = Date.now(); console.log(`CLAIM  ${nowIso()}  ${line}`); }
      }
      const real = (v) => v && Date.parse(v) !== Date.parse('2001-01-01T00:00:00Z');
      const byCase = (k) => contracts.filter((c) => c.mwf_name.includes(`-${k.toUpperCase()}`)).map((c) => steps.filter((s) => s._mwf_contract_value === c.mwf_contractid));
      const complete = WIN === 1
        ? byCase('r5').length === 7 && byCase('r5').every((ss) => real(ss.find((s) => s.mwf_steporder === 1)?.mwf_remindedon)) && byCase('r3').every((ss) => real(ss[0]?.mwf_escalatedon))
        : byCase('r1').every((ss) => real(ss[0]?.mwf_escalatedon)) && byCase('r6').every((ss) => real(ss.find((s) => s.mwf_steporder === 2)?.mwf_escalatedon));
      const quiet = Date.now() - lastClaimAt >= 3 * 60 * 1000;
      if ((complete && quiet) || Date.now() - start > (w.onMinutes + 8) * 60 * 1000) { console.log(complete ? 'DONE: every expected notice was claimed and 3 quiet minutes passed.' : 'DONE (time limit): not every expected notice was claimed; the verdict will say which.'); break; }
      await sleep(15000); await recheckAfterWait(S.call, 'This is a read step; nothing is written by it.');
    }
    console.log('\n=== TURN THE FLOW OFF NOW (owner) ===');
    const off = await waitForOff(300, 15);
    console.log(off ? 'NEXT: --mode=verdict, then --mode=cleanup.' : 'The flow is STILL ON after 5 minutes. The verdict and the cleanup will refuse until it is OFF.');
    return off;
  }

  // ------------------------------------------------------------------------------------------------ verdict
  async function runVerdict() {
    console.log(SIMULATION_SENTENCE);
    const off = await waitForOff(180, 10);
    const w = WINDOWS[WIN]; const fl = await reminderFlow();
    const contracts = await contractsOf(w.prefix); const steps = await stepsOfAll(contracts);
    if (!steps.length) throw new Stop(`No step rows of window ${WIN} exist (run --mode=setup first, or the rows were already cleaned up). Nothing was changed.`);
    const earliest = Math.min(...steps.map((s) => Date.parse(s.createdon)));
    const rr = await S.call('GET', `flowruns?$filter=${q(`workflowid eq ${fl.workflowid} and starttime ge ${new Date(earliest - 60000).toISOString()}`)}&$orderby=starttime&$select=status,starttime,endtime&$top=500`);
    if (!rr.ok) throw new Stop(`flowruns not readable: HTTP ${rr.status}`);
    const runs = (rr.j.value || []).map((r) => ({ startMs: Date.parse(r.starttime), endMs: r.endtime ? Date.parse(r.endtime) : null, status: r.status }));
    const onAtMs = runs.length ? Math.min(...runs.map((r) => r.startMs)) - 60000 : null;
    const leg = (await get(`mwf_contracts?$select=mwf_name,mwf_approvalround,statuscode,modifiedon&$filter=${q(`statuscode eq ${STATUS.Pending} and mwf_approvalround eq null`)}`)).value[0];
    const legacy = leg ? { found: true, round: leg.mwf_approvalround, status: leg.statuscode, modifiedon: leg.modifiedon, modifiedonBefore: argOf('legacy-modifiedon') || null } : { found: false };
    const results = verdict({ windowId: WIN, contracts, steps, runs, flow: { on: !off || fl.statecode === 1, onAtMs }, legacy });
    for (const r of results) out(r.id, r.status, r.name, r.detail);
    const s = summarize(results);
    console.log(`\nVERDICT window ${WIN}: ${s.pass} PASS, ${s.fail} FAIL, ${s.obs} OBS.`);
    console.log(SIMULATION_SENTENCE);
    console.log('By your eye (not read by this script): the mailbox (the number and the text of the mails, all to your own address) and the run history (Send an email succeeded; the number of Increment_noticesSent iterations per run).');
    return s.fail === 0;
  }

  // ------------------------------------------------------------------------------------------------ cleanup
  async function cleanup() {
    enterCleanupPhase();
    const off = await waitForOff(120, 10);
    if (!off) { out('flow', 'FAIL', 'the reminders flow is still ON: nothing was deleted (turn it OFF first)'); return false; }
    const w = WINDOWS[WIN];
    const rows = await contractsOf(w.prefix);
    if (DRY) { console.log(`DRY-RUN  would delete ${rows.length} contract(s) with the prefix ${w.prefix}- (their steps go by the cascade), the counterparty, and restore the counters.`); return true; }
    const del = await deleteContracts(S.io, rows.map((r) => r.mwf_contractid));
    console.log(`INFO  cleanup: ${rows.length} contract(s) found, ${del.deleted} deleted, ${del.failed.length} failed (their steps go by the cascade)`);
    for (const x of (await get(`mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${w.prefix}-')`)}`)).value) { const d = await S.call('DELETE', `mwf_counterparties(${x.mwf_counterpartyid})`); console.log(`INFO  cleanup: counterparty delete HTTP ${d.status}`); }
    const rs = await restoreFromArgs(S.ctr);
    const left = (await contractsOf(w.prefix)).length;
    const c = await counts();
    check('clean', `prefix ${w.prefix}-: 0 contracts left`, left === 0, `${left}`);
    check('clean.counts', `contracts ${EXPECT.value}, approval steps 0 (the baseline)`, c.contracts === EXPECT.value && c.steps === 0, JSON.stringify(c));
    return left === 0 && !del.failed.length && !rs.refused && failed === 0;
  }

  (async () => {
    try {
      await open();
      let ok = true;
      if (MODE === 'baseline') ok = await baseline();
      else if (MODE === 'setup') ok = await setup();
      else if (MODE === 'await') ok = await awaitWindow();
      else if (MODE === 'verdict') ok = await runVerdict();
      else if (MODE === 'cleanup') ok = await cleanup();
      process.exit(ok ? 0 : 1);
    } catch (e) {
      console.error(`\nSTOPPED: ${noGuid(e.message)}`);
      if (MODE === 'setup') console.error(`If rows were created, clean up with: node scripts/test-flow-reminders.mjs --mode=cleanup --window=${WIN} --env=<url> --auth=az --confirm-mutates-environment --counters-before=... --counters-consumed=...  (the owner turns the flow off first if it is on)`);
      process.exit(4);
    }
  })();
}
