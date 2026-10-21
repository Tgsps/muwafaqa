#!/usr/bin/env node
/**
 * Server tests of the approval chain builder (ADR-007, plug-in ApprovalChainBuilder). FICTIONAL rows only, named TEST-TMP-CHAIN*.
 * The approval flow must be OFF (the script stops otherwise): a submission would start a run and an approval request.
 *
 *   T1  the four bands of one type and direction (value 5,000 / 25,000 / 75,000 / 250,000): step count, roles, actions, the last step of the
 *       top band is Inform, every step Pending, round 1, original approver set, name holds number + round + order + role.
 *       T1x: the other four types with direction Income get their own chain (2 steps at 25,000)
 *   T2  boundaries 10,000 / 10,000.01 / 50,000 / 50,000.01 / 100,000 / 100,000.01 (frozen value read back too)
 *   T3  value 0 falls on the first band
 *   T4  a negative value cannot be created (the Value column minimum is 0): observation. The rollback of a rejected submission is proved by T5
 *   T5  a role of the chain without an active assignment: the submission is rejected (HTTP 400, role named), the contract stays Draft with
 *       NO steps, and the PreOperation writes (frozen value, round) are rolled back too. A chain that does not need that role still works.
 *       The assignment row is deactivated and ALWAYS reactivated in finally, then read back
 *   T6  resubmission Pending -> Draft -> Pending: round 2; the open (Pending, Waiting) steps of round 1 become Cancelled, an Approved one stays
 *   T7  Rejected -> Draft -> Pending the same way
 *   T8  no new steps and no new round for edits that are not a real submission (Draft edit, same-status save, rejected edits on Pending)
 *   T9  the chain is frozen: after the submission a matching matrix row is deactivated, the steps do not change; the row is reactivated and
 *       110 active rows are read back
 *   T10 five submissions in parallel: each contract gets exactly its own chain
 *
 * Counters are snapshotted first and restored at the end by the rule of scripts/lib/counter-snapshot.mjs. Nothing is retried by the script
 * itself (GET on network errors only, by the shared fetch wrapper). Any other unexpected result stops the run and prints the cleanup command.
 *
 * Usage:
 *   node scripts/test-approval-chain.mjs --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment [--auth=device|az] [--only=T1,T5]
 *   node scripts/test-approval-chain.mjs --env=... --mode=check-clean
 *   node scripts/test-approval-chain.mjs --env=... --mode=cleanup --confirm-mutates-environment [--counters-before=... --counters-consumed=...]
 */
import { parseArgs, openSession, noGuid, Stop } from './lib/dv-session.mjs';
import { snapshotCounters, ctrIo, trackCreate, restoreAfterRun, restoreFromArgs, printHandoff, cleanupHint, requireStableConnection } from './lib/counter-snapshot.mjs';
import { approvalFlowState, deleteContracts } from './lib/contract-cleanup.mjs';
import { enterCleanupPhase } from './lib/resilient-fetch.mjs';

const { argOf, env: ENV, auth: AUTH, has } = parseArgs();
const MODE = argOf('mode') || 'run';
const ONLY = argOf('only');
const want = (id) => !ONLY || ONLY.split(',').map((x) => x.trim()).includes(id);
const PREFIX = 'TEST-TMP-CHAIN';
const q = encodeURIComponent;
if (!['run', 'check-clean', 'cleanup'].includes(MODE)) { console.error('Invalid --mode=run|check-clean|cleanup. Nothing was run.'); process.exit(2); }
if (MODE !== 'check-clean' && !has('--confirm-mutates-environment')) {
  console.error(`WARNING: this test creates, submits and deletes ${PREFIX}* rows, temporarily deactivates one approver assignment row and one matrix row, and temporarily writes the contract number counters. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
  process.exit(2);
}

const T = { Maintenance: 867640000, Procurement: 867640001, Insurance: 867640002, Sales: 867640003, Services: 867640004 };
const DIR = { Income: 867640000, Expense: 867640001 };
const ST = { Draft: 1, Pending: 867640000, Rejected: 2 };
const ROLE = { DH: 867640000, FM: 867640001, GM: 867640002, RO: 867640003, OW: 867640004 };
const ACT = { Approve: 867640000, Inform: 867640001 };
const DEC = { Pending: 867640000, Waiting: 867640001, Approved: 867640002, Cancelled: 867640005 };
const ROLE_NAME = { 867640000: 'Department Head', 867640001: 'Finance Manager', 867640002: 'General Manager', 867640003: 'Regional Office', 867640004: 'Owner' };
// expected chains of the fictional seed data (roles in order, last action)
const CHAIN = { 1: [ROLE.DH], 2: [ROLE.DH, ROLE.FM], 3: [ROLE.DH, ROLE.FM, ROLE.GM], 5: [ROLE.DH, ROLE.FM, ROLE.GM, ROLE.RO, ROLE.OW] };

let S; let USD; let CP; let ctr; let snap;
const results = [];
const out = (id, status, name, detail = '') => { results.push({ id, status }); console.log(`${status.padEnd(4)}  ${id.padEnd(5)} ${name}${detail ? `  [${detail}]` : ''}`); return status === 'PASS'; };
const check = (id, name, ok, detail) => out(id, ok ? 'PASS' : 'FAIL', name, detail);
const touched = [];   // config rows deactivated by this run: { path, activate }

async function openAll() {
  S = await openSession({ env: ENV, auth: AUTH });
  const raw = S.call;
  S.callT = async (m, p, b, x) => { const r = await raw(m, p, b, x); trackCreate(m, p, b, r.ok); return r; };
  ctr = ctrIo(S.callT);
  await requireStableConnection(raw);
}
const get = async (p) => (await S.must('GET', p)).j;
const count = async (path) => (await get(`${path}${path.includes('?') ? '&' : '?'}$count=true&$top=1`))['@odata.count'];

// ---------------------------------------------------------------- data helpers
const body = (name, type, direction, value) => ({
  mwf_name: name, mwf_contracttype: type, mwf_direction: direction, mwf_value: value,
  'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${CP})`, 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${USD})`,
});
async function createContract(name, type = T.Maintenance, direction = DIR.Expense, value = 1000) {
  const r = await S.callT('POST', 'mwf_contracts?$select=mwf_contractnumber', body(name, type, direction, value), { Prefer: 'return=representation' });
  if (!r.ok) throw new Stop(`contract create failed HTTP ${r.status} ${S.msgOf(r)}`);
  return { id: r.j.mwf_contractid, number: r.j.mwf_contractnumber };
}
const patch = async (id, b) => { const r = await S.call('PATCH', `mwf_contracts(${id})`, b, { 'If-Match': '*' }); return { ok: r.ok, status: r.status, message: S.msgOf(r) }; };
const submit = (id) => patch(id, { statuscode: ST.Pending });
const withdraw = (id) => patch(id, { statuscode: ST.Draft });
const toRejected = (id) => patch(id, { statecode: 1, statuscode: ST.Rejected });
const toDraftFromRejected = (id) => patch(id, { statecode: 0, statuscode: ST.Draft });
const readContract = async (id) => get(`mwf_contracts(${id})?$select=statuscode,statecode,mwf_approvalround,mwf_valueusdfrozen,mwf_contractnumber,mwf_name`);
async function stepsOf(id) {
  return (await get(`mwf_approvalsteps?$select=mwf_name,mwf_approvalround,mwf_steporder,mwf_approverrole,mwf_actiontype,mwf_decision,_mwf_originalapprover_value&$filter=_mwf_contract_value eq ${id}&$orderby=mwf_approvalround asc,mwf_steporder asc`)).value;
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sig = (steps) => steps.map((s) => `${s.mwf_approvalround}/${s.mwf_steporder}/${s.mwf_approverrole}/${s.mwf_actiontype}/${s.mwf_decision}`).join('|');

async function deactivate(path, how) {
  const r = await S.call('PATCH', path, { statecode: 1, statuscode: 2 }, { 'If-Match': '*' });
  if (!r.ok) throw new Stop(`could not deactivate (${how}): HTTP ${r.status} ${S.msgOf(r)}`);
  touched.push({ path, how });
}
async function reactivateAll() {
  // always reactivates what this run deactivated; reads each row back; if a result is unknown it prints the state and stops
  while (touched.length) {
    const t = touched[touched.length - 1];
    const r = await S.call('PATCH', t.path, { statecode: 0, statuscode: 1 }, { 'If-Match': '*' });
    const now = await S.call('GET', `${t.path}?$select=statecode`);
    if (!now.ok || now.j.statecode !== 0) {
      console.error(`STATE UNKNOWN: ${t.how} could not be confirmed Active (PATCH HTTP ${r.status}, read HTTP ${now.status}, statecode ${now.j?.statecode}). Reactivate it by hand, then run --mode=cleanup.`);
      throw new Stop(`reactivation of ${t.how} not confirmed`);
    }
    touched.pop();
  }
}

async function configIsClean() {
  const m = await count('mwf_approvalmatrixes?$filter=statecode eq 0');
  const a = await count('mwf_approverassignments?$filter=statecode eq 0');
  return { m, asg: a };
}
async function checkClean() {
  const a = (await get(`mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value.length;
  const b = (await get(`mwf_counterparties?$select=mwf_counterpartyid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value.length;
  const total = await count('mwf_contracts');
  const steps = await count('mwf_approvalsteps');
  const cfg = await configIsClean();
  console.log(`check-clean (prefix ${PREFIX}): TEST-TMP contracts ${a}, counterparties ${b}, total contracts ${total}, approval steps ${steps}, active matrix rows ${cfg.m}, active assignments ${cfg.asg} (expected 0, 0, 11, 0, 110, 5)`);
  return { a, b, total, steps, ...cfg };
}

// ---------------------------------------------------------------- the tests
async function run() {
  const flow = await approvalFlowState(S.io);
  if (!flow.known || flow.on) throw new Stop(`The approval flow is ${flow.known ? 'ON' : 'not readable'}. It must be confirmed OFF. Nothing was created.`);
  console.log('INFO  approval flow is OFF (read only check)');
  const pre = await checkClean();
  if (pre.a || pre.b || pre.steps || pre.total !== 11 || pre.m !== 110 || pre.asg !== 5) throw new Stop('The starting state is not clean (see the line above). Nothing was created.');
  const cur = (await get("transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0")).value;
  if (cur.length !== 1) throw new Stop(`active USD currency: expected 1, found ${cur.length}`);
  USD = cur[0].transactioncurrencyid;
  const typeOpts = (await get("EntityDefinitions(LogicalName='mwf_contract')/Attributes(LogicalName='mwf_contracttype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)")).OptionSet.Options;
  const dirOpts = (await get("EntityDefinitions(LogicalName='mwf_contract')/Attributes(LogicalName='mwf_direction')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)")).OptionSet.Options;
  const lab = (opts, v) => opts.find((o) => o.Value === v)?.Label?.UserLocalizedLabel?.Label;
  if (lab(dirOpts, DIR.Income) !== 'Income' || lab(dirOpts, DIR.Expense) !== 'Expense' || lab(typeOpts, T.Services) !== 'Services') throw new Stop('Contract Type / Direction option values differ from the expected ones. Nothing was created.');

  snap = await snapshotCounters(ctr);
  console.log('INFO  counters before: ' + Object.values(snap.byType).map((c) => `${c.prefix}=${c.last}`).join(' '));
  const cpOpt = (await get("EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)")).OptionSet.Options[0].Value;
  CP = (await S.must('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} Fictional Counterparty (delete me)`, mwf_counterpartytype: cpOpt })).id;

  try {
    // ---------- T1
    const verifyChain = async (id, number, steps, expectedRoles, round, label) => {
      const rolesOk = sameJson(steps.map((s) => s.mwf_approverrole), expectedRoles);
      const orderOk = sameJson(steps.map((s) => s.mwf_steporder), expectedRoles.map((_, i) => i + 1));
      const lastInform = expectedRoles.length === 5 ? steps[4]?.mwf_actiontype === ACT.Inform && steps.slice(0, 4).every((s) => s.mwf_actiontype === ACT.Approve) : steps.every((s) => s.mwf_actiontype === ACT.Approve);
      const pendingOk = steps.every((s) => s.mwf_decision === DEC.Pending && s.mwf_approvalround === round);
      const approverOk = steps.every((s) => !!s._mwf_originalapprover_value);
      const nameOk = steps.every((s) => s.mwf_name === `${number} R${round} S${s.mwf_steporder} ${ROLE_NAME[s.mwf_approverrole]}`);
      return check(label[0], label[1], steps.length === expectedRoles.length && rolesOk && orderOk && lastInform && pendingOk && approverOk && nameOk,
        `${steps.length} step(s); roles ${rolesOk}, orders ${orderOk}, actions ${lastInform}, Pending+round ${pendingOk}, approver set ${approverOk}, names ${nameOk}`);
    };
    if (want('T1')) {
      for (const [value, n] of [[5000, 1], [25000, 2], [75000, 3], [250000, 5]]) {
        const c = await createContract(`${PREFIX}-T1-${value}`, T.Maintenance, DIR.Expense, value);
        const r = await submit(c.id);
        const steps = await stepsOf(c.id); const row = await readContract(c.id);
        check('T1', `value ${value}: submission accepted, status Pending, round 1`, r.ok && row.statuscode === ST.Pending && row.mwf_approvalround === 1, `HTTP ${r.status}${r.ok ? '' : ' ' + r.message.slice(0, 120)}`);
        await verifyChain(c.id, c.number, steps, CHAIN[n], 1, ['T1', `value ${value}: ${n} step(s) in the right order, roles, actions, names`]);
      }
      for (const t of ['Procurement', 'Insurance', 'Sales', 'Services']) {
        const c = await createContract(`${PREFIX}-T1x-${t}`, T[t], DIR.Income, 25000);
        const r = await submit(c.id); const steps = await stepsOf(c.id);
        check('T1x', `${t} / Income at 25,000 gets its own chain of 2 steps`, r.ok && steps.length === 2 && sameJson(steps.map((s) => s.mwf_approverrole), CHAIN[2]), `HTTP ${r.status}, ${steps.length} step(s)`);
      }
    }
    // ---------- T2
    if (want('T2')) {
      for (const [value, n] of [['10000', 1], ['10000.01', 2], ['50000', 2], ['50000.01', 3], ['100000', 3], ['100000.01', 5]]) {
        const c = await createContract(`${PREFIX}-T2-${value}`, T.Maintenance, DIR.Expense, Number(value));
        const r = await submit(c.id); const steps = await stepsOf(c.id); const row = await readContract(c.id);
        check('T2', `boundary ${value}: ${n} step(s)`, r.ok && steps.length === n && sameJson(steps.map((s) => s.mwf_approverrole), CHAIN[n]) && Number(row.mwf_valueusdfrozen) === Number(value),
          `HTTP ${r.status}, ${steps.length} step(s), frozen ${row.mwf_valueusdfrozen}`);
      }
    }
    // ---------- T3
    if (want('T3')) {
      const c = await createContract(`${PREFIX}-T3-zero`, T.Maintenance, DIR.Expense, 0);
      const r = await submit(c.id); const steps = await stepsOf(c.id); const row = await readContract(c.id);
      check('T3', 'value 0 falls on the first band (1 step, Department Head)', r.ok && steps.length === 1 && steps[0].mwf_approverrole === ROLE.DH && Number(row.mwf_valueusdfrozen) === 0, `HTTP ${r.status}, ${steps.length} step(s), frozen ${row.mwf_valueusdfrozen}`);
    }
    // ---------- T4
    if (want('T4')) {
      const neg = await S.call('POST', 'mwf_contracts', body(`${PREFIX}-T4-neg`, T.Maintenance, DIR.Expense, -1));
      if (neg.ok) { out('T4', 'FAIL', 'a negative Value was ACCEPTED by the platform (unexpected)', 'the row will be removed by the cleanup'); }
      else out('T4', 'PASS', 'a negative Value cannot be created: the Value column minimum is 0 (HTTP ' + neg.status + ')', S.msgOf(neg).slice(0, 100));
      out('T4', 'OBS', 'the negative-value branch of the planner is reachable only by unit tests (the frozen value is system-written and the exchange rate must be > 0). The rollback of a rejected submission is proved by T5');
    }
    // ---------- T5
    if (want('T5')) {
      const fm = (await get(`mwf_approverassignments?$select=mwf_approverrole&$filter=mwf_approverrole eq ${ROLE.FM}`)).value;
      if (fm.length !== 1) throw new Stop(`T5 setup: expected 1 assignment row for Finance Manager, found ${fm.length}`);
      await deactivate(`mwf_approverassignments(${fm[0].mwf_approverassignmentid})`, 'the Finance Manager assignment');
      try {
        const c = await createContract(`${PREFIX}-T5-25000`, T.Maintenance, DIR.Expense, 25000);
        const r = await submit(c.id); const row = await readContract(c.id); const steps = await stepsOf(c.id);
        check('T5', 'role without an active assignment: submission rejected (HTTP 400) and the role is named', !r.ok && r.status === 400 && /Finance Manager/.test(r.message) && /^Cannot submit the contract\./.test(r.message), `HTTP ${r.status}: ${r.message.slice(0, 140)}`);
        check('T5', 'rollback: the contract is still Draft, round and frozen value are still empty (PreOperation writes rolled back), no steps', row.statuscode === ST.Draft && row.mwf_approvalround == null && row.mwf_valueusdfrozen == null && steps.length === 0,
          `status ${row.statuscode}, round ${row.mwf_approvalround}, frozen ${row.mwf_valueusdfrozen}, steps ${steps.length}`);
        const c2 = await createContract(`${PREFIX}-T5-5000`, T.Maintenance, DIR.Expense, 5000);
        const r2 = await submit(c2.id); const s2 = await stepsOf(c2.id);
        check('T5', 'a chain that does not need the missing role still works (5,000: Department Head only)', r2.ok && s2.length === 1, `HTTP ${r2.status}, ${s2.length} step(s)`);
        await reactivateAll();
        const again = await submit(c.id); const s3 = await stepsOf(c.id); const row3 = await readContract(c.id);
        check('T5', 'after the assignment is active again the same contract is accepted (round 1, 2 steps)', again.ok && s3.length === 2 && row3.mwf_approvalround === 1, `HTTP ${again.status}, ${s3.length} step(s), round ${row3.mwf_approvalround}`);
      } finally { await reactivateAll(); }
      const cfg = await configIsClean();
      check('T5', 'restored: 5 active assignment rows', cfg.asg === 5, String(cfg.asg));
    }
    // ---------- T6
    if (want('T6')) {
      const c = await createContract(`${PREFIX}-T6`, T.Maintenance, DIR.Expense, 25000);
      await submit(c.id);
      let s = await stepsOf(c.id);
      await S.call('PATCH', `mwf_approvalsteps(${s[0].mwf_approvalstepid})`, { mwf_decision: DEC.Waiting }, { 'If-Match': '*' });
      await S.call('PATCH', `mwf_approvalsteps(${s[1].mwf_approvalstepid})`, { mwf_decision: DEC.Approved }, { 'If-Match': '*' });
      const w = await withdraw(c.id); const r = await submit(c.id);
      s = await stepsOf(c.id); const row = await readContract(c.id);
      const r1 = s.filter((x) => x.mwf_approvalround === 1); const r2 = s.filter((x) => x.mwf_approvalround === 2);
      check('T6', 'resubmission: round 2, 4 rows in total (nothing deleted)', w.ok && r.ok && row.mwf_approvalround === 2 && s.length === 4, `round ${row.mwf_approvalround}, ${s.length} rows`);
      check('T6', 'round 1: the Waiting step is Cancelled, the Approved step stays Approved', r1.length === 2 && r1[0].mwf_decision === DEC.Cancelled && r1[1].mwf_decision === DEC.Approved, r1.map((x) => x.mwf_decision - 867640000).join(','));
      check('T6', 'round 2: 2 new Pending steps', r2.length === 2 && r2.every((x) => x.mwf_decision === DEC.Pending), `${r2.length} step(s)`);
      // a plain Pending one in round 2 goes Cancelled on the third submission
      await withdraw(c.id); await submit(c.id);
      s = await stepsOf(c.id);
      check('T6', 'third submission: round 3; the Pending steps of round 2 are Cancelled', s.filter((x) => x.mwf_approvalround === 2).every((x) => x.mwf_decision === DEC.Cancelled) && s.filter((x) => x.mwf_approvalround === 3).length === 2, `${s.length} rows`);
    }
    // ---------- T7
    if (want('T7')) {
      const c = await createContract(`${PREFIX}-T7`, T.Maintenance, DIR.Expense, 75000);
      await submit(c.id);
      const rj = await toRejected(c.id); const dr = await toDraftFromRejected(c.id); const r = await submit(c.id);
      const s = await stepsOf(c.id); const row = await readContract(c.id);
      check('T7', 'Pending -> Rejected -> Draft -> Pending: round 2, round-1 steps Cancelled, round-2 steps Pending (3 + 3 rows)', rj.ok && dr.ok && r.ok && row.mwf_approvalround === 2 && s.length === 6
        && s.filter((x) => x.mwf_approvalround === 1).every((x) => x.mwf_decision === DEC.Cancelled) && s.filter((x) => x.mwf_approvalround === 2).every((x) => x.mwf_decision === DEC.Pending),
        `HTTP ${rj.status}/${dr.status}/${r.status}${r.ok ? '' : ' ' + r.message.slice(0, 100)}, round ${row.mwf_approvalround}, ${s.length} rows`);
    }
    // ---------- T8
    if (want('T8')) {
      const c = await createContract(`${PREFIX}-T8`, T.Maintenance, DIR.Expense, 25000);
      const e1 = await patch(c.id, { mwf_name: `${PREFIX}-T8 edited` });
      check('T8', 'editing a Draft that was never submitted creates no steps', e1.ok && (await stepsOf(c.id)).length === 0, `HTTP ${e1.status}`);
      await submit(c.id);
      const base = await stepsOf(c.id); const baseRow = await readContract(c.id);
      const same = await patch(c.id, { statuscode: ST.Pending });
      const val = await patch(c.id, { mwf_value: 90000 });
      const sub = await patch(c.id, { mwf_name: `${PREFIX}-T8 edited again` });
      const after = await stepsOf(c.id); const afterRow = await readContract(c.id);
      out('T8', 'OBS', `on Pending: same-status save HTTP ${same.status}, Value change HTTP ${val.status}${val.ok ? '' : ' (' + val.message.slice(0, 60) + ')'}, Subject edit HTTP ${sub.status}`);
      check('T8', 'on Pending: no new steps, same signature, same round and frozen value', sig(base) === sig(after) && baseRow.mwf_approvalround === afterRow.mwf_approvalround && Number(baseRow.mwf_valueusdfrozen) === Number(afterRow.mwf_valueusdfrozen), `${after.length} rows, round ${afterRow.mwf_approvalround}`);
      await withdraw(c.id);
      const e2 = await patch(c.id, { mwf_name: `${PREFIX}-T8 edited after withdraw` });
      const after2 = await stepsOf(c.id);
      check('T8', 'withdraw to Draft and a Draft edit add no steps (the round-1 steps stay Pending until the next submission)', e2.ok && sig(after2) === sig(base), `${after2.length} rows`);
    }
    // ---------- T9
    if (want('T9')) {
      const c = await createContract(`${PREFIX}-T9`, T.Maintenance, DIR.Expense, 25000);
      await submit(c.id);
      const before = await stepsOf(c.id);
      const rows = (await get(`mwf_approvalmatrixes?$select=mwf_rulename&$filter=mwf_contracttype eq ${T.Maintenance} and mwf_contractdirection eq ${DIR.Expense} and mwf_minvalueusd eq 10000 and mwf_steporder eq 2 and statecode eq 0`)).value;
      if (rows.length !== 1) throw new Stop(`T9 setup: expected 1 matching matrix row, found ${rows.length}`);
      await deactivate(`mwf_approvalmatrixes(${rows[0].mwf_approvalmatrixid})`, 'one matrix row');
      let during;
      try { during = await stepsOf(c.id); } finally { await reactivateAll(); }
      const after = await stepsOf(c.id); const cfg = await configIsClean();
      check('T9', 'the chain is frozen: the steps did not change while a matching matrix row was inactive, nor after it was reactivated', sig(before) === sig(during) && sig(before) === sig(after) && before.length === 2, `${before.length} rows`);
      check('T9', 'restored: 110 active matrix rows', cfg.m === 110, String(cfg.m));
    }
    // ---------- T10
    if (want('T10')) {
      const plan = [[5000, 1], [25000, 2], [75000, 3], [250000, 5], [25000, 2]];
      const cs = [];
      for (let i = 0; i < plan.length; i++) cs.push(await createContract(`${PREFIX}-T10-${i + 1}`, T.Maintenance, DIR.Expense, plan[i][0]));
      const t0 = Date.now();
      const rs = await Promise.all(cs.map((c) => submit(c.id)));
      const ms = Date.now() - t0;
      let all = rs.every((r) => r.ok);
      const detail = [];
      for (let i = 0; i < cs.length; i++) {
        const s = await stepsOf(cs[i].id);
        const ok = s.length === plan[i][1] && sameJson(s.map((x) => x.mwf_approverrole), CHAIN[plan[i][1]]) && s.every((x) => x.mwf_approvalround === 1 && x.mwf_name.startsWith(cs[i].number));
        detail.push(`${s.length}`); all = all && ok;
      }
      const total = (await get(`mwf_approvalsteps?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${cs[0].number.split('-')[0]}-')`)}&$top=5000`)).value.length;
      check('T10', 'five parallel submissions: all accepted, each contract has exactly its own chain', all, `HTTP ${rs.map((r) => r.status).join('/')}, steps per contract ${detail.join('/')}, ${ms} ms`);
      out('T10', 'OBS', `step rows whose name starts with the Maintenance prefix (all earlier tests included): ${total}`);
    }
  } finally {
    enterCleanupPhase();
    try { await reactivateAll(); } catch (e) { console.error(`CLEANUP: ${noGuid(e.message)}`); }
    const rows = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value;
    const del = await deleteContracts(S.io, rows.map((r) => r.mwf_contractid));
    console.log(`INFO  cleanup: ${del.deleted} contract row(s) deleted, ${del.failed.length} failed (their steps are deleted by the cascade)`);
    if (CP) { const d = await S.call('DELETE', `mwf_counterparties(${CP})`); console.log(`INFO  cleanup: counterparty delete HTTP ${d.status}`); }
    const rs = await restoreAfterRun(ctr, snap);
    const c = await checkClean();
    check('D', 'check-clean: 0 TEST-TMP contracts, 0 counterparties, 11 contracts, 0 steps, 110 active matrix rows, 5 active assignments, counters restored',
      c.a === 0 && c.b === 0 && c.total === 11 && c.steps === 0 && c.m === 110 && c.asg === 5 && rs.refused === 0, `${c.a}/${c.b}/${c.total}/${c.steps}/${c.m}, refused ${rs.refused}`);
  }
  const bad = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\nSUMMARY: ${results.filter((r) => r.status === 'PASS').length} PASS, ${bad} FAIL, ${results.filter((r) => r.status === 'OBS').length} OBS.`);
  process.exit(bad ? 1 : 0);
}

async function cleanupOnly() {
  enterCleanupPhase();
  const rows = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value;
  const del = await deleteContracts(S.io, rows.map((r) => r.mwf_contractid));
  console.log(`INFO  cleanup: ${rows.length} contract row(s) found, ${del.deleted} deleted, ${del.failed.length} failed`);
  for (const c of (await get(`mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value) {
    const d = await S.call('DELETE', `mwf_counterparties(${c.mwf_counterpartyid})`); console.log(`INFO  cleanup: counterparty delete HTTP ${d.status}`);
  }
  for (const [set, key] of [['mwf_approvalmatrixes', 'mwf_approvalmatrixid'], ['mwf_approverassignments', 'mwf_approverassignmentid']]) {
    const inactive = (await get(`${set}?$select=statecode&$filter=statecode eq 1`)).value;
    for (const r of inactive) { const x = await S.call('PATCH', `${set}(${r[key]})`, { statecode: 0, statuscode: 1 }, { 'If-Match': '*' }); console.log(`INFO  cleanup: reactivated one ${set} row, HTTP ${x.status}`); }
  }
  await restoreFromArgs(ctr);
  await checkClean();
}

(async () => {
  try {
    await openAll();
    if (MODE === 'check-clean') await checkClean();
    else if (MODE === 'cleanup') await cleanupOnly();
    else await run();
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    if (MODE === 'run') { console.error(cleanupHint(PREFIX, snap).replace('scripts/cleanup-test-rows.mjs --prefix=' + PREFIX, 'scripts/test-approval-chain.mjs --mode=cleanup')); }
    process.exit(4);
  }
})();
