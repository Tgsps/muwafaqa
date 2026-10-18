#!/usr/bin/env node
/**
 * How many approval flow runs does each action start, with the trigger
 *   Select columns = mwf_valueusdfrozen, Filter rows = statuscode eq 867640000 ?
 * FICTIONAL TEST-TMP-TRIG rows only. The approval flow must be ON (the test is about its trigger).
 *
 * Cases (each: UTC timestamp, the action, wait about 60 s, count the runs started after the timestamp):
 *   1  PATCH Draft -> Pending Approval                              expected 1 new run
 *   2  PATCH only the Subject of the Pending contract               expected 0
 *   3  PATCH statuscode = Pending Approval again (same value)       expected 0
 *   4  PATCH the Subject together with statuscode = Pending         expected 0
 *
 * Read only, before the cases: the flow state, and the trigger column filter and filter expression exactly as stored
 * in the flow definition (workflows.clientdata). The runs are read from the flowruns table if it is readable in this
 * environment. If it is not, the script says so and counts nothing (no guessing).
 *
 * Usage:
 *   node scripts/test-flow-trigger.mjs --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment [--auth=device|az] [--wait=60]
 *
 * Cleanup: the contract is withdrawn to Draft and deleted, then the counterparty (shared helper). The run started by
 * case 1 stays Running (waiting for approval); it is NOT cancelled by this script.
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
import { execSync } from 'node:child_process';
import { deleteContracts, approvalFlowState } from './lib/contract-cleanup.mjs';
import { ctrIo, trackCreate, snapshotCounters, restoreAfterRun, restoreFromArgs, printHandoff, requireStableConnection } from './lib/counter-snapshot.mjs';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const ENV = argOf('env').replace(/\/+$/, '');
const AUTH = argOf('auth') || 'device';
const WAIT_S = Number(argOf('wait') || 60);
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id, same as the other scripts
const PREFIX = 'TEST-TMP-TRIG';
const PENDING = 867640000;

if (!/^https:\/\/[^/]+$/.test(ENV)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
if (!['device', 'az'].includes(AUTH)) { console.error('Invalid --auth=device|az. Nothing was run.'); process.exit(2); }
if (!process.argv.includes('--confirm-mutates-environment')) {
  console.error(`WARNING: test-flow-trigger.mjs creates, updates and deletes ${PREFIX}* rows, and each move to Pending Approval starts a REAL flow run and an approval request. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
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
  const r = await fetch(`${API}/${path}`, { method, headers: hdr(extra), body: body === undefined ? undefined : JSON.stringify(body) });
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
const msgOf = (r) => noGuid(r.j?.error?.message || (r.ok ? '' : r.text) || '').replace(/\s+/g, ' ').trim().slice(0, 300);
const io = {
  get: async (p) => { const r = await call('GET', p); return { ok: r.ok, status: r.status, json: r.j, message: msgOf(r) }; },
  patch: async (p, b) => { const r = await call('PATCH', p, b, { 'If-Match': '*' }); return { ok: r.ok, status: r.status, message: msgOf(r) }; },
  del: async (p, h) => { const r = await call('DELETE', p, undefined, h || {}); return { ok: r.ok, status: r.status, message: msgOf(r) }; },
};

// ---- the flow: state, trigger as stored, and the runs
const FLOW = { row: null, ids: [] };
async function readFlow() {
  const st = await approvalFlowState(io);
  if (!st.known) throw new Stop(`The flow state could not be read (${st.count} matching flow rows). Nothing was changed.`);
  if (!st.on) throw new Stop('The approval flow is OFF. This test is about its trigger, so it must be ON. Nothing was changed.');
  const r = await must('GET', `workflows?$filter=${q(`category eq 5 and contains(name,'Contract Approval')`)}&$select=name,statecode,modifiedon,clientdata,workflowid,workflowidunique`);
  FLOW.row = r.j.value[0];
  FLOW.ids = [FLOW.row.workflowid, FLOW.row.workflowidunique].filter(Boolean).map((x) => String(x).toLowerCase());
  console.log(`flow: "${FLOW.row.name}" | state ${FLOW.row.statecode} (1 = On) | modifiedon ${FLOW.row.modifiedon}`);
  let cd = null;
  try { cd = JSON.parse(FLOW.row.clientdata); } catch { /* keep null */ }
  const triggers = cd?.properties?.definition?.triggers || {};
  const names = Object.keys(triggers);
  if (!names.length) { console.log('trigger: could not be read from clientdata (no triggers found)'); return; }
  for (const n of names) {
    const p = triggers[n]?.inputs?.parameters || {};
    console.log(`trigger "${n}" (${triggers[n]?.type || '?'}):`);
    for (const k of Object.keys(p).filter((x) => x.startsWith('subscriptionRequest/'))) {
      console.log(`   ${k} = ${JSON.stringify(p[k])}`);
    }
  }
}

const RUNS = { readable: null, note: '', startKey: null, flowKey: null };
async function probeRuns() {
  const r = await call('GET', 'flowruns?$top=25');
  if (!r.ok) { RUNS.readable = false; RUNS.note = `HTTP ${r.status}: ${msgOf(r)}`; return; }
  RUNS.readable = true;
  const rows = r.j.value || [];
  const keys = rows.length ? Object.keys(rows[0]).filter((k) => !k.startsWith('@')) : [];
  RUNS.startKey = keys.find((k) => /^starttime$/i.test(k)) || keys.find((k) => /start/i.test(k)) || null;
  for (const k of keys) {
    if (rows.some((x) => FLOW.ids.includes(String(x[k] ?? '').toLowerCase()))) { RUNS.flowKey = k; break; }
  }
  RUNS.note = `table readable, ${rows.length} recent row(s) returned; columns: ${keys.join(', ') || '(none)'}; start column: ${RUNS.startKey || 'not found'}; column matching this flow: ${RUNS.flowKey || 'not found'}`;
}
async function countRunsSince(ts) {
  if (!RUNS.readable) return { count: null, why: 'flowruns not readable' };
  if (!RUNS.startKey) return { count: null, why: 'no start time column' };
  const r = await call('GET', `flowruns?$filter=${q(`${RUNS.startKey} ge ${new Date(ts.getTime() - 2000).toISOString()}`)}`);
  if (!r.ok) return { count: null, why: `HTTP ${r.status} ${msgOf(r)}` };
  const rows = r.j.value || [];
  if (!RUNS.flowKey) return { count: null, why: `${rows.length} run(s) of any flow started after the timestamp, but none could be attributed to this flow` };
  const mine = rows.filter((x) => FLOW.ids.includes(String(x[RUNS.flowKey] ?? '').toLowerCase()));
  return { count: mine.length, why: '' };
}

(async () => {
  const table = [];
  let exit = 0;
  const fx = { cp: null, id: null };
  const ctr = ctrIo(call);
  let ctrSnap = null;
  try {
    TOKEN = AUTH === 'az'
      ? execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim()
      : await deviceToken();
    await requireStableConnection(call);   // 3 GET requests in a row before any write (counter helper)

    await readFlow();
    await probeRuns();
    console.log(`flowruns: ${RUNS.readable ? 'READABLE' : 'NOT READABLE'}${RUNS.note ? ` (${RUNS.note})` : ''}`);

    const pre = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value.length;
    if (pre) throw new Stop(`${pre} row(s) with the prefix ${PREFIX} already exist. Nothing was changed.`);
    const total0 = (await must('GET', `mwf_contracts?$select=mwf_contractid&$count=true&$top=1`)).j['@odata.count'];
    console.log(`before: total contracts ${total0}`);
    ctrSnap = await snapshotCounters(ctr);

    // fixtures
    const opt = async (table, col, label) => {
      const a = await must('GET', `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${col}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`);
      const o = a.j.OptionSet.Options.find((x) => x.Label?.UserLocalizedLabel?.Label === label);
      if (!o) throw new Stop(`Option '${label}' of ${col} not found`);
      return o.Value;
    };
    const cpType = (await must('GET', `EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`)).j.OptionSet.Options[0].Value;
    const usd = (await must('GET', `transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0`)).j.value;
    if (usd.length !== 1) throw new Stop(`active USD currency: expected 1, found ${usd.length}`);
    fx.cp = (await must('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} Fictional Counterparty (delete me)`, mwf_counterpartytype: cpType })).id;
    fx.id = (await must('POST', 'mwf_contracts', {
      mwf_name: `${PREFIX}1`, mwf_value: 1000,
      mwf_contracttype: await opt('mwf_contract', 'mwf_contracttype', 'Maintenance'), mwf_direction: await opt('mwf_contract', 'mwf_direction', 'Expense'),
      'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${fx.cp})`,
      'transactioncurrencyid@odata.bind': `/transactioncurrencies(${usd[0].transactioncurrencyid})`,
    })).id;
    console.log(`created: ${PREFIX}1 (Draft, USD 1000)`);

    const cases = [
      ['1', 'PATCH Draft -> Pending Approval', { statuscode: PENDING }, 1],
      ['2', 'PATCH only the Subject (Pending)', { mwf_name: `${PREFIX}1 subject A` }, 0],
      ['3', 'PATCH statuscode = Pending Approval again (same value)', { statuscode: PENDING }, 0],
      ['4', 'PATCH the Subject together with statuscode = Pending Approval', { mwf_name: `${PREFIX}1 subject B`, statuscode: PENDING }, 0],
    ];
    for (const [id, what, body, expected] of cases) {
      if (id !== '1') await sleep(1000);
      const ts = new Date();
      const r = await call('PATCH', `mwf_contracts(${fx.id})`, body, { 'If-Match': '*' });
      console.log(`case ${id}: ${what} | UTC ${ts.toISOString()} | HTTP ${r.status}${r.ok ? '' : ` ${msgOf(r)}`}`);
      console.log(`         waiting ${WAIT_S} s ...`);
      await sleep(WAIT_S * 1000);
      const c = await countRunsSince(ts);
      table.push({ id, what, ts: ts.toISOString(), http: r.status, count: c.count, why: c.why, expected });
    }
  } catch (e) {
    exit = 4;
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
  } finally {
    try {
      if (TOKEN && (fx.id || fx.cp)) {
        console.log('\n--- cleanup');
        if (fx.id) {
          const res = await deleteContracts(io, [fx.id]);
          console.log(`contract: deleted ${res.deleted}${res.failed.length ? `, FAILED ${JSON.stringify(res.failed)}` : ''}`);
        }
        if (fx.cp) { const d = await call('DELETE', `mwf_counterparties(${fx.cp})`); console.log(`counterparty: HTTP ${d.status}`); }
        const a = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value.length;
        const b = (await must('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value.length;
        const total = (await must('GET', `mwf_contracts?$select=mwf_contractid&$count=true&$top=1`)).j['@odata.count'];
        console.log(`check-clean (prefix ${PREFIX}): contracts ${a}, counterparties ${b}, total contracts ${total} (expected 0, 0, 11 when nothing else exists)`);
        if (a || b) exit = exit || 5;
        if (ctrSnap) { const rs = await restoreAfterRun(ctr, ctrSnap); if (rs.refused) exit = exit || 6; }
      }
    } catch (e) { console.error(`cleanup FAILED: ${noGuid(e.message)}`); exit = exit || 5; }
    if (table.length) {
      // flowruns lists FINISHED runs only (a row is written after the run ends), and a run that waits for an approval
      // is still Running. So a count taken right after the action cannot be a verdict. No NO/yes is printed.
      console.log('\n=== RESULT (actions and timestamps; the flow runs table cannot give a verdict)');
      for (const t of table) {
        const listed = t.count === null ? `not readable (${t.why})` : String(t.count);
        console.log(`case ${t.id} | ${t.what} | ${t.ts} | expected ${t.expected} new run(s) | in flowruns now: ${listed}`);
      }
      console.log('Not countable while a run is waiting (flowruns lists finished runs only); check the flow run history.');
    }
  }
  process.exit(exit);
})();
