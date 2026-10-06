#!/usr/bin/env node
/**
 * Creates the mwf_contract table (Phase 1) via the Dataverse Web API, then verifies it.
 * Source of truth: docs/data-model-phase1.md section 2.
 *
 * Auth: device code flow with the public Azure CLI client id. The token lives in memory only.
 * Metadata requests send MSCRM.SolutionUniqueName. Data requests (test rows) do not.
 * Idempotent: existing objects are skipped, never modified.
 * Any HTTP error stops the script with the full error text. No retries, no fallbacks.
 * Deliberate STOP points (exit code 3) are printed as "STOP:".
 *
 * Usage:
 *   node scripts/create-contract-table.mjs --env=https://<org>.crm4.dynamics.com [--solution=Muwafaqa] [--export=<zip path>] [--skip-fx]
 *
 * NOT done here (see docs): renaming the default Status Reason options. The Microsoft docs do not confirm
 * that UpdateOptionValue works on statuscode, so this script only reads statuscode.
 */
import { writeFileSync } from 'node:fs';

const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id
const LCID = 1033;
const TABLE = 'mwf_contract';
const PARENT = 'mwf_counterparty';
const REL = 'mwf_counterparty_mwf_contract';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const ENV = String(args.env ?? '').replace(/\/+$/, '');
const SOLUTION = String(args.solution ?? 'Muwafaqa');
const EXPORT_PATH = args.export ? String(args.export) : null;
if (!ENV) { console.error('Missing --env=https://<org>.crm4.dynamics.com'); process.exit(2); }
const API = `${ENV}/api/data/v9.2`;

class Stop extends Error {}

const label = (t) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: LCID }] });
const req = (v) => ({ Value: v });

// ---------- auth ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// ---------- http ----------
let TOKEN;
async function dv(method, path, body, { meta = true, allow404 = false } = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}`, 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' };
  if (meta) headers['MSCRM.SolutionUniqueName'] = SOLUTION;
  const r = await fetch(`${API}/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (r.status === 404 && allow404) return null;
  if (!r.ok) throw new Error(`${method} ${path} failed (HTTP ${r.status}):\n${t}`);
  if (t) return JSON.parse(t);
  return { entityId: r.headers.get('OData-EntityId') };
}
const q = (s) => encodeURIComponent(s).replace(/%24/g, '$');
const idOf = (entityId) => /\(([0-9a-f-]{36})\)/i.exec(entityId)?.[1];
const attrPath = (n, extra = '') => `EntityDefinitions(LogicalName='${TABLE}')/Attributes(LogicalName='${n}')${extra}`;

async function ensureAttribute(logicalName, body) {
  const ex = await dv('GET', attrPath(logicalName, '?$select=LogicalName,AttributeType'), null, { allow404: true });
  if (ex) { console.log(`SKIP    ${logicalName} (exists, ${ex.AttributeType})`); return 'skipped'; }
  await dv('POST', `EntityDefinitions(LogicalName='${TABLE}')/Attributes`, body);
  console.log(`CREATED ${logicalName}`);
  return 'created';
}

const picklist = (schema, display, desc, options, level) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata', SchemaName: schema, DisplayName: label(display), Description: label(desc), RequiredLevel: req(level),
  OptionSet: { '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata', IsGlobal: false, OptionSetType: 'Picklist', Options: options.map((o, i) => ({ Value: 867640000 + i, Label: label(o) })) },
});
const dateOnly = (schema, display, desc, level) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata', AttributeType: 'DateTime', AttributeTypeName: { Value: 'DateTimeType' },
  SchemaName: schema, DisplayName: label(display), Description: label(desc), RequiredLevel: req(level), Format: 'DateOnly', DateTimeBehavior: { Value: 'DateOnly' },
});

// ---------- main ----------
try {
  TOKEN = await token();
  console.log('Signed in.');
  const created = [];

  // preconditions (read-only)
  const sol = await dv('GET', `solutions?$select=solutionid,uniquename&$filter=${q(`uniquename eq '${SOLUTION}'`)}`, null, { meta: false });
  if (!sol.value.length) throw new Error(`Solution '${SOLUTION}' not found.`);
  const solutionId = sol.value[0].solutionid;
  const parent = await dv('GET', `EntityDefinitions(LogicalName='${PARENT}')?$select=LogicalName,OwnershipType,MetadataId`, null, { meta: false, allow404: true });
  if (!parent) throw new Error(`Table ${PARENT} not found.`);

  // 1. table
  let ent = await dv('GET', `EntityDefinitions(LogicalName='${TABLE}')?$select=LogicalName,MetadataId`, null, { allow404: true });
  if (ent) console.log(`SKIP    table ${TABLE} (exists)`);
  else {
    await dv('POST', 'EntityDefinitions', {
      '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
      SchemaName: 'mwf_Contract', // maker-style, same pattern as mwf_Counterparty
      DisplayName: label('Contract'), DisplayCollectionName: label('Contracts'),
      Description: label('A service contract with a counterparty. Phase 1 core table.'),
      OwnershipType: 'UserOwned', IsActivity: false, HasActivities: false, HasNotes: false,
      Attributes: [{
        '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' },
        SchemaName: 'mwf_Name', // maker-style primary name, same as mwf_Name on Counterparty
        DisplayName: label('Contract Subject'), Description: label('Subject of the contract. Primary name.'),
        RequiredLevel: { Value: 'ApplicationRequired', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
        FormatName: { Value: 'Text' }, MaxLength: 200, IsPrimaryName: true,
      }],
    });
    console.log(`CREATED table ${TABLE}`);
    created.push('table');
    for (let i = 0; i < 15; i++) { ent = await dv('GET', `EntityDefinitions(LogicalName='${TABLE}')?$select=LogicalName,MetadataId`, null, { allow404: true }); if (ent) break; await sleep(2000); }
    if (!ent) throw new Error('Table was created but is not readable after 30 s.');
  }
  const tableMetaId = ent.MetadataId;

  // 2. Value (Money) + checkpoint
  await ensureAttribute('mwf_value', {
    '@odata.type': 'Microsoft.Dynamics.CRM.MoneyAttributeMetadata', AttributeType: 'Money', AttributeTypeName: { Value: 'MoneyType' },
    SchemaName: 'mwf_value', DisplayName: label('Value'), Description: label('Contract value in the contract currency. The base amount (USD) is calculated by the platform.'),
    RequiredLevel: req('ApplicationRequired'), PrecisionSource: 2,
  });
  const attrsAfterMoney = await dv('GET', `EntityDefinitions(LogicalName='${TABLE}')/Attributes?$select=LogicalName,AttributeType,RequiredLevel,IsCustomAttribute`);
  const have = new Map(attrsAfterMoney.value.map((a) => [a.LogicalName, a]));
  console.log('\nColumns after the Money column:');
  console.table(attrsAfterMoney.value.filter((a) => /value|currency|exchange|mwf_/.test(a.LogicalName)).map((a) => ({ LogicalName: a.LogicalName, AttributeType: a.AttributeType, RequiredLevel: a.RequiredLevel?.Value })));
  const missing = ['transactioncurrencyid', 'exchangerate', 'mwf_value_base'].filter((n) => !have.has(n));
  if (missing.length) throw new Stop(`Missing after creating mwf_value: ${missing.join(', ')}. Not creating them explicitly. Waiting for owner decision.`);
  console.log(`transactioncurrencyid RequiredLevel = ${have.get('transactioncurrencyid').RequiredLevel?.Value} (read only, not modified)`);

  // 3. choices
  await ensureAttribute('mwf_contracttype', picklist('mwf_contracttype', 'Contract Type', 'Category of the contract.', ['Maintenance', 'Procurement', 'Insurance', 'Sales', 'Services'], 'ApplicationRequired'));
  await ensureAttribute('mwf_direction', picklist('mwf_direction', 'Contract Direction', 'Cash-flow direction from the organization perspective.', ['Income', 'Expense'], 'ApplicationRequired'));

  // 3b. contract number (plain text for now, ADR-002)
  await ensureAttribute('mwf_contractnumber', {
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' },
    SchemaName: 'mwf_contractnumber', DisplayName: label('Contract Number'), Description: label('Plain text for now. Generated by a plugin in Phase 2.'),
    RequiredLevel: req('None'), FormatName: { Value: 'Text' }, MaxLength: 100,
  });

  // 4. dates
  await ensureAttribute('mwf_signeddate', dateOnly('mwf_signeddate', 'Signed Date', 'Date the contract was signed. Empty while Draft.', 'None'));
  await ensureAttribute('mwf_effectivedate', dateOnly('mwf_effectivedate', 'Effective Date', 'Date the contract takes effect.', 'Recommended'));
  await ensureAttribute('mwf_expirydate', dateOnly('mwf_expirydate', 'Expiry Date', 'Date the contract expires.', 'Recommended'));

  // 5. relationship + lookup (Restrict on delete)
  const relEx = await dv('GET', `RelationshipDefinitions?$select=SchemaName&$filter=${q(`SchemaName eq '${REL}'`)}`);
  if (relEx.value.length) console.log(`SKIP    relationship ${REL} (exists)`);
  else {
    await dv('POST', 'RelationshipDefinitions', {
      '@odata.type': 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata', SchemaName: REL,
      ReferencedEntity: PARENT, ReferencedAttribute: 'mwf_counterpartyid', ReferencingEntity: TABLE,
      AssociatedMenuConfiguration: { Behavior: 'UseCollectionName', Group: 'Details', Label: label('Contracts'), Order: 10000 },
      CascadeConfiguration: { Assign: 'NoCascade', Delete: 'Restrict', Merge: 'NoCascade', Reparent: 'NoCascade', Share: 'NoCascade', Unshare: 'NoCascade' },
      Lookup: {
        '@odata.type': 'Microsoft.Dynamics.CRM.LookupAttributeMetadata', AttributeType: 'Lookup', AttributeTypeName: { Value: 'LookupType' },
        SchemaName: 'mwf_counterpartyid', DisplayName: label('Counterparty'), Description: label('The other party to the contract.'),
        RequiredLevel: { Value: 'ApplicationRequired', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
      },
    });
    console.log(`CREATED relationship ${REL} (Delete = Restrict)`);
  }

  // ---------- verification ----------
  console.log('\n===== VERIFICATION =====');
  const meta = await dv('GET', `EntityDefinitions(LogicalName='${TABLE}')?$select=LogicalName,SchemaName,EntitySetName,OwnershipType,PrimaryNameAttribute,PrimaryIdAttribute,HasNotes,HasActivities,MetadataId`);
  console.log('Table:', JSON.stringify(meta));
  const attrs = await dv('GET', `EntityDefinitions(LogicalName='${TABLE}')/Attributes?$select=LogicalName,SchemaName,AttributeType,RequiredLevel,IsCustomAttribute,MetadataId`);
  console.log('\n(a) Contract columns (all; custom marked):');
  console.table(attrs.value.filter((a) => a.IsCustomAttribute || /currency|exchange|statecode|statuscode|ownerid/.test(a.LogicalName)).map((a) => ({ LogicalName: a.LogicalName, SchemaName: a.SchemaName, AttributeType: a.AttributeType, RequiredLevel: a.RequiredLevel?.Value, Custom: a.IsCustomAttribute })).sort((x, y) => x.LogicalName.localeCompare(y.LogicalName)));

  console.log('(b) Choices:');
  for (const n of ['mwf_contracttype', 'mwf_direction']) {
    const p = await dv('GET', attrPath(n, '/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options,IsGlobal)'));
    console.log(`  ${n} (IsGlobal=${p.OptionSet.IsGlobal})`);
    console.table(p.OptionSet.Options.map((o) => ({ Value: o.Value, Label: o.Label?.UserLocalizedLabel?.Label })));
  }
  const st = await dv('GET', attrPath('statuscode', '/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)'));
  const sc = await dv('GET', attrPath('statecode', '/Microsoft.Dynamics.CRM.StateAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)'));
  console.log('  statecode options:');
  console.table(sc.OptionSet.Options.map((o) => ({ Value: o.Value, Label: o.Label?.UserLocalizedLabel?.Label, DefaultStatus: o.DefaultStatus })));
  console.log('  statuscode options (default, NOT renamed by this script):');
  console.table(st.OptionSet.Options.map((o) => ({ Value: o.Value, Label: o.Label?.UserLocalizedLabel?.Label, State: o.State })));

  console.log('(c) DateTimeBehavior of the three dates:');
  const dts = [];
  for (const n of ['mwf_signeddate', 'mwf_effectivedate', 'mwf_expirydate']) {
    const d = await dv('GET', attrPath(n, '/Microsoft.Dynamics.CRM.DateTimeAttributeMetadata?$select=LogicalName,Format,DateTimeBehavior'));
    dts.push({ LogicalName: d.LogicalName, Format: d.Format, DateTimeBehavior: d.DateTimeBehavior?.Value });
  }
  console.table(dts);

  const rel = await dv('GET', `RelationshipDefinitions(SchemaName='${REL}')/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencedAttribute,ReferencingAttribute,CascadeConfiguration`);
  console.log('Relationship:', JSON.stringify(rel));

  // (e) rootcomponentbehavior of the table component
  const comps = await dv('GET', `solutioncomponents?$select=objectid,componenttype,rootcomponentbehavior&$filter=${q(`_solutionid_value eq ${solutionId} and componenttype eq 1`)}`, null, { meta: false });
  console.log('(e) Entity components in solution:');
  console.table(comps.value.map((c) => ({ objectid: c.objectid, rootcomponentbehavior: c.rootcomponentbehavior, isContract: c.objectid.toLowerCase() === tableMetaId.toLowerCase(), isCounterparty: c.objectid.toLowerCase() === parent.MetadataId.toLowerCase() })));

  // (d) export unmanaged solution
  if (EXPORT_PATH) {
    const exp = await dv('POST', 'ExportSolution', { SolutionName: SOLUTION, Managed: false }, { meta: false });
    const buf = Buffer.from(exp.ExportSolutionFile, 'base64');
    writeFileSync(EXPORT_PATH, buf);
    console.log(`(d) Exported unmanaged solution: ${buf.length} bytes -> ${EXPORT_PATH}`);
  }

  // ---------- exchange test (creates rows, deletes only what this run created) ----------
  if (args['skip-fx']) { console.log('\nFX test skipped (--skip-fx).'); }
  else {
    console.log('\n===== FX TEST =====');
    const cur = await dv('GET', `transactioncurrencies?$select=transactioncurrencyid,currencyname,isocurrencycode,exchangerate,currencyprecision&$filter=${q("isocurrencycode eq 'USD' or isocurrencycode eq 'KWD'")}`, null, { meta: false });
    console.log('Currency records found:');
    console.table(cur.value.map((c) => ({ iso: c.isocurrencycode, name: c.currencyname, exchangerate: c.exchangerate, precision: c.currencyprecision })));
    const usd = cur.value.find((c) => c.isocurrencycode === 'USD');
    const kwd = cur.value.find((c) => c.isocurrencycode === 'KWD');
    if (!usd || !kwd) throw new Stop(`FX test needs currency records USD and KWD. Missing: ${[!usd && 'USD', !kwd && 'KWD'].filter(Boolean).join(', ')}. I did not create currency records. Everything above completed.`);

    const madeContracts = []; let madeParty = null;
    try {
      const p = await dv('POST', 'mwf_counterparties', { mwf_name: 'Fictional FX Test Co (TEST - delete me)', mwf_counterpartytype: 867640000 }, { meta: false });
      madeParty = idOf(p.entityId);
      console.log(`Created test counterparty ${madeParty}`);
      const rows = [];
      for (const [tag, c] of [['USD 100', usd], ['KWD 100', kwd]]) {
        const r = await dv('POST', meta.EntitySetName, {
          mwf_name: `TEST FX ${tag} (delete me)`, mwf_contracttype: 867640000, mwf_direction: 867640001, mwf_value: 100,
          'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${madeParty})`, 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${c.transactioncurrencyid})`,
        }, { meta: false });
        const id = idOf(r.entityId); madeContracts.push(id);
        const g = await dv('GET', `${meta.EntitySetName}(${id})?$select=mwf_value,mwf_value_base,exchangerate,_transactioncurrencyid_value,statecode,statuscode`, null, { meta: false });
        rows.push({ test: tag, mwf_value: g.mwf_value, mwf_value_base: g.mwf_value_base, exchangerate: g.exchangerate, statecode: g.statecode, statuscode: g.statuscode });
      }
      console.log('Results (read back from Dataverse):');
      console.table(rows);
    } finally {
      for (const id of madeContracts) { await dv('DELETE', `${meta.EntitySetName}(${id})`, null, { meta: false }); console.log(`Deleted test contract ${id}`); }
      if (madeParty) { await dv('DELETE', `mwf_counterparties(${madeParty})`, null, { meta: false }); console.log(`Deleted test counterparty ${madeParty}`); }
    }
  }
  console.log('\nDONE.');
} catch (e) {
  if (e instanceof Stop) { console.error('\nSTOP: ' + e.message); process.exit(3); }
  console.error('\nFAILED. Full error follows. Nothing further was attempted.\n');
  console.error(e.message);
  process.exit(1);
}
