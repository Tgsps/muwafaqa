#!/usr/bin/env node
/**
 * Failed endings of flow v2 (ADR-007, docs/flow-approval-v2.md section 5), cases F1 and F2. FICTIONAL rows only, prefixes TEST-TMP-FF1 and TEST-TMP-FF2.
 * No approval request is created by these cases, so the owner answers nothing: the owner only turns v2 ON before and OFF after. This script never
 * turns a flow on or off. v2 must be ON and v1 OFF when a case is submitted (read only check).
 *
 *   F1  a contract of USD 5,000 is submitted Draft -> Pending with the ApprovalChainBuilder step bypassed (header MSCRM.BypassBusinessLogicExecutionStepIds
 *       with the id of that ONE step, the same administrative mechanism the cleanup uses for In Force rows). Round 1 is written, no step rows are built.
 *       Expected: v2 ends Failed (NoApprovalSteps), the contract stays Pending Approval.
 *   F2  the same, but a step row is created by hand first (round 1, order 1, Department Head, Approve, Pending) and the assignment row of Department
 *       Head is made Inactive BEFORE the submission. The submission itself is the trigger, so the run reads the step while the assignment is Inactive.
 *       The assignment is reactivated in a finally block after the run has been seen in flowruns (or after the timeout), read back, and a failure to
 *       confirm it stops everything at once. Expected: v2 ends Failed (ApprovalStepFailed, "no active Approver Assignment"), the contract stays Pending.
 *
 * Why no resubmission in F2: the trigger of v2 fires when the frozen USD value is written on a Pending contract. The first (bypassed) submission
 * already does that, so ordering "create the step, deactivate the assignment, submit" is the simplest sequence in which the run must read the step
 * while the assignment is Inactive. The assignment stays Inactive until the run is listed (the table lists finished runs 1 to 2 minutes late).
 *
 * Modes (every mode that writes needs --confirm-mutates-environment; --dry-run reads, prints the writes it would do and sends none):
 *   --mode=plan                       offline: the sequences
 *   --mode=baseline                   read only: flows, state, builder step, counters
 *   --mode=setup --case=f1|f2         creates the rows, submits with the bypass, waits for the run to be listed, prints status / errorcode / errormessage
 *   --mode=await --case=f1|f2         read only: waits (up to 8 minutes) for the run of the case and prints it
 *   --mode=verdict --case=f1|f2       read only: PASS / FAIL / OBS
 *   --mode=cleanup --case=f1|f2 [--counters-before=... --counters-consumed=...]
 *                                     reactivates an inactive assignment (always), deletes the contract (Pending: withdrawn to Draft first, steps by the
 *                                     cascade), the counterparty, restores the counters, check-clean. Run it with v2 OFF. Reverse order: f2, f1
 * The token stays in memory and is never printed. No id, address, email or token is printed or stored.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, openSession, noGuid, sleep, Stop } from './lib/dv-session.mjs';
import { snapshotCounters, ctrIo, trackCreate, restoreFromArgs, printHandoff, requireStableConnection } from './lib/counter-snapshot.mjs';
import { deleteContracts } from './lib/contract-cleanup.mjs';
import { enterCleanupPhase, recheckAfterWait } from './lib/resilient-fetch.mjs';
import { CASES, BUILDER_STEP_NAME, bypassHeaders, manualStepBody, runsSince, finished, judgeRun, assignmentActive, sessionFlowState, ROLE_DEPARTMENT_HEAD, prefixesAreIndependent } from './lib/flow-failures.mjs';

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
const { argOf, env: ENV, auth: AUTH, has } = isMain && !process.argv.includes('--mode=plan') ? parseArgs() : { argOf: (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3), env: '', auth: '', has: (f) => process.argv.includes(f) };
const MODE = argOf('mode');
const CASE = argOf('case');
const DRY = has('--dry-run');
const q = encodeURIComponent;
const V1 = 'Muwafaqa - Contract Approval v1';
const V2 = 'Muwafaqa - Contract Approval v2';
const ST = { Draft: 1, Pending: 867640000 };
const PREFIXES = Object.values(CASES).map((c) => c.prefix);

let S; let USDID = null;
const results = [];
const out = (id, status, name, detail = '') => { results.push({ id, status }); console.log(`${status.padEnd(4)}  ${id.padEnd(5)} ${name}${detail ? `  [${detail}]` : ''}`); };
const check = (id, name, ok, detail) => out(id, ok ? 'PASS' : 'FAIL', name, detail);
const get = async (p) => (await S.must('GET', p)).j;
const count = async (path) => (await get(`${path}${path.includes('?') ? '&' : '?'}$count=true&$top=1`))['@odata.count'];

async function open() {
  S = await openSession({ env: ENV, auth: AUTH });
  const raw = S.call;
  S.callT = async (m, p, b, x) => { const r = await raw(m, p, b, x); trackCreate(m, p, b, r.ok); return r; };
  S.ctr = ctrIo(S.callT);
  await requireStableConnection(raw);
}
const gate = () => requireStableConnection(S.call, { need: 3, maxAttempts: 6, pauseMs: 1500 });
/** Every write goes through here: 3 consecutive reads first, no retry, and in dry-run only a printed line. */
async function write(method, path, body, extra) {
  if (DRY) { console.log(`DRY-RUN  would ${method} ${noGuid(path).slice(0, 80)}${body ? ' ' + JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => !k.includes('@odata')))) : ''}${extra && Object.keys(extra).some((k) => k.startsWith('MSCRM')) ? ' [bypass header: the id of the ApprovalChainBuilder Update step only]' : ''}`); return { ok: true, status: 0, j: {}, id: null, dry: true }; }
  await gate();
  return S.callT(method, path, body, extra);
}

async function flows() {
  const rows = (await get(`workflows?$select=name,statecode,workflowid,workflowidunique,modifiedon&$filter=${q(`category eq 5 and (name eq '${V1}' or name eq '${V2}')`)}`)).value;
  return { v1: rows.find((r) => r.name === V1), v2: rows.find((r) => r.name === V2), count: rows.length };
}
async function requireFlows() {
  const f = await flows();
  if (f.count !== 2) throw new Stop(`Expected the two flow rows (v1 and v2), found ${f.count}. Nothing was changed.`);
  const s = sessionFlowState(f.v1, f.v2);
  if (!s.ok) {
    const msg = `v1 is ${s.v1On ? 'ON' : 'OFF'} and v2 is ${s.v2On ? 'ON' : 'OFF'}. A case needs v1 OFF and v2 ON (the owner turns them; never both ON).`;
    if (DRY) { console.log(`DRY-RUN  note: ${msg} A real run would stop here.`); return f; }
    throw new Stop(`${msg} Nothing was changed.`);
  }
  console.log('INFO  v1 is OFF and v2 is ON (read only check)');
  return f;
}
async function builderStep() {
  const r = (await get(`sdkmessageprocessingsteps?$select=name,statecode&$filter=${q(`name eq '${BUILDER_STEP_NAME}'`)}`)).value;
  if (r.length !== 1 || r[0].statecode !== 0) throw new Stop(`The ApprovalChainBuilder Update step: expected 1 enabled step, found ${r.length}${r[0] ? ` (statecode ${r[0].statecode})` : ''}. Nothing was changed.`);
  return r[0].sdkmessageprocessingstepid;
}
async function assignmentOfDH() {
  const r = (await get(`mwf_approverassignments?$select=mwf_name,statecode,_mwf_user_value&$filter=mwf_approverrole eq ${ROLE_DEPARTMENT_HEAD}`)).value;
  if (r.length !== 1) throw new Stop(`Expected 1 assignment row for Department Head, found ${r.length}.`);
  return r[0];
}
async function baseline() {
  const f = await flows();
  console.log(`INFO  v1: ${f.v1 ? (f.v1.statecode === 1 ? 'ON' : 'OFF') : 'missing'} (modifiedon ${String(f.v1?.modifiedon).slice(0, 19)}Z), v2: ${f.v2 ? (f.v2.statecode === 1 ? 'ON' : 'OFF') : 'missing'} (modifiedon ${String(f.v2?.modifiedon).slice(0, 19)}Z)`);
  const filt = q(PREFIXES.map((p) => `startswith(mwf_name,'${p}')`).join(' or '));
  const a = (await get(`mwf_contracts?$select=mwf_name&$filter=${filt}`)).value.length;
  const cp = (await get(`mwf_counterparties?$select=mwf_name&$filter=${filt}`)).value.length;
  const total = await count('mwf_contracts'); const steps = await count('mwf_approvalsteps');
  const m = await count('mwf_approvalmatrixes?$filter=statecode eq 0'); const asg = await count('mwf_approverassignments?$filter=statecode eq 0');
  const c = await snapshotCounters(S.ctr);
  console.log(`baseline: TEST-TMP-FF contracts ${a}, counterparties ${cp}, total contracts ${total} (11 expected), approval steps ${steps} (0), active matrix rows ${m} (110), active assignments ${asg} (5), counters ${Object.values(c.byType).map((x) => `${x.prefix}=${x.last}`).join(' ')} (all 0)`);
  try { const id = await builderStep(); console.log(`INFO  the ApprovalChainBuilder Update step exists and is enabled (id read, not printed): ${!!id}`); } catch (e) { console.log(`NOTE: ${noGuid(e.message)}`); }
  const open = (await get(`msdyn_flow_approvals?$select=msdyn_flow_approval_title&$filter=${q("contains(msdyn_flow_approval_title,'TEST-TMP-FF')")}&$top=50`)).value.length;
  console.log(`INFO  approval requests with a TEST-TMP-FF title: ${open} (0 expected: these cases create none)`);
  return a === 0 && cp === 0 && total === 11 && steps === 0 && m === 110 && asg === 5;
}

// ---------------------------------------------------------------------------------------------------------------- runs
const RUN_SEL = 'starttime,endtime,status,errorcode,errormessage,_workflow_value';
async function v2Runs(sinceMs, untilMs = Infinity) {
  const f = await flows(); const ids = [f.v2.workflowid, f.v2.workflowidunique];
  const since = new Date(sinceMs - 60000).toISOString();
  let r = await S.call('GET', `flowruns?$filter=${q(`starttime ge ${since}`)}&$orderby=starttime&$select=${RUN_SEL}`);
  let note = '';
  if (!r.ok) { note = `errormessage not selectable (HTTP ${r.status}); read without it`; r = await S.call('GET', `flowruns?$filter=${q(`starttime ge ${since}`)}&$orderby=starttime&$select=starttime,endtime,status,errorcode,_workflow_value`); }
  if (!r.ok) throw new Stop(`flowruns not readable: HTTP ${r.status}`);
  return { runs: runsSince(r.j.value || [], ids, sinceMs, untilMs), note };
}
/** The start of the next case (its contract was submitted later), so that its run is not attributed to this case. */
async function untilOf(c) {
  const mine = await contractOf(c); if (!mine) return Infinity;
  let until = Infinity;
  for (const o of Object.values(CASES)) {
    if (o === c) continue;
    const row = await contractOf(o);
    if (row && Date.parse(row.modifiedon) > Date.parse(mine.modifiedon)) until = Math.min(until, Date.parse(row.modifiedon) - 5000);
  }
  return until;
}
async function waitForRun(sinceMs, timeoutMs) {
  const t0 = Date.now(); let last = { runs: [], note: '' };
  while (Date.now() - t0 < timeoutMs) {
    last = await v2Runs(sinceMs);
    if (last.runs.some(finished)) return last;
    console.log(`  waiting: ${last.runs.length} run(s) listed, none finished yet (${Math.round((Date.now() - t0) / 1000)} s)`);
    await sleep(20000); await recheckAfterWait(S.call, 'This is a read step; nothing is written by it.');
  }
  return last;
}
function printRuns(label, runs) {
  for (const r of runs) console.log(`${label}: run start ${String(r.starttime).slice(0, 19)}Z, end ${String(r.endtime || '-').slice(0, 19)}Z, status ${r.status ?? '-'}, errorcode ${JSON.stringify(r.errorcode ?? null)}, errormessage ${JSON.stringify(r.errormessage ?? null)}`);
}

async function contractOf(c) {
  const r = (await get(`mwf_contracts?$select=mwf_name,mwf_contractnumber,statuscode,statecode,mwf_approvalround,mwf_valueusdfrozen,modifiedon&$filter=${q(`mwf_name eq '${c.subject}'`)}`)).value;
  return r[0] || null;
}
const stepsOf = async (id) => (await get(`mwf_approvalsteps?$select=mwf_name,mwf_approvalround,mwf_steporder,mwf_approverrole,mwf_decision,mwf_actiontype&$filter=_mwf_contract_value eq ${id}&$orderby=mwf_approvalround asc,mwf_steporder asc`)).value;

// ---------------------------------------------------------------------------------------------------------------- the assignment, always put back
let deactivated = null;   // { path }
async function reactivate() {
  if (!deactivated) return;
  const path = deactivated.path;
  const r = await S.call('PATCH', path, { statecode: 0, statuscode: 1 }, { 'If-Match': '*' });   // one attempt, never retried
  let now = null; try { now = (await S.call('GET', `${path}?$select=statecode`)).j; } catch { /* handled below */ }
  if (!assignmentActive(now)) {
    console.error(`STATE UNKNOWN: the Department Head assignment could not be confirmed Active (PATCH HTTP ${r.status}, statecode read ${now?.statecode ?? 'unreadable'}). Reactivate it by hand NOW, then run --mode=cleanup. Stopping at once.`);
    process.exit(5);
  }
  deactivated = null;
  console.log('INFO  the Department Head assignment is Active again (read back)');
}

// ---------------------------------------------------------------------------------------------------------------- modes
function modePlan() {
  console.log(`Session plan for the Failed endings of v2 (offline). The owner answers no request; the owner turns v2 ON before and OFF after. Prefixes: ${PREFIXES.join(', ')} (independent: ${prefixesAreIndependent(PREFIXES)}).\n`);
  console.log('F1 (no step rows):\n  1. read: v1 OFF, v2 ON, clean state, the builder Update step enabled\n  2. create the counterparty and a Draft contract of USD 5,000 (Maintenance / Expense)\n  3. PATCH statuscode Pending with the header MSCRM.BypassBusinessLogicExecutionStepIds = the id of the ApprovalChainBuilder Update step ONLY\n     (plug-in 1 still runs: frozen USD value and round 1 are written; the trigger fires; no step rows are built)\n  4. wait until the run is listed in flowruns; print status, errorcode and errormessage literally\n  expected: run Failed (NoApprovalSteps); contract Pending, round 1, 0 steps, no approval request\n');
  console.log('F2 (role without an active assignment). SEQUENCE, in this order:\n  1. read: v1 OFF, v2 ON, clean state, the Department Head assignment Active, the builder step enabled\n  2. create the counterparty and a Draft contract of USD 5,000\n  3. create ONE step row by hand: round 1, order 1, Department Head, Approve, Pending (original approver = the assignment user, as the builder does)\n  4. make the Department Head assignment Inactive (one PATCH, read back)\n  5. PATCH statuscode Pending with the bypass of the builder step only: this is the trigger, so the run starts with the step present and the assignment Inactive\n  6. wait until the run is listed in flowruns (the assignment stays Inactive meanwhile: the run must read it first)\n  7. finally (always): make the assignment Active again, ONE PATCH, read back; if it cannot be confirmed, stop at once and tell the owner\n  expected: run Failed (ApprovalStepFailed, "no active Approver Assignment row"); contract Pending, round 1, the manual step still Pending, no approval request\n');
  console.log('Why this order: the trigger fires when the frozen USD value is written on a Pending contract, so the bypassed submission is already the event that starts the run;\nno resubmission is needed. Trade-off: the assignment is Inactive for as long as the run takes to be listed (about 1 to 3 minutes); nothing else reads it (flows v1 OFF, no other test).');
  console.log('\nAfter both: the owner turns v2 OFF; then --mode=cleanup --case=f2, then f1 (the contracts are Pending: the cleanup withdraws them to Draft first, with v2 OFF no run starts), then baseline.');
  return true;
}

async function modeSetup(c) {
  const f = await requireFlows();
  if (!(await baseline())) throw new Stop('The baseline is not clean (see the line above). Nothing was created.');
  if ((await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${c.prefix}')`)}`)).value.length) throw new Stop(`Rows with the prefix ${c.prefix} already exist. Run --mode=cleanup first.`);
  const stepId = await builderStep();
  const usd = (await get("transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0")).value;
  if (usd.length !== 1) throw new Stop(`active USD currency: expected 1, found ${usd.length}`);
  const asg = await assignmentOfDH();
  if (asg.statecode !== 0) throw new Stop('The Department Head assignment is not Active at the start. Nothing was changed.');
  const snap = await snapshotCounters(S.ctr);
  const cpOpt = (await get("EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)")).OptionSet.Options[0].Value;
  let submittedAt = null;
  try {
    const cp = await write('POST', 'mwf_counterparties', { mwf_name: `${c.prefix} Fictional Counterparty (delete me)`, mwf_counterpartytype: cpOpt });
    if (!cp.ok) throw new Stop(`counterparty create failed HTTP ${cp.status} ${S.msgOf(cp)}`);
    const k = await write('POST', 'mwf_contracts?$select=mwf_contractnumber', { mwf_name: c.subject, mwf_contracttype: 867640000, mwf_direction: 867640001, mwf_value: c.value,
      'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${cp.id || '<dry-run>'})`, 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${usd[0].transactioncurrencyid})` }, { Prefer: 'return=representation' });
    if (!k.ok) throw new Stop(`contract create failed HTTP ${k.status} ${S.msgOf(k)}`);
    const id = k.j?.mwf_contractid; const number = k.j?.mwf_contractnumber;
    if (!DRY) printHandoff(snap);   // printed early: if anything stops later, the cleanup needs these two arguments
    if (c.manualStep) {
      const st = await write('POST', 'mwf_approvalsteps', manualStepBody({ contractId: id || '<dry-run>', userId: asg._mwf_user_value, number: number || '<number>' }));
      if (!st.ok) throw new Stop(`manual step create failed HTTP ${st.status} ${S.msgOf(st)}`);
      if (!DRY) {
        deactivated = { path: `mwf_approverassignments(${asg.mwf_approverassignmentid})` };   // set BEFORE the write: if its result is unknown, the finally block still puts it back
        const d = await write('PATCH', deactivated.path, { statecode: 1, statuscode: 2 }, { 'If-Match': '*' });
        if (!d.ok) throw new Stop(`could not make the assignment Inactive: HTTP ${d.status} ${S.msgOf(d)}`);
        const back = (await S.call('GET', `${deactivated.path}?$select=statecode`)).j;
        if (back?.statecode !== 1) throw new Stop(`the assignment was not read back as Inactive (statecode ${back?.statecode}). Nothing was submitted.`);
      } else console.log('DRY-RUN  would make the Department Head assignment Inactive (one PATCH), and reactivate it in a finally block');
    }
    // the flow must still be v1 OFF / v2 ON right before the submission
    if (!DRY) await requireFlows();
    const sub = await write('PATCH', `mwf_contracts(${id || '<dry-run>'})`, { statuscode: ST.Pending }, bypassHeaders(stepId));
    if (!sub.ok) throw new Stop(`submission failed HTTP ${sub.status} ${S.msgOf(sub)}`);
    submittedAt = Date.now();
    console.log(`INFO  case ${CASE.toUpperCase()} submitted at ${new Date().toISOString().slice(0, 19)}Z (UTC)${DRY ? ' (dry-run: nothing was sent)' : ''}`);
    if (DRY) { console.log('DRY-RUN  would now wait up to 8 minutes for the run to be listed and print its status, errorcode and errormessage; then (F2) reactivate the assignment.'); return; }
    await sleep(3000);
    const row = await contractOf(c); const steps = await stepsOf(row.mwf_contractid);
    check('setup', `submitted with the builder bypassed: Pending, round 1, frozen ${c.value}, ${c.expect.steps} step row(s)`, row.statuscode === ST.Pending && row.mwf_approvalround === 1 && Number(row.mwf_valueusdfrozen) === c.value && steps.length === c.expect.steps,
      `status ${row.statuscode}, round ${row.mwf_approvalround}, frozen ${row.mwf_valueusdfrozen}, ${steps.length} step(s)`);
    const w = await waitForRun(Date.parse(row.modifiedon) - 5000, 8 * 60 * 1000);
    printRuns(`RUN ${CASE.toUpperCase()}`, w.runs);
    if (w.note) console.log(`NOTE: ${w.note}`);
    if (!w.runs.some(finished)) console.log(`NO FINISHED RUN LISTED after 8 minutes. ${c.manualStep ? 'The assignment is reactivated now (finally), so this case is NOT conclusive.' : ''} Read again later with --mode=await.`);
  } finally {
    await reactivate();
  }
}

async function modeAwait(c) {
  const row = await contractOf(c); if (!row) throw new Stop(`No contract with Subject "${c.subject}".`);
  const until = await untilOf(c);
  let w = await v2Runs(Date.parse(row.modifiedon) - 5000, until);
  if (!w.runs.some(finished)) w = await waitForRun(Date.parse(row.modifiedon) - 5000, 8 * 60 * 1000);
  printRuns(`RUN ${CASE.toUpperCase()}`, w.runs); if (w.note) console.log(`NOTE: ${w.note}`);
  return w.runs.some(finished);
}

async function modeVerdict(c) {
  const row = await contractOf(c); if (!row) throw new Stop(`No contract with Subject "${c.subject}".`);
  const steps = await stepsOf(row.mwf_contractid);
  check(CASE, 'the contract stays Pending Approval, round 1, USD value frozen', row.statuscode === ST.Pending && row.statecode === 0 && row.mwf_approvalround === 1 && Number(row.mwf_valueusdfrozen) === c.value, `status ${row.statuscode}, state ${row.statecode}, round ${row.mwf_approvalround}, frozen ${row.mwf_valueusdfrozen}`);
  check(CASE, `${c.expect.steps} step row(s) (the builder was bypassed${c.manualStep ? '; the one row is the manual step' : ''})${c.manualStep ? ', still Pending (never marked Waiting)' : ''}`, steps.length === c.expect.steps && steps.every((s) => s.mwf_decision === 867640000), `${steps.length} row(s)`);
  const w = await v2Runs(Date.parse(row.modifiedon) - 5000, await untilOf(c));
  printRuns(`RUN ${CASE.toUpperCase()}`, w.runs); if (w.note) out(CASE, 'OBS', w.note);
  const fin = w.runs.filter(finished);
  check(CASE, 'exactly one finished run of v2 since the submission', fin.length === 1, `${w.runs.length} listed, ${fin.length} finished`);
  if (fin.length === 1) {
    const j = judgeRun(fin[0], c.expect);
    check(CASE, 'run status Failed', j.statusFailed, `status ${fin[0].status}`);
    out(CASE, j.codeSeen || j.messageSeen ? 'PASS' : 'OBS', `the expected code (${c.expect.code}) or message appears in errorcode or errormessage`, `code seen ${j.codeSeen}, message seen ${j.messageSeen}; literal values printed above`);
  }
  const reqs = (await get(`msdyn_flow_approvals?$select=msdyn_flow_approval_title&$filter=${q(`contains(msdyn_flow_approval_title,'${c.subject}')`)}&$top=20`)).value.length;
  check(CASE, 'no approval request was created for this Subject', reqs === 0, `${reqs}`);
  if (c.manualStep) { const a = await assignmentOfDH(); check(CASE, 'the Department Head assignment is Active again', assignmentActive(a), `statecode ${a.statecode}`); }
  const asg = await count('mwf_approverassignments?$filter=statecode eq 0');
  check(CASE, '5 active assignment rows', asg === 5, `${asg}`);
  const bad = results.filter((x) => x.status === 'FAIL').length;
  console.log(`\nVERDICT case ${CASE.toUpperCase()}: ${results.filter((x) => x.status === 'PASS').length} PASS, ${bad} FAIL, ${results.filter((x) => x.status === 'OBS').length} OBS.`);
  return bad === 0;
}

async function modeCleanup(c) {
  enterCleanupPhase();
  const a = await assignmentOfDH();
  if (a.statecode !== 0) {
    if (DRY) console.log('DRY-RUN  would reactivate the Department Head assignment');
    else { deactivated = { path: `mwf_approverassignments(${a.mwf_approverassignmentid})` }; await reactivate(); }
  }
  const rows = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${c.prefix}')`)}`)).value;
  if (DRY) { console.log(`DRY-RUN  would delete ${rows.length} contract(s) with the prefix ${c.prefix} (Pending: withdrawn to Draft first; steps by the cascade), the counterparty, and restore the counters.`); return true; }
  const f = await flows(); if (f.v2?.statecode === 1) console.log('NOTE: v2 is ON. Withdrawing a Pending contract does not match the trigger filter, but the owner is expected to have turned v2 OFF first.');
  const del = await deleteContracts(S.io, rows.map((r) => r.mwf_contractid));
  console.log(`INFO  cleanup: ${rows.length} contract(s) found, ${del.deleted} deleted, ${del.failed.length} failed (their steps go by the cascade)`);
  for (const x of (await get(`mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${c.prefix}')`)}`)).value) {
    const d = await S.call('DELETE', `mwf_counterparties(${x.mwf_counterpartyid})`); console.log(`INFO  cleanup: counterparty delete HTTP ${d.status}`);
  }
  const rs = await restoreFromArgs(S.ctr);
  const left = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${c.prefix}')`)}`)).value.length;
  const total = await count('mwf_contracts'); const steps = await count('mwf_approvalsteps'); const asg = await count('mwf_approverassignments?$filter=statecode eq 0');
  check('clean', `prefix ${c.prefix}: 0 contracts left`, left === 0, `${left}`);
  console.log(`INFO  after this cleanup: ${total} contracts in total, ${steps} approval steps, ${asg} active assignments`);
  return left === 0 && !del.failed.length && !rs.refused;
}

// ---------------------------------------------------------------------------------------------------------------- main
if (isMain) {
  const MODES = ['plan', 'baseline', 'setup', 'await', 'verdict', 'cleanup'];
  if (!MODES.includes(MODE)) { console.error(`Missing or invalid --mode=${MODES.join('|')}. Nothing was run.`); process.exit(2); }
  const c = CASES[CASE];
  if (!['plan', 'baseline'].includes(MODE) && !c) { console.error('Missing or invalid --case=f1|f2. Nothing was run.'); process.exit(2); }
  const writes = ['setup', 'cleanup'].includes(MODE);
  if (writes && !DRY && !has('--confirm-mutates-environment')) {
    console.error(`WARNING: --mode=${MODE} writes to the environment (${PREFIXES.join(', ')} rows, and for F2 the Department Head assignment). Add --confirm-mutates-environment to run it on purpose, or --dry-run to see what it would do. Nothing was run.`);
    process.exit(2);
  }
  (async () => {
    try {
      if (MODE === 'plan') process.exit(modePlan() ? 0 : 1);
      await open();
      let ok = true;
      if (MODE === 'baseline') { await requireFlows().catch((e) => console.log(`NOTE: ${e.message}`)); ok = await baseline(); }
      else if (MODE === 'setup') await modeSetup(c);
      else if (MODE === 'await') ok = await modeAwait(c);
      else if (MODE === 'verdict') ok = await modeVerdict(c);
      else if (MODE === 'cleanup') ok = await modeCleanup(c);
      process.exit(ok ? 0 : 1);
    } catch (e) {
      console.error(`\nSTOPPED: ${noGuid(e.message)}`);
      try { await reactivate(); } catch { /* reactivate() exits the process itself when the state is unknown */ }
      if (writes) console.error(`If rows were created, clean up with: node scripts/test-flow-failures.mjs --mode=cleanup --case=${CASE} --env=<url> --auth=az --confirm-mutates-environment --counters-before=... --counters-consumed=...  (the values were printed by setup)`);
      process.exit(4);
    }
  })();
}
