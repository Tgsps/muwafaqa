#!/usr/bin/env node
/**
 * Integration tests of the Contract State Guard (ADR-004), through the Dataverse Web API.
 * FICTIONAL TEST-TMP-GUARD-* rows only. The approval flow must be OFF while this runs.
 *
 * Modes:
 *   --mode=integration  groups 1 to 8, then three rows for the user to try in the app (TEST-TMP-GUARD-UI A/B/C),
 *                       then the cleanup of every other TEST-TMP-GUARD row. Needs --confirm-mutates-environment.
 *                       Add --skip-ui-rows to create no UI rows (then everything is cleaned, counterparties included).
 *                       The approval flow must be OFF: the state is read first and the run stops if it is ON
 *                       (or cannot be read; after checking by hand add --flow-off-confirmed).
 *   --mode=cleanup      removes TEST-TMP-GUARD rows. Add --include-ui to remove the UI rows too.
 *   --mode=check-clean  read only. Lists what remains with the prefix.
 *
 * Usage:
 *   node scripts/test-state-guard.mjs --mode=integration --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment [--auth=device|az]
 *
 * An unexpected error stops the run (no blind retry). A failed expectation is recorded as FAIL and the run goes on.
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
import { execSync } from 'node:child_process';
import { deleteContract, requireFlowOff } from './lib/contract-cleanup.mjs';
import { ctrIo, trackCreate, snapshotCounters, restoreAfterRun, restoreFromArgs, printHandoff, requireStableConnection } from './lib/counter-snapshot.mjs';
import { resilientFetch, enterCleanupPhase, recheckAfterWait } from './lib/resilient-fetch.mjs';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const MODE = argOf('mode');
const ENV = argOf('env').replace(/\/+$/, '');
const AUTH = argOf('auth') || 'device';
const INCLUDE_UI = process.argv.includes('--include-ui');
const SKIP_UI_ROWS = process.argv.includes('--skip-ui-rows');
const FLOW_OFF_CONFIRMED = process.argv.includes('--flow-off-confirmed');
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id, same as the other scripts
const PREFIX = 'TEST-TMP-GUARD';
const UI_PREFIX = 'TEST-TMP-GUARD-UI';
const GUARD_DELETE_STEP = 'Muwafaqa.Plugins.Contract.ContractStateGuard: Delete of mwf_contract';

if (!['integration', 'cleanup', 'check-clean'].includes(MODE)) { console.error('Missing or invalid --mode=integration|cleanup|check-clean. Nothing was run.'); process.exit(2); }
if (!/^https:\/\/[^/]+$/.test(ENV)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
if (!['device', 'az'].includes(AUTH)) { console.error('Invalid --auth=device|az. Nothing was run.'); process.exit(2); }
if (MODE !== 'check-clean' && !process.argv.includes('--confirm-mutates-environment')) {
  console.error(`WARNING: --mode=${MODE} creates, updates and deletes ${PREFIX}-* rows. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
  process.exit(2);
}

const API = `${ENV}/api/data/v9.2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noGuid = (t) => String(t ?? '').replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>');
const q = encodeURIComponent;
const ST = { Draft: 1, Pending: 867640000, InForce: 867640001, Rejected: 2 };
const NAME = { 1: 'Draft', 867640000: 'Pending', 867640001: 'In Force', 2: 'Rejected' };
let TOKEN;

async function form(url, f) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = null; }
  return { ok: r.ok, status: r.status, j, t };
}
async function deviceToken() {
  const base = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
  const dc = await form(`${base}/devicecode`, { client_id: CLIENT_ID, scope: `${ENV}/.default` });
  if (!dc.ok) throw new Error(`Device code request failed (HTTP ${dc.status}):\n${noGuid(dc.t)}`);
  console.log(`\nSIGN-IN URL : ${dc.j.verification_uri}\nDEVICE CODE : ${dc.j.user_code}\n(single use, ${Math.round(dc.j.expires_in / 60)} min). Waiting for sign-in...\n`);
  let iv = (dc.j.interval ?? 5) * 1000; const end = Date.now() + dc.j.expires_in * 1000;
  while (Date.now() < end) {
    await sleep(iv);
    const t = await form(`${base}/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, device_code: dc.j.device_code });
    if (t.ok) return t.j.access_token;
    const e = t.j?.error;
    if (e === 'authorization_pending') continue;
    if (e === 'slow_down') { iv += 5000; continue; }
    throw new Error(`Token request failed (HTTP ${t.status}):\n${noGuid(t.t).slice(0, 600)}`);
  }
  throw new Error('Device code expired. Rerun for a new code.');
}

const hdr = (extra = {}) => ({ Authorization: `Bearer ${TOKEN}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Content-Type': 'application/json; charset=utf-8', ...extra });
async function call(method, path, body, extra = {}) {
  const r = await resilientFetch(`${API}/${path}`, { method, headers: hdr(extra), body: body === undefined ? undefined : JSON.stringify(body) });   // GET retried on network errors only (scripts/lib/resilient-fetch.mjs)
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { /* not json */ }
  const m = /\(([0-9a-fA-F-]{36})\)/.exec(r.headers.get('OData-EntityId') || '');
  trackCreate(method, path, body, r.ok);   // counts committed contract creates (counter helper, ADR-006)
  return { ok: r.ok, status: r.status, j, text: t, id: m ? m[1] : null };
}
class Unexpected extends Error {}
async function must(method, path, body, extra) {
  const r = await call(method, path, body, extra);
  if (!r.ok) throw new Unexpected(`${method} ${noGuid(path).slice(0, 90)} failed HTTP ${r.status}\n${noGuid(r.text).slice(0, 600)}`);
  return r;
}
const msgOf = (r) => noGuid((r.j?.error?.message || (r.ok ? '' : r.text) || '')).replace(/\s+/g, ' ').trim();
const clip = (s, n = 200) => (s.length > n ? `${s.slice(0, n)}...` : s);

// ------------------------------------------------------------------ results
const rec = []; // {group, label, status: PASS|FAIL|OBS}
let group = '';
function out(status, label, req, http, msg, expected, extra = '') {
  rec.push({ group, label, status });
  console.log(`${status.padEnd(4)} [${group}] ${label}\n       request : ${req}\n       HTTP    : ${http}${msg ? `   message: ${clip(msg)}` : ''}\n       expected: ${expected}${extra ? `\n       ${extra}` : ''}`);
}

// ------------------------------------------------------------------ fixtures
const FX = { cp: {}, cur: {}, T: [], D: [], stepId: null, bypassWorks: false, uiRows: [] };
const SEL = 'mwf_name,mwf_contractnumber,mwf_value,mwf_valueusdfrozen,statecode,statuscode,mwf_contracttype,mwf_direction,_mwf_counterpartyid_value,_transactioncurrencyid_value';
const strip = (j) => { const o = {}; for (const k of Object.keys(j)) if (!k.startsWith('@')) o[k] = j[k]; return o; };
async function snap(id) { return strip((await must('GET', `mwf_contracts(${id})?$select=${SEL}`)).j); }
const exists = async (id) => (await call('GET', `mwf_contracts(${id})?$select=mwf_contractid`)).status === 200;

async function options(table, col) {
  const a = await must('GET', `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${col}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`);
  return a.j.OptionSet.Options.map((o) => o.Value);
}
async function setup() {
  const cs = (await must('GET', `transactioncurrencies?$select=isocurrencycode&$filter=statecode eq 0`)).j.value;
  for (const c of cs) FX.cur[c.isocurrencycode] = c.transactioncurrencyid;
  FX.T = await options('mwf_contract', 'mwf_contracttype');
  FX.D = await options('mwf_contract', 'mwf_direction');
  const cpType = (await options('mwf_counterparty', 'mwf_counterpartytype'))[0];
  for (const k of ['A', 'B']) {
    const r = await must('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} Fictional Counterparty ${k}${k === 'A' ? ' (keep for the UI rows)' : ' (delete me)'}`, mwf_counterpartytype: cpType });
    FX.cp[k] = r.id;
  }
  const st = (await must('GET', `sdkmessageprocessingsteps?$filter=name eq '${GUARD_DELETE_STEP}'&$select=name`)).j.value;
  if (st.length !== 1) throw new Unexpected(`guard Delete step: expected 1, found ${st.length}`);
  FX.stepId = st[0].sdkmessageprocessingstepid;
}

async function mk(key, o = {}) {
  const body = {
    mwf_name: o.name || `${PREFIX} ${key}`,
    mwf_contracttype: FX.T[0], mwf_direction: FX.D[0],
    'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${FX.cp.A})`,
    'transactioncurrencyid@odata.bind': `/transactioncurrencies(${FX.cur.USD})`,
    mwf_value: o.value ?? 1000,
  };
  const r = await call('POST', 'mwf_contracts', body);
  if (!r.ok) throw new Unexpected(`setup: create ${key} failed HTTP ${r.status}\n${msgOf(r).slice(0, 400)}`);
  return r.id;
}
const patch = (id, body, extra = {}) => call('PATCH', `mwf_contracts(${id})`, body, { 'If-Match': '*', ...extra });
async function go(id, body, what) {          // a setup transition that MUST work
  const r = await patch(id, body);
  if (!r.ok) throw new Unexpected(`setup: ${what} failed HTTP ${r.status}\n${msgOf(r).slice(0, 400)}`);
}
const toPending = (id) => go(id, { statuscode: ST.Pending }, 'Draft -> Pending');
const toRejected = (id) => go(id, { statecode: 1, statuscode: ST.Rejected }, 'Pending -> Rejected');
const toInForce = (id) => go(id, { statuscode: ST.InForce }, 'Pending -> In Force');
const toDraft = (id) => go(id, { statuscode: ST.Draft }, 'Pending -> Draft');

// ------------------------------------------------------------------ assertions
/** expect: 'ok' | '400' | 'observe'. For '400' the row must be unchanged. */
async function attempt(label, id, body, expect, opts = {}) {
  const before = await snap(id);
  const r = await patch(id, body);
  const after = await snap(id);
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const msg = msgOf(r);
  const req = `PATCH ${JSON.stringify(body)}`;
  const http = r.status;
  const guardMsg = /^Cannot /.test(msg);
  if (expect === 'observe') {
    out('OBS', label, req, http, msg, opts.expected || 'observation only', `row after: statecode ${after.statecode}, statuscode ${after.statuscode} (${NAME[after.statuscode] || '?'}), contract number ${JSON.stringify(after.mwf_contractnumber)}`);
    return { r, after };
  }
  if (expect === '400') {
    const pass = r.status === 400 && unchanged && (!opts.mustSay || msg.includes(opts.mustSay));
    out(pass ? 'PASS' : 'FAIL', label, req, http, msg, `HTTP 400, row unchanged${opts.mustSay ? `, message contains "${opts.mustSay}"` : ''}`, `row unchanged: ${unchanged ? 'yes' : 'NO'}; guard message: ${guardMsg ? 'yes' : 'no'}`);
    return { r, after };
  }
  let pass = r.ok;
  let extra = '';
  if (pass && opts.verify) { const e = opts.verify(after); if (e) { pass = false; extra = e; } }
  if (!pass && !r.ok && !guardMsg && opts.platformMayBlock) {
    out('OBS', label, req, http, msg, 'HTTP 204 (the platform itself may block writes on this row)', 'platform behavior, not a guard message');
    return { r, after };
  }
  out(pass ? 'PASS' : 'FAIL', label, req, http, msg, opts.expected || 'HTTP 204', extra || `guard message: ${guardMsg ? 'yes' : 'no'}`);
  return { r, after };
}

async function deleteCase(label, id, expect, opts = {}) {
  const r = await call('DELETE', `mwf_contracts(${id})`, undefined, opts.headers || {});
  const still = await exists(id);
  const msg = msgOf(r);
  const pass = expect === 'ok' ? (r.ok && !still) : (r.status === 400 && still);
  out(pass ? 'PASS' : 'FAIL', label, `DELETE${opts.headers ? ' with the bypass header' : ''}`, r.status, msg,
    expect === 'ok' ? 'HTTP 204 and the row is gone' : 'HTTP 400 and the row still exists', `row exists after: ${still ? 'yes' : 'no'}`);
  return { r, still };
}

// ------------------------------------------------------------------ groups
async function g1() {
  group = '1 transitions';
  // X: Draft -> Pending -> (same) -> Draft -> Pending -> Rejected -> (negatives) -> Draft
  const x = await mk('G1-X');
  await attempt('Draft -> Rejected {statecode 1, statuscode Rejected}', x, { statecode: 1, statuscode: ST.Rejected }, '400', { mustSay: 'from Draft to Rejected' });
  await attempt('Draft -> In Force', x, { statuscode: ST.InForce }, '400', { mustSay: 'from Draft to In Force' });
  await attempt('Draft -> Pending', x, { statuscode: ST.Pending }, 'ok');
  await attempt('Pending -> Pending (same status)', x, { statuscode: ST.Pending }, 'ok');
  await attempt('Pending -> Draft', x, { statuscode: ST.Draft }, 'ok');
  await attempt('Draft -> Pending (again)', x, { statuscode: ST.Pending }, 'ok');
  await attempt('Pending -> Rejected {statecode 1, statuscode Rejected}', x, { statecode: 1, statuscode: ST.Rejected }, 'ok');
  await attempt('Rejected -> Pending (decision Q1)', x, { statecode: 0, statuscode: ST.Pending }, '400', { mustSay: 'from Rejected to Pending' });
  await attempt('Rejected -> In Force', x, { statecode: 0, statuscode: ST.InForce }, '400', { mustSay: 'from Rejected to In Force' });
  await attempt('Rejected -> Draft {statecode 0, statuscode Draft}', x, { statecode: 0, statuscode: ST.Draft }, 'ok');
  // Y: Pending -> In Force, then every way out is rejected
  const y = await mk('G1-Y');
  await toPending(y);
  await attempt('Pending -> In Force', y, { statuscode: ST.InForce }, 'ok');
  await attempt('In Force -> Draft', y, { statuscode: ST.Draft }, '400', { mustSay: 'In Force is final' });
  await attempt('In Force -> Pending', y, { statuscode: ST.Pending }, '400', { mustSay: 'In Force is final' });
  await attempt('In Force -> Rejected {statuscode only}', y, { statuscode: ST.Rejected }, '400', { mustSay: 'In Force is final' });
  await attempt('In Force -> Rejected {statecode 1, statuscode Rejected}', y, { statecode: 1, statuscode: ST.Rejected }, '400', { mustSay: 'In Force is final' });
  await attempt('In Force + {statecode 1} alone', y, { statecode: 1 }, '400');
  await attempt('In Force + {statecode 0} alone', y, { statecode: 0 }, '400');
  // Z: Activate-like request from Rejected
  const z = await mk('G1-Z');
  await toPending(z); await toRejected(z);
  await attempt('Rejected -> Draft with {statecode 0} ALONE (what Activate may send)', z, { statecode: 0 }, 'observe',
    { expected: 'allowed by the guard (state alone = Draft). Report the resulting status' });
}

async function createAttempt(label, body, expect, mustSay) {
  const r = await call('POST', 'mwf_contracts', body);
  const found = (await must('GET', `mwf_contracts?$select=mwf_contractid,statuscode,statecode&$filter=${q(`mwf_name eq '${body.mwf_name}'`)}`)).j.value;
  const msg = msgOf(r);
  let pass;
  if (expect === 'ok') pass = r.ok && found.length === 1;
  else pass = r.status === 400 && found.length === 0 && (!mustSay || msg.includes(mustSay));
  const st = found[0] ? `status ${found[0].statuscode} (${NAME[found[0].statuscode] || '?'}), state ${found[0].statecode}` : 'no row created';
  out(pass ? 'PASS' : 'FAIL', label, `POST ${JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => !k.includes('@odata') && k !== 'mwf_contracttype' && k !== 'mwf_direction')))}`,
    r.status, msg, expect === 'ok' ? 'HTTP 204 and the row exists' : `HTTP 400 and no row created${mustSay ? `, message contains "${mustSay}"` : ''}`, st);
  return found[0];
}
function createBody(key, extra = {}) {
  return {
    mwf_name: `${PREFIX} ${key}`, mwf_contracttype: FX.T[0], mwf_direction: FX.D[0],
    'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${FX.cp.A})`,
    'transactioncurrencyid@odata.bind': `/transactioncurrencies(${FX.cur.USD})`, mwf_value: 1000, ...extra,
  };
}
async function g2() {
  group = '2 create';
  await createAttempt('Create without a status (Draft)', createBody('G2-DRAFT'), 'ok');
  // CHANGED 2026-10-22 on purpose (ADR-004 update, option b): a Create as Pending Approval is now REJECTED by the guard. It used to be accepted
  // and this test then checked that plug-in 1 wrote the frozen value; that second check is replaced by "no counter moved by the rejected create".
  const ctrBefore = await snapshotCounters(ctr);
  await createAttempt('Create as Pending (with currency and Value): rejected since 2026-10-22', createBody('G2-PEND', { statuscode: ST.Pending }), '400', 'A contract must be created as Draft; submit it for approval afterwards.');
  const ctrAfter = await snapshotCounters(ctr);
  const moved = Object.keys(ctrBefore.byType).filter((t) => ctrBefore.byType[t].last !== ctrAfter.byType[t].last);
  out(moved.length === 0 ? 'PASS' : 'FAIL', 'Create as Pending: the rejected create did not move any counter', 'GET the five counters before and after', 200, '', 'all counters unchanged', `${moved.length} counter(s) moved`);
  await createAttempt('Create with an explicit statuscode Draft (new 2026-10-22)', createBody('G2-DRAFT2', { statuscode: ST.Draft }), 'ok');
  await createAttempt('Create as In Force', createBody('G2-INF', { statuscode: ST.InForce }), '400', 'Cannot create a contract with status In Force');
  await createAttempt('Create as Rejected {statuscode only}', createBody('G2-REJ', { statuscode: ST.Rejected }), '400', 'Cannot create a contract with status Rejected');
  // statecode 1 on create: report what the platform does (not a PASS/FAIL expectation)
  {
    const body = createBody('G2-ST1', { statecode: 1 });
    const r = await call('POST', 'mwf_contracts', body);
    const f = (await must('GET', `mwf_contracts?$select=statuscode,statecode&$filter=${q(`mwf_name eq '${PREFIX} G2-ST1'`)}`)).j.value[0];
    out('OBS', 'Create with {statecode 1} and no statuscode', 'POST {statecode: 1, ...}', r.status, msgOf(r),
      'observation only (the guard reads state 1 as Rejected, so a rejection is expected)', f ? `row created: statecode ${f.statecode}, statuscode ${f.statuscode} (${NAME[f.statuscode] || '?'})` : 'no row created');
  }
  await createAttempt('Create with a non-null mwf_valueusdfrozen', createBody('G2-FRZ', { mwf_valueusdfrozen: 5 }), '400', 'Value (USD, Frozen) cannot be changed');
}

const COLUMNS = [
  { key: 'Value', display: 'Value', other: () => ({ mwf_value: 2000 }), same: () => ({ mwf_value: 1000 }) },
  { key: 'Currency', display: 'Currency', other: () => ({ 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${FX.cur.KWD})` }), same: () => ({ 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${FX.cur.USD})` }) },
  { key: 'Contract Direction', display: 'Contract Direction', other: () => ({ mwf_direction: FX.D[1] }), same: () => ({ mwf_direction: FX.D[0] }) },
  { key: 'Counterparty', display: 'Counterparty', other: () => ({ 'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${FX.cp.B})` }), same: () => ({ 'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${FX.cp.A})` }) },
  // Contract Type (set once) and Contract Number (system-written) are tested by scripts/test-contract-number.mjs (ADR-006)
];

async function lockedRow(label, key, toState) {
  const id = await mk(key);
  if (toState === 'Pending') await toPending(id);
  if (toState === 'In Force') { await toPending(id); await toInForce(id); }
  if (toState === 'Rejected') { await toPending(id); await toRejected(id); }
  return id;
}
async function g3() {
  group = '3 locked columns';
  FX.lock = {};
  for (const state of ['Pending', 'In Force', 'Rejected']) {
    const id = await lockedRow(state, `G3-${state.replace(' ', '')}`, state);
    FX.lock[state] = id;
    for (const c of COLUMNS) {
      await attempt(`${state}: ${c.key} DIFFERENT value`, id, c.other(), '400', { mustSay: `Cannot change ${c.display}` });
      await attempt(`${state}: ${c.key} IDENTICAL value`, id, c.same(), 'ok', { platformMayBlock: state === 'Rejected', expected: 'HTTP 204 (no-op)' });
    }
    await attempt(`${state}: mwf_valueusdfrozen different value`, id, { mwf_valueusdfrozen: 5 }, '400', { mustSay: 'Value (USD, Frozen) cannot be changed' });
    await attempt(`${state}: Subject`, id, { mwf_name: `${PREFIX} G3 ${state} renamed` }, 'ok', { platformMayBlock: state === 'Rejected' });
  }
  // Draft: every column is editable, the frozen one is not, the Subject is editable
  const d = await mk('G3-Draft');
  FX.lock.Draft = d;
  for (const c of COLUMNS) {
    await attempt(`Draft: ${c.key} DIFFERENT value`, d, c.other(), 'ok', { expected: 'HTTP 204 (Draft is editable)' });
  }
  await attempt('Draft: mwf_valueusdfrozen different value', d, { mwf_valueusdfrozen: 5 }, '400', { mustSay: 'Value (USD, Frozen) cannot be changed' });
  await attempt('Draft: Subject', d, { mwf_name: `${PREFIX} G3 Draft renamed` }, 'ok');
}

async function g4() {
  group = '4 combined requests';
  const d = await mk('G4-D', { value: 1000 });
  await attempt('Draft: ONE PATCH {mwf_value 3000, statuscode Pending}', d, { mwf_value: 3000, statuscode: ST.Pending }, 'ok', {
    expected: 'HTTP 204 and mwf_valueusdfrozen 3000.00 (the NEW value)',
    verify: (a) => (Number(a.mwf_valueusdfrozen).toFixed(2) === '3000.00' && a.statuscode === ST.Pending ? null : `frozen ${a.mwf_valueusdfrozen}, status ${a.statuscode}`),
  });
  const p = await mk('G4-P', { value: 1000 });
  await toPending(p);
  await attempt('Pending: ONE PATCH {mwf_value 4000, statuscode Draft}', p, { mwf_value: 4000, statuscode: ST.Draft }, '400', { mustSay: 'Cannot change Value' });
  const a = await snap(p);
  out(a.statuscode === ST.Pending && Number(a.mwf_value) === 1000 ? 'PASS' : 'FAIL', 'Pending row after the rejected combined request', 'GET the row', 200, '',
    'status still Pending and Value still 1000', `status ${a.statuscode}, Value ${a.mwf_value}, frozen ${a.mwf_valueusdfrozen}`);
}

async function g5() {
  group = '5 delete';
  await deleteCase('Draft', FX.lock.Draft, 'ok');
  await deleteCase('Rejected', FX.lock.Rejected, 'ok');
  await deleteCase('Pending', FX.lock.Pending, '400');
  await toDraft(FX.lock.Pending);
  await deleteCase('Pending -> PATCH to Draft -> DELETE', FX.lock.Pending, 'ok');
  await deleteCase('In Force', FX.lock['In Force'], '400');   // this row stays for the bypass test
}

async function g6() {
  group = '6 plug-in 1 regression';
  const c1 = await mk('G6-C1', { value: 500 });
  await attempt('case 1: Draft Value 500, ONE PATCH {Value 1000, Pending}', c1, { mwf_value: 1000, statuscode: ST.Pending }, 'ok', {
    expected: 'frozen 1000.00', verify: (a) => (Number(a.mwf_valueusdfrozen).toFixed(2) === '1000.00' ? null : `frozen ${a.mwf_valueusdfrozen}`) });
  const c7 = await mk('G6-C7', { value: 1000 });
  await toPending(c7);
  await attempt('case 7: Pending -> Draft', c7, { statuscode: ST.Draft }, 'ok');
  await attempt('case 7: edit Value 2500 in Draft', c7, { mwf_value: 2500 }, 'ok');
  await attempt('case 7: Draft -> Pending', c7, { statuscode: ST.Pending }, 'ok', {
    expected: 'frozen becomes 2500.00', verify: (a) => (Number(a.mwf_valueusdfrozen).toFixed(2) === '2500.00' ? null : `frozen ${a.mwf_valueusdfrozen}`) });
  const c8 = await mk('G6-C8', { value: 1000 });
  await toPending(c8);
  await attempt('case 8: edit Value 3000 while Pending (now rejected by the guard)', c8, { mwf_value: 3000 }, '400', { mustSay: 'Cannot change Value' });
  const a8 = await snap(c8);
  out(Number(a8.mwf_valueusdfrozen).toFixed(2) === '1000.00' && Number(a8.mwf_value) === 1000 ? 'PASS' : 'FAIL', 'case 8: frozen value and Value after the rejection', 'GET the row', 200, '', 'frozen 1000.00 and Value 1000', `frozen ${a8.mwf_valueusdfrozen}, Value ${a8.mwf_value}`);
  const c2 = await mk('G6-C2', { value: 1000 });
  await toPending(c2); await toRejected(c2);
  await attempt('case 2 (old): Rejected -> Pending (now rejected by design)', c2, { statecode: 0, statuscode: ST.Pending }, '400', { mustSay: 'from Rejected to Pending' });
}

async function g7() {
  group = '7 observations';
  const p = await mk('G7-P');
  await toPending(p);
  await attempt('Pending row (it has a generated number): PATCH mwf_contractnumber ""', p, { mwf_contractnumber: '' }, 'observe',
    { expected: 'observation only (the number is system-written since ADR-006: a rejection is expected)' });
  const d = await mk('G7-D');
  await attempt('Draft row (it has a generated number): PATCH mwf_contractnumber ""', d, { mwf_contractnumber: '' }, 'observe',
    { expected: 'observation only (the number is system-written since ADR-006: a rejection is expected, in Draft too)' });
}

async function g8() {
  group = '8 bypass';
  const id = FX.lock['In Force'];
  const r = await deleteCase('DELETE an In Force row with MSCRM.BypassBusinessLogicExecutionStepIds = the guard Delete step', id, 'ok',
    { headers: { 'MSCRM.BypassBusinessLogicExecutionStepIds': FX.stepId } });
  FX.bypassWorks = r.r.ok && !r.still;
  console.log(`       bypass works: ${FX.bypassWorks ? 'YES' : 'NO'}`);
}

async function uiRows() {
  group = 'UI rows';
  const mkUi = async (letter, text) => mk(`UI-${letter}`, { name: `${UI_PREFIX} ${letter} ${text}` });
  const a = await mkUi('A', 'Draft deactivate me');
  const b = await mkUi('B', 'Rejected activate me');
  await toPending(b); await toRejected(b);
  const c = await mkUi('C', 'Pending edit me');
  await toPending(c);
  for (const [id, label] of [[a, 'A'], [b, 'B'], [c, 'C']]) {
    const s = await snap(id);
    console.log(`UI row ${label}: Subject "${s.mwf_name}" | status ${s.statuscode} (${NAME[s.statuscode]}) | state ${s.statecode}`);
    rec.push({ group, label: `UI ${label}`, status: 'OBS' });
  }
}

// ------------------------------------------------------------------ cleanup
// adapter for the shared helper (scripts/lib/contract-cleanup.mjs)
const io = {
  get: async (p) => { const r = await call('GET', p); return { ok: r.ok, status: r.status, json: r.j, message: msgOf(r) }; },
  patch: async (p, b) => { const r = await patch(p.replace(/^mwf_contracts\(([^)]+)\)$/, '$1'), b); return { ok: r.ok, status: r.status, message: msgOf(r) }; },
  del: async (p, h) => { const r = await call('DELETE', p, undefined, h || {}); return { ok: r.ok, status: r.status, message: msgOf(r) }; },
};
async function cleanup({ includeUi, bypass }) {
  enterCleanupPhase();   // from here DELETE is retried (404 = already gone) and reads are more patient
  const rows = (await must('GET', `mwf_contracts?$select=mwf_name,statuscode&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}&$top=500`)).j.value;
  const left = [];
  let removed = 0;
  for (const r of rows) {
    if (r.mwf_name.startsWith(UI_PREFIX) && !includeUi) continue;
    // shared helper: Pending -> withdraw to Draft then delete; Draft/Rejected -> delete; In Force -> bypass of the guard Delete step only
    const d = await deleteContract(io, r.mwf_contractid, { bypassStepId: bypass ? FX.stepId : null });
    if (d.deleted) removed++; else left.push(`${r.mwf_name} (${NAME[r.statuscode] || r.statuscode}) ${d.how}${d.status ? ` HTTP ${d.status}` : ''}`);
  }
  const cps = (await must('GET', `mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value;
  for (const c of cps) {
    const used = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=_mwf_counterpartyid_value eq ${c.mwf_counterpartyid}&$top=1`)).j.value.length;
    if (used) continue;
    const d = await call('DELETE', `mwf_counterparties(${c.mwf_counterpartyid})`);
    if (d.ok) removed++; else left.push(`counterparty ${c.mwf_name} HTTP ${d.status}`);
  }
  return { removed, left };
}
async function remaining() {
  const rows = (await must('GET', `mwf_contracts?$select=mwf_name,statuscode&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}&$top=500`)).j.value;
  const cps = (await must('GET', `mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value;
  const total = (await must('GET', `mwf_contracts?$select=mwf_contractid&$count=true&$top=1`)).j['@odata.count'];
  return { rows, cps, total };
}

// ------------------------------------------------------------------ main
const ctr = ctrIo(call);
(async () => {
  let exit = 0;
  let ctrSnap = null;
  try {
    TOKEN = AUTH === 'az'
      ? execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim()
      : await deviceToken();
    await requireStableConnection(call);   // 3 GET requests in a row before any write (counter helper)
    if (MODE === 'check-clean') {
      const r = await remaining();
      console.log(`rows with the prefix: ${r.rows.length}; counterparties: ${r.cps.length}; total contracts ${r.total}`);
      for (const x of r.rows) console.log(`  "${x.mwf_name}" (${NAME[x.statuscode] || x.statuscode})`);
      process.exit(0);
    }
    if (MODE === 'cleanup') {
      const stepRows = (await must('GET', `sdkmessageprocessingsteps?$filter=name eq '${GUARD_DELETE_STEP}'&$select=name`)).j.value;
      FX.stepId = stepRows[0]?.sdkmessageprocessingstepid;
      const c = await cleanup({ includeUi: INCLUDE_UI, bypass: true });
      const r = await remaining();
      console.log(`cleanup: removed ${c.removed}; could not remove: ${c.left.length ? c.left.join('; ') : 'none'}`);
      console.log(`remaining: contracts ${r.rows.length}, counterparties ${r.cps.length}; total contracts ${r.total}`);
      const rsC = !c.left.length && !r.rows.length ? await restoreFromArgs(ctr) : { refused: 0 };
      process.exit(c.left.length || rsC.refused ? 1 : 0);
    }

    await requireFlowOff(io, { confirmedByUser: FLOW_OFF_CONFIRMED });
    const before = await remaining();
    console.log(`before: rows with the prefix ${before.rows.length}, counterparties ${before.cps.length}; total contracts ${before.total}`);
    if (before.rows.length || before.cps.length) throw new Unexpected('Rows with the TEST-TMP-GUARD prefix already exist. Run --mode=cleanup --include-ui first.');
    ctrSnap = await snapshotCounters(ctr);
    await setup();
    for (const f of [g1, g2, g3, g4, g5, g6, g7, g8, ...(SKIP_UI_ROWS ? [] : [uiRows])]) await f();
    console.log(SKIP_UI_ROWS ? '\n=== cleanup of every TEST-TMP-GUARD row (UI rows skipped)' : '\n=== cleanup of every TEST-TMP-GUARD row except the UI rows A, B, C');
    const c = await cleanup({ includeUi: false, bypass: FX.bypassWorks });
    console.log(`cleanup: removed ${c.removed}; left (not removable): ${c.left.length ? '' : 'none'}`);
    for (const l of c.left) console.log(`  ${l}`);
    const r = await remaining();
    console.log(`remaining: contracts ${r.rows.length}, counterparties ${r.cps.length}; total contracts ${r.total}`);
    for (const x of r.rows) console.log(`  "${x.mwf_name}" (${NAME[x.statuscode] || x.statuscode})`);
    for (const x of r.cps) console.log(`  counterparty "${x.mwf_name}"`);
    if (r.rows.length) printHandoff(ctrSnap);   // the UI rows keep their numbers: restore only after they are deleted (--mode=cleanup --include-ui)
    else { const rs = await restoreAfterRun(ctr, ctrSnap); if (rs.refused) exit = exit || 6; }
  } catch (e) {
    exit = 4;
    console.error(`\nSTOPPED (unexpected): ${noGuid(e.message)}`);
  } finally {
    const byGroup = {};
    for (const x of rec) { byGroup[x.group] ??= { PASS: 0, FAIL: 0, OBS: 0 }; byGroup[x.group][x.status]++; }
    console.log('\n=== SUMMARY per group');
    let p = 0; let f = 0; let o = 0;
    for (const [g, c] of Object.entries(byGroup)) { console.log(`${g.padEnd(24)} PASS ${String(c.PASS).padStart(3)}   FAIL ${String(c.FAIL).padStart(3)}   OBS ${String(c.OBS).padStart(3)}`); p += c.PASS; f += c.FAIL; o += c.OBS; }
    console.log(`${'TOTAL'.padEnd(24)} PASS ${String(p).padStart(3)}   FAIL ${String(f).padStart(3)}   OBS ${String(o).padStart(3)}`);
    if (f && !exit) exit = 1;
  }
  process.exit(exit);
})();
