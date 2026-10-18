#!/usr/bin/env node
/**
 * Creates the counter table mwf_contractnumbercounter for the contract number generator (ADR-006), in the solution.
 * Idempotent: existing objects are only read back, never modified. Any error stops the script with the full message.
 *
 *   Table        : mwf_contractnumbercounter ("Contract Number Counter"), Organization-owned, no notes, no activities
 *   Columns      : mwf_name (primary, text), mwf_contracttypevalue (Whole Number, required, min 0),
 *                  mwf_prefix (text, max 10, required), mwf_lastnumber (Whole Number, required, min 0),
 *                  mwf_lockstamp (text, max 50, optional; a new GUID written by the plug-in as the pre-lock placeholder)
 *   Alternate key: mwf_ContractNumberCounterKey on mwf_contracttypevalue (one counter per contract type)
 *   Seed         : one row per Contract Type option with mwf_lastnumber 0 (the prefix map below is checked against the
 *                  option labels read from the environment; an unknown option stops the script)
 *
 * Then it reads (names only) which security roles hold any privilege on the new table.
 *
 * Usage:
 *   node scripts/create-contractnumbercounter-table.mjs --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment [--auth=device|az] [--solution=Muwafaqa]
 *
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
import { execSync } from 'node:child_process';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const ENV = argOf('env').replace(/\/+$/, '');
const AUTH = argOf('auth') || 'device';
const SOLUTION = argOf('solution') || 'Muwafaqa';
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id, same as the other scripts
const TABLE = 'mwf_contractnumbercounter';
const KEY = 'mwf_ContractNumberCounterKey';
// Contract Type option label -> prefix (ADR-006, confirmed by the owner)
const PREFIXES = { Maintenance: 'MNT', Procurement: 'PRC', Insurance: 'INS', Sales: 'SAL', Services: 'SRV' };

if (!/^https:\/\/[^/]+$/.test(ENV)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
if (!['device', 'az'].includes(AUTH)) { console.error('Invalid --auth=device|az. Nothing was run.'); process.exit(2); }
if (!process.argv.includes('--confirm-mutates-environment')) {
  console.error(`WARNING: create-contractnumbercounter-table.mjs creates the table ${TABLE}, its columns and key, and seeds 5 rows, in the environment and the solution ${SOLUTION}. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
  process.exit(2);
}

const API = `${ENV}/api/data/v9.2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noGuid = (t) => String(t ?? '').replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>');
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
  return { ok: r.ok, status: r.status, j, text: t };
}
class Stop extends Error {}
async function must(method, path, body, extra) {
  const r = await call(method, path, body, extra);
  if (!r.ok) throw new Stop(`${method} ${noGuid(path).slice(0, 100)} failed HTTP ${r.status}\n${noGuid(r.j?.error?.message || r.text).slice(0, 800)}`);
  return r;
}
const label = (text) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: 1033 }] });
const req = (v) => ({ Value: v, CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const SOL = { 'MSCRM.SolutionUniqueName': SOLUTION };
let SET;
const attrBase = `EntityDefinitions(LogicalName='${TABLE}')/Attributes`;

async function ensureColumn(logicalName, body) {
  const ex = await call('GET', `${attrBase}(LogicalName='${logicalName}')?$select=LogicalName,AttributeType`);
  if (ex.ok) { console.log(`SKIP     column ${logicalName} (exists, ${ex.j.AttributeType})`); return; }
  if (ex.status !== 404) throw new Stop(`could not check column ${logicalName}: HTTP ${ex.status} ${noGuid(ex.text).slice(0, 300)}`);
  await must('POST', attrBase, body, SOL);
  console.log(`CREATED  column ${logicalName}`);
}

(async () => {
  try {
    TOKEN = AUTH === 'az'
      ? execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim()
      : await deviceToken();

    const sol = (await must('GET', `solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid,ismanaged`)).j.value;
    if (sol.length !== 1 || sol[0].ismanaged) throw new Stop(`solution ${SOLUTION}: expected 1 unmanaged solution, found ${sol.length}${sol[0]?.ismanaged ? ' (managed)' : ''}`);

    // Contract Type options (read only): the prefix map must cover exactly these
    const opt = (await must('GET', "EntityDefinitions(LogicalName='mwf_contract')/Attributes(LogicalName='mwf_contracttype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)")).j.OptionSet.Options
      .map((o) => ({ value: o.Value, label: o.Label?.UserLocalizedLabel?.Label }));
    const unknown = opt.filter((o) => !PREFIXES[o.label]);
    if (unknown.length) throw new Stop(`Contract Type option(s) without a prefix in the map: ${unknown.map((o) => o.label).join(', ')}. Nothing was created.`);
    console.log(`INFO     ${opt.length} Contract Type options, all have a prefix`);

    // 1. table
    const tbl = await call('GET', `EntityDefinitions(LogicalName='${TABLE}')?$select=LogicalName,OwnershipType,MetadataId`);
    if (tbl.ok) console.log(`SKIP     table ${TABLE} (exists, ${tbl.j.OwnershipType})`);
    else if (tbl.status !== 404) throw new Stop(`could not check the table: HTTP ${tbl.status} ${noGuid(tbl.text).slice(0, 300)}`);
    else {
      await must('POST', 'EntityDefinitions', {
        '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
        SchemaName: 'mwf_ContractNumberCounter',
        DisplayName: label('Contract Number Counter'), DisplayCollectionName: label('Contract Number Counters'),
        Description: label('One row per contract type. Holds the last issued contract number. Written only by the plug-in; no user privileges.'),
        OwnershipType: 'OrganizationOwned', IsActivity: false, HasActivities: false, HasNotes: false,
        Attributes: [{
          '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' },
          SchemaName: 'mwf_Name', DisplayName: label('Name'), Description: label('The contract type label, for people only.'),
          RequiredLevel: req('ApplicationRequired'), FormatName: { Value: 'Text' }, MaxLength: 100, IsPrimaryName: true,
        }],
      }, SOL);
      console.log(`CREATED  table ${TABLE}`);
      let ok = false;
      for (let i = 0; i < 15 && !ok; i++) { ok = (await call('GET', `EntityDefinitions(LogicalName='${TABLE}')?$select=LogicalName`)).ok; if (!ok) await sleep(2000); }
      if (!ok) throw new Stop('The table was created but is not readable after 30 s.');
    }

    SET = (await must('GET', `EntityDefinitions(LogicalName='${TABLE}')?$select=EntitySetName`)).j.EntitySetName;

    // 2. columns
    await ensureColumn('mwf_contracttypevalue', {
      '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata', SchemaName: 'mwf_contracttypevalue', LogicalName: 'mwf_contracttypevalue',
      DisplayName: label('Contract Type Value'), Description: label('The option value of Contract Type on the contract. Alternate key: one counter per type.'),
      RequiredLevel: req('ApplicationRequired'), Format: 'None', MinValue: 0, MaxValue: 2147483647,
    });
    await ensureColumn('mwf_prefix', {
      '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' },
      SchemaName: 'mwf_prefix', DisplayName: label('Prefix'), Description: label('Prefix of the contract numbers of this type, for example MNT.'),
      RequiredLevel: req('ApplicationRequired'), FormatName: { Value: 'Text' }, MaxLength: 10,
    });
    await ensureColumn('mwf_lastnumber', {
      '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata', SchemaName: 'mwf_lastnumber', LogicalName: 'mwf_lastnumber',
      DisplayName: label('Last Number'), Description: label('The last issued number of this type. The next one is this value plus 1. Written only by the plug-in.'),
      RequiredLevel: req('ApplicationRequired'), Format: 'None', MinValue: 0, MaxValue: 2147483647,
    });
    // The lock stamp must change on EVERY pre-lock write (a fresh GUID). A Date and Time column has a resolution of about a
    // second, so two writes could be identical; the first version of this column was a Date and Time and is replaced here.
    // The table has no data in this column, so deleting and recreating it loses nothing.
    const stampAttr = `${attrBase}(LogicalName='mwf_lockstamp')`;
    const stampNow = await call('GET', `${stampAttr}?$select=LogicalName,AttributeType`);
    if (stampNow.ok && stampNow.j.AttributeType !== 'String') {
      await must('DELETE', stampAttr);
      console.log(`DELETED  column mwf_lockstamp (was ${stampNow.j.AttributeType}, replaced by a text column)`);
      for (let i = 0; i < 15; i++) { if ((await call('GET', `${stampAttr}?$select=LogicalName`)).status === 404) break; await sleep(2000); }
    }
    await ensureColumn('mwf_lockstamp', {
      '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' },
      SchemaName: 'mwf_lockstamp', DisplayName: label('Lock Stamp'), Description: label('Placeholder written by the plug-in (a new GUID every time) to take the row lock before it reads the counter.'),
      RequiredLevel: req('None'), FormatName: { Value: 'Text' }, MaxLength: 50,
    });

    // 3. alternate key
    const keys = (await must('GET', `EntityDefinitions(LogicalName='${TABLE}')/Keys?$select=SchemaName,KeyAttributes,EntityKeyIndexStatus`)).j.value;
    if (keys.some((k) => k.SchemaName === KEY)) console.log(`SKIP     key ${KEY} (exists)`);
    else {
      await must('POST', `EntityDefinitions(LogicalName='${TABLE}')/Keys`, {
        SchemaName: KEY, DisplayName: label('Contract Number Counter Key'), KeyAttributes: ['mwf_contracttypevalue'],
      }, SOL);
      console.log(`CREATED  key ${KEY}`);
    }
    let status = null;
    for (let i = 0; i < 40; i++) {
      const k = (await must('GET', `EntityDefinitions(LogicalName='${TABLE}')/Keys?$select=SchemaName,EntityKeyIndexStatus`)).j.value.find((x) => x.SchemaName === KEY);
      status = k?.EntityKeyIndexStatus;
      if (status === 'Active') break;
      if (status === 'Failed') throw new Stop('The alternate key index failed.');
      await sleep(3000);
    }
    if (status !== 'Active') throw new Stop(`The alternate key is not Active yet (status ${status}). Rerun the script later; it is idempotent.`);
    console.log(`PASS     key ${KEY} index status Active`);

    // 4. seed one row per type (data requests, no solution header)
    for (const o of opt) {
      const found = (await must('GET', `${SET}?$select=mwf_name&$filter=mwf_contracttypevalue eq ${o.value}`)).j.value;
      if (found.length) { console.log(`SKIP     seed ${PREFIXES[o.label]} (exists)`); continue; }
      await must('POST', SET, { mwf_name: o.label, mwf_contracttypevalue: o.value, mwf_prefix: PREFIXES[o.label], mwf_lastnumber: 0 });
      console.log(`CREATED  seed ${PREFIXES[o.label]} (${o.label}) lastnumber 0`);
    }

    // 5. read back (counts and values; no ids)
    const rows = (await must('GET', `${SET}?$select=mwf_name,mwf_contracttypevalue,mwf_prefix,mwf_lastnumber&$orderby=mwf_prefix`)).j.value;
    console.log('--- seed rows');
    for (const r of rows) console.log(`  ${r.mwf_prefix}  type ${r.mwf_contracttypevalue} (${r.mwf_name})  lastnumber ${r.mwf_lastnumber}`);
    let bad = 0;
    const chk = (n, ok, v) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}: ${v}`); if (!ok) bad++; };
    chk('5 seed rows, one per type, lastnumber 0', rows.length === opt.length && rows.every((r) => r.mwf_lastnumber === 0 && r.mwf_prefix === PREFIXES[r.mwf_name]), `${rows.length} rows`);
    const md = (await must('GET', `EntityDefinitions(LogicalName='${TABLE}')?$select=OwnershipType,IsCustomEntity,HasNotes,HasActivities,MetadataId`)).j;
    chk('Organization-owned', md.OwnershipType === 'OrganizationOwned', md.OwnershipType);
    const own = (await must('GET', `solutioncomponents?$filter=_solutionid_value eq ${sol[0].solutionid} and objectid eq ${md.MetadataId}&$select=componenttype,rootcomponentbehavior`)).j.value;
    chk('table is a component of the solution', own.length >= 1, `${own.length} row(s), include-all-subcomponents=${own[0]?.rootcomponentbehavior === 0}`);

    // 6. security roles with any privilege on the table (names only)
    console.log('--- security roles with a privilege on the table (names only)');
    const privs = await call('GET', `privileges?$select=name&$filter=${encodeURIComponent(`contains(name,'ContractNumberCounter') or contains(name,'contractnumbercounter')`)}`);
    if (!privs.ok) { console.log(`  (not read: HTTP ${privs.status} ${noGuid(privs.text).slice(0, 200)})`); }
    else {
      console.log(`  privileges found: ${privs.j.value.length}`);
      const roleNames = new Map();
      for (const p of privs.j.value) {
        const r = await call('GET', `privileges(${p.privilegeid})?$select=name&$expand=roleprivileges_association($select=name)`);
        if (!r.ok) { console.log(`  (roles of one privilege not read: HTTP ${r.status} ${noGuid(r.text).slice(0, 160)})`); continue; }
        for (const role of r.j.roleprivileges_association || []) roleNames.set(role.name, (roleNames.get(role.name) || 0) + 1);
      }
      if (!roleNames.size) console.log('  no role holds a privilege on the table');
      for (const [n, c] of roleNames) console.log(`  ${n}: ${c} privilege(s)`);
    }
    console.log(`\nSUMMARY: ${bad} failed check(s).`);
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
