#!/usr/bin/env node
/**
 * Adds the four remaining columns to mwf_counterparty via the Dataverse Web API.
 * Source of truth: docs/data-model-phase1.md section 1 (same definitions as Add-CounterpartyColumns.ps1).
 *
 * - Auth: OAuth 2.0 device code flow with the public Azure CLI client id. No az install needed.
 *   The access token lives in memory only. It is never written to disk or printed.
 *   Each device code is single-use: on expiry, rerun the script to get a new one.
 * - Idempotent: an existing column is skipped (never modified, never deleted).
 * - Scope: only the table mwf_counterparty. Every request sends MSCRM.SolutionUniqueName.
 * - Any failure stops the script and prints the full error. No retries, no fallbacks.
 *
 * Usage:
 *   node scripts/add-counterparty-columns.mjs --env=https://<org>.crm4.dynamics.com [--solution=Muwafaqa] [--tenant=organizations] [--dry-run]
 *
 * Requires Node 18+ (global fetch).
 */

const AZURE_CLI_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public client id of Azure CLI
const TABLE = 'mwf_counterparty';
const LANGUAGE_CODE = 1033; // English (Base language)

// ---------- args ----------

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const ENV_URL = String(args.env ?? '').replace(/\/+$/, '');
const SOLUTION = String(args.solution ?? 'Muwafaqa');
const TENANT = String(args.tenant ?? 'organizations');
const DRY_RUN = Boolean(args['dry-run']);
if (!ENV_URL) {
  console.error('Missing --env=https://<org>.crm4.dynamics.com');
  process.exit(2);
}
const API = `${ENV_URL}/api/data/v9.2`;

// ---------- column definitions ----------
// The data model does not specify max length for the text columns. 100 was approved by the owner.

const label = (text) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.Label',
  LocalizedLabels: [
    { '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: LANGUAGE_CODE },
  ],
});

const typeOptions = ['Supplier', 'Customer', 'Contractor', 'Partner', 'Other'];

const COLUMNS = [
  {
    logicalName: 'mwf_counterpartytype',
    body: {
      '@odata.type': 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata',
      SchemaName: 'mwf_counterpartytype',
      DisplayName: label('Type'),
      Description: label('Role of the counterparty.'),
      RequiredLevel: { Value: 'ApplicationRequired' }, // Business Required
      OptionSet: {
        '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata',
        IsGlobal: false,
        OptionSetType: 'Picklist',
        Options: typeOptions.map((t, i) => ({ Value: 867640000 + i, Label: label(t) })),
      },
    },
  },
  {
    logicalName: 'mwf_commercialregistration',
    body: {
      '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
      SchemaName: 'mwf_commercialregistration',
      DisplayName: label('Commercial Registration'),
      Description: label('Fictitious values only, e.g. TEST-CR-0001.'),
      RequiredLevel: { Value: 'None' },
      MaxLength: 100,
      FormatName: { Value: 'Text' },
    },
  },
  {
    logicalName: 'mwf_contactname',
    body: {
      '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
      SchemaName: 'mwf_contactname',
      DisplayName: label('Contact'),
      Description: label('Free text role or department label. No person names.'),
      RequiredLevel: { Value: 'None' },
      MaxLength: 100,
      FormatName: { Value: 'Text' },
    },
  },
  {
    logicalName: 'mwf_email',
    body: {
      '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
      SchemaName: 'mwf_email',
      DisplayName: label('Email'),
      Description: label('Reserved example domains only (example.com, example.test).'),
      RequiredLevel: { Value: 'None' },
      MaxLength: 100,
      FormatName: { Value: 'Email' },
    },
  },
];

if (DRY_RUN) {
  console.log(`DRY RUN (no network). Target ${API}, solution ${SOLUTION}`);
  for (const c of COLUMNS) {
    console.log(`\nPOST EntityDefinitions(LogicalName='${TABLE}')/Attributes  [${c.logicalName}]`);
    console.log(`header MSCRM.SolutionUniqueName: ${SOLUTION}`);
    console.log(JSON.stringify(c.body, null, 2));
  }
  process.exit(0);
}

// ---------- auth: device code flow (token in memory only) ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function formPost(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}

async function acquireToken() {
  const base = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
  const dc = await formPost(`${base}/devicecode`, {
    client_id: AZURE_CLI_CLIENT_ID,
    scope: `${ENV_URL}/.default`,
  });
  if (!dc.ok) throw new Error(`Device code request failed (HTTP ${dc.status}):\n${dc.text}`);

  console.log('');
  console.log(`SIGN-IN URL : ${dc.json.verification_uri}`);
  console.log(`DEVICE CODE : ${dc.json.user_code}`);
  console.log(`(expires in ${Math.round(dc.json.expires_in / 60)} min; single use). Waiting for sign-in...`);
  console.log('');

  let interval = (dc.json.interval ?? 5) * 1000;
  const deadline = Date.now() + dc.json.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const t = await formPost(`${base}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: AZURE_CLI_CLIENT_ID,
      device_code: dc.json.device_code,
    });
    if (t.ok) return t.json.access_token;
    const err = t.json?.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    throw new Error(`Token request failed (HTTP ${t.status}):\n${t.text}`);
  }
  throw new Error('Device code expired before sign-in completed. Rerun the script for a new code.');
}

// ---------- Dataverse helpers ----------

let TOKEN;

async function dv(method, path, body) {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      'MSCRM.SolutionUniqueName': SOLUTION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw new Error(`${method} ${path} failed (HTTP ${res.status}):\n${text}`);
  return text ? JSON.parse(text) : { status: res.status, entityId: res.headers.get('OData-EntityId') };
}

const q = (s) => encodeURIComponent(s).replace(/%24/g, '$');

// ---------- main ----------

try {
  TOKEN = await acquireToken();
  console.log('Signed in.');

  // Preconditions (read-only)
  const sol = await dv('GET', `solutions?$select=solutionid,uniquename&$filter=${q(`uniquename eq '${SOLUTION}'`)}`);
  if (!sol || sol.value.length === 0) throw new Error(`Solution '${SOLUTION}' not found. Stopping.`);
  const solutionId = sol.value[0].solutionid;

  const ent = await dv('GET', `EntityDefinitions(LogicalName='${TABLE}')?$select=LogicalName,OwnershipType,PrimaryNameAttribute`);
  if (!ent) throw new Error(`Table '${TABLE}' not found. Stopping.`);
  console.log(`Table ${ent.LogicalName}: OwnershipType=${ent.OwnershipType}, PrimaryNameAttribute=${ent.PrimaryNameAttribute}`);
  if (ent.OwnershipType !== 'OrganizationOwned') {
    throw new Error(`Expected OrganizationOwned (data model D4) but found '${ent.OwnershipType}'. Stopping.`);
  }

  // Create (idempotent)
  const summary = [];
  for (const c of COLUMNS) {
    const existing = await dv('GET', `EntityDefinitions(LogicalName='${TABLE}')/Attributes(LogicalName='${c.logicalName}')?$select=LogicalName,AttributeType`);
    if (existing) {
      console.log(`SKIP    ${c.logicalName} (exists, AttributeType=${existing.AttributeType})`);
      summary.push({ column: c.logicalName, action: 'skipped (exists)' });
      continue;
    }
    await dv('POST', `EntityDefinitions(LogicalName='${TABLE}')/Attributes`, c.body);
    console.log(`CREATED ${c.logicalName}`);
    summary.push({ column: c.logicalName, action: 'created' });
  }
  console.log('\nSummary:');
  console.table(summary);

  // (a) custom columns with logical names
  const attrs = await dv('GET', `EntityDefinitions(LogicalName='${TABLE}')/Attributes?$select=LogicalName,SchemaName,AttributeType,RequiredLevel,IsCustomAttribute,MetadataId`);
  const custom = attrs.value.filter((a) => a.IsCustomAttribute);
  console.log(`\n(a) Custom columns on ${TABLE}:`);
  console.table(
    custom
      .map((a) => ({ LogicalName: a.LogicalName, SchemaName: a.SchemaName, AttributeType: a.AttributeType, RequiredLevel: a.RequiredLevel?.Value }))
      .sort((x, y) => x.LogicalName.localeCompare(y.LogicalName)),
  );

  // (b) Type options
  const pick = await dv('GET', `EntityDefinitions(LogicalName='${TABLE}')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options,IsGlobal)`);
  console.log('(b) Options of mwf_counterpartytype (IsGlobal=' + pick?.OptionSet?.IsGlobal + '):');
  console.table((pick?.OptionSet?.Options ?? []).map((o) => ({ Value: o.Value, Label: o.Label?.UserLocalizedLabel?.Label })));

  // (c) solution membership via solutioncomponents (componenttype 2 = Attribute)
  const comps = await dv('GET', `solutioncomponents?$select=objectid,componenttype&$filter=${q(`_solutionid_value eq ${solutionId} and componenttype eq 2`)}`);
  const inSolution = new Set(comps.value.map((x) => x.objectid.toLowerCase()));
  console.log(`(c) Solution membership. Method: GET solutioncomponents filtered by _solutionid_value of '${SOLUTION}' and componenttype eq 2 (Attribute), matched on objectid = attribute MetadataId. Attribute rows in this solution: ${comps.value.length}`);
  console.table(
    COLUMNS.map((c) => {
      const a = attrs.value.find((x) => x.LogicalName === c.logicalName);
      return { LogicalName: c.logicalName, MetadataId: a?.MetadataId ?? '(not found)', InSolutionComponents: a ? inSolution.has(a.MetadataId.toLowerCase()) : false };
    }),
  );
} catch (e) {
  console.error('\nFAILED. Full error follows. Nothing further was attempted.\n');
  console.error(e.message);
  process.exit(1);
}
