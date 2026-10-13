#!/usr/bin/env node
/**
 * Loads the fictitious test data (data/counterparties.csv, data/contracts.csv) through the Dataverse Web API.
 *
 * - Auth: device code flow, token in memory only.
 * - Idempotent: counterparties are keyed by name, contracts by Contract Number. Existing rows are skipped, never changed.
 * - The "Approx. USD" notes are ignored. No base amount is computed: Dataverse calculates mwf_value_base from the currency records.
 * - Currency lookup is matched by ISO code (USD/KWD/AED/SAR) against EXISTING currency records. Currency records are never touched or created.
 * - Contract statuses: only Draft, In Force and Rejected are produced. A contract whose CSV status is "Pending Approval" is loaded as Draft
 *   (use --skip-pending to skip those rows instead). Non-default statuses are set by updates after creation and verified by reading back.
 *   Under the Contract State Guard (ADR-004) In Force and Rejected are reached by the ALLOWED transitions: Draft -> Pending Approval -> In Force
 *   and Draft -> Pending Approval -> Rejected. Moving a row to Pending Approval starts an approval flow run when the flow is ON, and the
 *   plug-in FreezeUsdValueOnSubmission writes mwf_valueusdfrozen, so the approval flow must be OFF: the script reads the flow state before
 *   the first such row and stops if it is ON (or cannot be read; after checking by hand add --flow-off-confirmed).
 * - Any HTTP error, missing currency, or failed verification stops the script with the full error. No retries, no fallbacks.
 *
 * Usage: node scripts/load-test-data.mjs --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment [--skip-pending] [--flow-off-confirmed]
 *
 * The script WRITES to the environment (counterparties, contracts, status changes). Without --confirm-mutates-environment it prints
 * why and exits with code 2 without sending anything (same behavior as the other mutating scripts).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { requireFlowOff } from './lib/contract-cleanup.mjs';

const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const ENV = String(args.env ?? '').replace(/\/+$/, '');
if (!ENV) { console.error('Missing --env=https://<org>.crm4.dynamics.com'); process.exit(2); }
if (!args['confirm-mutates-environment']) {
  console.error([
    'WARNING: load-test-data.mjs WRITES to the environment:',
    '  - creates counterparties and contracts (existing rows are skipped, never changed)',
    '  - moves contracts to Pending Approval and then to In Force or Rejected (approval flow must be OFF)',
    '  - the plug-in writes mwf_valueusdfrozen on every contract that passes Pending Approval',
    'Nothing was run. To run it on purpose, add --confirm-mutates-environment (and --env=<url>).',
  ].join('\n'));
  process.exit(2);
}
const API = `${ENV}/api/data/v9.2`;
const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

// CSV currency name -> ISO code (matching is done on the ISO code of the existing currency records)
const NAME_TO_ISO = { 'US Dollar': 'USD', 'Kuwaiti Dinar': 'KWD', 'UAE Dirham': 'AED', 'Saudi Riyal': 'SAR' };
const ALLOWED_STATUS = ['Draft', 'In Force', 'Rejected'];

class Stop extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => encodeURIComponent(s).replace(/%24/g, '$');
const lit = (s) => String(s).replace(/'/g, "''");
const idOf = (e) => /\(([0-9a-f-]{36})\)/i.exec(e)?.[1];

function parseCsv(path) {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x !== ''));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

async function form(url, f) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = null; }
  return { ok: r.ok, status: r.status, j, t };
}
async function token() {
  const base = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
  const dc = await form(`${base}/devicecode`, { client_id: CLIENT_ID, scope: `${ENV}/.default` });
  if (!dc.ok) throw new Error(`Device code request failed (HTTP ${dc.status}):\n${dc.t}`);
  console.log(`\nSIGN-IN URL : ${dc.j.verification_uri}\nDEVICE CODE : ${dc.j.user_code}\n(single use, ${Math.round(dc.j.expires_in / 60)} min). Waiting for sign-in...\n`);
  let iv = (dc.j.interval ?? 5) * 1000; const end = Date.now() + dc.j.expires_in * 1000;
  while (Date.now() < end) {
    await sleep(iv);
    const t = await form(`${base}/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, device_code: dc.j.device_code });
    if (t.ok) return t.j.access_token;
    const e = t.j?.error;
    if (e === 'authorization_pending') continue;
    if (e === 'slow_down') { iv += 5000; continue; }
    throw new Error(`Token request failed (HTTP ${t.status}):\n${t.t}`);
  }
  throw new Error('Device code expired. Rerun for a new code.');
}
let TOKEN;
async function dv(method, path, body) {
  const r = await fetch(`${API}/${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} failed (HTTP ${r.status}):\n${t}`);
  return t ? JSON.parse(t) : { entityId: r.headers.get('OData-EntityId') };
}
// adapter for the shared helper (scripts/lib/contract-cleanup.mjs): reads only
const io = {
  get: async (p) => { try { return { ok: true, status: 200, json: await dv('GET', p) }; } catch (e) { return { ok: false, status: 0, message: String(e.message).slice(0, 200) }; } },
};
let flowChecked = false;
async function ensureFlowOff() {
  if (flowChecked) return;
  await requireFlowOff(io, { confirmedByUser: args['flow-off-confirmed'] === true });
  flowChecked = true;
}
const attr = (table, n, kind) => `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${n}')/Microsoft.Dynamics.CRM.${kind}?$select=LogicalName&$expand=OptionSet($select=Options)`;
async function optionMap(table, n, kind = 'PicklistAttributeMetadata') {
  const a = await dv('GET', attr(table, n, kind));
  return new Map(a.OptionSet.Options.map((o) => [o.Label?.UserLocalizedLabel?.Label, { value: o.Value, state: o.State }]));
}

try {
  const cpRows = parseCsv(join(DATA, 'counterparties.csv'));
  const ctRows = parseCsv(join(DATA, 'contracts.csv'));
  console.log(`CSV rows: ${cpRows.length} counterparties, ${ctRows.length} contracts`);
  for (const r of ctRows) {
    if (!NAME_TO_ISO[r.transactioncurrencyid]) throw new Stop(`Unknown currency name in CSV: '${r.transactioncurrencyid}' (${r.mwf_contractnumber})`);
  }

  TOKEN = await token();
  console.log('Signed in.');

  // currency records (read only)
  const curs = await dv('GET', `transactioncurrencies?$select=transactioncurrencyid,currencyname,isocurrencycode,exchangerate&$filter=${q("isocurrencycode eq 'USD' or isocurrencycode eq 'KWD' or isocurrencycode eq 'AED' or isocurrencycode eq 'SAR'")}`);
  const isoToId = new Map(curs.value.map((c) => [c.isocurrencycode, c.transactioncurrencyid]));
  const idToIso = new Map(curs.value.map((c) => [c.transactioncurrencyid, c.isocurrencycode]));
  const missing = ['USD', 'KWD', 'AED', 'SAR'].filter((i) => !isoToId.has(i));
  if (missing.length) throw new Stop(`Currency records missing: ${missing.join(', ')}. Not creating currency records.`);
  console.log('Currency records used (not modified):');
  console.table(curs.value.map((c) => ({ iso: c.isocurrencycode, name: c.currencyname, exchangerate: c.exchangerate })));

  // option maps from metadata (no hardcoded numbers)
  const cpType = await optionMap('mwf_counterparty', 'mwf_counterpartytype');
  const ctType = await optionMap('mwf_contract', 'mwf_contracttype');
  const ctDir = await optionMap('mwf_contract', 'mwf_direction');
  const stat = await optionMap('mwf_contract', 'statuscode', 'StatusAttributeMetadata');
  const need = (map, label, what) => { const o = map.get(label); if (!o) throw new Stop(`No ${what} option labelled '${label}'.`); return o; };
  for (const s of [...ALLOWED_STATUS, 'Pending Approval']) need(stat, s, 'Status Reason');   // Pending Approval is the stop on the way to In Force / Rejected

  // ---------- counterparties ----------
  let cpCreated = 0, cpSkipped = 0; const cpId = new Map();
  for (const r of cpRows) {
    const ex = await dv('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=${q(`mwf_name eq '${lit(r.mwf_name)}'`)}`);
    if (ex.value.length) { cpId.set(r.mwf_name, ex.value[0].mwf_counterpartyid); cpSkipped++; console.log(`SKIP    counterparty ${r.mwf_name} (exists)`); continue; }
    const c = await dv('POST', 'mwf_counterparties', {
      mwf_name: r.mwf_name, mwf_counterpartytype: need(cpType, r.mwf_counterpartytype, 'Counterparty Type').value,
      mwf_commercialregistration: r.mwf_commercialregistration, mwf_contactname: r.mwf_contactname, mwf_email: r.mwf_email,
    });
    cpId.set(r.mwf_name, idOf(c.entityId)); cpCreated++; console.log(`CREATED counterparty ${r.mwf_name}`);
  }

  // ---------- contracts ----------
  let ctCreated = 0, ctSkipped = 0, ctOmitted = 0; const notes = new Map();
  for (const r of ctRows) {
    const num = r.mwf_contractnumber;
    let status = r.statuscode;
    if (!['Draft', 'In Force', 'Rejected', 'Pending Approval'].includes(status)) throw new Stop(`Unexpected CSV status '${status}' for ${num}`);
    if (status === 'Pending Approval') {
      if (args['skip-pending']) { ctOmitted++; console.log(`OMIT    ${num} (CSV status Pending Approval, --skip-pending)`); continue; }
      status = 'Draft'; notes.set(num, 'CSV said Pending Approval, loaded as Draft');
    }
    const ex = await dv('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`mwf_contractnumber eq '${lit(num)}'`)}`);
    if (ex.value.length) { ctSkipped++; console.log(`SKIP    contract ${num} (exists)`); continue; }
    const cp = cpId.get(r.mwf_counterpartyid);
    if (!cp) throw new Stop(`Counterparty '${r.mwf_counterpartyid}' for ${num} not found in the loaded counterparties.`);
    const body = {
      mwf_name: r.mwf_name, mwf_contractnumber: num,
      mwf_contracttype: need(ctType, r.mwf_contracttype, 'Contract Type').value, mwf_direction: need(ctDir, r.mwf_direction, 'Contract Direction').value,
      mwf_value: Number(r.mwf_value),
      'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${cp})`,
      'transactioncurrencyid@odata.bind': `/transactioncurrencies(${isoToId.get(NAME_TO_ISO[r.transactioncurrencyid])})`,
    };
    if (r.mwf_signeddate) body.mwf_signeddate = r.mwf_signeddate;
    if (r.mwf_effectivedate) body.mwf_effectivedate = r.mwf_effectivedate;
    if (r.mwf_expirydate) body.mwf_expirydate = r.mwf_expirydate;
    if (status !== 'Draft') await ensureFlowOff();   // the route to In Force / Rejected passes Pending Approval
    const created = await dv('POST', 'mwf_contracts', body);
    const id = idOf(created.entityId); ctCreated++;
    console.log(`CREATED contract ${num}`);

    // non-default status: update after creation by the transitions the guard allows (Draft -> Pending Approval -> status), verify each
    if (status !== 'Draft') {
      for (const step of ['Pending Approval', status]) {
        const t = need(stat, step, 'Status Reason');
        await dv('PATCH', `mwf_contracts(${id})`, { statecode: t.state, statuscode: t.value });
        const g = await dv('GET', `mwf_contracts(${id})?$select=statecode,statuscode`);
        if (g.statuscode !== t.value || g.statecode !== t.state) throw new Error(`Status verification failed for ${num}: expected state ${t.state}/status ${t.value}, got ${g.statecode}/${g.statuscode}`);
        console.log(`  status -> ${step} (verified: state ${g.statecode}, status ${g.statuscode})`);
      }
    }
  }

  // ---------- summary ----------
  console.log('\nSummary:');
  console.table([
    { table: 'Counterparty', created: cpCreated, skipped: cpSkipped },
    { table: 'Contract', created: ctCreated, skipped: ctSkipped, omitted: ctOmitted },
  ]);
  const idToStatus = new Map([...stat.entries()].map(([l, o]) => [o.value, l]));
  const out = [];
  for (const r of ctRows) {
    const num = r.mwf_contractnumber;
    const g = await dv('GET', `mwf_contracts?$select=mwf_value,mwf_value_base,statuscode,statecode,_transactioncurrencyid_value,exchangerate&$filter=${q(`mwf_contractnumber eq '${lit(num)}'`)}`);
    if (!g.value.length) { out.push({ 'Contract Number': num, Currency: '-', Value: '-', 'Base amount (TRY)': '-', Status: '(not loaded)', Note: notes.get(num) ?? '' }); continue; }
    const c = g.value[0];
    out.push({ 'Contract Number': num, Currency: idToIso.get(c._transactioncurrencyid_value) ?? c._transactioncurrencyid_value, Value: c.mwf_value, 'Base amount (TRY)': c.mwf_value_base, Status: idToStatus.get(c.statuscode) ?? c.statuscode, Note: notes.get(num) ?? '' });
  }
  console.table(out);
  console.log('\nDONE.');
} catch (e) {
  if (e instanceof Stop) { console.error('\nSTOP: ' + e.message); process.exit(3); }
  console.error('\nFAILED. Full error follows. Nothing further was attempted.\n');
  console.error(e.message);
  process.exit(1);
}
