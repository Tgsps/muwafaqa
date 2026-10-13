#!/usr/bin/env node
/**
 * Adds the column mwf_approvalround (Whole Number) to mwf_contract through the Dataverse Web API, in the solution.
 * Idempotent: if the column exists it is only read back.
 *
 *   Display name : Approval Round
 *   Type         : Whole Number, Format None, min 0, max 2147483647, not required
 *   Description  : Incremented by plug-in on each real Draft -> Pending Approval submission. Read-only for clients.
 *
 * Whole Number columns have no default value in the metadata (IntegerAttributeMetadata has none), so a new row holds null.
 * The plug-in treats null as 0.
 *
 * Usage:
 *   node scripts/add-approvalround-column.mjs --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment [--auth=device|az] [--solution=Muwafaqa]
 *
 * It adds the column to the solution with the MSCRM.SolutionUniqueName header at creation, then reads the metadata back and
 * counts the solution component rows for the column. The token stays in memory and is never printed. No id, address or
 * token is printed or stored.
 */
import { execSync } from 'node:child_process';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const ENV = argOf('env').replace(/\/+$/, '');
const AUTH = argOf('auth') || 'device';
const SOLUTION = argOf('solution') || 'Muwafaqa';
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id, same as the other scripts
const TABLE = 'mwf_contract';
const COLUMN = 'mwf_approvalround';
const DESCRIPTION = 'Incremented by plug-in on each real Draft -> Pending Approval submission. Read-only for clients.';

if (!/^https:\/\/[^/]+$/.test(ENV)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
if (!['device', 'az'].includes(AUTH)) { console.error('Invalid --auth=device|az. Nothing was run.'); process.exit(2); }
if (!process.argv.includes('--confirm-mutates-environment')) {
  console.error(`WARNING: add-approvalround-column.mjs creates the column ${COLUMN} on ${TABLE} in the environment and adds it to the solution ${SOLUTION}. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
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

(async () => {
  try {
    TOKEN = AUTH === 'az'
      ? execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim()
      : await deviceToken();

    const sol = (await must('GET', `solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid,ismanaged`)).j.value;
    if (sol.length !== 1 || sol[0].ismanaged) throw new Stop(`solution ${SOLUTION}: expected 1 unmanaged solution, found ${sol.length}${sol[0]?.ismanaged ? ' (managed)' : ''}`);

    const attrPath = `EntityDefinitions(LogicalName='${TABLE}')/Attributes(LogicalName='${COLUMN}')`;
    const existing = await call('GET', `${attrPath}?$select=LogicalName`);
    if (existing.ok) {
      console.log(`SKIP  the column ${COLUMN} already exists (idempotent), no create`);
    } else if (existing.status !== 404) {
      throw new Stop(`could not check the column: HTTP ${existing.status} ${noGuid(existing.text).slice(0, 300)}`);
    } else {
      await must('POST', `EntityDefinitions(LogicalName='${TABLE}')/Attributes`, {
        '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
        SchemaName: COLUMN,
        LogicalName: COLUMN,
        DisplayName: label('Approval Round'),
        Description: label(DESCRIPTION),
        RequiredLevel: { Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
        Format: 'None',
        MinValue: 0,
        MaxValue: 2147483647,
        IsAuditEnabled: { Value: true, CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyauditsettings' },
      }, { 'MSCRM.SolutionUniqueName': SOLUTION });
      console.log(`CREATED  the column ${COLUMN} with the solution header ${SOLUTION}`);
    }

    // read the metadata back (retry a few times: the metadata cache may need a moment)
    let md = null;
    for (let i = 0; i < 10; i++) {
      const r = await call('GET', `${attrPath}/Microsoft.Dynamics.CRM.IntegerAttributeMetadata?$select=LogicalName,SchemaName,AttributeType,Format,MinValue,MaxValue,RequiredLevel,IsCustomAttribute,IsAuditEnabled,IsValidForCreate,IsValidForUpdate,MetadataId,DisplayName,Description`);
      if (r.ok) { md = r.j; break; }
      await sleep(3000);
    }
    if (!md) throw new Stop('The column could not be read back after creation.');
    const lbl = (l) => l?.LocalizedLabels?.[0]?.Label;
    console.log('--- metadata read back');
    const checks = [
      ['logical name', md.LogicalName === COLUMN, md.LogicalName],
      ['type Integer (Whole Number)', md.AttributeType === 'Integer', md.AttributeType],
      ['format None', md.Format === 'None', md.Format],
      ['min 0', md.MinValue === 0, md.MinValue],
      ['max 2147483647', md.MaxValue === 2147483647, md.MaxValue],
      ['required level None', md.RequiredLevel?.Value === 'None', md.RequiredLevel?.Value],
      ['display name "Approval Round"', lbl(md.DisplayName) === 'Approval Round', lbl(md.DisplayName)],
      ['description as specified', lbl(md.Description) === DESCRIPTION, lbl(md.Description) === DESCRIPTION ? 'yes' : lbl(md.Description)],
      ['custom column', md.IsCustomAttribute === true, md.IsCustomAttribute],
      ['valid for create and update (the guard, not the metadata, locks it)', md.IsValidForCreate === true && md.IsValidForUpdate === true, `${md.IsValidForCreate}/${md.IsValidForUpdate}`],
    ];
    let bad = 0;
    for (const [n, ok, v] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}: ${v}`); if (!ok) bad++; }

    // A column of a table that is in the solution with "include all subcomponents" (rootcomponentbehavior 0) has no row of its
    // own in solutioncomponents (the existing custom columns have none either). So: the column's own row, or the table row.
    const ownRows = (await must('GET', `solutioncomponents?$filter=_solutionid_value eq ${sol[0].solutionid} and objectid eq ${md.MetadataId}&$select=componenttype`)).j.value;
    const ent = (await must('GET', `EntityDefinitions(LogicalName='${TABLE}')?$select=MetadataId`)).j.MetadataId;
    const tableRows = (await must('GET', `solutioncomponents?$filter=_solutionid_value eq ${sol[0].solutionid} and objectid eq ${ent}&$select=componenttype,rootcomponentbehavior`)).j.value;
    const viaTable = tableRows.length >= 1 && tableRows[0].rootcomponentbehavior === 0;
    const inSol = ownRows.length >= 1 || viaTable;
    console.log(`${inSol ? 'PASS' : 'FAIL'}  the column belongs to the solution ${SOLUTION}: own component rows=${ownRows.length}, table is a component with include-all-subcomponents=${viaTable}`);
    if (!inSol) bad++;
    console.log(`\nSUMMARY: ${checks.length + 1 - bad} passed, ${bad} failed.`);
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
