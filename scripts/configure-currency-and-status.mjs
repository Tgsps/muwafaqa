#!/usr/bin/env node
/**
 * Steps (stop on any error, full error text printed, no fallbacks):
 *  1. Read the organization base currency (read only). Stops if it is not the expected ISO code.
 *  2. Set placeholder exchange rates on the non-base currency records (never touches the base currency).
 *  3. Exchange-rate test: 1 test counterparty + 2 test contracts (100 USD, 100 KWD), read back, delete only what this run created.
 *  4. Status Reason on mwf_contract: UpdateOptionValue on statuscode (EXPLICITLY UNDOCUMENTED experiment: rename 1 -> Draft, then 2 -> Rejected),
 *     then InsertStatusValue (documented) for Pending Approval / In Force under State 0. Nothing is deleted.
 *     If the rename of value 1 fails, the script stops and changes nothing else in this step.
 *
 * Auth: device code flow (public Azure CLI client id). Token in memory only.
 * Usage: node scripts/configure-currency-and-status.mjs --env=https://<org>.crm4.dynamics.com [--base=TRY] [--solution=Muwafaqa]
 */
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const LCID = 1033;
const TABLE = 'mwf_contract';
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const ENV = String(args.env ?? '').replace(/\/+$/, '');
const SOLUTION = String(args.solution ?? 'Muwafaqa');
const EXPECTED_BASE = String(args.base ?? 'TRY');
if (!ENV) { console.error('Missing --env=https://<org>.crm4.dynamics.com'); process.exit(2); }
const API = `${ENV}/api/data/v9.2`;

// Placeholder rates (units of the currency per 1 unit of the base currency). Test data, not market rates.
const RATES = { USD: 0.020408163265, KWD: 0.006666666667, AED: 0.076923076923, SAR: 0.076923076923 };

class Stop extends Error {}
const label = (t) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: LCID }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => encodeURIComponent(s).replace(/%24/g, '$');
const idOf = (e) => /\(([0-9a-f-]{36})\)/i.exec(e)?.[1];

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
async function dv(method, path, body, { meta = false } = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}`, 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' };
  if (meta) headers['MSCRM.SolutionUniqueName'] = SOLUTION;
  const r = await fetch(`${API}/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} failed (HTTP ${r.status}):\n${t}`);
  return t ? JSON.parse(t) : { entityId: r.headers.get('OData-EntityId') };
}
const attrPath = (n, extra = '') => `EntityDefinitions(LogicalName='${TABLE}')/Attributes(LogicalName='${n}')${extra}`;

async function readStatus() {
  const st = await dv('GET', attrPath('statuscode', '/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)'));
  return st.OptionSet.Options.map((o) => ({ Value: o.Value, Label: o.Label?.UserLocalizedLabel?.Label, State: o.State }));
}

try {
  TOKEN = await token();
  console.log('Signed in.');

  // ===== 1. base currency (read only) =====
  const org = await dv('GET', 'organizations?$select=name,_basecurrencyid_value');
  const baseId = org.value[0]._basecurrencyid_value;
  const baseCur = await dv('GET', `transactioncurrencies(${baseId})?$select=currencyname,isocurrencycode,exchangerate,currencyprecision`);
  console.log('\n(1) Organization base currency:');
  console.table([{ iso: baseCur.isocurrencycode, name: baseCur.currencyname, exchangerate: baseCur.exchangerate, precision: baseCur.currencyprecision }]);
  if (baseCur.isocurrencycode !== EXPECTED_BASE) throw new Stop(`Base currency is ${baseCur.isocurrencycode}, not the expected ${EXPECTED_BASE}. Nothing changed.`);

  // ===== 2. exchange rates =====
  const curs = await dv('GET', `transactioncurrencies?$select=transactioncurrencyid,currencyname,isocurrencycode,exchangerate,currencyprecision`);
  console.log('\n(2) Currency records before:');
  console.table(curs.value.map((c) => ({ iso: c.isocurrencycode, name: c.currencyname, exchangerate: c.exchangerate, precision: c.currencyprecision })));
  const changes = [];
  for (const [iso, rate] of Object.entries(RATES)) {
    const c = curs.value.find((x) => x.isocurrencycode === iso);
    if (!c) { changes.push({ iso, action: 'SKIPPED (no such currency record, not created)' }); continue; }
    if (c.transactioncurrencyid === baseId) { changes.push({ iso, action: 'SKIPPED (base currency, untouched)' }); continue; }
    await dv('PATCH', `transactioncurrencies(${c.transactioncurrencyid})`, { exchangerate: rate });
    changes.push({ iso, before: c.exchangerate, after: rate, action: 'updated' });
  }
  console.table(changes);
  const after = await dv('GET', `transactioncurrencies?$select=currencyname,isocurrencycode,exchangerate&$filter=${q("isocurrencycode eq 'USD' or isocurrencycode eq 'KWD' or isocurrencycode eq 'AED' or isocurrencycode eq 'SAR'")}`);
  console.log('Read back after update:');
  console.table(after.value.map((c) => ({ iso: c.isocurrencycode, exchangerate: c.exchangerate })));

  // ===== 3. exchange test =====
  console.log('\n(3) FX test');
  const usd = curs.value.find((c) => c.isocurrencycode === 'USD');
  const kwd = curs.value.find((c) => c.isocurrencycode === 'KWD');
  if (!usd || !kwd) throw new Stop('USD or KWD currency record missing.');
  const setName = (await dv('GET', `EntityDefinitions(LogicalName='${TABLE}')?$select=EntitySetName`)).EntitySetName;
  const made = []; let party = null;
  try {
    const p = await dv('POST', 'mwf_counterparties', { mwf_name: 'Fictional FX Test Co (TEST - delete me)', mwf_counterpartytype: 867640000 });
    party = idOf(p.entityId);
    const rows = [];
    for (const [tag, c] of [['USD 100', usd], ['KWD 100', kwd]]) {
      const r = await dv('POST', setName, { mwf_name: `TEST FX ${tag} (delete me)`, mwf_contracttype: 867640000, mwf_direction: 867640001, mwf_value: 100, 'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${party})`, 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${c.transactioncurrencyid})` });
      const id = idOf(r.entityId); made.push(id);
      const g = await dv('GET', `${setName}(${id})?$select=mwf_value,mwf_value_base,exchangerate`);
      rows.push({ test: tag, mwf_value: g.mwf_value, mwf_value_base: g.mwf_value_base, exchangerate: g.exchangerate });
    }
    console.table(rows);
  } finally {
    for (const id of made) { await dv('DELETE', `${setName}(${id})`); console.log(`Deleted test contract ${id}`); }
    if (party) { await dv('DELETE', `mwf_counterparties(${party})`); console.log(`Deleted test counterparty ${party}`); }
  }

  // ===== 4. Status Reason =====
  console.log('\n(4) Status Reason');
  console.log('Before:'); console.table(await readStatus());
  const cur = await readStatus();
  const labelOf = (v) => cur.find((o) => o.Value === v)?.Label;

  async function rename(value, text) {
    if (labelOf(value) === text) { console.log(`SKIP    rename ${value} -> ${text} (already)`); return; }
    await dv('POST', 'UpdateOptionValue', { AttributeLogicalName: 'statuscode', EntityLogicalName: TABLE, Value: value, Label: label(text), MergeLabels: true }, { meta: true });
    console.log(`RENAMED statuscode ${value} -> ${text}  (UpdateOptionValue, undocumented for statuscode)`);
  }
  try { await rename(1, 'Draft'); }
  catch (e) { throw new Error(`UpdateOptionValue on statuscode failed. Nothing else in step 4 was changed.\n${e.message}`); }
  await rename(2, 'Rejected');

  const have = (await readStatus());
  for (const [text, value] of [['Pending Approval', 867640000], ['In Force', 867640001]]) {
    if (have.some((o) => o.Label === text)) { console.log(`SKIP    insert ${text} (exists)`); continue; }
    const r = await dv('POST', 'InsertStatusValue', { AttributeLogicalName: 'statuscode', EntityLogicalName: TABLE, Label: label(text), StateCode: 0, Value: value, SolutionUniqueName: SOLUTION });
    console.log(`INSERTED ${text} = ${r.NewOptionValue}`);
  }
  console.log('\nstatuscode options after (nothing deleted):');
  console.table(await readStatus());
  console.log('\nDONE.');
} catch (e) {
  if (e instanceof Stop) { console.error('\nSTOP: ' + e.message); process.exit(3); }
  console.error('\nFAILED. Full error follows. Nothing further was attempted.\n');
  console.error(e.message);
  process.exit(1);
}
