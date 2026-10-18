#!/usr/bin/env node
/**
 * Test of the two checkpoints of the approval flow "Muwafaqa - Contract Approval v1" (the flow ends with Terminate,
 * status Cancelled, when the contract is no longer Pending Approval after a stage). FICTIONAL TEST-TMP-CHK rows only.
 * The approval flow must be ON. This script never turns the flow on or off.
 *
 * Contracts (USD 1000, Maintenance, Expense):
 *   TEST-TMP-CHK1 normal                    approve stage 1 and stage 2          expected: In Force, run Succeeded
 *   TEST-TMP-CHK2 withdrawn before stage 1  withdrawn to Draft at once           expected: Draft,    run Cancelled (checkpoint 1)
 *   TEST-TMP-CHK3 withdrawn after stage 1   withdrawn after stage 1 is approved  expected: Draft,    run Cancelled (checkpoint 2)
 *   TEST-TMP-CHK4 rejected                  rejected at stage 1                  expected: Rejected (Inactive), run Succeeded
 *
 * Modes:
 *   --mode=setup      creates the counterparty and the four contracts (Draft), moves all four to Pending Approval,
 *                     verifies the frozen value 1000.00, withdraws CHK2 to Draft immediately, prints what to do next.
 *   --mode=withdraw3  withdraws CHK3 to Draft (Pending -> Draft). Run it AFTER stage 1 of CHK3 was approved.
 *   --mode=read       reads the four rows and, read only, the finished runs of this flow from the flowruns table
 *                     (a row appears only after a run ends; retries for about 3 minutes). Never guesses.
 *   --mode=cleanup    deletes the four contracts and the counterparty with the shared helper, then check-clean.
 *
 * Usage:
 *   node scripts/test-flow-checkpoints.mjs --mode=setup|withdraw3|read|cleanup --env=https://<org>.crm4.dynamics.com
 *        [--confirm-mutates-environment] [--auth=device|az]        (the flag is required for setup, withdraw3 and cleanup)
 *
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
import { execSync } from 'node:child_process';
import { deleteContract, findGuardDeleteStepId, approvalFlowState } from './lib/contract-cleanup.mjs';
import { ctrIo, trackCreate, snapshotCounters, restoreAfterRun, restoreFromArgs, printHandoff, requireStableConnection } from './lib/counter-snapshot.mjs';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const MODE = argOf('mode');
const ENV = argOf('env').replace(/\/+$/, '');
const AUTH = argOf('auth') || 'device';
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id, same as the other scripts
const PREFIX = 'TEST-TMP-CHK';
const PENDING = 867640000;
const DRAFT = 1;
const NAME = { 1: 'Draft', 867640000: 'Pending Approval', 867640001: 'In Force', 2: 'Rejected' };
const CONTRACTS = [
  { n: 1, subject: `${PREFIX}1 normal`, expect: { status: 867640001, state: 0, run: 'Succeeded' } },
  { n: 2, subject: `${PREFIX}2 withdrawn before stage 1`, expect: { status: 1, state: 0, run: 'Cancelled (checkpoint 1)' } },
  { n: 3, subject: `${PREFIX}3 withdrawn after stage 1`, expect: { status: 1, state: 0, run: 'Cancelled (checkpoint 2)' } },
  { n: 4, subject: `${PREFIX}4 rejected`, expect: { status: 2, state: 1, run: 'Succeeded' } },
];

if (!['setup', 'withdraw3', 'read', 'cleanup'].includes(MODE)) { console.error('Missing or invalid --mode=setup|withdraw3|read|cleanup. Nothing was run.'); process.exit(2); }
if (!/^https:\/\/[^/]+$/.test(ENV)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
if (!['device', 'az'].includes(AUTH)) { console.error('Invalid --auth=device|az. Nothing was run.'); process.exit(2); }
if (MODE !== 'read' && !process.argv.includes('--confirm-mutates-environment')) {
  console.error(`WARNING: --mode=${MODE} creates, updates or deletes ${PREFIX}* rows, and a move to Pending Approval starts REAL flow runs and approval requests. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
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

const SEL = 'mwf_name,mwf_contractnumber,statuscode,statecode,mwf_valueusdfrozen,createdon';
const two = (v) => (v === null || v === undefined ? 'null' : Number(v).toFixed(2));
const rows = async () => (await must('GET', `mwf_contracts?$select=${SEL}&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}&$orderby=mwf_name`)).j.value;
const byNumber = (list, n) => list.find((r) => r.mwf_name.startsWith(`${PREFIX}${n} `));   // found by Subject (the number is generated)

async function requireFlowOn() {
  const f = await approvalFlowState(io);
  if (!f.known) throw new Stop(`The flow state could not be read (${f.count} matching flow rows). Nothing was changed.`);
  if (!f.on) throw new Stop('The approval flow is OFF. This test needs it ON. Nothing was changed.');
  console.log('INFO  approval flow is ON (read only check)');
}

const ctr = ctrIo(call);

async function setup() {
  await requireFlowOn();
  const existing = await rows();
  if (existing.length) throw new Stop(`${existing.length} row(s) with the prefix ${PREFIX} already exist. Run --mode=cleanup first. Nothing was changed.`);
  const opt = async (col, label) => {
    const a = await must('GET', `EntityDefinitions(LogicalName='mwf_contract')/Attributes(LogicalName='${col}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`);
    const o = a.j.OptionSet.Options.find((x) => x.Label?.UserLocalizedLabel?.Label === label);
    if (!o) throw new Stop(`Option '${label}' of ${col} not found`);
    return o.Value;
  };
  const cpType = (await must('GET', `EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`)).j.OptionSet.Options[0].Value;
  const usd = (await must('GET', `transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0`)).j.value;
  if (usd.length !== 1) throw new Stop(`active USD currency: expected 1, found ${usd.length}`);
  const type = await opt('mwf_contracttype', 'Maintenance');
  const dir = await opt('mwf_direction', 'Expense');

  const ctrSnap = await snapshotCounters(ctr);
  const cp = (await must('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} Fictional Counterparty (delete me)`, mwf_counterpartytype: cpType })).id;
  const ids = {};
  for (const c of CONTRACTS) {
    ids[c.n] = (await must('POST', 'mwf_contracts', {
      mwf_name: c.subject, mwf_value: 1000, mwf_contracttype: type, mwf_direction: dir,
      'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${cp})`,
      'transactioncurrencyid@odata.bind': `/transactioncurrencies(${usd[0].transactioncurrencyid})`,
    })).id;
  }
  console.log(`created: 1 counterparty and ${CONTRACTS.length} contracts (Draft)`);

  const t0 = new Date();
  console.log(`--- move all four to Pending Approval. UTC time before the first move: ${t0.toISOString()}`);
  for (const c of CONTRACTS) await must('PATCH', `mwf_contracts(${ids[c.n]})`, { statuscode: PENDING }, { 'If-Match': '*' });
  const after = await rows();
  let ok = true;
  for (const c of CONTRACTS) {
    const r = byNumber(after, c.n);
    const good = r.statuscode === PENDING && two(r.mwf_valueusdfrozen) === '1000.00';
    ok = ok && good;
    console.log(`  ${c.subject} | ${NAME[r.statuscode] || r.statuscode} | frozen ${two(r.mwf_valueusdfrozen)} | ${good ? 'PASS' : 'FAIL'}`);
  }
  if (!ok) throw new Stop('A contract is not Pending Approval with the frozen value 1000.00. Stopping (nothing cleaned).');

  console.log('--- withdraw CHK2 to Draft immediately');
  await must('PATCH', `mwf_contracts(${ids[2]})`, { statuscode: DRAFT }, { 'If-Match': '*' });
  const chk2 = byNumber(await rows(), 2);
  console.log(`  ${chk2.mwf_name} | ${NAME[chk2.statuscode] || chk2.statuscode}  (expected Draft)`);

  printHandoff(ctrSnap);
  console.log(`
=== WHAT TO DO NEXT (in Power Automate / the approvals app)
 Four runs should have started at about ${t0.toISOString()} (one per contract). Identify each approval by the contract
 subject. Then, in this order:
  1. CHK1 "${CONTRACTS[0].subject}": approve stage 1, then approve stage 2.
  2. CHK2 "${CONTRACTS[1].subject}": its stage 1 approval is still outstanding; APPROVE it. The run should end at checkpoint 1
     and never send a stage 2 request.
  3. CHK4 "${CONTRACTS[3].subject}": REJECT stage 1.
  4. CHK3 "${CONTRACTS[2].subject}": approve stage 1 ONLY. Do NOT answer its stage 2 request yet. Then tell me, and I run
     --mode=withdraw3.
 After my withdraw3 message, answer the stage 2 request of CHK3 (approve), wait for the runs to finish, then tell me to run --mode=read.`);
}

async function withdraw3() {
  await requireFlowOn();
  const r = byNumber(await rows(), 3);
  if (!r) throw new Stop('CHK3 does not exist. Run --mode=setup first. Nothing was changed.');
  console.log(`CHK3 now: ${NAME[r.statuscode] || r.statuscode}`);
  if (r.statuscode !== PENDING) throw new Stop(`CHK3 is not Pending Approval (it is ${NAME[r.statuscode] || r.statuscode}). Nothing was changed.`);
  await must('PATCH', `mwf_contracts(${r.mwf_contractid})`, { statuscode: DRAFT }, { 'If-Match': '*' });
  const a = byNumber(await rows(), 3);
  console.log(`CHK3 after: ${NAME[a.statuscode] || a.statuscode}  (expected Draft)`);
  console.log(`
=== WHAT TO DO NEXT
 Now answer the stage 2 request of CHK3 (approve). Wait until all four runs have finished, then tell me to run --mode=read.`);
}

async function read() {
  const f = await approvalFlowState(io);
  console.log(`flow state: ${f.known ? (f.on ? 'ON' : 'OFF') : 'could not be read'}`);
  const list = await rows();
  if (!list.length) throw new Stop(`No ${PREFIX} rows found.`);
  console.log('\n=== rows');
  let allOk = true;
  for (const c of CONTRACTS) {
    const r = byNumber(list, c.n);
    if (!r) { console.log(`${c.subject} | not found`); allOk = false; continue; }
    const good = r.statuscode === c.expect.status && r.statecode === c.expect.state;
    allOk = allOk && good;
    console.log(`${c.subject} | status ${NAME[r.statuscode] || r.statuscode} | state ${r.statecode === 0 ? 'Active' : 'Inactive'} | frozen ${two(r.mwf_valueusdfrozen)} | expected ${NAME[c.expect.status]} / ${c.expect.state === 0 ? 'Active' : 'Inactive'} | ${good ? 'MATCH' : 'DIFFERENT'}`);
  }
  console.log(`rows match the expected final state: ${allOk ? 'yes' : 'NO'}`);

  // flow runs (finished runs only), read only
  console.log('\n=== flow runs from the flowruns table (finished runs only; retrying for about 3 minutes)');
  const wf = (await must('GET', `workflows?$filter=${q(`category eq 5 and contains(name,'Contract Approval')`)}&$select=name,workflowid,workflowidunique`)).j.value;
  if (wf.length !== 1) { console.log(`flow row: ${wf.length} found; runs cannot be attributed. Not guessing.`); return; }
  const ids = [wf[0].workflowid, wf[0].workflowidunique].filter(Boolean).map((x) => String(x).toLowerCase());
  const since = new Date(Math.min(...list.map((r) => new Date(r.createdon).getTime())) - 60000);
  let mine = []; let readable = true; let note = '';
  for (let i = 0; i < 9; i++) {
    const r = await call('GET', `flowruns?$filter=${q(`starttime ge ${since.toISOString()}`)}&$orderby=starttime&$select=starttime,endtime,status,errorcode,errormessage,_workflow_value`);
    if (!r.ok) { readable = false; note = `HTTP ${r.status}: ${msgOf(r)}`; break; }
    mine = (r.j.value || []).filter((x) => ids.includes(String(x._workflow_value ?? '').toLowerCase()));
    if (mine.length >= 4) break;
    console.log(`  attempt ${i + 1}: ${mine.length} finished run(s) listed so far, waiting 20 s`);
    await sleep(20000);
  }
  if (!readable) { console.log(`flowruns not readable: ${note}`); return; }
  console.log(`finished runs of this flow started after ${since.toISOString()}: ${mine.length}`);
  mine.forEach((x, i) => console.log(`  run ${i + 1} (by start order) | start ${x.starttime} | end ${x.endtime} | ${x.status}${x.errormessage ? ` | ${noGuid(x.errormessage).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`));
  console.log('The flowruns table does not say which contract a run belongs to: the order above is the START order, and the four');
  console.log('runs started in the order CHK1, CHK2, CHK3, CHK4 (inferred from the order of the moves, not read from the table).');
  if (mine.length < 4) console.log(`NOT AVAILABLE: only ${mine.length} of the 4 expected runs are listed (a run appears after it ends). Check the run history.`);
  const failed = mine.filter((x) => /fail/i.test(String(x.status)));
  console.log(`runs with status Failed: ${failed.length} (expected 0)`);
}

async function cleanup() {
  const list = await rows();
  console.log(`contracts found: ${list.length}`);
  if (list.length) {
    // one row at a time with the shared helper, so that HOW each row was deleted is printed (no ids)
    let stepId = null; let looked = false; let failed = 0;
    for (const r of list) {
      let d = await deleteContract(io, r.mwf_contractid, { bypassStepId: stepId });
      if (!d.deleted && d.statuscode === 867640001 && !looked) {
        looked = true; stepId = await findGuardDeleteStepId(io);
        if (stepId) d = await deleteContract(io, r.mwf_contractid, { bypassStepId: stepId });
      }
      console.log(`  ${r.mwf_name} | status before: ${NAME[r.statuscode] || r.statuscode} | ${d.how} | HTTP ${d.status ?? '-'} | ${d.deleted ? 'deleted' : 'NOT DELETED'}`);
      if (!d.deleted) failed++;
    }
    if (failed) throw new Stop(`${failed} row(s) could not be deleted. Nothing else was changed.`);
  }
  const cps = (await must('GET', `mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value;
  for (const c of cps) { const d = await call('DELETE', `mwf_counterparties(${c.mwf_counterpartyid})`); console.log(`counterparty: HTTP ${d.status}`); }
  const a = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'TEST-TMP')`)}`)).j.value.length;
  const b = (await must('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=${q(`startswith(mwf_name,'TEST-TMP')`)}`)).j.value.length;
  const total = (await must('GET', `mwf_contracts?$select=mwf_contractid&$count=true&$top=1`)).j['@odata.count'];
  console.log(`check-clean: TEST-TMP contracts ${a}, TEST-TMP counterparties ${b}, total contracts ${total} (expected 0, 0, 11)`);
  if (a === 0 && b === 0) await restoreFromArgs(ctr);
}

(async () => {
  let exit = 0;
  try {
    TOKEN = AUTH === 'az'
      ? execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim()
      : await deviceToken();
    await requireStableConnection(call);   // 3 GET requests in a row before any write (counter helper)
    if (MODE === 'setup') await setup();
    else if (MODE === 'withdraw3') await withdraw3();
    else if (MODE === 'read') await read();
    else await cleanup();
  } catch (e) {
    exit = 4;
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
  }
  process.exit(exit);
})();
