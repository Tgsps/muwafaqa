#!/usr/bin/env node
/**
 * NOTE: the mode --mode=flow-case is a **v1 scenario, retired** (it was run for "Muwafaqa - Contract Approval v1", which the owner decided to retire; kept as history, not deleted).
 * It was never run against v2: a result is not a v2 result. The other modes are not affected.
 *
 * Integration tests for the plug-in FreezeUsdValueOnSubmission (ADR-003), through the Dataverse Web API.
 * FICTIONAL TEST-TMP-USD-* rows only. All rows are deleted at the end and the cleanup is verified.
 *
 * Modes:
 *   --mode=update-cases  cases 1, 2, 4, 5, 6, 6b, 6c, 7, 8, 10 (the Update path). Needs the Update step registered.
 *   --mode=create-case   case 3: create a contract directly as Pending Approval without a currency. CHANGED 2026-10-22 (ADR-004 update): the guard now
 *                        rejects any Create that is not Draft, so the case checks that rejection (it used to be an observation of the Create path of plug-in 1).
 *   --mode=guard-smoke   smoke test of the Contract State Guard (ADR-004), no Pending and no In Force row is created:
 *                        create a Draft, PATCH it to In Force (must fail with the guard message), PATCH the Subject,
 *                        PATCH Value, DELETE it. Cleans up and runs check-clean.
 *   --mode=flow-case     case 9: creates ONE row (Draft, USD 1000) and moves it to Pending Approval, then reads it back. [v1 scenario, retired]
 *                        The row (and its counterparty) is KEPT so the approval flow run can be checked by hand.
 *   --mode=cleanup       deletes every TEST-TMP-USD row (contracts, then the counterparty; rows of other scripts are not touched) and verifies it.
 *   --mode=check-clean   read only. No TEST-TMP-USD rows remain.
 *
 * Usage:
 *   node scripts/test-usd-freeze.mjs --mode=update-cases --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment [--auth=device|az]
 *
 * PRECONDITION: the approval flow must be OFF while these cases run (every entry into Pending Approval starts a run).
 * The modes update-cases, create-case and guard-smoke READ the flow state first and stop if it is ON (or cannot be read;
 * after checking by hand, add --flow-off-confirmed). The mode flow-case is meant for the flow ON and does not check.
 *
 * Contract State Guard (ADR-004): every status is reached by an allowed transition (Draft -> Pending -> Rejected),
 * Rejected to Pending is a NEGATIVE test, editing Value while Pending is a NEGATIVE test, and the cleanup withdraws
 * Pending rows to Draft before deleting them (shared helper scripts/lib/contract-cleanup.mjs).
 *
 * Rules: STOPS at the first mismatch and prints the evidence (no silent rerun). Rows are cleaned in every case of exit.
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
import { execSync } from 'node:child_process';
import { deleteContracts, requireFlowOff } from './lib/contract-cleanup.mjs';
import { ctrIo, trackCreate, snapshotCounters, restoreAfterRun, restoreFromArgs, printHandoff, requireStableConnection } from './lib/counter-snapshot.mjs';
import { resilientFetch, enterCleanupPhase, leaveCleanupPhase, recheckAfterWait } from './lib/resilient-fetch.mjs';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const MODE = argOf('mode');
const ENV = argOf('env').replace(/\/+$/, '');
const AUTH = argOf('auth') || 'device';
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id, same as the other scripts
const PREFIX = 'TEST-TMP-USD';
const FLOW_OFF_CONFIRMED = process.argv.includes('--flow-off-confirmed');

if (!['update-cases', 'create-case', 'flow-case', 'guard-smoke', 'cleanup', 'check-clean'].includes(MODE)) { console.error('Missing or invalid --mode=update-cases|create-case|flow-case|guard-smoke|cleanup|check-clean (flow-case is a v1 scenario, retired). Nothing was run.'); process.exit(2); }
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
const PENDING = 867640000;
const DRAFT = { statecode: 0, statuscode: 1 };
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
async function must(method, path, body, extra) {
  const r = await call(method, path, body, extra);
  if (!r.ok) throw new Error(`${method} ${noGuid(path).slice(0, 90)} failed HTTP ${r.status}\n${noGuid(r.text).slice(0, 700)}`);
  return r;
}

// adapter for the shared helper (scripts/lib/contract-cleanup.mjs)
const msgOfCall = (r) => noGuid(r.j?.error?.message || (r.ok ? '' : r.text) || '').replace(/\s+/g, ' ').trim();
const io = {
  get: async (p) => { const r = await call('GET', p); return { ok: r.ok, status: r.status, json: r.j, message: msgOfCall(r) }; },
  patch: async (p, b) => { const r = await call('PATCH', p, b, { 'If-Match': '*' }); return { ok: r.ok, status: r.status, message: msgOfCall(r) }; },
  del: async (p, h) => { const r = await call('DELETE', p, undefined, h || {}); return { ok: r.ok, status: r.status, message: msgOfCall(r) }; },
};

class Mismatch extends Error {}
const log = [];
function report(id, input, expected, actual, pass, extra = '') {
  const line = `${pass ? 'PASS' : 'FAIL'}  case ${id}\n        input    : ${input}\n        expected : ${expected}\n        actual   : ${actual}${extra ? `\n        ${extra}` : ''}`;
  console.log(line);
  log.push({ id, pass });
  if (!pass) throw new Mismatch(`case ${id} did not match. Stopping.`);
}
const two = (v) => (v === null || v === undefined ? 'null' : Number(v).toFixed(2));

// ---- fixtures -----------------------------------------------------------
const FX = { ids: [], cp: null, iso: new Map(), ctType: null, ctDir: null };
async function optionValue(table, col, label) {
  const a = await must('GET', `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${col}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`);
  const o = a.j.OptionSet.Options.find((x) => x.Label?.UserLocalizedLabel?.Label === label);
  if (!o) throw new Error(`Option '${label}' of ${col} not found`);
  return o.Value;
}
async function setup() {
  const cs = (await must('GET', `transactioncurrencies?$select=isocurrencycode&$filter=statecode eq 0`)).j.value;
  for (const c of cs) FX.iso.set(c.isocurrencycode, c.transactioncurrencyid);
  FX.ctType = await optionValue('mwf_contract', 'mwf_contracttype', 'Maintenance');
  FX.ctDir = await optionValue('mwf_contract', 'mwf_direction', 'Expense');
  const cpOpts = await must('GET', `EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`);
  const cpType = cpOpts.j.OptionSet.Options[0].Value;
  const cp = await must('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} Fictional Counterparty (delete me)`, mwf_counterpartytype: cpType });
  FX.cp = cp.id;
}
async function contract({ key, iso, value, status, noCurrency = false, noValue = false }) {
  const body = {
    mwf_name: `${PREFIX} ${key}`,
    mwf_contracttype: FX.ctType, mwf_direction: FX.ctDir,
    'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${FX.cp})`,
  };
  if (!noValue) body.mwf_value = value;
  if (!noCurrency) body['transactioncurrencyid@odata.bind'] = `/transactioncurrencies(${FX.iso.get(iso)})`;
  if (status !== undefined) body.statuscode = status;
  const r = await call('POST', 'mwf_contracts', body);
  if (r.ok && r.id) FX.ids.push(r.id);
  return r;
}
const read = async (id) => (await must('GET', `mwf_contracts(${id})?$select=mwf_value,mwf_valueusdfrozen,statecode,statuscode,exchangerate,_transactioncurrencyid_value`)).j;
const patch = (id, body) => call('PATCH', `mwf_contracts(${id})`, body, { 'If-Match': '*' });
const snap = (g) => `statecode ${g.statecode}, statuscode ${g.statuscode}, mwf_value ${g.mwf_value}, mwf_valueusdfrozen ${two(g.mwf_valueusdfrozen)}`;

async function cleanup() {
  enterCleanupPhase();   // from here DELETE is retried (404 = already gone) and reads are more patient
  let removed = 0;
  // contracts by number or by name, each id once. Pending rows are withdrawn to Draft first (the guard forbids deleting them).
  const ids = new Set();
  for (const f of [`startswith(mwf_name,'${PREFIX}')`]) {
    for (const r of (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(f)}`)).j.value) ids.add(r.mwf_contractid);
  }
  const res = await deleteContracts(io, [...ids]);
  if (res.failed.length) throw new Error(`could not delete ${res.failed.length} contract row(s): ${JSON.stringify(res.failed)}`);
  removed += res.deleted;
  const cps = (await must('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value;
  for (const r of cps) { await must('DELETE', `mwf_counterparties(${r.mwf_counterpartyid})`); removed++; }
  return removed;
}
async function counts() {
  const a = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value.length;
  const b = (await must('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value.length;
  const total = (await must('GET', `mwf_contracts?$select=mwf_contractid&$count=true&$top=1`)).j['@odata.count'];
  return { contracts: a, counterparties: b, totalContracts: total };
}

// ---- cases --------------------------------------------------------------
async function toPending(id, extraBody = {}) {
  const r = await patch(id, { statuscode: PENDING, ...extraBody });
  if (!r.ok) throw new Error(`PATCH to Pending failed HTTP ${r.status}\n${noGuid(r.text).slice(0, 700)}`);
}
async function simple(idKey, label, iso, value, expected) {
  const c = await contract({ key: idKey, iso, value });
  if (!c.ok) throw new Error(`create failed HTTP ${c.status}\n${noGuid(c.text).slice(0, 500)}`);
  await toPending(c.id);
  const g = await read(c.id);
  report(label, `${iso} Draft ${value}, then PATCH statuscode=Pending`, expected, `${snap(g)}`, two(g.mwf_valueusdfrozen) === expected && g.statuscode === PENDING);
  return c.id;
}

async function updateCases() {
  // 1 Value + statuscode together (PreImage question, and persistence of the column written in the status pass)
  {
    const c = await contract({ key: 'C1', iso: 'USD', value: 500 });
    await toPending(c.id, { mwf_value: 1000 });
    const g = await read(c.id);
    let note = '';
    if (two(g.mwf_valueusdfrozen) === '500.00') note = 'EVIDENCE: the PreImage in the status pass held the OLD Value (500).';
    if (g.mwf_valueusdfrozen === null) note = 'EVIDENCE: the column written in the status pass was NOT persisted.';
    report('1', 'USD Draft 500; one PATCH {mwf_value:1000, statuscode:Pending}', '1000.00 (the NEW Value)', snap(g), two(g.mwf_valueusdfrozen) === '1000.00' && g.statuscode === PENDING, note);
  }
  // 2 Rejected -> Pending in one PATCH (statecode + statuscode). NEGATIVE test since the guard (ADR-004, decision Q1:
  //   Rejected goes back to Draft first). The row reaches Rejected by allowed transitions: Draft -> Pending -> Rejected.
  {
    const c = await contract({ key: 'C2', iso: 'AED', value: 367250 });
    await toPending(c.id);
    const first = await read(c.id);
    const rej = await patch(c.id, { statecode: 1, statuscode: 2 });
    if (!rej.ok) throw new Error(`setup PATCH Pending -> Rejected failed HTTP ${rej.status}\n${noGuid(rej.text).slice(0, 500)}`);
    const before = await read(c.id);
    const r = await patch(c.id, { statecode: 0, statuscode: PENDING });
    const after = await read(c.id);
    const m = noGuid(r.j?.error?.message || r.text || '').replace(/\s+/g, ' ').slice(0, 300);
    const unchanged = after.statuscode === before.statuscode && after.statecode === before.statecode
      && two(after.mwf_valueusdfrozen) === two(before.mwf_valueusdfrozen) && Number(after.mwf_value) === Number(before.mwf_value);
    report('2', `AED 367250, Draft -> Pending -> Rejected (state ${before.statecode}/status ${before.statuscode}); one PATCH {statecode:0, statuscode:Pending}`,
      'HTTP 400 "Cannot change the contract status from Rejected to Pending Approval."; row unchanged (Rejected, frozen 97433.67 from the first submission)',
      `HTTP ${r.status}; message: ${m}; ${snap(after)}`,
      r.status === 400 && /Cannot change the contract status from Rejected to Pending Approval\./.test(m) && unchanged
        && two(first.mwf_valueusdfrozen) === '97433.67' && two(after.mwf_valueusdfrozen) === '97433.67' && after.statuscode === 2);
  }
  // 4 base currency
  await simple('C4', '4', 'TRY', 49000, '1000.00');
  // 5 USD
  await simple('C5', '5', 'USD', 1000, '1000.00');
  // 6 / 6b / 6c
  await simple('C6', '6', 'KWD', 6500.255, '19898.74');
  await simple('C6B', '6b', 'KWD', 750.125, '2296.30');
  await simple('C6C', '6c', 'AED', 367250, '97433.67');
  // 7 recompute on re-entry
  {
    const c = await contract({ key: 'C7', iso: 'USD', value: 1000 });
    await toPending(c.id);
    const g1 = await read(c.id);
    const back = await patch(c.id, { statuscode: 1 });
    const g2 = await read(c.id);
    const ed = await patch(c.id, { mwf_value: 2500 });
    const g3 = await read(c.id);
    await toPending(c.id);
    const g4 = await read(c.id);
    report('7', 'USD Draft 1000 -> Pending -> Draft -> edit Value 2500 -> Pending',
      'after 1st Pending 1000.00; kept 1000.00 in Draft (also after the edit); after 2nd Pending 2500.00',
      `1st: ${two(g1.mwf_valueusdfrozen)}; Draft(HTTP ${back.status}): ${two(g2.mwf_valueusdfrozen)} status ${g2.statuscode}; edit(HTTP ${ed.status}): ${two(g3.mwf_valueusdfrozen)}; 2nd: ${two(g4.mwf_valueusdfrozen)}`,
      two(g1.mwf_valueusdfrozen) === '1000.00' && two(g2.mwf_valueusdfrozen) === '1000.00' && two(g3.mwf_valueusdfrozen) === '1000.00' && two(g4.mwf_valueusdfrozen) === '2500.00');
  }
  // 8 same status save does not recompute
  {
    const c = await contract({ key: 'C8', iso: 'USD', value: 1000 });
    await toPending(c.id);
    const g1 = await read(c.id);
    const ed = await patch(c.id, { mwf_value: 3000 });
    const g2 = await read(c.id);
    const edMsg = noGuid(ed.j?.error?.message || ed.text || '').replace(/\s+/g, ' ').slice(0, 300);
    const same = await patch(c.id, { statuscode: PENDING });
    const g3 = await read(c.id);
    report('8', 'USD 1000 Pending; edit Value 3000 while Pending (the guard rejects it, ADR-004); PATCH statuscode=Pending again',
      'the edit gets HTTP 400 "Cannot change Value ..." and Value stays 1000; frozen 1000.00 stays; the same-status save is HTTP 204 and does not recompute',
      `1st: ${two(g1.mwf_valueusdfrozen)}; edit: HTTP ${ed.status} ${edMsg}; after edit Value ${g2.mwf_value}, frozen ${two(g2.mwf_valueusdfrozen)}; same-status save: HTTP ${same.status}, frozen ${two(g3.mwf_valueusdfrozen)}`,
      two(g1.mwf_valueusdfrozen) === '1000.00' && ed.status === 400 && /Cannot change Value/.test(edMsg) && Number(g2.mwf_value) === 1000
        && two(g2.mwf_valueusdfrozen) === '1000.00' && same.status === 204 && two(g3.mwf_valueusdfrozen) === '1000.00');
  }
  // 10 failure: no Value -> Pending
  {
    const c = await contract({ key: 'C10', iso: 'USD', noValue: true });
    if (!c.ok) {
      report('10', 'create TEST-TMP Draft without Value', 'row created (the API does not enforce Business Required)', `HTTP ${c.status} ${noGuid(c.text).slice(0, 300)}`, false);
    }
    const r = await patch(c.id, { statuscode: PENDING });
    const g = await read(c.id);
    const msg = noGuid(r.j?.error?.message || r.text || '').slice(0, 300);
    report('10', 'USD Draft with NO Value; PATCH statuscode=Pending',
      'HTTP 400 with "The contract has no Value"; status stays Draft (1); frozen null',
      `HTTP ${r.status}; message: ${msg}; ${snap(g)}`,
      !r.ok && /no Value/.test(msg) && g.statuscode === 1 && g.mwf_valueusdfrozen === null);
  }
}

async function guardSmoke() {
  const msgOf = (r) => noGuid(r.j?.error?.message || r.text || '').slice(0, 400);
  // a) create a Draft with Value and currency (the Contract Number is generated by the server, ADR-006)
  const c = await contract({ key: 'G1', iso: 'USD', value: 1000 });
  report('smoke a', 'POST a Draft contract (USD, Value 1000, no number sent, no status)',
    'HTTP 204 (the Create step ran without error)', `HTTP ${c.status}${c.ok ? '' : `; ${msgOf(c)}`}`, c.ok && c.status === 204);
  const id = c.id;
  const d0 = await read(id);
  // b) Draft -> In Force must fail with the guard message and leave the row Draft
  const b = await patch(id, { statuscode: 867640001 });
  const d1 = await read(id);
  const bm = msgOf(b);
  report('smoke b', 'PATCH {statuscode: In Force} on the Draft',
    'HTTP 400 with "Cannot change the contract status from Draft to In Force."; the row stays Draft',
    `HTTP ${b.status}; message: ${bm}; row statuscode ${d1.statuscode}`,
    b.status === 400 && /Cannot change the contract status from Draft to In Force\./.test(bm) && d1.statuscode === 1 && d0.statuscode === 1);
  // c) Subject only
  const cc = await patch(id, { mwf_name: `${PREFIX} G1 renamed` });
  report('smoke c', 'PATCH {mwf_name} only', 'HTTP 204', `HTTP ${cc.status}${cc.ok ? '' : `; ${msgOf(cc)}`}`, cc.status === 204);
  // d) Value in Draft
  const dd = await patch(id, { mwf_value: 2000 });
  const d2 = await read(id);
  report('smoke d', 'PATCH {mwf_value: 2000} on the Draft', 'HTTP 204 and Value 2000 (Draft is editable)',
    `HTTP ${dd.status}${dd.ok ? '' : `; ${msgOf(dd)}`}; mwf_value ${d2.mwf_value}`, dd.status === 204 && Number(d2.mwf_value) === 2000);
  // e) delete
  const e = await call('DELETE', `mwf_contracts(${id})`);
  const gone = await call('GET', `mwf_contracts(${id})?$select=mwf_contractid`);
  report('smoke e', 'DELETE the Draft (the Delete step with the PreImage ran)', 'HTTP 204 and the row is gone (GET returns 404)',
    `HTTP ${e.status}${e.ok ? '' : `; ${msgOf(e)}`}; GET after delete: HTTP ${gone.status}`, e.status === 204 && gone.status === 404);
  FX.ids = FX.ids.filter((x) => x !== id);
}

async function flowCase() {
  const c = await contract({ key: 'C9-FLOW', iso: 'USD', value: 1000 });
  if (!c.ok) throw new Error(`create failed HTTP ${c.status}\n${noGuid(c.text).slice(0, 500)}`);
  const d = await read(c.id);
  console.log(`created: Draft, ${snap(d)}`);
  await toPending(c.id);
  const g = await read(c.id);
  const n = (await must('GET', `mwf_contracts(${c.id})?$select=mwf_name`)).j.mwf_name;
  report('9 (part 1)', 'USD Draft 1000, then PATCH statuscode=Pending with the approval flow ON',
    'mwf_valueusdfrozen 1000.00, status Pending Approval', `Subject: ${n}; ${snap(g)}`,
    two(g.mwf_valueusdfrozen) === '1000.00' && g.statuscode === PENDING);
  console.log('\nThe row is KEPT. Check the flow run and answer the approval by hand, then run --mode=cleanup.');
}

async function createCase() {
  const c = await contract({ key: 'C3', value: 1000, noCurrency: true, status: PENDING });
  if (!c.ok) {
    const m = noGuid(c.j?.error?.message || c.text);
    report('3', 'POST contract with statuscode=Pending, Value 1000, NO transactioncurrencyid', 'HTTP 400 from the guard: "A contract must be created as Draft; submit it for approval afterwards." (changed 2026-10-22)',
      `HTTP ${c.status}; ${m.slice(0, 400)}`, c.status === 400 && /A contract must be created as Draft; submit it for approval afterwards\./.test(m));
    return;
  }
  report('3', 'POST contract with statuscode=Pending, Value 1000, NO transactioncurrencyid', 'HTTP 400 from the guard (changed 2026-10-22)', `ACCEPTED: HTTP ${c.status}, which is no longer expected`, false);
  const g = await read(c.id);
  const iso = [...FX.iso.entries()].find(([, id]) => id === g._transactioncurrencyid_value)?.[0] ?? '(none)';
  report('3', 'POST contract with statuscode=Pending, Value 1000, NO transactioncurrencyid',
    'OBSERVATION (no fixed expectation): which currency was filled, and whether the frozen value was written',
    `HTTP ${c.status}; currency filled: ${iso}; ${snap(g)}`, true,
    g.statuscode !== PENDING ? 'OBSERVATION: statuscode was NOT Pending after create (the platform ignored it on create), so the plug-in path was not exercised.' : '');
}

const ctr = ctrIo(call);
(async () => {
  let exit = 0;
  let ctrSnap = null;
  try {
    TOKEN = AUTH === 'az'
      ? execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim()
      : await deviceToken();
    await requireStableConnection(call);   // 3 GET requests in a row before any write (counter helper)
    if (['update-cases', 'create-case', 'guard-smoke'].includes(MODE)) {
      await requireFlowOff(io, { confirmedByUser: FLOW_OFF_CONFIRMED });
    }
    if (MODE === 'cleanup') {
      // show the rows (read only) before they are deleted
      const rows = (await must('GET', `mwf_contracts?$select=mwf_name,statecode,statuscode,mwf_valueusdfrozen&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value;
      for (const r of rows) console.log(`row: Subject "${r.mwf_name}", statecode ${r.statecode}, statuscode ${r.statuscode}, mwf_valueusdfrozen ${two(r.mwf_valueusdfrozen)}`);
      console.log(`rows found before cleanup: ${rows.length}`);
      const removed = await cleanup();
      const a = await counts();
      console.log(`cleanup: removed ${removed} row(s); check-clean (prefix ${PREFIX}): contracts ${a.contracts}, counterparties ${a.counterparties}; total contracts ${a.totalContracts}`);
      const rsC = a.contracts === 0 && a.counterparties === 0 ? await restoreFromArgs(ctr) : { refused: 0 };
      process.exit(a.contracts === 0 && a.counterparties === 0 && !rsC.refused ? 0 : 1);
    }
    if (MODE === 'check-clean') {
      const c = await counts();
      console.log(`check-clean (prefix ${PREFIX}): contracts ${c.contracts}, counterparties ${c.counterparties}, total contracts ${c.totalContracts}`);
      process.exit(c.contracts === 0 && c.counterparties === 0 ? 0 : 1);
    }
    const before = await counts();
    console.log(`before (prefix ${PREFIX}): contracts ${before.contracts}, counterparties ${before.counterparties}; total contracts ${before.totalContracts}`);
    if (before.contracts || before.counterparties) { console.log(`INFO  removing ${await cleanup()} leftover TEST-TMP-USD row(s) first`); leaveCleanupPhase(); }   // the cleanup phase must not cover the test steps that follow
    ctrSnap = await snapshotCounters(ctr);
    await setup();
    if (MODE === 'update-cases') await updateCases();
    else if (MODE === 'flow-case') await flowCase();
    else if (MODE === 'guard-smoke') await guardSmoke();
    else await createCase();
    if (MODE === 'flow-case') printHandoff(ctrSnap);   // the rows stay for the flow; the cleanup mode restores the counters
    console.log(`\nSUMMARY: ${log.filter((l) => l.pass).length} passed, ${log.filter((l) => !l.pass).length} failed.`);
  } catch (e) {
    exit = e instanceof Mismatch ? 1 : 4;
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
  } finally {
    try {
      if (TOKEN && !['check-clean', 'cleanup', 'flow-case'].includes(MODE)) {
        const removed = await cleanup();
        const a = await counts();
        console.log(`\ncleanup: removed ${removed} row(s); check-clean (prefix ${PREFIX}): contracts ${a.contracts}, counterparties ${a.counterparties}; total contracts ${a.totalContracts}`);
        if (a.contracts || a.counterparties) exit = exit || 5;
        if (ctrSnap) { const rs = await restoreAfterRun(ctr, ctrSnap); if (rs.refused) exit = exit || 6; }
      }
    } catch (e) { console.error(`cleanup FAILED: ${noGuid(e.message)}`); exit = exit || 5; }
  }
  process.exit(exit);
})();
