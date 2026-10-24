#!/usr/bin/env node
/**
 * Test that a STALE approval run stops at the checkpoint after the contract was withdrawn and resubmitted
 * (ADR-005: the checkpoint compares mwf_approvalround, read after each stage, with the value from the trigger).
 * FICTIONAL TEST-TMP-RND-1 rows only.
 *
 * v1 AND v2: the approvals of the contract are found by their Subject with subjectOfTitle() (scripts/lib/run-attribution.mjs), which reads the v1
 * titles and the v2 titles ("Approve contract: <Subject> (step i of n, <role>)"). With v2 the contract (USD 1000, band 1) has a ONE-step chain, so "stage 1"
 * below means "step 1 of 1"; the scenario (two submissions, answer the older request) is the same.
 *
 * THIS TEST NEEDS THE APPROVAL FLOW ON (the opposite of most other scripts). The script reads the flow state (read only)
 * and refuses to run setup if the flow is OFF. It never turns the flow on or off.
 *
 * Modes:
 *   --mode=setup    needs --confirm-mutates-environment. Creates one counterparty and one Draft contract (TEST-TMP-RND-1), then:
 *                   PATCH to Pending Approval (submission 1, round 1, starts run 1), wait about 20 s, PATCH back to Draft
 *                   (withdraw), wait about 10 s, PATCH to Pending Approval again (submission 2, round 2, starts run 2).
 *                   Prints the status and mwf_approvalround after each step and the UTC time of each submission.
 *   --mode=read     read only. Status, state and mwf_approvalround of the test contract, and COUNTS of the approvals created
 *                   since the test contract was created (by status and result; no ids, no names).
 *   --mode=cleanup  needs --confirm-mutates-environment. Deletes the test contract and the counterparty with the shared helper
 *                   (Pending: withdrawn to Draft then deleted; In Force: bypass of the guard Delete step only), then check-clean.
 *
 * Usage:
 *   node scripts/test-flow-approvalround.mjs --mode=setup|read|cleanup --env=https://<org>.crm4.dynamics.com [--confirm-mutates-environment] [--auth=device|az]
 *
 * The token stays in memory and is never printed. No id, address, email or token is printed or stored.
 */
import { execSync } from 'node:child_process';
import { deleteContracts, approvalFlowState } from './lib/contract-cleanup.mjs';
import { ctrIo, trackCreate, snapshotCounters, restoreAfterRun, restoreFromArgs, printHandoff, requireStableConnection, cleanupHint } from './lib/counter-snapshot.mjs';
import { resilientFetch, enterCleanupPhase, recheckAfterWait } from './lib/resilient-fetch.mjs';
import { subjectOfTitle } from './lib/run-attribution.mjs';
import { expectContractsOrExit, describeExpectContracts } from './lib/expect-contracts.mjs';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const MODE = argOf('mode');
const EXPECT = expectContractsOrExit();   // contracts expected in the starting and the final state (argument, variable or default 11)
console.log(describeExpectContracts(EXPECT));
const ENV = argOf('env').replace(/\/+$/, '');
const AUTH = argOf('auth') || 'device';
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id, same as the other scripts
const SUBJECT = 'TEST-TMP-RND-1 stale run test';
const SCOPE = 'TEST-TMP-RND-1';   // this script's own prefix (the other scripts' rows are never touched)
const CP_NAME = 'TEST-TMP-RND-1 Fictional Counterparty (delete me)';
const PENDING = 867640000;
const DRAFT = 1;
const NAME = { 1: 'Draft', 867640000: 'Pending Approval', 867640001: 'In Force', 2: 'Rejected' };

if (!['setup', 'read', 'cleanup'].includes(MODE)) { console.error('Missing or invalid --mode=setup|read|cleanup. Nothing was run.'); process.exit(2); }
if (!/^https:\/\/[^/]+$/.test(ENV)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
if (!['device', 'az'].includes(AUTH)) { console.error('Invalid --auth=device|az. Nothing was run.'); process.exit(2); }
if (MODE !== 'read' && !process.argv.includes('--confirm-mutates-environment')) {
  console.error(`WARNING: --mode=${MODE} creates, updates or deletes the TEST-TMP-RND-1 rows, and the moves to Pending Approval start REAL flow runs and approval requests. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
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
const msgOf = (r) => noGuid(r.j?.error?.message || (r.ok ? '' : r.text) || '').replace(/\s+/g, ' ').trim().slice(0, 300);
const io = {
  get: async (p) => { const r = await call('GET', p); return { ok: r.ok, status: r.status, json: r.j, message: msgOf(r) }; },
  patch: async (p, b) => { const r = await call('PATCH', p, b, { 'If-Match': '*' }); return { ok: r.ok, status: r.status, message: msgOf(r) }; },
  del: async (p, h) => { const r = await call('DELETE', p, undefined, h || {}); return { ok: r.ok, status: r.status, message: msgOf(r) }; },
};

const SEL = 'mwf_name,statuscode,statecode,mwf_approvalround,mwf_valueusdfrozen,createdon';
const show = (v) => (v === null || v === undefined ? 'null' : String(v));
const testRows = async () => (await must('GET', `mwf_contracts?$select=${SEL}&$filter=${q(`mwf_name eq '${SUBJECT}'`)}`)).j.value;
const stateLine = (r) => `status ${NAME[r.statuscode] || r.statuscode} | statecode ${r.statecode} | mwf_approvalround ${show(r.mwf_approvalround)}`;

async function requireFlowOn() {
  const f = await approvalFlowState(io);
  if (!f.known) throw new Stop(`The flow state could not be read (${f.count} matching flow rows). Nothing was changed.`);
  if (!f.on) throw new Stop('The approval flow is OFF. This test needs it ON (it is about runs). Nothing was changed. This script never turns the flow on or off.');
  console.log('INFO  approval flow is ON (read only check)');
}

const ctr = ctrIo(call);

async function setup() {
  await requireFlowOn();
  const pre = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'${SCOPE}')`)}`)).j.value.length;
  if (pre) throw new Stop(`${pre} TEST-TMP row(s) already exist. Run --mode=cleanup first. Nothing was changed.`);
  const total0 = (await must('GET', `mwf_contracts?$select=mwf_contractid&$count=true&$top=1`)).j['@odata.count'];
  console.log(`before: total contracts ${total0}`);
  const ctrSnap = await snapshotCounters(ctr);

  const opt = async (col, label) => {
    const a = await must('GET', `EntityDefinitions(LogicalName='mwf_contract')/Attributes(LogicalName='${col}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`);
    const o = a.j.OptionSet.Options.find((x) => x.Label?.UserLocalizedLabel?.Label === label);
    if (!o) throw new Stop(`Option '${label}' of ${col} not found`);
    return o.Value;
  };
  const cpType = (await must('GET', `EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`)).j.OptionSet.Options[0].Value;
  const usd = (await must('GET', `transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0`)).j.value;
  if (usd.length !== 1) throw new Stop(`active USD currency: expected 1, found ${usd.length}`);

  const cp = (await must('POST', 'mwf_counterparties', { mwf_name: CP_NAME, mwf_counterpartytype: cpType })).id;
  const id = (await must('POST', 'mwf_contracts', {
    mwf_name: SUBJECT, mwf_value: 1000,
    mwf_contracttype: await opt('mwf_contracttype', 'Maintenance'), mwf_direction: await opt('mwf_direction', 'Expense'),
    'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${cp})`,
    'transactioncurrencyid@odata.bind': `/transactioncurrencies(${usd[0].transactioncurrencyid})`,
  })).id;
  const move = async (statuscode) => must('PATCH', `mwf_contracts(${id})`, { statuscode }, { 'If-Match': '*' });
  const now = async () => (await must('GET', `mwf_contracts(${id})?$select=${SEL}`)).j;

  console.log(`created: Draft | ${stateLine(await now())}`);

  const t1 = new Date();
  console.log(`\n--- submission 1 at UTC ${t1.toISOString()}  (PATCH Draft -> Pending Approval, starts run 1)`);
  await move(PENDING);
  console.log(`after submission 1: ${stateLine(await now())}   (expected round 1)`);

  console.log('waiting about 20 s ...');
  await sleep(20000);
  await recheckAfterWait(call, cleanupHint(SCOPE, ctrSnap));   // connection back before the next write, else stop with nothing written
  console.log(`\n--- withdraw (PATCH Pending Approval -> Draft) at UTC ${new Date().toISOString()}`);
  await move(DRAFT);
  console.log(`after withdraw: ${stateLine(await now())}   (expected round stays 1)`);

  console.log('waiting about 10 s ...');
  await sleep(10000);
  await recheckAfterWait(call, cleanupHint(SCOPE, ctrSnap));
  const t2 = new Date();
  console.log(`\n--- submission 2 at UTC ${t2.toISOString()}  (PATCH Draft -> Pending Approval, starts run 2)`);
  await move(PENDING);
  const fin = await now();
  console.log(`after submission 2: ${stateLine(fin)}   (expected round 2)`);

  printHandoff(ctrSnap);
  console.log(`
=== WHAT TO DO NEXT (in Power Automate / the approvals app)
 Two runs should have started: run 1 at about ${t1.toISOString()} and run 2 at about ${t2.toISOString()}.
 Two stage 1 approval requests exist for this contract. Tell them apart by their creation time (the older one belongs to run 1).
 Expected outcome (to be documented only after you run it, nothing is claimed here):
   - answer the stage 1 request of run 1 (the older one): run 1 should stop at "Stop - contract no longer Pending (stage 1)" (its round, 1,
     no longer matches the stored round 2);
   - answer the stage 1 request of run 2: run 2 should continue to stage 2.
 Then tell me to run --mode=read, and --mode=cleanup when you are done.`);
}

async function read() {
  const f = await approvalFlowState(io);
  console.log(`flow state: ${f.known ? (f.on ? 'ON' : 'OFF') : 'could not be read'}`);
  const rows = await testRows();
  if (rows.length !== 1) throw new Stop(`Expected 1 test contract, found ${rows.length}.`);
  const r = rows[0];
  console.log(`contract: ${stateLine(r)}`);

  // approvals created since the test contract was created, counts only (read independently of the flow run history)
  const since = new Date(new Date(r.createdon).getTime() - 60000).toISOString();
  const resp = await call('GET', `msdyn_flow_approvals?$select=statuscode,statecode,msdyn_flow_approval_result,msdyn_flow_approval_title,createdon&$filter=${q(`createdon ge ${since}`)}&$top=200`, undefined,
    { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' });
  if (!resp.ok) { console.log(`approvals: not readable (HTTP ${resp.status})`); return; }
  const everything = resp.j.value || [];
  // only the approvals of THIS contract (the Subject is read from the title); others created in the same window are excluded and counted separately
  // subjectOfTitle() understands the v1 titles and the v2 titles ("Approve contract: <Subject> (step i of n, <role>)", "For information: contract <Subject> (...)")
  const list = everything.filter((x) => subjectOfTitle(x.msdyn_flow_approval_title) === SUBJECT);
  const fv = (x, k) => x[`${k}@OData.Community.Display.V1.FormattedValue`] ?? x[k];
  const by = {};
  for (const x of list) { const k = `${fv(x, 'statuscode')} / result ${fv(x, 'msdyn_flow_approval_result') ?? 'none'}`; by[k] = (by[k] || 0) + 1; }
  console.log(`approvals of this contract (matched by title) created since it was created: ${list.length}   (approvals of other contracts in the same window, excluded: ${everything.length - list.length})`);
  for (const [k, n] of Object.entries(by)) console.log(`   ${k}: ${n}`);
  console.log('Matched by the approval title (the Subject); the title is the only link the table gives to the contract, so this is an attribution by name, not by id.');
  console.log('The flow runs are not read here (flowruns lists finished runs only); check the flow run history.');
}

async function cleanup() {
  enterCleanupPhase();   // from here DELETE is retried (404 = already gone) and reads are more patient
  const rows = await testRows();
  console.log(`test contracts found: ${rows.length}`);
  for (const r of rows) {
    const [res] = [await deleteContracts(io, [r.mwf_contractid])];
    console.log(`  status before: ${NAME[r.statuscode] || r.statuscode} | deleted ${res.deleted}${res.failed.length ? ` | FAILED ${JSON.stringify(res.failed)}` : ''}`);
    if (res.failed.length) throw new Stop('The contract could not be deleted. Nothing else was changed.');
  }
  const cps = (await must('GET', `mwf_counterparties?$select=mwf_name&$filter=${q(`mwf_name eq '${CP_NAME}'`)}`)).j.value;
  for (const c of cps) { const d = await call('DELETE', `mwf_counterparties(${c.mwf_counterpartyid})`); console.log(`counterparty: HTTP ${d.status}`); }
  const a = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'${SCOPE}')`)}`)).j.value.length;
  const b = (await must('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=${q(`startswith(mwf_name,'${SCOPE}')`)}`)).j.value.length;
  const total = (await must('GET', `mwf_contracts?$select=mwf_contractid&$count=true&$top=1`)).j['@odata.count'];
  console.log(`check-clean (prefix ${SCOPE}): contracts ${a}, counterparties ${b}, total contracts ${total} (expected 0, 0, ${EXPECT.value} when nothing else exists)`);
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
    else if (MODE === 'read') await read();
    else await cleanup();
  } catch (e) {
    exit = 4;
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
  }
  process.exit(exit);
})();
