#!/usr/bin/env node
/**
 * Server tests of the bulk messages CreateMultiple / UpdateMultiple on mwf_contract against the Contract State Guard (ADR-004, assembly
 * 1.0.7.0), the contract number generator (ADR-006) and the approval chain builder (ADR-007). FICTIONAL rows only, named TEST-TMP-BULK*.
 * Both approval flows (v1 and v2) must be OFF: the script reads their state and stops if any is ON. It never turns a flow on or off.
 *
 * Nothing is assumed: every case records what happened (PASS / FAIL / OBS). A FAIL (a result that differs from the design, for example a
 * guard bypass in a batch) stops the run at that case, cleans up and prints the details. No plug-in is changed or registered.
 *
 *   C1   CreateMultiple, 3 valid Drafts of different types: numbers PREFIX-NNNN with the right sequence, counters +1 each, rows created, USD frozen?
 *   C1b  CreateMultiple, 2 Drafts of the SAME type: sequence inside one batch (N+1, N+2), counter +2
 *   C2   CreateMultiple with one Pending contract: the whole batch rejected by the guard message, no row, counters unchanged
 *   C3   CreateMultiple with a number supplied by the client: rejected? effect on the batch (rows, counters)
 *   C4   UpdateMultiple, two Drafts submitted (Draft -> Pending) in one request: chain per contract, round 1, USD frozen
 *   C5   UpdateMultiple with one valid submission and one forbidden transition: all rejected, no side effect on the valid one
 *   C6   UpdateMultiple changing a locked column (Value) on a Pending contract next to an allowed edit: rejected, nothing changed
 *   C7   UpdateMultiple changing the contract type / the contract number: rejected, nothing changed
 *   C8   UpdateMultiple withdrawing Pending -> Draft and a second UpdateMultiple resubmitting: round 2, round-1 steps Cancelled
 *
 * Before every case and before every bulk request: 3 consecutive successful reads (requireStableConnection). A write is never retried
 * (GET only, by the shared fetch wrapper). Counters are snapshotted first and restored at the end by scripts/lib/counter-snapshot.mjs.
 *
 * Modes (every mode that writes needs --confirm-mutates-environment; --dry-run reads the state, prints what it would send, sends nothing):
 *   node scripts/test-bulk-messages.mjs --mode=plan                       (offline: the case list)
 *   node scripts/test-bulk-messages.mjs --env=https://<org>.crm4.dynamics.com --auth=az --mode=baseline
 *   node scripts/test-bulk-messages.mjs --env=... --auth=az --mode=run --confirm-mutates-environment [--only=C1,C2] [--dry-run]
 *   node scripts/test-bulk-messages.mjs --env=... --auth=az --mode=cleanup --confirm-mutates-environment [--counters-before=... --counters-consumed=...]
 */
import { parseArgs, openSession, noGuid, Stop } from './lib/dv-session.mjs';
import { snapshotCounters, readCounters, ctrIo, trackCreate, restoreAfterRun, restoreFromArgs, cleanupHint, requireStableConnection } from './lib/counter-snapshot.mjs';
import { deleteContracts } from './lib/contract-cleanup.mjs';
import { enterCleanupPhase } from './lib/resilient-fetch.mjs';
import { bulkPath, bulkBody, updateTarget, checkSequence, movedCounters, chainLengthFor, failureText, allFlowsOff } from './lib/bulk-messages.mjs';

const argv = process.argv;
const MODE = ((argv.find((a) => a.startsWith('--mode=')) || '').slice(7)) || 'run';
const PREFIX = 'TEST-TMP-BULK';
const q = encodeURIComponent;

const CASES = [
  ['C1', 'CreateMultiple: 3 valid Drafts of different types'],
  ['C1b', 'CreateMultiple: 2 Drafts of the same type (sequence inside one batch)'],
  ['C2', 'CreateMultiple: a Pending contract inside the batch'],
  ['C3', 'CreateMultiple: a contract number supplied by the client'],
  ['C4', 'UpdateMultiple: two Drafts submitted in one request'],
  ['C5', 'UpdateMultiple: one valid submission and one forbidden transition'],
  ['C6', 'UpdateMultiple: a locked column on a Pending contract'],
  ['C7', 'UpdateMultiple: the contract type and the contract number'],
  ['C8', 'UpdateMultiple: withdraw to Draft, then resubmit in bulk'],
];
if (MODE === 'plan') {
  console.log(`plan (offline, nothing is read or written). Prefix ${PREFIX}. Both flows must be OFF.`);
  for (const [id, t] of CASES) console.log(`  ${id.padEnd(4)} ${t}`);
  process.exit(0);
}

const { argOf, env: ENV, auth: AUTH, has } = parseArgs();
const ONLY = argOf('only');
const want = (id) => !ONLY || ONLY.split(',').map((x) => x.trim()).includes(id);
const DRY = has('--dry-run');
if (!['baseline', 'run', 'cleanup', 'check-clean'].includes(MODE)) { console.error('Invalid --mode=plan|baseline|run|cleanup. Nothing was run.'); process.exit(2); }
if (['run', 'cleanup'].includes(MODE) && !DRY && !has('--confirm-mutates-environment')) {
  console.error(`WARNING: --mode=${MODE} creates, submits and deletes ${PREFIX}* rows and temporarily writes the contract number counters. Add --confirm-mutates-environment to run it on purpose, or --dry-run to see what it would do. Nothing was run.`);
  process.exit(2);
}

const T = { Maintenance: 867640000, Procurement: 867640001, Insurance: 867640002, Sales: 867640003, Services: 867640004 };
const DIR = { Income: 867640000, Expense: 867640001 };
const ST = { Draft: 1, Pending: 867640000, InForce: 867640001 };
const ROLE = { DH: 867640000, FM: 867640001, GM: 867640002, RO: 867640003, OW: 867640004 };
const ACT = { Approve: 867640000, Inform: 867640001 };
const DEC = { Pending: 867640000, Cancelled: 867640005 };
const ROLE_NAME = { 867640000: 'Department Head', 867640001: 'Finance Manager', 867640002: 'General Manager', 867640003: 'Regional Office', 867640004: 'Owner' };
const CHAIN = { 1: [ROLE.DH], 2: [ROLE.DH, ROLE.FM], 3: [ROLE.DH, ROLE.FM, ROLE.GM], 5: [ROLE.DH, ROLE.FM, ROLE.GM, ROLE.RO, ROLE.OW] };
const GUARD_CREATE_MSG = 'A contract must be created as Draft; submit it for approval afterwards.';

let S; let USD; let CP; let ctr; let snap;
const results = [];
const out = (id, status, name, detail = '') => { results.push({ id, status }); console.log(`${status.padEnd(4)}  ${id.padEnd(4)} ${name}${detail ? `  [${detail}]` : ''}`); return status === 'PASS'; };
const check = (id, name, ok, detail) => out(id, ok ? 'PASS' : 'FAIL', name, detail);
const obs = (id, name, detail) => out(id, 'OBS', name, detail);

async function openAll() {
  S = await openSession({ env: ENV, auth: AUTH });
  const raw = S.call;
  S.callT = async (m, p, b, x) => { const r = await raw(m, p, b, x); trackCreate(m, p, b, r.ok); return r; };
  ctr = ctrIo(S.callT);
  await requireStableConnection(raw);
}
const gate = () => requireStableConnection(S.call, { need: 3, maxAttempts: 6, pauseMs: 1500 });
const get = async (p) => (await S.must('GET', p)).j;
const count = async (path) => (await get(`${path}${path.includes('?') ? '&' : '?'}$count=true&$top=1`))['@odata.count'];
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- reads
async function flows() {
  const rows = (await get(`workflows?$select=name,statecode,modifiedon&$filter=${q("category eq 5 and contains(name,'Contract Approval')")}`)).value;
  return rows;
}
const flowLine = (rows) => rows.map((r) => `${/v(\d)\s*$/.exec(r.name)?.[0] || 'flow'} ${r.statecode === 0 ? 'OFF' : 'ON'}`).join(', ');
async function checkClean() {
  const a = (await get(`mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value.length;
  const b = (await get(`mwf_counterparties?$select=mwf_counterpartyid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value.length;
  const total = await count('mwf_contracts');
  const steps = await count('mwf_approvalsteps');
  const m = await count('mwf_approvalmatrixes?$filter=statecode eq 0');
  const asg = await count('mwf_approverassignments?$filter=statecode eq 0');
  const fl = await flows();
  console.log(`check-clean (prefix ${PREFIX}): TEST-TMP-BULK contracts ${a}, counterparties ${b}, total contracts ${total}, approval steps ${steps}, active matrix rows ${m}, active assignments ${asg}, flows: ${flowLine(fl)} (expected 0, 0, 11, 0, 110, 5, all OFF)`);
  return { a, b, total, steps, m, asg, flowsOff: allFlowsOff(fl) };
}
async function baseline() {
  const c = await checkClean();
  const fl = await flows();
  console.log(`flow rows read: ${fl.length}; modifiedon (UTC): ${fl.map((r) => `${/v\d/.exec(r.name)?.[0] || 'flow'} ${String(r.modifiedon).slice(0, 19)}Z`).join(', ')}`);
  const cs = await snapshotCounters(ctr);
  console.log('counters: ' + Object.values(cs.byType).map((x) => `${x.prefix}=${x.last}`).join(' '));
  try {
    const steps = (await get(`sdkmessageprocessingsteps?$select=name,stage,mode,statecode&$expand=sdkmessageid($select=name)&$filter=${q("contains(name,'Muwafaqa.Plugins')")}`)).value;
    const by = {};
    for (const s of steps) { const k = `${s.sdkmessageid?.name} stage ${s.stage} ${s.mode === 0 ? 'sync' : 'async'}${s.statecode === 0 ? '' : ' DISABLED'}`; by[k] = (by[k] || 0) + 1; }
    console.log(`registered steps of the plug-in assembly: ${steps.length}`);
    for (const [k, v] of Object.entries(by).sort()) console.log(`  ${k}: ${v}`);
  } catch (e) { console.log(`registered steps could not be listed: ${noGuid(e.message).slice(0, 120)}`); }
  for (const m of ['CreateMultiple', 'UpdateMultiple']) {
    try { const f = (await get(`sdkmessagefilters?$select=sdkmessagefilterid&$filter=${q(`sdkmessageid/name eq '${m}' and primaryobjecttypecode eq 'mwf_contract'`)}`)).value.length; console.log(`message ${m} available for mwf_contract: ${f === 1 ? 'yes' : `no (${f} filter rows)`}`); }
    catch (e) { console.log(`availability of ${m} could not be read: ${noGuid(e.message).slice(0, 100)}`); }
  }
  return c;
}

// ---------------------------------------------------------------- data helpers
const target = (name, type, direction, value, extra = {}) => ({
  mwf_name: name, mwf_contracttype: type, mwf_direction: direction, mwf_value: value,
  'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${CP || '<counterparty>'})`, 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${USD || '<usd>'})`, ...extra,
});
async function createOne(name, type = T.Maintenance, direction = DIR.Expense, value = 1000) {
  const r = await S.callT('POST', 'mwf_contracts?$select=mwf_contractnumber', target(name, type, direction, value), { Prefer: 'return=representation' });
  if (!r.ok) throw new Stop(`contract create failed HTTP ${r.status} ${S.msgOf(r)}`);
  return { id: r.j.mwf_contractid, number: r.j.mwf_contractnumber, value };
}
const readContract = (id) => get(`mwf_contracts(${id})?$select=statuscode,statecode,mwf_approvalround,mwf_valueusdfrozen,mwf_contractnumber,mwf_name,mwf_contracttype,mwf_value`);
const stepsOf = async (id) => (await get(`mwf_approvalsteps?$select=mwf_name,mwf_approvalround,mwf_steporder,mwf_approverrole,mwf_actiontype,mwf_decision,_mwf_originalapprover_value&$filter=_mwf_contract_value eq ${id}&$orderby=mwf_approvalround asc,mwf_steporder asc`)).value;
const sig = (steps) => steps.map((s) => `${s.mwf_approvalround}/${s.mwf_steporder}/${s.mwf_approverrole}/${s.mwf_actiontype}/${s.mwf_decision}`).join('|');
const countByName = async (prefix) => (await get(`mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'${prefix}')`)}`)).value.length;

/** One bulk request. In dry-run nothing is sent. */
async function bulk(message, targets) {
  if (DRY) { console.log(`DRY   would POST ${bulkPath(message)} with ${targets.length} target(s): ${targets.map((t) => Object.keys(t).filter((k) => !k.includes('@odata')).join('+')).join(' | ')}`); return { ok: true, status: 0, message: '', ids: [] }; }
  await gate();
  const r = await S.call('POST', bulkPath(message), bulkBody(targets), { 'If-None-Match': 'null' });
  return { ok: r.ok, status: r.status, message: S.msgOf(r), ids: r.j?.Ids || [] };
}
const counters = () => readCounters(ctr, snap);
const trackTypes = (types) => { for (const t of types) trackCreate('POST', 'mwf_contracts', { mwf_contracttype: t }, true); };

function stepsOk(c, steps, roles, round) {
  const n = roles.length;
  const rolesOk = sameJson(steps.map((s) => s.mwf_approverrole), roles);
  const orderOk = sameJson(steps.map((s) => s.mwf_steporder), roles.map((_, i) => i + 1));
  const actOk = n === 5 ? steps[4]?.mwf_actiontype === ACT.Inform && steps.slice(0, 4).every((s) => s.mwf_actiontype === ACT.Approve) : steps.every((s) => s.mwf_actiontype === ACT.Approve);
  const decOk = steps.every((s) => s.mwf_decision === DEC.Pending && s.mwf_approvalround === round);
  const apprOk = steps.every((s) => !!s._mwf_originalapprover_value);
  const nameOk = steps.every((s) => s.mwf_name === `${c.number} R${round} S${s.mwf_steporder} ${ROLE_NAME[s.mwf_approverrole]}`);
  return { ok: steps.length === n && rolesOk && orderOk && actOk && decOk && apprOk && nameOk, detail: `${steps.length} step(s); roles ${rolesOk}, orders ${orderOk}, actions ${actOk}, Pending+round ${decOk}, approver ${apprOk}, names ${nameOk}` };
}

// ---------------------------------------------------------------- fixtures shared by several cases
let XY = null; let ZW = null;
async function ensureXY() { if (!XY) XY = [await createOne(`${PREFIX}-X`, T.Maintenance, DIR.Expense, 25000), await createOne(`${PREFIX}-Y`, T.Maintenance, DIR.Expense, 75000)]; return XY; }
async function ensureXYPending() {
  const xy = await ensureXY();
  for (const c of xy) { const row = await readContract(c.id); if (row.statuscode !== ST.Pending) { const r = await S.call('PATCH', `mwf_contracts(${c.id})`, { statuscode: ST.Pending }, { 'If-Match': '*' }); if (!r.ok) throw new Stop(`fixture submission failed HTTP ${r.status} ${S.msgOf(r)}`); } }
  return xy;
}
async function ensureZW() { if (!ZW) ZW = [await createOne(`${PREFIX}-Z`, T.Maintenance, DIR.Expense, 25000), await createOne(`${PREFIX}-W`, T.Maintenance, DIR.Expense, 5000)]; return ZW; }

// ---------------------------------------------------------------- the cases
async function caseC1() {
  const targets = [target(`${PREFIX}-C1-a`, T.Maintenance, DIR.Expense, 5000), target(`${PREFIX}-C1-b`, T.Procurement, DIR.Expense, 25000), target(`${PREFIX}-C1-c`, T.Insurance, DIR.Expense, 75000)];
  const before = await counters();
  const r = await bulk('CreateMultiple', targets); if (DRY) return;
  check('C1', 'batch accepted and 3 ids returned', r.ok && r.ids.length === 3, `${failureText(r.status, r.message)}, ${r.ids.length} id(s)`);
  if (!r.ok) return;
  trackTypes(targets.map((t) => t.mwf_contracttype));
  const rows = []; for (const id of r.ids) rows.push(await readContract(id));
  check('C1', 'rows exist, all Draft, returned in the order of the targets', rows.length === 3 && rows.every((x) => x.statuscode === ST.Draft) && rows.every((x, i) => x.mwf_name === targets[i].mwf_name), rows.map((x) => x.statuscode).join('/'));
  const after = await counters();
  const seq = targets.map((t, i) => { const type = t.mwf_contracttype; return checkSequence(before[type].last, before[type].prefix, [rows[i].mwf_contractnumber]); });
  check('C1', 'each contract has its own PREFIX-NNNN number = counter + 1 of its type', seq.every((s) => s.ok), seq.map((s) => s.detail).join(' ; '));
  check('C1', 'each of the 3 counters moved by exactly +1, the other 2 did not move', movedCounters(before, after).length === 3 && targets.every((t) => after[t.mwf_contracttype].last === before[t.mwf_contracttype].last + 1), `moved ${movedCounters(before, after).length}`);
  obs('C1', 'USD frozen value / round right after CreateMultiple (by design written at submission, so empty at Draft)', `frozen ${rows.map((x) => x.mwf_valueusdfrozen).join('/')}, round ${rows.map((x) => x.mwf_approvalround).join('/')}`);
}
async function caseC1b() {
  const targets = [target(`${PREFIX}-C1b-a`, T.Sales, DIR.Income, 1000), target(`${PREFIX}-C1b-b`, T.Sales, DIR.Income, 2000)];
  const before = await counters();
  const r = await bulk('CreateMultiple', targets); if (DRY) return;
  check('C1b', 'batch accepted and 2 ids returned', r.ok && r.ids.length === 2, `${failureText(r.status, r.message)}`);
  if (!r.ok) return;
  trackTypes([T.Sales, T.Sales]);
  const rows = []; for (const id of r.ids) rows.push(await readContract(id));
  const after = await counters();
  const s = checkSequence(before[T.Sales].last, before[T.Sales].prefix, rows.map((x) => x.mwf_contractnumber));
  check('C1b', 'two contracts of one type in one batch get N+1 and N+2 (no gap, no duplicate)', s.setOk, s.detail);
  obs('C1b', 'the numbers follow the order of the targets', String(s.inOrder));
  check('C1b', 'the counter moved by exactly +2', after[T.Sales].last === before[T.Sales].last + 2, `${before[T.Sales].last} -> ${after[T.Sales].last}`);
}
async function caseC2() {
  const targets = [target(`${PREFIX}-C2-a`, T.Maintenance, DIR.Expense, 1000), target(`${PREFIX}-C2-b`, T.Procurement, DIR.Expense, 1000), target(`${PREFIX}-C2-c`, T.Maintenance, DIR.Expense, 1000, { statuscode: ST.Pending })];
  const before = await counters(); const total = await count('mwf_contracts');
  const r = await bulk('CreateMultiple', targets); if (DRY) return;
  check('C2', 'the whole batch is rejected (HTTP 400) with the guard message', !r.ok && r.status === 400 && r.message.includes(GUARD_CREATE_MSG), failureText(r.status, r.message));
  if (r.ok) trackTypes(targets.map((t) => t.mwf_contracttype));
  const after = await counters();
  check('C2', 'no contract of the batch was created (the 2 valid Drafts included)', (await countByName(`${PREFIX}-C2`)) === 0 && (await count('mwf_contracts')) === total, `${await countByName(`${PREFIX}-C2`)} row(s)`);
  check('C2', 'no counter moved', movedCounters(before, after).length === 0, `moved ${movedCounters(before, after).length}`);
}
async function caseC3() {
  const targets = [target(`${PREFIX}-C3-a`, T.Maintenance, DIR.Expense, 1000), target(`${PREFIX}-C3-b`, T.Maintenance, DIR.Expense, 1000, { mwf_contractnumber: `${PREFIX}-9999` })];
  const before = await counters(); const total = await count('mwf_contracts');
  const r = await bulk('CreateMultiple', targets); if (DRY) return;
  check('C3', 'the batch with a client-supplied number is rejected (HTTP 400), message says the number is generated by the system', !r.ok && r.status === 400 && /generated by the system/.test(r.message), failureText(r.status, r.message));
  if (r.ok) trackTypes([T.Maintenance, T.Maintenance]);
  const after = await counters();
  check('C3', 'effect on the batch: no row created (the valid one included) and no counter moved', (await countByName(`${PREFIX}-C3`)) === 0 && (await count('mwf_contracts')) === total && movedCounters(before, after).length === 0, `${await countByName(`${PREFIX}-C3`)} row(s), moved ${movedCounters(before, after).length}`);
}
async function caseC4() {
  const [x, y] = await ensureXY();
  const r = await bulk('UpdateMultiple', [updateTarget(x.id, { statuscode: ST.Pending }), updateTarget(y.id, { statuscode: ST.Pending })]); if (DRY) return;
  check('C4', 'UpdateMultiple of two submissions accepted (HTTP 204)', r.ok && r.status === 204, failureText(r.status, r.message));
  const rows = [await readContract(x.id), await readContract(y.id)]; const steps = [await stepsOf(x.id), await stepsOf(y.id)];
  obs('C4', 'state after the request', `status ${rows.map((v) => v.statuscode).join('/')}, round ${rows.map((v) => v.mwf_approvalround).join('/')}, frozen ${rows.map((v) => v.mwf_valueusdfrozen).join('/')}, steps ${steps.map((s) => s.length).join('/')}`);
  check('C4', 'both contracts are Pending in round 1', rows.every((v) => v.statuscode === ST.Pending && v.mwf_approvalround === 1), `status ${rows.map((v) => v.statuscode).join('/')}, round ${rows.map((v) => v.mwf_approvalround).join('/')}`);
  check('C4', 'the USD value is frozen for each (equal to its Value, currency USD)', rows.every((v, i) => Number(v.mwf_valueusdfrozen) === [x, y][i].value), rows.map((v) => v.mwf_valueusdfrozen).join('/'));
  const sx = stepsOk(x, steps[0], CHAIN[chainLengthFor(x.value)], 1); const sy = stepsOk(y, steps[1], CHAIN[chainLengthFor(y.value)], 1);
  check('C4', `each contract has the chain of its own value: ${chainLengthFor(x.value)} and ${chainLengthFor(y.value)} step(s), round 1, Pending, names`, sx.ok && sy.ok, `${sx.detail} | ${sy.detail}`);
}
async function caseC5() {
  const [z, w] = await ensureZW();
  const r = await bulk('UpdateMultiple', [updateTarget(z.id, { statuscode: ST.Pending }), updateTarget(w.id, { statuscode: ST.InForce })]); if (DRY) return;
  check('C5', 'the batch is rejected (HTTP 400) with the transition message (Draft to In Force)', !r.ok && r.status === 400 && /Cannot change the contract status from Draft/.test(r.message), failureText(r.status, r.message));
  const rz = await readContract(z.id); const rw = await readContract(w.id); const sz = await stepsOf(z.id);
  check('C5', 'no side effect on the valid contract: still Draft, round and frozen value empty, no steps', rz.statuscode === ST.Draft && rz.mwf_approvalround == null && rz.mwf_valueusdfrozen == null && sz.length === 0, `status ${rz.statuscode}, round ${rz.mwf_approvalround}, frozen ${rz.mwf_valueusdfrozen}, steps ${sz.length}`);
  check('C5', 'the forbidden one is unchanged (Draft)', rw.statuscode === ST.Draft, `status ${rw.statuscode}`);
}
async function caseC6() {
  const [x, y] = await ensureXYPending();
  const bx = await readContract(x.id); const by = await readContract(y.id); const sbx = sig(await stepsOf(x.id)); const sby = sig(await stepsOf(y.id));
  const r = await bulk('UpdateMultiple', [updateTarget(x.id, { mwf_name: `${PREFIX}-X edited in bulk` }), updateTarget(y.id, { mwf_value: 80000 })]); if (DRY) return;
  check('C6', 'the batch is rejected (HTTP 400): Value cannot be changed on a Pending contract', !r.ok && r.status === 400 && /Cannot change Value/.test(r.message), failureText(r.status, r.message));
  const ax = await readContract(x.id); const ay = await readContract(y.id);
  check('C6', 'nothing changed: the allowed rename of the other contract was rolled back too, Value and frozen value unchanged, steps unchanged', ax.mwf_name === bx.mwf_name && Number(ay.mwf_value) === Number(by.mwf_value) && Number(ay.mwf_valueusdfrozen) === Number(by.mwf_valueusdfrozen) && sig(await stepsOf(x.id)) === sbx && sig(await stepsOf(y.id)) === sby, `name unchanged ${ax.mwf_name === bx.mwf_name}, Value ${ay.mwf_value}`);
}
async function caseC7() {
  const [z, w] = await ensureZW();
  const bz = await readContract(z.id); const bw = await readContract(w.id);
  const r1 = await bulk('UpdateMultiple', [updateTarget(w.id, { mwf_name: `${PREFIX}-W edited in bulk` }), updateTarget(z.id, { mwf_contracttype: T.Procurement })]); if (DRY) return;
  check('C7', 'changing the contract type is rejected (HTTP 400, "cannot be changed after the contract is created")', !r1.ok && r1.status === 400 && /Contract Type cannot be changed/.test(r1.message), failureText(r1.status, r1.message));
  const az = await readContract(z.id); const aw = await readContract(w.id);
  check('C7', 'nothing changed: type unchanged, the allowed rename rolled back', az.mwf_contracttype === bz.mwf_contracttype && aw.mwf_name === bw.mwf_name, `type ${az.mwf_contracttype === bz.mwf_contracttype ? 'unchanged' : 'CHANGED'}, name ${aw.mwf_name === bw.mwf_name ? 'unchanged' : 'CHANGED'}`);
  const r2 = await bulk('UpdateMultiple', [updateTarget(z.id, { mwf_contractnumber: `${PREFIX}-8888` })]);
  check('C7', 'changing the contract number is rejected (HTTP 400, "cannot be changed")', !r2.ok && r2.status === 400 && /Contract Number cannot be changed/.test(r2.message), failureText(r2.status, r2.message));
  const bz2 = await readContract(z.id);
  check('C7', 'the number is unchanged', bz2.mwf_contractnumber === bz.mwf_contractnumber, 'number unchanged');
}
async function caseC8() {
  const [x, y] = await ensureXYPending();
  const w = await bulk('UpdateMultiple', [updateTarget(x.id, { statuscode: ST.Draft }), updateTarget(y.id, { statuscode: ST.Draft })]); if (DRY) return;
  check('C8', 'withdrawal Pending -> Draft in one request accepted (HTTP 204)', w.ok && w.status === 204, failureText(w.status, w.message));
  const mid = [await readContract(x.id), await readContract(y.id)]; const midSteps = [await stepsOf(x.id), await stepsOf(y.id)];
  obs('C8', 'state after the withdrawal (round-1 steps stay Pending until the next submission, as in T8)', `status ${mid.map((v) => v.statuscode).join('/')}, round ${mid.map((v) => v.mwf_approvalround).join('/')}, steps ${midSteps.map((s) => s.length).join('/')}`);
  const r = await bulk('UpdateMultiple', [updateTarget(x.id, { statuscode: ST.Pending }), updateTarget(y.id, { statuscode: ST.Pending })]);
  check('C8', 'resubmission in one request accepted (HTTP 204)', r.ok && r.status === 204, failureText(r.status, r.message));
  const rows = [await readContract(x.id), await readContract(y.id)]; const steps = [await stepsOf(x.id), await stepsOf(y.id)];
  check('C8', 'both contracts are Pending in round 2', rows.every((v) => v.statuscode === ST.Pending && v.mwf_approvalround === 2), `status ${rows.map((v) => v.statuscode).join('/')}, round ${rows.map((v) => v.mwf_approvalround).join('/')}`);
  const n = [CHAIN[chainLengthFor(x.value)].length, CHAIN[chainLengthFor(y.value)].length];
  const parts = [x, y].map((c, i) => {
    const r1 = steps[i].filter((s) => s.mwf_approvalround === 1); const r2 = steps[i].filter((s) => s.mwf_approvalround === 2);
    return { total: steps[i].length === 2 * n[i], r1: r1.length === n[i] && r1.every((s) => s.mwf_decision === DEC.Cancelled), r2: stepsOk(c, r2, CHAIN[chainLengthFor(c.value)], 2) };
  });
  check('C8', `round-1 steps are Cancelled and round-2 steps are new and Pending (${n[0] * 2} and ${n[1] * 2} rows in total, nothing deleted)`, parts.every((p) => p.total && p.r1 && p.r2.ok), parts.map((p) => `rows ${p.total}, r1 cancelled ${p.r1}, r2 ${p.r2.ok}`).join(' | '));
  check('C8', 'the USD value is still frozen after the resubmission', rows.every((v, i) => Number(v.mwf_valueusdfrozen) === [x, y][i].value), rows.map((v) => v.mwf_valueusdfrozen).join('/'));
}
const RUNNERS = { C1: caseC1, C1b: caseC1b, C2: caseC2, C3: caseC3, C4: caseC4, C5: caseC5, C6: caseC6, C7: caseC7, C8: caseC8 };

// ---------------------------------------------------------------- run / cleanup
async function runAll() {
  const fl = await flows();
  console.log(`INFO  approval flows (read only): ${flowLine(fl)}`);
  if (!allFlowsOff(fl)) throw new Stop(`Not every approval flow is OFF (${fl.length} flow row(s) read). Nothing was created. Report this; the script never turns a flow on or off.`);
  const pre = await checkClean();
  if (pre.a || pre.b || pre.steps || pre.total !== 11 || pre.m !== 110 || pre.asg !== 5) throw new Stop('The starting state is not clean (see the line above). Nothing was created.');
  const cur = (await get("transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0")).value;
  if (cur.length !== 1) throw new Stop(`active USD currency: expected 1, found ${cur.length}`);
  USD = cur[0].transactioncurrencyid;
  snap = await snapshotCounters(ctr);
  console.log('INFO  counters before: ' + Object.values(snap.byType).map((c) => `${c.prefix}=${c.last}`).join(' '));
  if (DRY) {
    console.log('DRY   dry-run: the case list and the requests below are NOT sent. Cases that need ids from earlier cases are shown once only.');
    CP = null;
    for (const [id, t] of CASES) if (want(id)) { console.log(`\n--- ${id}: ${t}`); }
    console.log('\nDRY   requests (shape only): CreateMultiple C1 (3 Drafts), C1b (2 Drafts), C2 (2 Drafts + 1 Pending), C3 (Draft + one with a supplied number); UpdateMultiple C4 (2 submissions), C5 (submission + Draft->In Force), C6 (rename + Value change), C7 (rename + type change; number change), C8 (2 withdrawals; 2 resubmissions).');
    return;
  }
  const cpOpt = (await get("EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)")).OptionSet.Options[0].Value;
  await gate();
  CP = (await S.must('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} Fictional Counterparty (delete me)`, mwf_counterpartytype: cpOpt })).id;
  try {
    for (const [id, title] of CASES) {
      if (!want(id)) continue;
      console.log(`\n--- ${id}: ${title}`);
      const failsBefore = results.filter((r) => r.status === 'FAIL').length;
      await gate();
      await RUNNERS[id]();
      if (results.filter((r) => r.status === 'FAIL').length > failsBefore) throw new Stop(`case ${id} gave a result that differs from the design: stopped here, cleaning up (details above)`);
    }
  } finally {
    enterCleanupPhase();
    const rows = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value;
    const del = await deleteContracts(S.io, rows.map((r) => r.mwf_contractid));
    console.log(`INFO  cleanup: ${rows.length} contract row(s) found, ${del.deleted} deleted, ${del.failed.length} failed (their steps are deleted by the cascade)`);
    if (CP) { const d = await S.call('DELETE', `mwf_counterparties(${CP})`); console.log(`INFO  cleanup: counterparty delete HTTP ${d.status}`); }
    const rs = await restoreAfterRun(ctr, snap);
    const c = await checkClean();
    check('D', 'check-clean: 0 TEST-TMP-BULK contracts, 0 counterparties, 11 contracts, 0 steps, 110 matrix rows, 5 assignments, flows OFF, counters restored', c.a === 0 && c.b === 0 && c.total === 11 && c.steps === 0 && c.m === 110 && c.asg === 5 && c.flowsOff && rs.refused === 0, `${c.a}/${c.b}/${c.total}/${c.steps}/${c.m}/${c.asg}, refused ${rs.refused}`);
    const bad = results.filter((r) => r.status === 'FAIL').length;
    console.log(`\nSUMMARY: ${results.filter((r) => r.status === 'PASS').length} PASS, ${bad} FAIL, ${results.filter((r) => r.status === 'OBS').length} OBS.`);
  }
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
}

async function cleanupOnly() {
  enterCleanupPhase();
  const rows = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value;
  const del = await deleteContracts(S.io, rows.map((r) => r.mwf_contractid));
  console.log(`INFO  cleanup: ${rows.length} contract row(s) found, ${del.deleted} deleted, ${del.failed.length} failed`);
  for (const c of (await get(`mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value) {
    const d = await S.call('DELETE', `mwf_counterparties(${c.mwf_counterpartyid})`); console.log(`INFO  cleanup: counterparty delete HTTP ${d.status}`);
  }
  await restoreFromArgs(ctr);
  await checkClean();
}

(async () => {
  try {
    await openAll();
    if (MODE === 'baseline' || MODE === 'check-clean') await baseline();
    else if (MODE === 'cleanup') await cleanupOnly();
    else await runAll();
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    if (MODE === 'run') console.error(cleanupHint(PREFIX, snap).replace('scripts/cleanup-test-rows.mjs --prefix=' + PREFIX, 'scripts/test-bulk-messages.mjs --mode=cleanup'));
    process.exit(4);
  }
})();
