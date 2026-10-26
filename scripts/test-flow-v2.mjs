#!/usr/bin/env node
/**
 * Flow-ON session for "Muwafaqa - Contract Approval v2" (ADR-007, docs/flow-on-session-plan.md, "Session plan for v2"). Run against the live flow on 2026-10-22: cases A to D, 25 PASS, 0 FAIL (ADR-007, "v2 flow-ON session").
 * FICTIONAL rows only. One prefix per case, and no prefix is a prefix of another: TEST-TMP-V2A, TEST-TMP-V2B, TEST-TMP-V2C, TEST-TMP-V2D.
 *
 * The OWNER alone turns flows on and off. This script never does. v2 must be ON and v1 OFF (read only check; never both ON).
 * The script never answers, cancels or deletes an approval request: the owner answers by hand, and the cleanup needs no click on any request.
 *
 * Cases (value, chain from the fictional ApprovalMatrix, Maintenance / Expense):
 *   a  USD   5,000  1 step                 Approve step 1                                   -> In Force,  run Succeeded
 *   b  USD  25,000  2 steps                Approve step 1, REJECT step 2                    -> Rejected,  run Succeeded
 *   c  USD 250,000  5 steps (4 Approve + Inform)  Approve steps 1 to 4                      -> In Force,  step 5 Informed, run Succeeded, 1 open Inform request
 *   d  USD  25,000  2 steps                Approve step 1 of round 1; withdraw and resubmit while step 2 waits (round 2);
 *                                          answer the OLD step-2 request, then both round-2 steps -> In Force, run 1 Cancelled, run 2 Succeeded
 *
 * Modes (every mode that writes needs --confirm-mutates-environment; --dry-run prints the writes it would do and sends none):
 *   --mode=plan                           read only: the four cases, the owner's actions, and a check that the plan equals the ApprovalMatrix
 *   --mode=baseline                       read only: the state required before the session
 *   --mode=setup --case=a|b|c|d           creates the counterparty and the Draft contract, submits it (round 1); prints the counters hand-off
 *   --mode=request --case=X --step=i [--round=1|2] [--which=oldest|newest]
 *                                         waits (up to 3 minutes) until the request exists, then prints the LITERAL instruction for the owner
 *   --mode=await --case=X --step=i [--round=..] [--which=..]
 *                                         waits (up to 15 minutes) until THAT request is answered; prints the answer time (UTC and UTC+3) and result.
 *                                         It reports NOTHING else before the owner has really answered; on timeout it prints that and exits with 10
 *   --mode=steps --case=X                 read only: the step rows, the contract, the requests (no verdict)
 *   --mode=withdraw-resubmit --case=d     waits until step 2 of round 1 is Waiting, withdraws to Draft and submits again (round 2)
 *   --mode=verdict --case=X               read only: PASS / FAIL / OBS against the expected end state. Refuses (exit 10) while a required answer is missing
 *   --mode=cleanup --case=X [--counters-before=... --counters-consumed=...]
 *                                         deletes the contract (its steps go by the cascade) and the counterparty, restores the counters by the helper rule,
 *                                         check-clean. It does not touch any approval request. Run in reverse order: d, c, b, a
 *
 * Usage:
 *   node scripts/test-flow-v2.mjs --mode=plan --env=https://<org>.crm4.dynamics.com --auth=az
 *   node scripts/test-flow-v2.mjs --mode=setup --case=a --env=... --auth=az --confirm-mutates-environment [--dry-run]
 *
 * The token stays in memory and is never printed. No id, address, email or token is printed or stored.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, openSession, noGuid, sleep, Stop } from './lib/dv-session.mjs';
import { snapshotCounters, ctrIo, trackCreate, restoreAfterRun, restoreFromArgs, printHandoff, requireStableConnection } from './lib/counter-snapshot.mjs';
import { deleteContracts } from './lib/contract-cleanup.mjs';
import { enterCleanupPhase, recheckAfterWait } from './lib/resilient-fetch.mjs';
import { subjectOfTitle, isInformTitle, lastApprovalByContract, attributeRuns } from './lib/run-attribution.mjs';
import { expectContractsOrExit, describeExpectContracts, contractsVerdict } from './lib/expect-contracts.mjs';

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;   // false when the unit test imports this file
const { argOf, env: ENV, auth: AUTH, has } = isMain ? parseArgs() : { argOf: () => '', env: '', auth: '', has: () => false };
const MODE = argOf('mode');
const EXPECT = expectContractsOrExit();   // contracts expected in the starting and the final state (argument, variable or default 11)
if (isMain) console.log(describeExpectContracts(EXPECT));
const CASE = argOf('case');
const DRY = has('--dry-run');
const q = encodeURIComponent;
const V1 = 'Muwafaqa - Contract Approval v1';
const V2 = 'Muwafaqa - Contract Approval v2';
const ST = { Draft: 1, Pending: 867640000, InForce: 867640001, Rejected: 2 };
const DEC = { Pending: 867640000, Waiting: 867640001, Approved: 867640002, Rejected: 867640003, Informed: 867640004, Cancelled: 867640005 };
const DECN = Object.fromEntries(Object.entries(DEC).map(([k, v]) => [v, k]));
const ROLE = { 867640000: 'Department Head', 867640001: 'Finance Manager', 867640002: 'General Manager', 867640003: 'Regional Office', 867640004: 'Owner' };

export const CASES = {
  a: { prefix: 'TEST-TMP-V2A', subject: 'TEST-TMP-V2A one step', value: 5000, chain: [867640000], informLast: false,
    answers: [{ round: 1, step: 1, choice: 'Approve' }], end: { status: ST.InForce, state: 0 }, steps: { 1: ['Approved'] }, runs: ['Succeeded'], inform: 0 },
  b: { prefix: 'TEST-TMP-V2B', subject: 'TEST-TMP-V2B reject in step two', value: 25000, chain: [867640000, 867640001], informLast: false,
    answers: [{ round: 1, step: 1, choice: 'Approve' }, { round: 1, step: 2, choice: 'Reject' }], end: { status: ST.Rejected, state: 1 }, steps: { 1: ['Approved', 'Rejected'] }, runs: ['Succeeded'], inform: 0 },
  c: { prefix: 'TEST-TMP-V2C', subject: 'TEST-TMP-V2C top band with inform', value: 250000, chain: [867640000, 867640001, 867640002, 867640003, 867640004], informLast: true,
    answers: [1, 2, 3, 4].map((step) => ({ round: 1, step, choice: 'Approve' })), end: { status: ST.InForce, state: 0 }, steps: { 1: ['Approved', 'Approved', 'Approved', 'Approved', 'Informed'] }, runs: ['Succeeded'], inform: 1 },
  d: { prefix: 'TEST-TMP-V2D', subject: 'TEST-TMP-V2D withdraw and resubmit', value: 25000, chain: [867640000, 867640001], informLast: false,
    answers: [{ round: 1, step: 1, choice: 'Approve' }, { round: 1, step: 2, choice: 'Approve', which: 'oldest', note: 'the OLD request of round 1: it should have no effect' },
      { round: 2, step: 1, choice: 'Approve', which: 'newest' }, { round: 2, step: 2, choice: 'Approve', which: 'newest' }],
    end: { status: ST.InForce, state: 0 }, steps: { 1: ['Approved', 'Cancelled'], 2: ['Approved', 'Approved'] }, runs: ['Cancelled', 'Succeeded'], inform: 0 },
};
const PREFIXES = Object.values(CASES).map((c) => c.prefix);

/** The title of a request (docs/flow-approval-v2.md). */
export const titleOf = (c, step, n, role, inform = false) => `${inform ? 'For information: contract ' : 'Approve contract: '}${c.subject} (step ${step} of ${n}, ${ROLE[role]})`;
/** (Min, Max] with 0 on the band whose Min is 0: the expected steps of a value, from the matrix rows of one type and direction. */
export function expectedSteps(value, rows) {
  const covers = (r) => (value > r.min || (value === 0 && r.min === 0)) && (r.max === null || value <= r.max);
  const bands = new Map();
  for (const r of rows.filter(covers)) { const k = `${r.min}|${r.max}`; bands.set(k, [...(bands.get(k) || []), r]); }
  if (bands.size !== 1) return null;
  return [...bands.values()][0].sort((x, y) => x.order - y.order);
}

const plan = (c) => c.chain.map((role, i) => ({ step: i + 1, role, inform: c.informLast && i === c.chain.length - 1 }));
const localTime = (iso) => new Date(Date.parse(iso) + 3 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

// ---------------------------------------------------------------------------------------------------------------- session
let S; let snap = null;
const results = [];
const out = (id, status, name, detail = '') => { results.push({ id, status }); console.log(`${status.padEnd(4)}  ${id.padEnd(5)} ${name}${detail ? `  [${detail}]` : ''}`); };
const check = (id, name, ok, detail) => out(id, ok ? 'PASS' : 'FAIL', name, detail);
const get = async (p) => (await S.must('GET', p)).j;

/** Every write goes through here: in dry-run it only prints what it would send. */
async function write(method, path, body, extra) {
  if (DRY) { console.log(`DRY-RUN  would ${method} ${noGuid(path).slice(0, 80)}${body ? ' ' + JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => !k.includes('@odata')))) : ''}`); return { ok: true, status: 0, j: {}, dry: true }; }
  const r = await S.callT(method, path, body, extra);
  return r;
}
async function open() {
  S = await openSession({ env: ENV, auth: AUTH });
  const raw = S.call;
  S.callT = async (m, p, b, x) => { const r = await raw(m, p, b, x); trackCreate(m, p, b, r.ok); return r; };
  S.ctr = ctrIo(S.callT);
  await requireStableConnection(raw);
}
async function flows() {
  const rows = (await get(`workflows?$select=name,statecode,workflowid,workflowidunique&$filter=${q(`category eq 5 and (name eq '${V1}' or name eq '${V2}')`)}`)).value;
  const v1 = rows.find((r) => r.name === V1); const v2 = rows.find((r) => r.name === V2);
  return { v1, v2, count: rows.length };
}
async function requireFlows() {
  const f = await flows();
  if (!f.v2) throw new Stop(`Expected the v2 flow row (v1 may or may not exist), found ${f.count} row(s) and no v2. Nothing was changed.`);
  const v1Off = !f.v1 || f.v1.statecode === 0; const v2On = f.v2.statecode === 1;
  if (!v1Off || !v2On) {
    const msg = `${f.v1 ? `v1 is ${v1Off ? 'OFF' : 'ON'}` : 'v1 does not exist'} and v2 is ${v2On ? 'ON' : 'OFF'}. The session needs v2 ON and v1 OFF if it exists (the owner turns them; never both ON).`;
    if (DRY) { console.log(`DRY-RUN  note: ${msg} A real run would stop here.`); return f; }
    throw new Stop(`${msg} Nothing was changed.`);
  }
  console.log(`INFO  ${f.v1 ? 'v1 is OFF and v2 is ON' : 'v1 does not exist and v2 is ON'} (read only check)`);
  return f;
}
async function matrixRows() {
  const all = [];
  for (const r of (await get(`mwf_approvalmatrixes?$select=mwf_minvalueusd,mwf_maxvalueusd,mwf_steporder,mwf_approverrole,mwf_actiontype&$filter=mwf_contracttype eq 867640000 and mwf_contractdirection eq 867640001 and statecode eq 0`)).value)
    all.push({ min: Number(r.mwf_minvalueusd), max: r.mwf_maxvalueusd === null ? null : Number(r.mwf_maxvalueusd), order: r.mwf_steporder, role: r.mwf_approverrole, action: r.mwf_actiontype });
  return all;
}
async function baseline() {
  const f = await get(`workflows?$select=name,statecode&$filter=${q(`category eq 5 and (name eq '${V1}' or name eq '${V2}')`)}`);
  for (const w of f.value) console.log(`INFO  ${w.name.slice(-2)}: ${w.statecode === 1 ? 'ON' : 'OFF'}`);
  const a = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(PREFIXES.map((p) => `startswith(mwf_name,'${p}')`).join(' or '))}`)).value.length;
  const cp = (await get(`mwf_counterparties?$select=mwf_name&$filter=${q(PREFIXES.map((p) => `startswith(mwf_name,'${p}')`).join(' or '))}`)).value.length;
  const total = (await get('mwf_contracts?$select=mwf_contractid&$count=true&$top=1'))['@odata.count'];
  const steps = (await get('mwf_approvalsteps?$select=mwf_name&$count=true&$top=1'))['@odata.count'];
  const m = (await get('mwf_approvalmatrixes?$select=mwf_rulename&$filter=statecode eq 0&$count=true&$top=1'))['@odata.count'];
  const asg = (await get('mwf_approverassignments?$select=mwf_name&$filter=statecode eq 0&$count=true&$top=1'))['@odata.count'];
  const c = await snapshotCounters(S.ctr);
  console.log(`baseline: V2x contracts ${a}, V2x counterparties ${cp}, total contracts ${total} (${EXPECT.value} expected), approval steps ${steps} (0), active matrix rows ${m} (110), active assignments ${asg} (5), counters ${Object.values(c.byType).map((x) => `${x.prefix}=${x.last}`).join(' ')} (all 0)`);
  const open = (await get(`msdyn_flow_approvals?$select=msdyn_flow_approval_title&$filter=${q("startswith(msdyn_flow_approval_title,'Approve contract: TEST-TMP-V2') or startswith(msdyn_flow_approval_title,'For information: contract TEST-TMP-V2')")}&$top=200`)).value.length;
  console.log(`INFO  approval requests with a TEST-TMP-V2 title already in the table: ${open} (0 expected before the session)`);
  if (total !== EXPECT.value) console.log(`MISMATCH ${contractsVerdict(EXPECT, total).text}`);
  return a === 0 && cp === 0 && total === EXPECT.value && steps === 0 && m === 110 && asg === 5;
}

// ---------------------------------------------------------------------------------------------------------------- approvals
const APPROVAL_SEL = 'msdyn_flow_approval_title,msdyn_flow_approval_result,msdyn_flow_approval_completedon,statuscode,createdon';
const FV = { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' };
async function approvalsOf(c) {
  const r = await S.call('GET', `msdyn_flow_approvals?$select=${APPROVAL_SEL}&$filter=${q(`contains(msdyn_flow_approval_title,'${c.subject}')`)}&$orderby=createdon asc&$top=200`, undefined, FV);
  if (!r.ok) throw new Stop(`approvals not readable: HTTP ${r.status}`);
  return (r.j.value || []).filter((x) => subjectOfTitle(x.msdyn_flow_approval_title) === c.subject);
}
/** The request an instruction or an await refers to. `which`: oldest or newest of the requests with that exact title. */
function pick(list, title, which) {
  const m = list.filter((x) => x.msdyn_flow_approval_title === title);
  if (!m.length) return null;
  return which === 'oldest' ? m[0] : m[m.length - 1];
}
function answerSpec(c) {
  const a = c.answers.find((x) => x.round === Number(argOf('round') || 1) && x.step === Number(argOf('step')));
  if (!a) throw new Stop(`No such answer in case ${CASE}: round ${argOf('round') || 1}, step ${argOf('step')}.`);
  return { ...a, which: argOf('which') || a.which || 'newest' };
}
const answerTitle = (c, a) => titleOf(c, a.step, c.chain.length, c.chain[a.step - 1]);

async function contractOf(c) {
  const r = (await get(`mwf_contracts?$select=mwf_name,mwf_contractnumber,statuscode,statecode,mwf_approvalround,mwf_valueusdfrozen,modifiedon&$filter=${q(`mwf_name eq '${c.subject}'`)}`)).value;
  return r[0] || null;
}
async function stepsOf(contractId) {
  return (await get(`mwf_approvalsteps?$select=mwf_name,mwf_approvalround,mwf_steporder,mwf_approverrole,mwf_actiontype,mwf_decision,mwf_decidedon,mwf_comments,modifiedon&$filter=_mwf_contract_value eq ${contractId}&$orderby=mwf_approvalround asc,mwf_steporder asc`)).value;
}

// ---------------------------------------------------------------------------------------------------------------- modes
async function modePlan() {
  const rows = await matrixRows();
  console.log('Session plan for v2 (read only). The owner answers one request at a time; the cases run in the order a, b, c, d; the cleanup runs d, c, b, a.\n');
  for (const [k, c] of Object.entries(CASES)) {
    const exp = expectedSteps(c.value, rows);
    const same = !!exp && exp.length === c.chain.length && exp.every((r, i) => r.role === c.chain[i] && (r.action === 867640001) === plan(c)[i].inform);
    check(`plan ${k}`, `chain of USD ${c.value.toLocaleString('en-US')} in the ApprovalMatrix = ${c.chain.length} step(s) as planned (${c.chain.map((r) => ROLE[r]).join(', ')}${c.informLast ? '; the last is Inform' : ''})`, same);
    console.log(`  case ${k.toUpperCase()}: Subject "${c.subject}", USD ${c.value}`);
    for (const a of c.answers) console.log(`    owner: ${a.choice.toUpperCase()}  "${answerTitle(c, a)}"${a.round === 2 ? '  (round 2)' : ''}${a.note ? '  - ' + a.note : ''}`);
    if (c.informLast) console.log(`    not answered by the owner: "${titleOf(c, c.chain.length, c.chain.length, c.chain[c.chain.length - 1], true)}" (stays open)`);
    console.log(`    expected: contract ${c.end.status === ST.InForce ? 'In Force' : 'Rejected'}, steps ${JSON.stringify(c.steps)}, runs ${c.runs.join(' + ')}, open Inform requests ${c.inform}`);
  }
  const bad = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\nplan: ${results.length - bad} consistent, ${bad} inconsistent.`);
  return bad === 0;
}

async function modeSetup(c) {
  await requireFlows();
  const ok = await baseline();
  if (!ok) throw new Stop('The baseline is not clean (see the line above). Nothing was created.');
  if ((await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${c.prefix}')`)}`)).value.length) throw new Stop(`Rows with the prefix ${c.prefix} already exist. Run --mode=cleanup first.`);
  const usd = (await get("transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0")).value;
  if (usd.length !== 1) throw new Stop(`active USD currency: expected 1, found ${usd.length}`);
  snap = await snapshotCounters(S.ctr);
  const cpOpt = (await get("EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)")).OptionSet.Options[0].Value;
  const cp = await write('POST', 'mwf_counterparties', { mwf_name: `${c.prefix} Fictional Counterparty (delete me)`, mwf_counterpartytype: cpOpt });
  if (!cp.ok) throw new Stop(`counterparty create failed HTTP ${cp.status} ${S.msgOf(cp)}`);
  const body = { mwf_name: c.subject, mwf_contracttype: 867640000, mwf_direction: 867640001, mwf_value: c.value,
    'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${cp.id || '<dry-run>'})`, 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${usd[0].transactioncurrencyid})` };
  const k = await write('POST', 'mwf_contracts?$select=mwf_contractnumber', body, { Prefer: 'return=representation' });
  if (!k.ok) throw new Stop(`contract create failed HTTP ${k.status} ${S.msgOf(k)}`);
  const id = k.j?.mwf_contractid;
  const sub = await write('PATCH', `mwf_contracts(${id || '<dry-run>'})`, { statuscode: ST.Pending }, { 'If-Match': '*' });
  if (!sub.ok) throw new Stop(`submission failed HTTP ${sub.status} ${S.msgOf(sub)}`);
  console.log(`INFO  case ${CASE.toUpperCase()} submitted at ${new Date().toISOString().slice(0, 19)}Z (UTC) ${DRY ? '(dry-run: nothing was sent)' : ''}`);
  if (!DRY) {
    await sleep(3000);
    const row = await contractOf(c); const steps = await stepsOf(row.mwf_contractid);
    check('setup', `submitted: Pending, round 1, frozen ${c.value}, ${c.chain.length} step(s) built`, row.statuscode === ST.Pending && row.mwf_approvalround === 1 && Number(row.mwf_valueusdfrozen) === c.value && steps.length === c.chain.length,
      `status ${row.statuscode}, round ${row.mwf_approvalround}, frozen ${row.mwf_valueusdfrozen}, ${steps.length} step(s)`);
    printHandoff(snap);
  }
  console.log(`\nNEXT: node scripts/test-flow-v2.mjs --mode=request --case=${CASE} --step=1 ...   (it prints the literal instruction for the owner)`);
}

async function modeRequest(c) {
  const a = answerSpec(c); const title = answerTitle(c, a);
  let target = null;
  for (let i = 0; i < 18 && !target; i++) {   // up to 3 minutes
    const list = await approvalsOf(c);
    const m = list.filter((x) => x.msdyn_flow_approval_title === title && !x.msdyn_flow_approval_completedon);
    target = a.which === 'oldest' ? m[0] : m[m.length - 1];
    if (!target) { await sleep(10000); await recheckAfterWait(S.call, 'This is a read step; nothing is written by it.'); }
  }
  if (!target) { console.log(`WAITING: the request "${title}" does not exist yet (the flow may not have sent it). Nothing to ask the owner. Exit 10.`); process.exit(10); }
  console.log(`\n=== ACTION FOR THE OWNER (one action only) ===\nIn the approvals inbox open the request titled EXACTLY:\n    ${title}\n${a.round === 2 || a.which === 'oldest' ? `It was received at ${localTime(target.createdon)} (UTC+3). ${a.which === 'oldest' ? 'Choose the OLDER one of the same title.' : 'Choose the NEWER one of the same title.'}\n` : ''}Choose: ${a.choice.toUpperCase()}.\nDo not answer anything else, and do not answer any request that starts with "For information:".\nThen tell me you pressed it.\n`);
}

async function modeAwait(c) {
  const a = answerSpec(c); const title = answerTitle(c, a);
  const started = Date.now(); let done = null;
  while (Date.now() - started < 15 * 60 * 1000 && !done) {
    const list = await approvalsOf(c);
    const t = pick(list, title, a.which);
    if (t && t.msdyn_flow_approval_completedon) done = t;
    else { await sleep(10000); await recheckAfterWait(S.call, 'This is a read step; nothing is written by it.'); }
  }
  if (!done) { console.log(`NOT ANSWERED: after 15 minutes the request "${title}" has no answer. Nothing is reported. Exit 10.`); process.exit(10); }
  const res = done['msdyn_flow_approval_result'] ?? done.msdyn_flow_approval_result;
  console.log(`ANSWERED: "${title}" | completedon ${done.msdyn_flow_approval_completedon} (UTC) = ${localTime(done.msdyn_flow_approval_completedon)} (UTC+3) | result ${res}`);
  check('answer', `the owner chose ${a.choice}`, String(res).toLowerCase() === a.choice.toLowerCase(), `result ${res}`);
}

async function modeSteps(c) {
  const row = await contractOf(c); if (!row) throw new Stop(`No contract with Subject "${c.subject}".`);
  console.log(`contract: status ${row.statuscode}, state ${row.statecode}, round ${row.mwf_approvalround}, frozen ${row.mwf_valueusdfrozen}, modifiedon ${row.modifiedon}`);
  for (const s of await stepsOf(row.mwf_contractid)) console.log(`  round ${s.mwf_approvalround} step ${s.mwf_steporder} ${ROLE[s.mwf_approverrole]} | ${s.mwf_actiontype === 867640001 ? 'Inform ' : 'Approve'} | ${DECN[s.mwf_decision]} | decidedon ${s.mwf_decidedon ?? '-'}`);
  for (const x of await approvalsOf(c)) console.log(`  request "${x.msdyn_flow_approval_title.slice(x.msdyn_flow_approval_title.indexOf('(step'))}" ${isInformTitle(x.msdyn_flow_approval_title) ? '[inform] ' : ''}created ${x.createdon} | completed ${x.msdyn_flow_approval_completedon ?? 'no'} | ${x.msdyn_flow_approval_result ?? 'no result'}`);
}

async function modeWithdrawResubmit(c) {
  if (CASE !== 'd') throw new Stop('withdraw-resubmit is for case d only.');
  const row = await contractOf(c); if (!row) throw new Stop('No contract of case d.');
  let ready = false;
  for (let i = 0; i < 12 && !ready; i++) {
    const s = await stepsOf(row.mwf_contractid);
    ready = s.some((x) => x.mwf_approvalround === 1 && x.mwf_steporder === 1 && x.mwf_decision === DEC.Approved) && s.some((x) => x.mwf_approvalround === 1 && x.mwf_steporder === 2 && x.mwf_decision === DEC.Waiting);
    if (!ready) await sleep(5000);
  }
  if (!ready) throw new Stop('Round 1 is not at "step 1 Approved, step 2 Waiting". Nothing was changed. Read with --mode=steps.');
  const w = await write('PATCH', `mwf_contracts(${row.mwf_contractid})`, { statuscode: ST.Draft }, { 'If-Match': '*' });
  if (!w.ok) throw new Stop(`withdraw failed HTTP ${w.status} ${S.msgOf(w)}`);
  if (!DRY) await sleep(3000);
  const r = await write('PATCH', `mwf_contracts(${row.mwf_contractid})`, { statuscode: ST.Pending }, { 'If-Match': '*' });
  if (!r.ok) throw new Stop(`resubmission failed HTTP ${r.status} ${S.msgOf(r)}`);
  if (!DRY) {
    await sleep(3000);
    const now = await contractOf(c); const s = await stepsOf(row.mwf_contractid);
    check('d', 'resubmitted: Pending, round 2, 4 step rows; round-1 step 2 Cancelled', now.statuscode === ST.Pending && now.mwf_approvalround === 2 && s.length === 4
      && s.find((x) => x.mwf_approvalround === 1 && x.mwf_steporder === 2)?.mwf_decision === DEC.Cancelled, `status ${now.statuscode}, round ${now.mwf_approvalround}, ${s.length} rows`);
  }
  console.log(`\nNEXT: --mode=request --case=d --step=2 --round=1 --which=oldest   (the old request), then round 2 steps 1 and 2.`);
}

async function modeVerdict(c) {
  const row = await contractOf(c); if (!row) throw new Stop(`No contract with Subject "${c.subject}".`);
  const list = await approvalsOf(c);
  const missing = c.answers.filter((a) => { const t = pick(list, answerTitle(c, a), a.which || 'newest'); return !t || !t.msdyn_flow_approval_completedon; });
  if (missing.length) { console.log(`WAITING: ${missing.length} required owner answer(s) are missing (${missing.map((a) => `round ${a.round} step ${a.step}`).join('; ')}). No verdict is given. Exit 10.`); process.exit(10); }
  // the contract needs a moment after the last answer (the run marks the step, checks, updates): wait for its final state, up to 2 minutes
  let r = row;
  for (let i = 0; i < 12 && !(r.statuscode === c.end.status); i++) { await sleep(10000); await recheckAfterWait(S.call, 'This is a read step; nothing is written by it.'); r = await contractOf(c); }
  check(CASE, `contract ends ${c.end.status === ST.InForce ? 'In Force' : 'Rejected'} (state ${c.end.state})`, r.statuscode === c.end.status && r.statecode === c.end.state, `status ${r.statuscode}, state ${r.statecode}`);
  const steps = await stepsOf(r.mwf_contractid);
  for (const [round, want] of Object.entries(c.steps)) {
    const got = steps.filter((s) => s.mwf_approvalround === Number(round)).map((s) => DECN[s.mwf_decision]);
    check(CASE, `round ${round} steps: ${want.join(', ')}`, JSON.stringify(got) === JSON.stringify(want), got.join(', '));
  }
  const decided = steps.filter((s) => s.mwf_decision === DEC.Approved || s.mwf_decision === DEC.Rejected || s.mwf_decision === DEC.Informed);
  check(CASE, 'every Approved, Rejected or Informed step has mwf_decidedon', decided.every((s) => !!s.mwf_decidedon), `${decided.length} step(s)`);
  if (c.end.status === ST.InForce && c.informLast) {
    const last = c.answers[c.answers.length - 1]; const t = pick(list, answerTitle(c, last), 'newest');
    const dt = (Date.parse(r.modifiedon) - Date.parse(t.msdyn_flow_approval_completedon)) / 1000;
    out(CASE, 'OBS', `Inform does not block: the contract was last modified ${Math.round(dt)} s after the answer to step ${last.step} (the run did not wait for step ${c.chain.length})`, `modifiedon ${r.modifiedon}`);
  }
  // Inform requests, counted (never answered by the owner)
  const inf = list.filter((x) => isInformTitle(x.msdyn_flow_approval_title));
  const byStatus = {}; for (const x of inf) { const k = x['statuscode@OData.Community.Display.V1.FormattedValue'] ?? x.statuscode; byStatus[k] = (byStatus[k] || 0) + 1; }
  check(CASE, `Inform requests for this Subject: ${c.inform}`, inf.length === c.inform, `${inf.length} found ${JSON.stringify(byStatus)}`);
  check(CASE, 'no Inform request was answered', inf.every((x) => !x.msdyn_flow_approval_completedon));
  // runs (finished runs only; the table lags)
  const f = await flows(); const ids = [f.v2.workflowid, f.v2.workflowidunique].filter(Boolean).map((x) => String(x).toLowerCase());
  const since = new Date(Date.parse(list[0].createdon) - 120000).toISOString();
  let mine = [];
  for (let i = 0; i < 9; i++) {
    const rr = await S.call('GET', `flowruns?$filter=${q(`starttime ge ${since}`)}&$orderby=starttime&$select=starttime,endtime,status,errorcode,_workflow_value`);
    if (!rr.ok) { out(CASE, 'OBS', 'flowruns not readable', `HTTP ${rr.status}`); mine = null; break; }
    mine = (rr.j.value || []).filter((x) => ids.includes(String(x._workflow_value ?? '').toLowerCase()));
    if (mine.length >= c.runs.length) break;
    console.log(`  attempt ${i + 1}: ${mine.length} finished run(s) listed, waiting 20 s`); await sleep(20000); await recheckAfterWait(S.call, 'This is a read step; nothing is written by it.');
  }
  if (mine) {
    const got = mine.map((x) => x.status).sort(); const want = [...c.runs].sort();
    check(CASE, `finished runs of v2 since the case began: ${c.runs.join(' + ')} (cases run one at a time, so the time window holds only this case)`, JSON.stringify(got) === JSON.stringify(want), got.join(' + ') || 'none listed yet');
    const att = attributeRuns(mine, lastApprovalByContract(list.map((x) => ({ title: x.msdyn_flow_approval_title, completedon: x.msdyn_flow_approval_completedon }))), [c.subject], 15);
    out(CASE, 'OBS', `attribution by end time (15 s): ${att[c.subject].unique ? 'one run fits the last answer' : `${att[c.subject].candidates.length} candidate run(s), not unique`}`);
  }
  const bad = results.filter((x) => x.status === 'FAIL').length;
  console.log(`\nVERDICT case ${CASE.toUpperCase()}: ${results.filter((x) => x.status === 'PASS').length} PASS, ${bad} FAIL, ${results.filter((x) => x.status === 'OBS').length} OBS.`);
  return bad === 0;
}

async function modeCleanup(c) {
  enterCleanupPhase();
  const rows = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${c.prefix}')`)}`)).value;
  if (DRY) { console.log(`DRY-RUN  would delete ${rows.length} contract(s) with the prefix ${c.prefix} (their steps go by the cascade), the counterparty, and restore the counters. No approval request is touched.`); return true; }
  const del = await deleteContracts(S.io, rows.map((r) => r.mwf_contractid));
  console.log(`INFO  cleanup: ${rows.length} contract(s) found, ${del.deleted} deleted, ${del.failed.length} failed (their steps go by the cascade)`);
  for (const x of (await get(`mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${c.prefix}')`)}`)).value) {
    const d = await S.call('DELETE', `mwf_counterparties(${x.mwf_counterpartyid})`); console.log(`INFO  cleanup: counterparty delete HTTP ${d.status}`);
  }
  const rs = await restoreFromArgs(S.ctr);
  const a = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${c.prefix}')`)}`)).value.length;
  const total = (await get('mwf_contracts?$select=mwf_contractid&$count=true&$top=1'))['@odata.count'];
  const steps = (await get('mwf_approvalsteps?$select=mwf_name&$count=true&$top=1'))['@odata.count'];
  const open = (await approvalsOf(c)).filter((x) => !x.msdyn_flow_approval_completedon);
  console.log(`INFO  approval requests of this Subject still open (never touched by this script; the owner decides what to do with them): ${open.length} (${open.filter((x) => isInformTitle(x.msdyn_flow_approval_title)).length} of them Inform)`);
  check('clean', `prefix ${c.prefix}: 0 contracts left`, a === 0, `${a}`);
  console.log(`INFO  after this cleanup: ${total} contracts in total, ${steps} approval steps`);
  return a === 0 && !del.failed.length && !rs.refused;
}

// ---------------------------------------------------------------------------------------------------------------- main
if (isMain) {
  const MODES = ['plan', 'baseline', 'setup', 'request', 'await', 'steps', 'withdraw-resubmit', 'verdict', 'cleanup'];
  if (!MODES.includes(MODE)) { console.error(`Missing or invalid --mode=${MODES.join('|')}. Nothing was run.`); process.exit(2); }
  const c = CASES[CASE];
  if (!['plan', 'baseline'].includes(MODE) && !c) { console.error('Missing or invalid --case=a|b|c|d. Nothing was run.'); process.exit(2); }
  const writes = ['setup', 'withdraw-resubmit', 'cleanup'].includes(MODE);
  if (writes && !DRY && !has('--confirm-mutates-environment')) {
    console.error(`WARNING: --mode=${MODE} writes to the environment (${PREFIXES.join(', ')} rows). Add --confirm-mutates-environment to run it on purpose, or --dry-run to see what it would do. Nothing was run.`);
    process.exit(2);
  }
  (async () => {
    try {
      await open();
      let ok = true;
      if (MODE === 'plan') ok = await modePlan();
      else if (MODE === 'baseline') { await requireFlows().catch((e) => console.log(`NOTE: ${e.message}`)); ok = await baseline(); }
      else if (MODE === 'setup') await modeSetup(c);
      else if (MODE === 'request') await modeRequest(c);
      else if (MODE === 'await') await modeAwait(c);
      else if (MODE === 'steps') await modeSteps(c);
      else if (MODE === 'withdraw-resubmit') await modeWithdrawResubmit(c);
      else if (MODE === 'verdict') ok = await modeVerdict(c);
      else if (MODE === 'cleanup') ok = await modeCleanup(c);
      process.exit(ok ? 0 : 1);
    } catch (e) {
      console.error(`\nSTOPPED: ${noGuid(e.message)}`);
      if (writes) console.error(`If rows were created, clean up with: node scripts/test-flow-v2.mjs --mode=cleanup --case=${CASE} --env=<url> --auth=az --confirm-mutates-environment --counters-before=... --counters-consumed=...  (the values were printed by setup)`);
      process.exit(4);
    }
  })();
}
