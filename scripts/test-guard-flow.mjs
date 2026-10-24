#!/usr/bin/env node
/**
 * End-to-end test of the Contract State Guard with the approval flow ON (ADR-004, phase C).
 * FICTIONAL TEST-TMP-GFLOW rows only (a prefix of its own, not a prefix of the other scripts' rows).
 *
 * Modes:
 *   --mode=part1  creates one counterparty and two Draft contracts (FLOW1 normal, FLOW2 withdrawn), moves both to Pending
 *                 Approval (the flow starts one run each), withdraws FLOW2 to Draft, prints the subjects and STOPS.
 *                 Nothing is cleaned up: the owner answers the approval requests by hand.
 *   --mode=part2  reads both rows again. If both have the expected status (FLOW1 In Force, FLOW2 Draft) it deletes them
 *                 (FLOW1 with the bypass of the guard DELETE step only), then the counterparty, then checks that no TEST-TMP
 *                 row remains. If a status is not the expected one it changes NOTHING and reports.
 *   --mode=check-clean  read only.
 *
 * Usage:
 *   node scripts/test-guard-flow.mjs --mode=part1|part2 --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment [--auth=device|az]
 *
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
import { execSync } from 'node:child_process';
import { deleteContract } from './lib/contract-cleanup.mjs';
import { ctrIo, trackCreate, snapshotCounters, restoreAfterRun, restoreFromArgs, printHandoff, requireStableConnection } from './lib/counter-snapshot.mjs';
import { resilientFetch, enterCleanupPhase, recheckAfterWait } from './lib/resilient-fetch.mjs';
import { expectContractsOrExit, describeExpectContracts } from './lib/expect-contracts.mjs';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const MODE = argOf('mode');
const EXPECT = expectContractsOrExit();   // contracts expected in the starting and the final state (argument, variable or default 11)
console.log(describeExpectContracts(EXPECT));
const ENV = argOf('env').replace(/\/+$/, '');
const AUTH = argOf('auth') || 'device';
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id, same as the other scripts
const PREFIX = 'TEST-TMP-GFLOW';
const GUARD_DELETE_STEP = 'Muwafaqa.Plugins.Contract.ContractStateGuard: Delete of mwf_contract';
const ST = { Draft: 1, Pending: 867640000, InForce: 867640001, Rejected: 2 };
const NAME = { 1: 'Draft', 867640000: 'Pending Approval', 867640001: 'In Force', 2: 'Rejected' };

if (!['part1', 'part2', 'check-clean'].includes(MODE)) { console.error('Missing or invalid --mode=part1|part2|check-clean. Nothing was run.'); process.exit(2); }
if (!/^https:\/\/[^/]+$/.test(ENV)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
if (!['device', 'az'].includes(AUTH)) { console.error('Invalid --auth=device|az. Nothing was run.'); process.exit(2); }
if (MODE !== 'check-clean' && !process.argv.includes('--confirm-mutates-environment')) {
  console.error(`WARNING: --mode=${MODE} creates, updates or deletes ${PREFIX}* rows. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
  process.exit(2);
}

const API = `${ENV}/api/data/v9.2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noGuid = (t) => String(t ?? '').replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>');
const q = encodeURIComponent;
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
class Stop extends Error {}
async function must(method, path, body, extra) {
  const r = await call(method, path, body, extra);
  if (!r.ok) throw new Stop(`${method} ${noGuid(path).slice(0, 90)} failed HTTP ${r.status}\n${noGuid(r.j?.error?.message || r.text).slice(0, 600)}`);
  return r;
}
const label = async (table, col, text) => {
  const a = await must('GET', `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${col}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`);
  const o = a.j.OptionSet.Options.find((x) => x.Label?.UserLocalizedLabel?.Label === text);
  if (!o) throw new Stop(`Option '${text}' of ${col} not found`);
  return o.Value;
};
const SEL = 'mwf_name,mwf_contractnumber,mwf_value,mwf_valueusdfrozen,statecode,statuscode';
const fmt = (g) => `Subject "${g.mwf_name}" | status ${g.statuscode} (${NAME[g.statuscode] || '?'}) | state ${g.statecode} | mwf_valueusdfrozen ${g.mwf_valueusdfrozen === null ? 'null' : Number(g.mwf_valueusdfrozen).toFixed(2)}`;
const read = async (id) => (await must('GET', `mwf_contracts(${id})?$select=${SEL}`)).j;
const rowsByPrefix = async () => (await must('GET', `mwf_contracts?$select=${SEL}&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}&$orderby=mwf_name`)).j.value;

const ctr = ctrIo(call);

async function part1() {
  const cpType = (await must('GET', `EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`)).j.OptionSet.Options[0].Value;
  const cur = (await must('GET', `transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0`)).j.value;
  if (cur.length !== 1) throw new Stop(`active USD currency: expected 1, found ${cur.length}`);
  const type = await label('mwf_contract', 'mwf_contracttype', 'Maintenance');
  const dir = await label('mwf_contract', 'mwf_direction', 'Expense');
  const before = (await rowsByPrefix()).length;
  if (before) throw new Stop(`${before} row(s) with the prefix ${PREFIX} already exist. Run part2 or clean them first.`);

  const ctrSnap = await snapshotCounters(ctr);
  console.log('--- a. create one counterparty and two Draft contracts');
  const cp = await must('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} Fictional Counterparty (delete me)`, mwf_counterpartytype: cpType });
  const mk = async (n, subject) => (await must('POST', 'mwf_contracts', {
    mwf_name: subject, mwf_contracttype: type, mwf_direction: dir, mwf_value: 1000,
    'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${cp.id})`,
    'transactioncurrencyid@odata.bind': `/transactioncurrencies(${cur[0].transactioncurrencyid})`,
  })).id;
  const f1 = await mk(1, `${PREFIX}1 normal`);
  const f2 = await mk(2, `${PREFIX}2 withdrawn`);
  console.log(`created: ${fmt(await read(f1))}`);
  console.log(`created: ${fmt(await read(f2))}`);

  console.log('\n--- b. PATCH both to Pending Approval (the flow starts one run each)');
  for (const id of [f1, f2]) await must('PATCH', `mwf_contracts(${id})`, { statuscode: ST.Pending }, { 'If-Match': '*' });
  const g1 = await read(f1); const g2 = await read(f2);
  console.log(fmt(g1)); console.log(fmt(g2));
  const okB = [g1, g2].every((g) => g.statuscode === ST.Pending && Number(g.mwf_valueusdfrozen).toFixed(2) === '1000.00');
  console.log(`b. expected Pending Approval and 1000.00 for both: ${okB ? 'PASS' : 'FAIL'}`);
  if (!okB) throw new Stop('Unexpected state after step b. Stopping (nothing cleaned).');

  console.log('\n--- c. withdraw FLOW2 to Draft while its approval is outstanding');
  await must('PATCH', `mwf_contracts(${f2})`, { statuscode: ST.Draft }, { 'If-Match': '*' });
  const g2b = await read(f2);
  console.log(fmt(g2b));
  console.log(`c. expected Draft: ${g2b.statuscode === ST.Draft ? 'PASS' : 'FAIL'}`);
  if (g2b.statuscode !== ST.Draft) throw new Stop('FLOW2 is not Draft after the withdrawal. Stopping (nothing cleaned).');

  console.log('\n--- d. subjects');
  console.log(`FLOW1: ${g1.mwf_name}`);
  console.log(`FLOW2: ${g2b.mwf_name}`);
  printHandoff(ctrSnap);
  console.log('\nSTOP: nothing was cleaned. Answer the approval requests by hand, then run --mode=part2 (pass the --counters-before / --counters-consumed values above to restore the counters).');
}

async function part2() {
  console.log('--- e. read both rows again');
  const rows = await rowsByPrefix();
  for (const r of rows) console.log(fmt(r));
  const f1 = rows.find((r) => r.mwf_name === `${PREFIX}1 normal`);
  const f2 = rows.find((r) => r.mwf_name === `${PREFIX}2 withdrawn`);
  if (!f1 || !f2) throw new Stop(`Expected both rows, found ${rows.length}. Nothing changed.`);
  const ok1 = f1.statuscode === ST.InForce;
  const ok2 = f2.statuscode === ST.Draft;
  console.log(`FLOW1 expected In Force: ${ok1 ? 'PASS' : 'MISMATCH'}`);
  console.log(`FLOW2 expected Draft   : ${ok2 ? 'PASS' : 'MISMATCH'}`);
  if (!ok1 || !ok2) {
    console.log('\nf. A status is not the expected one. NOTHING was changed and nothing was cleaned. Waiting.');
    process.exit(1);
  }

  enterCleanupPhase();   // from here DELETE is retried (404 = already gone) and reads are more patient
  console.log('\n--- g. cleanup');
  const step = (await must('GET', `sdkmessageprocessingsteps?$filter=name eq '${GUARD_DELETE_STEP}'&$select=name`)).j.value;
  if (step.length !== 1) throw new Stop(`guard Delete step: expected 1, found ${step.length}`);
  // shared helper (scripts/lib/contract-cleanup.mjs): In Force -> bypass of the guard Delete step only; Draft -> delete
  const m = (r) => noGuid(r.j?.error?.message || (r.ok ? '' : r.text) || '').slice(0, 300);
  const io = {
    get: async (p) => { const r = await call('GET', p); return { ok: r.ok, status: r.status, json: r.j, message: m(r) }; },
    patch: async (p, b) => { const r = await call('PATCH', p, b, { 'If-Match': '*' }); return { ok: r.ok, status: r.status, message: m(r) }; },
    del: async (p, h) => { const r = await call('DELETE', p, undefined, h || {}); return { ok: r.ok, status: r.status, message: m(r) }; },
  };
  const d1 = await deleteContract(io, f1.mwf_contractid, { bypassStepId: step[0].sdkmessageprocessingstepid });
  console.log(`delete FLOW1 (${d1.how}): HTTP ${d1.status}`);
  const d2 = await deleteContract(io, f2.mwf_contractid, { bypassStepId: step[0].sdkmessageprocessingstepid });
  console.log(`delete FLOW2 (${d2.how}): HTTP ${d2.status}`);
  if (!d1.deleted || !d2.deleted) throw new Stop(`A delete failed: ${(d1.deleted ? d2.message : d1.message) || (d1.deleted ? d2.how : d1.how)}`);
  const cps = (await must('GET', `mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value;
  for (const c of cps) {
    const used = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=_mwf_counterpartyid_value eq ${c.mwf_counterpartyid}&$top=1`)).j.value.length;
    if (used) { console.log('counterparty still referenced, kept'); continue; }
    const d = await call('DELETE', `mwf_counterparties(${c.mwf_counterpartyid})`);
    console.log(`delete counterparty: HTTP ${d.status}`);
  }
  await checkClean();
  await restoreFromArgs(ctr);
  console.log('\nh. nothing was committed.');
}

async function checkClean() {
  const a = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value.length;
  const b = (await must('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value.length;
  const total = (await must('GET', `mwf_contracts?$select=mwf_contractid&$count=true&$top=1`)).j['@odata.count'];
  console.log(`check-clean (prefix ${PREFIX}): contracts ${a}, counterparties ${b}, total contracts ${total} (expected 0, 0, ${EXPECT.value} when nothing else exists)`);
}

(async () => {
  try {
    TOKEN = AUTH === 'az'
      ? execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim()
      : await deviceToken();
    await requireStableConnection(call);   // 3 GET requests in a row before any write (counter helper)
    if (MODE === 'part1') await part1();
    else if (MODE === 'part2') await part2();
    else await checkClean();
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
