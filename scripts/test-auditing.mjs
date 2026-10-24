#!/usr/bin/env node
/**
 * Behavioral test of Dataverse auditing (ADR-009) with the ADMIN account only (`--auth=az`). NOT RUN YET. FICTIONAL rows only, prefix TEST-TMP-AUD.
 * Both approval flows must be OFF. The audit configuration must already be applied (scripts/configure-auditing.mjs): the script checks it and stops otherwise.
 *
 * What it does (every write is preceded by 3 consecutive successful reads and is never retried):
 *   counterparty : create, edit the name                                  (later: delete)
 *   contract     : create (Draft), edit the name, edit the Value to 25,000, submit (Draft -> Pending: the plug-ins write the round, the frozen USD value,
 *                  the status and the approval steps), withdraw (Pending -> Draft)  (later: delete)
 *   matrix row   : change mwf_rulename to another value, then restore it   (a real row of the seed data: restored in a finally block and read back)
 *   assignment   : change mwf_name of the Owner row to another value, then restore it (same)
 * Then it WAITS for the audit rows (polling every 10 s, at most 10 minutes, and until nothing new has appeared for 60 s) and records the real delay of each row
 * (the moment the poll first SAW the row minus the audit createdon). It reads the history in two ways: the audits table (who: userid, callinguserid; operation; action)
 * and RetrieveRecordChangeHistory / RetrieveAuditDetails (the old and new values), and checks:
 *   - who made each change (the admin account, the SYSTEM user, or another user; never printed by name)
 *   - what changed (old and new values) for each edit
 *   - the kind of operation (Create / Update / Delete)
 *   - whether the plug-in changes appear (approval round, frozen USD value, status), in which audit row, and by which user
 *   - the steps created by the builder (SYSTEM service) and deleted by the cascade
 *   - how many audit rows the rest of the environment wrote during the test (platform tables)
 * Counters are snapshotted and restored. Test audit rows stay in the audits table (they cannot be deleted directly; see ADR-009).
 *
 * NOT tested by this script: reading audit (off), user access audit (off), changes made by a non-admin user or an application user, impersonation, bulk messages,
 * the flows' own changes, retention deletion, DeleteRecordChangeHistory, the log storage used, the audit of role/privilege changes, export of the audit data.
 *
 * Modes (every mode that writes needs --confirm-mutates-environment; --dry-run reads the state and prints what it would do):
 *   --mode=plan      offline: the sequence and the checks
 *   --mode=run       the whole test
 *   --mode=cleanup   restores a matrix / assignment name that still carries the prefix, deletes TEST-TMP-AUD rows, restores the counters (--counters-before/--counters-consumed)
 */
import { parseArgs, openSession, noGuid, sleep, Stop } from './lib/dv-session.mjs';
import { snapshotCounters, ctrIo, trackCreate, restoreAfterRun, restoreFromArgs, printHandoff, requireStableConnection } from './lib/counter-snapshot.mjs';
import { deleteContracts } from './lib/contract-cleanup.mjs';
import { enterCleanupPhase, recheckAfterWait } from './lib/resilient-fetch.mjs';
import { allFlowsOff } from './lib/bulk-messages.mjs';
import { AUDIT_TABLES, changesOf, describeRows, operationName, actionName, lagStats, classifyUser, unmetExpectations, pollFinished, noteNewRows, changeHistoryPath, auditDetailsPath } from './lib/auditing.mjs';

const PREFIX = 'TEST-TMP-AUD';
const MAX_WAIT_MS = 10 * 60 * 1000; const POLL_MS = 10 * 1000; const QUIET_MS = 60 * 1000;
const MODE = (process.argv.find((a) => a.startsWith('--mode=')) || '').slice(7);
const q = encodeURIComponent;

if (MODE === 'plan') {
  console.log(`Audit test (offline plan). Prefix ${PREFIX}; admin account only; both flows OFF; the audit configuration must be applied first.\n`);
  console.log('Operations (each: 3 reads first, no retry):\n  1 counterparty create, 2 edit its name\n  3 contract create (Draft), 4 edit its name, 5 edit Value to 25,000, 6 submit (plug-ins: round, frozen USD value, status, 2 steps), 7 withdraw to Draft\n  8 matrix row: rulename changed, 9 restored\n  10 assignment (Owner row): name changed, 11 restored\n  then WAIT for the audit rows (poll every 10 s; at most 10 minutes; until quiet for 60 s), read the history (audits table + RetrieveRecordChangeHistory + RetrieveAuditDetails), then\n  12 contract delete (Draft; its steps go by the cascade), 13 counterparty delete, then wait again for the delete rows.\n');
  console.log('Checks: who (userid / callinguserid class), what (old and new values), operation, plug-in changes (which audit row, which user), steps created and deleted, the real delay of every row, the audit rows written by the rest of the environment.');
  console.log('Not tested: read audit, user access audit, non-admin or application-user changes, impersonation, bulk messages, flow changes, retention deletion, DeleteRecordChangeHistory, log storage, role-change audit, export.');
  process.exit(0);
}

const { argOf, env: ENV, auth: AUTH, has } = parseArgs();
const DRY = has('--dry-run');
if (!['run', 'cleanup'].includes(MODE)) { console.error('Missing or invalid --mode=plan|run|cleanup. Nothing was run.'); process.exit(2); }
if (!DRY && !has('--confirm-mutates-environment')) { console.error(`WARNING: --mode=${MODE} creates, edits, restores and deletes ${PREFIX}* rows and briefly renames one matrix row and one assignment row. Add --confirm-mutates-environment to run it on purpose, or --dry-run. Nothing was run.`); process.exit(2); }

let S; let snap = null; let ADMIN = null; let SYSTEM_IDS = [];
const results = [];
const out = (id, status, name, detail = '') => { results.push({ id, status }); console.log(`${status.padEnd(4)}  ${id.padEnd(6)} ${name}${detail ? `  [${detail}]` : ''}`); };
const check = (id, name, ok, detail) => out(id, ok ? 'PASS' : 'FAIL', name, detail);
const get = async (p) => (await S.must('GET', p)).j;
const count = async (path) => (await get(`${path}${path.includes('?') ? '&' : '?'}$count=true&$top=1`))['@odata.count'];
const gate = () => requireStableConnection(S.call, { need: 3, maxAttempts: 6, pauseMs: 1500 });
async function write(method, path, body, extra, note) {
  if (DRY) { console.log(`DRY-RUN  would ${method} ${noGuid(path).slice(0, 90)}${note ? `  ${note}` : ''}`); return { ok: true, status: 0, id: null, j: {}, dry: true }; }
  await gate();
  return S.call(method, path, body, extra);
}
const must = (r, what) => { if (!r.ok) throw new Stop(`${what} failed HTTP ${r.status} ${noGuid(S.msgOf(r))}. Not retried. Read the state, then run --mode=cleanup.`); return r; };

// ---------------------------------------------------------------------------------------------------------------- state
async function flowsOff() {
  const rows = (await get(`workflows?$select=name,statecode&$filter=${q("category eq 5 and contains(name,'Contract Approval')")}`)).value;
  return { ok: allFlowsOff(rows), line: rows.map((r) => `${/v\d\s*$/.exec(r.name)?.[0] || 'flow'} ${r.statecode === 0 ? 'OFF' : 'ON'}`).join(', ') };
}
async function checkClean() {
  const a = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value.length;
  const b = (await get(`mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value.length;
  const mx = (await get(`mwf_approvalmatrixes?$select=mwf_rulename&$filter=${q(`contains(mwf_rulename,'${PREFIX}')`)}`)).value.length;
  const as = (await get(`mwf_approverassignments?$select=mwf_name&$filter=${q(`contains(mwf_name,'${PREFIX}')`)}`)).value.length;
  const total = await count('mwf_contracts'); const steps = await count('mwf_approvalsteps');
  const m = await count('mwf_approvalmatrixes?$filter=statecode eq 0'); const asg = await count('mwf_approverassignments?$filter=statecode eq 0');
  console.log(`check-clean (prefix ${PREFIX}): contracts ${a}, counterparties ${b}, matrix rows renamed ${mx}, assignments renamed ${as}, total contracts ${total}, steps ${steps}, active matrix rows ${m}, active assignments ${asg} (expected 0, 0, 0, 0, 11, 0, 110, 5)`);
  return { a, b, mx, as, total, steps, m, asg };
}
async function auditConfigApplied() {
  const org = (await get('organizations?$select=isauditenabled,auditretentionperiodv2')).value[0];
  const bad = [];
  if (!org.isauditenabled) bad.push('organization auditing is off');
  for (const t of AUDIT_TABLES) { const e = await get(`EntityDefinitions(LogicalName='${t}')?$select=IsAuditEnabled`); if (!e.IsAuditEnabled.Value) bad.push(`${t} is not audited`); }
  out('config', bad.length ? 'FAIL' : 'PASS', 'the audit configuration is applied (organization on, the five tables on)', bad.join('; ') || `retention ${org.auditretentionperiodv2} days`);
  return !bad.length;
}

// ---------------------------------------------------------------------------------------------------------------- audit reading
const AUDIT_SEL = 'auditid,createdon,operation,action,objecttypecode,_userid_value,_callinguserid_value,_objectid_value,transactionid';
async function auditsOf(ids) {
  if (!ids.length) return [];
  const filter = ids.map((i) => `_objectid_value eq ${i}`).join(' or ');
  return (await get(`audits?$select=${AUDIT_SEL}&$filter=${q(filter)}&$orderby=createdon asc&$top=500`)).value;
}
const seen = new Map();     // auditid -> first moment the poll saw it
const allRows = new Map();  // auditid -> row
async function pollAudits(ids, expected, label) {
  const startedMs = Date.now(); let lastNew = startedMs; let last;
  for (;;) {
    const rows = await auditsOf(ids);
    for (const r of rows) allRows.set(r.auditid, r);
    const fresh = noteNewRows(seen, rows, Date.now());
    if (fresh.length) { lastNew = Date.now(); console.log(`  poll ${label}: +${fresh.length} row(s) after ${Math.round((Date.now() - startedMs) / 1000)} s (${rows.length} in total)`); }
    last = pollFinished({ unmet: unmetExpectations(rows, expected), lastNewRowMs: lastNew, nowMs: Date.now(), quietMs: QUIET_MS, startedMs, timeoutMs: MAX_WAIT_MS });
    if (last.done) { console.log(`  poll ${label}: finished (${last.why}) after ${Math.round((Date.now() - startedMs) / 1000)} s`); return { rows, why: last.why, unmet: unmetExpectations(rows, expected) }; }
    await sleep(POLL_MS); await recheckAfterWait(S.call, 'This is a read step; nothing is written by it.');
  }
}
const detailOf = async (auditId) => (await get(auditDetailsPath(auditId))).AuditDetail;
const rowsFor = (id) => [...allRows.values()].filter((r) => String(r._objectid_value).toLowerCase() === String(id).toLowerCase()).sort((a, b) => Date.parse(a.createdon) - Date.parse(b.createdon));
const who = (r) => classifyUser(r._userid_value, ADMIN, SYSTEM_IDS);

/** Finds, among the Update rows of a record, the first whose details show `col` going from oldV to newV (numbers compared as numbers). */
async function findChange(id, col, oldV, newV) {
  for (const r of rowsFor(id).filter((x) => x.operation === 2 || x.operation === 1)) {
    const c = changesOf(await detailOf(r.auditid))[col];
    const same = (a, b) => (a === undefined || a === null ? b === undefined || b === null : typeof b === 'number' || typeof a === 'number' ? Number(a) === Number(b) : a === b);
    if (c && same(c.old, oldV) && same(c.new, newV)) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------- the run
const T = { Maintenance: 867640000 }; const DIR = { Expense: 867640001 };
async function run() {
  const f = await flowsOff(); check('flows', `both approval flows are OFF (${f.line})`, f.ok); if (!f.ok) throw new Stop('A flow is ON. Nothing was created.');
  if (!(await auditConfigApplied()) && !DRY) throw new Stop('Apply the audit configuration first (scripts/configure-auditing.mjs). Nothing was created.');
  const pre = await checkClean();
  if (pre.a || pre.b || pre.mx || pre.as || pre.steps || pre.total !== 11 || pre.m !== 110 || pre.asg !== 5) throw new Stop('The starting state is not clean (see the line above). Nothing was created.');
  ADMIN = (await get('WhoAmI')).UserId;
  SYSTEM_IDS = (await get(`systemusers?$select=fullname&$filter=${q("fullname eq 'SYSTEM'")}`)).value.map((x) => x.systemuserid);
  const usd = (await get("transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0")).value[0].transactioncurrencyid;
  const cpOpt = (await get("EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)")).OptionSet.Options[0].Value;
  const mx = (await get('mwf_approvalmatrixes?$select=mwf_rulename&$top=1')).value[0]; const asg = (await get('mwf_approverassignments?$select=mwf_name&$filter=mwf_approverrole eq 867640004')).value[0];
  const M = { id: mx.mwf_approvalmatrixid, orig: mx.mwf_rulename, edited: `${mx.mwf_rulename} ${PREFIX}` }; const A = { id: asg.mwf_approverassignmentid, orig: asg.mwf_name, edited: `${asg.mwf_name} ${PREFIX}` };
  const auditsBefore = await count('audits');
  console.log(`INFO  the account that runs the test is classed 'admin'; ${SYSTEM_IDS.length} SYSTEM user row(s) known; audit rows readable before: ${auditsBefore}`);
  snap = await snapshotCounters(S.ctr);
  const P = {};   // pending restores
  const ops = []; const mark = (label) => { ops.push({ label, ms: Date.now() }); };
  try {
    // ---- counterparty
    const cp = must(await write('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} counterparty`, mwf_counterpartytype: cpOpt }), 'counterparty create'); mark('counterparty create');
    P.cp = cp.id;
    must(await write('PATCH', `mwf_counterparties(${P.cp || '<id>'})`, { mwf_name: `${PREFIX} counterparty edited` }, { 'If-Match': '*' }), 'counterparty edit'); mark('counterparty edit');
    // ---- contract
    const body = { mwf_name: `${PREFIX} contract`, mwf_contracttype: T.Maintenance, mwf_direction: DIR.Expense, mwf_value: 1000, 'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${P.cp || '<id>'})`, 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${usd})` };
    const ct = must(await write('POST', 'mwf_contracts?$select=mwf_contractnumber', body, { Prefer: 'return=representation' }), 'contract create'); mark('contract create');
    P.contract = ct.j?.mwf_contractid;
    if (!DRY) printHandoff(snap);
    const patch = async (b, label) => { must(await write('PATCH', `mwf_contracts(${P.contract || '<id>'})`, b, { 'If-Match': '*' }), label); mark(label); };
    await patch({ mwf_name: `${PREFIX} contract edited` }, 'contract edit name');
    await patch({ mwf_value: 25000 }, 'contract edit value');
    await patch({ statuscode: 867640000 }, 'contract submit');
    if (!DRY) { await sleep(3000); P.steps = (await get(`mwf_approvalsteps?$select=mwf_steporder&$filter=_mwf_contract_value eq ${P.contract}`)).value.map((s) => s.mwf_approvalstepid); }
    await patch({ statuscode: 1 }, 'contract withdraw');
    // ---- configuration rows (restored in the finally block too)
    P.matrix = M; P.assignment = A;
    must(await write('PATCH', `mwf_approvalmatrixes(${M.id})`, { mwf_rulename: M.edited }, { 'If-Match': '*' }), 'matrix rename'); mark('matrix rename');
    must(await write('PATCH', `mwf_approvalmatrixes(${M.id})`, { mwf_rulename: M.orig }, { 'If-Match': '*' }), 'matrix restore'); mark('matrix restore'); P.matrixRestored = true;
    must(await write('PATCH', `mwf_approverassignments(${A.id})`, { mwf_name: A.edited }, { 'If-Match': '*' }), 'assignment rename'); mark('assignment rename');
    must(await write('PATCH', `mwf_approverassignments(${A.id})`, { mwf_name: A.orig }, { 'If-Match': '*' }), 'assignment restore'); mark('assignment restore'); P.assignmentRestored = true;
    if (DRY) { console.log('\nDRY-RUN: the waits, the history reads and the deletes are not shown further; nothing was sent.'); return; }

    // ---- wait for the rows of the first phase, then read
    const ids1 = [P.cp, P.contract, M.id, A.id, ...(P.steps || [])];
    const exp1 = [{ objectid: P.cp, operation: 1, label: 'counterparty' }, { objectid: P.cp, operation: 2, label: 'counterparty' }, { objectid: P.contract, operation: 1, label: 'contract' }, { objectid: P.contract, operation: 2, label: 'contract' },
      { objectid: M.id, operation: 2, min: 2, label: 'matrix' }, { objectid: A.id, operation: 2, min: 2, label: 'assignment' }];
    console.log(`\nWaiting for the audit rows (poll every ${POLL_MS / 1000} s, at most ${MAX_WAIT_MS / 60000} minutes, until quiet for ${QUIET_MS / 1000} s)...`);
    const p1 = await pollAudits(ids1, exp1, 'phase 1');
    check('rows', 'every expected audit row of phase 1 appeared (counterparty create and edit, contract create and update, 2 matrix updates, 2 assignment updates)', p1.unmet.length === 0, `${p1.why}; ${p1.unmet.join('; ') || 'none missing'}`);

    // ---- what each change shows
    const need = async (id, col, o, n, label) => { const r = await findChange(id, col, o, n); out('what', r ? 'PASS' : 'FAIL', label, r ? `${operationName(r.operation)} row, ${actionName(r.action)}, by ${who(r)}` : 'no audit row shows this change'); return r; };
    await need(P.cp, 'mwf_name', `${PREFIX} counterparty`, `${PREFIX} counterparty edited`, 'counterparty edit: mwf_name old to new');
    await need(P.contract, 'mwf_name', `${PREFIX} contract`, `${PREFIX} contract edited`, 'contract edit: mwf_name old to new');
    await need(P.contract, 'mwf_value', 1000, 25000, 'contract edit: mwf_value 1,000 to 25,000');
    const st = await need(P.contract, 'statuscode', 1, 867640000, 'contract submit: statuscode Draft to Pending');
    const rd = await need(P.contract, 'mwf_approvalround', undefined, 1, 'plug-in change: mwf_approvalround written (empty to 1)');
    const fz = await need(P.contract, 'mwf_valueusdfrozen', undefined, 25000, 'plug-in change: mwf_valueusdfrozen written (empty to 25,000)');
    await need(P.contract, 'statuscode', 867640000, 1, 'contract withdraw: statuscode Pending to Draft');
    await need(M.id, 'mwf_rulename', M.orig, M.edited, 'matrix row: rulename old to new');
    await need(M.id, 'mwf_rulename', M.edited, M.orig, 'matrix row: rulename restored');
    await need(A.id, 'mwf_name', A.orig, A.edited, 'assignment row: name old to new');
    await need(A.id, 'mwf_name', A.edited, A.orig, 'assignment row: name restored');
    if (st && rd && fz) out('plugin', 'OBS', 'the plug-in changes (round, frozen USD) are in the SAME audit row as the status change', String(st.auditid === rd.auditid && rd.auditid === fz.auditid));
    if (rd) out('plugin', 'OBS', 'the audit row that shows the plug-in change was made by', who(rd));
    // ---- who
    for (const [label, id] of [['counterparty', P.cp], ['contract', P.contract], ['matrix row', M.id], ['assignment row', A.id]]) {
      const rs = rowsFor(id); check('who', `${label}: every audit row so far was made by the admin account`, rs.length > 0 && rs.every((r) => who(r) === 'admin'), rs.map((r) => `${operationName(r.operation)}:${who(r)}`).join(' '));
    }
    const stepRows = (P.steps || []).flatMap((s) => rowsFor(s));
    out('steps', stepRows.length ? 'PASS' : 'OBS', 'the steps created by the plug-in (SYSTEM service) have audit rows', `${stepRows.length} row(s): ${stepRows.map((r) => `${operationName(r.operation)}:${who(r)}`).join(' ') || 'none'}`);
    // ---- the two read paths
    const hist = await get(changeHistoryPath('mwf_contracts', P.contract));
    const nDet = hist.AuditDetailCollection?.AuditDetails?.length; const nRows = rowsFor(P.contract).length;
    out('history', nDet ? 'PASS' : 'FAIL', 'RetrieveRecordChangeHistory returns the contract history', `${nDet} detail(s) against ${nRows} audit row(s) of the contract; Learn: its Web API result carries no AuditRecord (who/when), so the audits table is used for that`);
    out('history', 'OBS', 'the details returned include a name change', String((hist.AuditDetailCollection?.AuditDetails || []).some((d) => (changesOf(d).mwf_name || {}).new === `${PREFIX} contract edited`)));

    // ---- deletes, then the delete rows
    must(await write('DELETE', `mwf_contracts(${P.contract})`), 'contract delete'); mark('contract delete'); P.contractDeleted = true;
    must(await write('DELETE', `mwf_counterparties(${P.cp})`), 'counterparty delete'); mark('counterparty delete'); P.cpDeleted = true;
    const exp2 = [{ objectid: P.contract, operation: 3, label: 'contract' }, { objectid: P.cp, operation: 3, label: 'counterparty' }];
    const p2 = await pollAudits(ids1, exp2, 'phase 2');
    check('rows', 'the Delete audit rows of the contract and of the counterparty appeared', p2.unmet.length === 0, `${p2.why}; ${p2.unmet.join('; ') || 'none missing'}`);
    const delSteps = (P.steps || []).flatMap((s) => rowsFor(s).filter((r) => r.operation === 3));
    out('steps', 'OBS', 'the steps deleted by the cascade have Delete audit rows', `${delSteps.length} of ${(P.steps || []).length}; by ${delSteps.map(who).join(',') || '-'}`);
    for (const id of [P.contract, P.cp]) { const d = rowsFor(id).find((r) => r.operation === 3); out('who', d ? (who(d) === 'admin' ? 'PASS' : 'FAIL') : 'FAIL', `delete row of ${id === P.contract ? 'the contract' : 'the counterparty'} was made by the admin account`, d ? who(d) : 'no delete row'); }
    // ---- timing and volume
    const lags = [...seen.entries()].map(([id, ms]) => Math.max(0, Math.round((ms - Date.parse(allRows.get(id).createdon)) / 1000)));
    const ls = lagStats(lags); out('lag', 'OBS', 'the real delay between an operation (audit createdon) and the moment the poll first saw its row', ls ? `${ls.count} rows: min ${ls.min} s, median ${ls.median} s, max ${ls.max} s (polling every ${POLL_MS / 1000} s, so the figures are rounded up to that)` : 'no rows');
    const auditsAfter = await count('audits');
    out('volume', 'OBS', 'audit rows written in the whole environment during the test (ours included)', `${auditsAfter - auditsBefore} (ours: ${allRows.size}); the rest comes from the platform tables that are audited by default`);
    console.log('\nRows seen, in order:'); for (const r of describeRows([...allRows.values()])) console.log(`  ${r.at.slice(11, 19)}Z ${r.operation.padEnd(6)} ${r.action.padEnd(8)} ${[...allRows.values()].find((x) => x.auditid === r.id).objecttypecode.padEnd(24)} by ${who({ _userid_value: r.userid })}${r.callinguserid ? ' (impersonation: calling user set)' : ''}`);
  } finally {
    enterCleanupPhase();
    await restoreConfigRows(P);
    await cleanupRows();
    const rs = await restoreAfterRun(S.ctr, snap);
    const c = await checkClean();
    check('D', 'check-clean: no TEST-TMP-AUD rows, no renamed matrix or assignment row, 11 contracts, 0 steps, 110 matrix rows, 5 assignments, counters restored', c.a === 0 && c.b === 0 && c.mx === 0 && c.as === 0 && c.total === 11 && c.steps === 0 && c.m === 110 && c.asg === 5 && rs.refused === 0, `refused ${rs.refused}`);
  }
}

/** Puts the two configuration rows back, always, with a read-back; a restore that cannot be confirmed is reported at once. */
async function restoreConfigRows(P) {
  for (const [set, key, nameCol, rec] of [['mwf_approvalmatrixes', 'mwf_approvalmatrixid', 'mwf_rulename', P?.matrix], ['mwf_approverassignments', 'mwf_approverassignmentid', 'mwf_name', P?.assignment]]) {
    if (!rec) continue;
    const now = (await S.call('GET', `${set}(${rec.id})?$select=${nameCol}`)).j;
    if (now && now[nameCol] !== rec.orig) {
      const r = await S.call('PATCH', `${set}(${rec.id})`, { [nameCol]: rec.orig }, { 'If-Match': '*' });   // one attempt
      const back = (await S.call('GET', `${set}(${rec.id})?$select=${nameCol}`)).j;
      if (back?.[nameCol] !== rec.orig) { console.error(`STATE UNKNOWN: the ${set} row could not be confirmed restored (PATCH HTTP ${r.status}). Restore its original name by hand NOW (it carries the suffix ${PREFIX}).`); process.exit(5); }
      console.log(`INFO  restored the original name of a ${set} row (read back)`);
    }
  }
}
async function cleanupRows() {
  const rows = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value;
  const del = await deleteContracts(S.io, rows.map((r) => r.mwf_contractid));
  console.log(`INFO  cleanup: ${rows.length} contract row(s) found, ${del.deleted} deleted, ${del.failed.length} failed`);
  for (const x of (await get(`mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value) { const d = await S.call('DELETE', `mwf_counterparties(${x.mwf_counterpartyid})`); console.log(`INFO  cleanup: counterparty delete HTTP ${d.status}`); }
}
async function cleanupOnly() {
  enterCleanupPhase();
  for (const [set, nameCol, key] of [['mwf_approvalmatrixes', 'mwf_rulename', 'mwf_approvalmatrixid'], ['mwf_approverassignments', 'mwf_name', 'mwf_approverassignmentid']]) {
    for (const r of (await get(`${set}?$select=${nameCol}&$filter=${q(`contains(${nameCol},' ${PREFIX}')`)}`)).value) {
      const orig = r[nameCol].replace(` ${PREFIX}`, '');
      const p = await S.call('PATCH', `${set}(${r[key]})`, { [nameCol]: orig }, { 'If-Match': '*' }); console.log(`INFO  cleanup: restored the name of a ${set} row, HTTP ${p.status}`);
    }
  }
  await cleanupRows();
  await restoreFromArgs(S.ctr);
  await checkClean();
}

(async () => {
  try {
    S = await openSession({ env: ENV, auth: AUTH });
    const raw = S.call; S.call = async (m, p, b, x) => { const r = await raw(m, p, b, x); trackCreate(m, p, b, r.ok); return r; };
    S.ctr = ctrIo(S.call);
    await requireStableConnection(raw);
    if (MODE === 'cleanup') await cleanupOnly(); else await run();
    const bad = results.filter((r) => r.status === 'FAIL').length;
    console.log(`\nSUMMARY: ${results.filter((r) => r.status === 'PASS').length} PASS, ${bad} FAIL, ${results.filter((r) => r.status === 'OBS').length} OBS.`);
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    if (MODE === 'run') console.error('Read the state; clean up with: node scripts/test-auditing.mjs --mode=cleanup --env=<url> --auth=az --confirm-mutates-environment --counters-before=... --counters-consumed=...  (the values are printed after the contract is created)');
    process.exit(4);
  }
})();
