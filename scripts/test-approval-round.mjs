#!/usr/bin/env node
/**
 * Integration tests for mwf_approvalround (ADR-005), through the Dataverse Web API.
 * FICTIONAL TEST-TMP-RND rows only. The approval flow must be OFF: every entry into Pending Approval would start a run.
 * The script reads the flow state first and stops if it is ON (or cannot be read; after checking by hand add --flow-off-confirmed).
 *
 * Cases:
 *   a   new Draft row: round is null or 0 (observation)
 *   1   Draft -> Pending Approval: round = 1 (and frozen USD value 1000.00)
 *   2   Pending -> Draft (withdraw): round stays 1
 *   3   Draft -> Pending Approval again: round = 2
 *   4   same-status save (Pending -> Pending): round unchanged
 *   5   client sets mwf_approvalround to a DIFFERENT value on Update (Pending): rejected, row unchanged
 *   5b  same on a Draft row: rejected
 *   6   client sends a value EQUAL to the stored one on Update: observation (expected rejected: the guard PreImage has 9 columns,
 *       without mwf_approvalround, so an equal non-null value reads as a change; fail closed)
 *   7   Pending -> In Force: round unchanged
 *   8   client sets mwf_approvalround on Create (5, and 0): rejected, no row created
 *   9   Create directly as Pending Approval: round value (observation, expected 1) and frozen 1000.00
 * After the cases: cleanup with the shared helper (scripts/lib/contract-cleanup.mjs), check-clean, and a read of the guard
 * Update step registration (filtering attributes count and PreImage attributes count).
 *
 * Usage:
 *   node scripts/test-approval-round.mjs --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment [--auth=device|az]
 *
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
import { execSync } from 'node:child_process';
import { deleteContracts, requireFlowOff, GUARD_DELETE_STEP_NAME } from './lib/contract-cleanup.mjs';
import { ctrIo, trackCreate, snapshotCounters, restoreAfterRun, restoreFromArgs, printHandoff } from './lib/counter-snapshot.mjs';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const ENV = argOf('env').replace(/\/+$/, '');
const AUTH = argOf('auth') || 'device';
const FLOW_OFF_CONFIRMED = process.argv.includes('--flow-off-confirmed');
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id, same as the other scripts
const PREFIX = 'TEST-TMP-RND';
const PENDING = 867640000;
const INFORCE = 867640001;
const DRAFT = 1;
const GUARD_UPDATE_STEP_NAME = GUARD_DELETE_STEP_NAME.replace(': Delete of', ': Update of');

if (!/^https:\/\/[^/]+$/.test(ENV)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
if (!['device', 'az'].includes(AUTH)) { console.error('Invalid --auth=device|az. Nothing was run.'); process.exit(2); }
if (!process.argv.includes('--confirm-mutates-environment')) {
  console.error(`WARNING: test-approval-round.mjs creates, updates and deletes ${PREFIX}* rows and moves them to Pending Approval. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
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

// ---- results
const results = [];
function out(status, id, what, expected, actual) {
  results.push({ status, id });
  console.log(`${status.padEnd(4)} [${id}] ${what}\n       expected: ${expected}\n       actual  : ${actual}`);
}
const show = (v) => (v === null || v === undefined ? 'null' : String(v));
const SEL = 'mwf_approvalround,mwf_valueusdfrozen,statuscode,statecode,mwf_value';
const read = async (id) => (await must('GET', `mwf_contracts(${id})?$select=${SEL}`)).j;
const patch = (id, body) => call('PATCH', `mwf_contracts(${id})`, body, { 'If-Match': '*' });
const two = (v) => (v === null || v === undefined ? 'null' : Number(v).toFixed(2));

const FX = { cp: null, usd: null, type: null, dir: null, ids: [] };
async function option(col, label) {
  const a = await must('GET', `EntityDefinitions(LogicalName='mwf_contract')/Attributes(LogicalName='${col}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`);
  const o = a.j.OptionSet.Options.find((x) => x.Label?.UserLocalizedLabel?.Label === label);
  if (!o) throw new Stop(`Option '${label}' of ${col} not found`);
  return o.Value;
}
function body(key, extra = {}) {
  return {
    mwf_name: `${PREFIX} ${key}`, mwf_value: 1000,
    mwf_contracttype: FX.type, mwf_direction: FX.dir,
    'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${FX.cp})`,
    'transactioncurrencyid@odata.bind': `/transactioncurrencies(${FX.usd})`,
    ...extra,
  };
}
async function newDraft(key) {
  const r = await must('POST', 'mwf_contracts', body(key));
  FX.ids.push(r.id);
  return r.id;
}

async function cases() {
  // a, 1, 2, 3, 4, 5, 6, 7 on one row
  const a = await newDraft('A');
  let g = await read(a);
  out('OBS', 'a', 'new Draft row: value of mwf_approvalround', 'null (a Whole Number column has no default)', show(g.mwf_approvalround));

  await must('PATCH', `mwf_contracts(${a})`, { statuscode: PENDING }, { 'If-Match': '*' });
  g = await read(a);
  out(g.mwf_approvalround === 1 && g.statuscode === PENDING && two(g.mwf_valueusdfrozen) === '1000.00' ? 'PASS' : 'FAIL', '1',
    'Draft -> Pending Approval', 'round 1, status Pending, frozen 1000.00', `round ${show(g.mwf_approvalround)}, status ${g.statuscode}, frozen ${two(g.mwf_valueusdfrozen)}`);

  await must('PATCH', `mwf_contracts(${a})`, { statuscode: DRAFT }, { 'If-Match': '*' });
  g = await read(a);
  out(g.mwf_approvalround === 1 && g.statuscode === DRAFT ? 'PASS' : 'FAIL', '2',
    'Pending -> Draft (withdraw)', 'round stays 1, status Draft', `round ${show(g.mwf_approvalround)}, status ${g.statuscode}`);

  await must('PATCH', `mwf_contracts(${a})`, { statuscode: PENDING }, { 'If-Match': '*' });
  g = await read(a);
  out(g.mwf_approvalround === 2 && g.statuscode === PENDING ? 'PASS' : 'FAIL', '3',
    'Draft -> Pending Approval again', 'round 2, status Pending', `round ${show(g.mwf_approvalround)}, status ${g.statuscode}`);

  const same = await patch(a, { statuscode: PENDING });
  g = await read(a);
  out(same.status === 204 && g.mwf_approvalround === 2 ? 'PASS' : 'FAIL', '4',
    'same-status save (Pending -> Pending)', 'HTTP 204, round unchanged (2)', `HTTP ${same.status}, round ${show(g.mwf_approvalround)}`);

  const diff = await patch(a, { mwf_approvalround: 7 });
  g = await read(a);
  const dm = msgOf(diff);
  out(diff.status === 400 && /Approval Round cannot be changed/.test(dm) && g.mwf_approvalround === 2 ? 'PASS' : 'FAIL', '5',
    'client sets mwf_approvalround = 7 on Update (Pending, stored 2)', 'HTTP 400 "Approval Round cannot be changed...", row unchanged (round 2)',
    `HTTP ${diff.status}; ${dm}; round ${show(g.mwf_approvalround)}`);

  const eq = await patch(a, { mwf_approvalround: 2 });
  g = await read(a);
  out('OBS', '6', 'client sends mwf_approvalround = 2 (EQUAL to the stored value) on Update',
    'observation; expected HTTP 400 (the guard PreImage has no mwf_approvalround, so an equal non-null value reads as a change)',
    `HTTP ${eq.status}${eq.ok ? '' : `; ${msgOf(eq)}`}; round after ${show(g.mwf_approvalround)}`);

  await must('PATCH', `mwf_contracts(${a})`, { statuscode: INFORCE }, { 'If-Match': '*' });
  g = await read(a);
  out(g.mwf_approvalround === 2 && g.statuscode === INFORCE ? 'PASS' : 'FAIL', '7',
    'Pending -> In Force', 'round unchanged (2), status In Force', `round ${show(g.mwf_approvalround)}, status ${g.statuscode}`);

  // 5b: a client write on a Draft row
  const b = await newDraft('B');
  const diffD = await patch(b, { mwf_approvalround: 5 });
  g = await read(b);
  out(diffD.status === 400 && g.mwf_approvalround === null ? 'PASS' : 'FAIL', '5b',
    'client sets mwf_approvalround = 5 on Update (Draft, stored null)', 'HTTP 400, round stays null', `HTTP ${diffD.status}; ${msgOf(diffD)}; round ${show(g.mwf_approvalround)}`);

  // 8: client sets it on Create
  for (const v of [5, 0]) {
    const key = `C${v}`;
    const r = await call('POST', 'mwf_contracts', body(key, { mwf_approvalround: v }));
    const found = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`mwf_name eq '${PREFIX} ${key}'`)}`)).j.value.length;
    if (found) FX.ids.push((await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`mwf_name eq '${PREFIX} ${key}'`)}`)).j.value[0].mwf_contractid);
    out(r.status === 400 && found === 0 && /Approval Round cannot be changed/.test(msgOf(r)) ? 'PASS' : 'FAIL', '8',
      `client sets mwf_approvalround = ${v} on Create`, 'HTTP 400 "Approval Round cannot be changed...", no row created', `HTTP ${r.status}; ${msgOf(r)}; rows created ${found}`);
  }

  // 9: Create directly as Pending Approval
  const p = await call('POST', 'mwf_contracts', body('D', { statuscode: PENDING }));
  if (!p.ok) {
    out('FAIL', '9', 'Create directly as Pending Approval', 'created', `HTTP ${p.status}; ${msgOf(p)}`);
  } else {
    const row = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`mwf_name eq '${PREFIX} D'`)}`)).j.value[0];
    FX.ids.push(row.mwf_contractid);
    g = await read(row.mwf_contractid);
    out('OBS', '9', 'Create directly as Pending Approval (API)', 'observation; expected round 1 and frozen 1000.00',
      `round ${show(g.mwf_approvalround)}, status ${g.statuscode}, frozen ${two(g.mwf_valueusdfrozen)} (the flow is OFF: nothing is claimed about runs)`);
  }
}

async function cleanupAll() {
  const rows = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value;
  const res = await deleteContracts(io, rows.map((r) => r.mwf_contractid));
  console.log(`contracts: found ${rows.length}, deleted ${res.deleted}${res.failed.length ? `, FAILED ${JSON.stringify(res.failed)}` : ''}`);
  const cps = (await must('GET', `mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value;
  for (const c of cps) { const d = await call('DELETE', `mwf_counterparties(${c.mwf_counterpartyid})`); console.log(`counterparty: HTTP ${d.status}`); }
  return res.failed.length === 0;
}

const ctr = ctrIo(call);
(async () => {
  let exit = 0;
  let ctrSnap = null;
  try {
    TOKEN = AUTH === 'az'
      ? execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim()
      : await deviceToken();
    await requireFlowOff(io, { confirmedByUser: FLOW_OFF_CONFIRMED });

    const pre = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'TEST-TMP')`)}`)).j.value.length;
    if (pre) throw new Stop(`${pre} TEST-TMP row(s) already exist. Nothing was changed.`);
    const total0 = (await must('GET', `mwf_contracts?$select=mwf_contractid&$count=true&$top=1`)).j['@odata.count'];
    console.log(`before: total contracts ${total0}`);
    ctrSnap = await snapshotCounters(ctr);

    const cpType = (await must('GET', `EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`)).j.OptionSet.Options[0].Value;
    const usd = (await must('GET', `transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0`)).j.value;
    if (usd.length !== 1) throw new Stop(`active USD currency: expected 1, found ${usd.length}`);
    FX.usd = usd[0].transactioncurrencyid;
    FX.type = await option('mwf_contracttype', 'Maintenance');
    FX.dir = await option('mwf_direction', 'Expense');
    FX.cp = (await must('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} Fictional Counterparty (delete me)`, mwf_counterpartytype: cpType })).id;

    await cases();
  } catch (e) {
    exit = 4;
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
  } finally {
    try {
      if (TOKEN) {
        console.log('\n--- cleanup (shared helper)');
        const ok = await cleanupAll();
        const a = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'TEST-TMP')`)}`)).j.value.length;
        const b = (await must('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=${q(`startswith(mwf_name,'TEST-TMP')`)}`)).j.value.length;
        const total = (await must('GET', `mwf_contracts?$select=mwf_contractid&$count=true&$top=1`)).j['@odata.count'];
        console.log(`check-clean: TEST-TMP contracts ${a}, TEST-TMP counterparties ${b}, total contracts ${total} (expected 0, 0, 11)`);
        if (!ok || a || b) exit = exit || 5;
        if (ctrSnap) { const rs = await restoreAfterRun(ctr, ctrSnap); if (rs.refused) exit = exit || 6; }

        // the guard Update step registration must be unchanged (filtering 10, PreImage 9)
        const st = (await must('GET', `sdkmessageprocessingsteps?$filter=${q(`name eq '${GUARD_UPDATE_STEP_NAME}'`)}&$select=name,filteringattributes`)).j.value;
        if (st.length === 1) {
          const im = (await must('GET', `sdkmessageprocessingstepimages?$filter=_sdkmessageprocessingstepid_value eq ${st[0].sdkmessageprocessingstepid}&$select=attributes`)).j.value;
          const f = (st[0].filteringattributes || '').split(',').filter(Boolean);
          const i = im.length ? (im[0].attributes || '').split(',').filter(Boolean) : [];
          console.log(`guard Update step: filtering attributes ${f.length} (contains mwf_approvalround: ${f.includes('mwf_approvalround')}), PreImage attributes ${i.length} (contains mwf_approvalround: ${i.includes('mwf_approvalround')}) (expected 10 and 9)`);
        } else console.log(`guard Update step: ${st.length} found`);
      }
    } catch (e) { console.error(`cleanup FAILED: ${noGuid(e.message)}`); exit = exit || 5; }
    const p = results.filter((r) => r.status === 'PASS').length;
    const f = results.filter((r) => r.status === 'FAIL').length;
    const o = results.filter((r) => r.status === 'OBS').length;
    console.log(`\nSUMMARY: ${p} passed, ${f} failed, ${o} observations.`);
    if (f && !exit) exit = 1;
  }
  process.exit(exit);
})();
