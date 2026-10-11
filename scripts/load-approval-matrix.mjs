#!/usr/bin/env node
/**
 * ApprovalMatrix (table mwf_approvalmatrix): metadata check, load, and validation. FICTIONAL data only.
 *
 * Modes:
 *   --mode=check     read only. Reads the column metadata and option values, compares them with the expected list,
 *                    and reports the RequiredLevel of each column. STOPS (exit 3) if a logical name or an option value differs.
 *   --mode=load      creates the rows of data/approval-matrix.csv that do not exist yet (looked up by Rule Name).
 *                    MUTATES the environment: it needs --confirm-mutates-environment. Idempotent.
 *   --mode=validate  read only. Checks the rows now in the table (count, contiguous bands, step orders, one Inform row per top band).
 *
 * Usage:
 *   node scripts/load-approval-matrix.mjs --mode=check|load|validate --env=https://<org>.crm4.dynamics.com [--confirm-mutates-environment] [--csv=<path>]
 *
 * Convention (fictional bands, to be replaced when the real thresholds are known):
 *   Min is EXCLUSIVE, Max is INCLUSIVE, an empty Max means unbounded. A value of exactly 0 matches no band.
 *
 * The access token comes from `az` and stays in memory. It is never printed. No URL, address or id is stored in this file.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const mode = argOf('mode');
const ENV = argOf('env').replace(/\/+$/, '');
const HERE = dirname(fileURLToPath(import.meta.url));
const CSV = argOf('csv') || join(HERE, '..', 'data', 'approval-matrix.csv');
const TABLE = 'mwf_approvalmatrix';

if (!['check', 'load', 'validate'].includes(mode)) { console.error('Missing or invalid --mode=check|load|validate. Nothing was run.'); process.exit(2); }
if (!/^https:\/\/[^/]+$/.test(ENV)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
if (mode === 'load' && !process.argv.includes('--confirm-mutates-environment')) {
  console.error('WARNING: --mode=load creates rows in the environment. Add --confirm-mutates-environment to run it on purpose. Nothing was run.');
  process.exit(2);
}

const TOKEN = execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim();
const API = `${ENV}/api/data/v9.2`;
const H = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Content-Type': 'application/json; charset=utf-8' };
const q = encodeURIComponent;
const noGuid = (t) => String(t ?? '').replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>');
async function get(path) {
  const r = await fetch(path.startsWith('http') ? path : `${API}/${path}`, { headers: H });
  const t = await r.text();
  if (!r.ok) throw new Error(`GET failed HTTP ${r.status} ${noGuid(t).slice(0, 300)}`);
  return JSON.parse(t);
}

// expected metadata (from the table design). Logical names and option VALUES are compared with the live metadata.
const EXPECT_COLUMNS = {
  mwf_rulename: 'String', mwf_contracttype: 'Picklist', mwf_contractdirection: 'Picklist', mwf_minvalueusd: 'Decimal',
  mwf_maxvalueusd: 'Decimal', mwf_steporder: 'Integer', mwf_approverrole: 'Picklist', mwf_actiontype: 'Picklist',
};
const EXPECT_OPTIONS = {
  mwf_contracttype: { Maintenance: 867640000, Procurement: 867640001, Insurance: 867640002, Sales: 867640003, Services: 867640004 },
  mwf_contractdirection: { Income: 867640000, Expense: 867640001 },
  mwf_approverrole: { 'Department Head': 867640000, 'Finance Manager': 867640001, 'General Manager': 867640002, 'Regional Office': 867640003, Owner: 867640004 },
  mwf_actiontype: { Approve: 867640000, Inform: 867640001 },
};
const EXPECT_REQUIRED = (n) => (n === 'mwf_maxvalueusd' ? 'None' : 'ApplicationRequired');

class Stop extends Error {}

async function readMetadata() {
  const ent = await get(`EntityDefinitions(LogicalName='${TABLE}')?$select=LogicalName,EntitySetName,PrimaryNameAttribute,OwnershipType`);
  const attrs = (await get(`EntityDefinitions(LogicalName='${TABLE}')/Attributes?$select=LogicalName,SchemaName,AttributeType,RequiredLevel,IsCustomAttribute`)).value;
  const options = {};
  for (const n of Object.keys(EXPECT_OPTIONS)) {
    const p = await get(`EntityDefinitions(LogicalName='${TABLE}')/Attributes(LogicalName='${n}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options,IsGlobal)`);
    options[n] = { isGlobal: p.OptionSet.IsGlobal, map: Object.fromEntries(p.OptionSet.Options.map((o) => [o.Label?.UserLocalizedLabel?.Label, o.Value])) };
  }
  const dec = {};
  for (const n of ['mwf_minvalueusd', 'mwf_maxvalueusd']) {
    const d = await get(`EntityDefinitions(LogicalName='${TABLE}')/Attributes(LogicalName='${n}')/Microsoft.Dynamics.CRM.DecimalAttributeMetadata?$select=Precision,MinValue,MaxValue`);
    dec[n] = { precision: d.Precision, min: d.MinValue, max: d.MaxValue };
  }
  return { ent, attrs, options, dec };
}

function compareMetadata(md) {
  const problems = [];
  const live = new Map(md.attrs.map((a) => [a.LogicalName, a]));
  for (const [n, type] of Object.entries(EXPECT_COLUMNS)) {
    if (!live.has(n)) problems.push(`column ${n} is missing`);
    else if (live.get(n).AttributeType !== type) problems.push(`column ${n}: AttributeType ${live.get(n).AttributeType}, expected ${type}`);
  }
  for (const [n, exp] of Object.entries(EXPECT_OPTIONS)) {
    const got = md.options[n]?.map ?? {};
    if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(exp).sort())) {
      problems.push(`options of ${n} differ. live: ${JSON.stringify(got)} expected: ${JSON.stringify(exp)}`);
    }
  }
  return problems;
}

function parseCsv(path) {
  const lines = readFileSync(path, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => { const c = l.split(','); return Object.fromEntries(head.map((h, i) => [h, c[i] ?? ''])); });
}

async function allRows(set) {
  let url = `${set}?$select=mwf_rulename,mwf_contracttype,mwf_contractdirection,mwf_minvalueusd,mwf_maxvalueusd,mwf_steporder,mwf_approverrole,mwf_actiontype&$top=500`;
  const rows = [];
  while (url) {
    const j = await get(url);
    rows.push(...j.value);
    url = j['@odata.nextLink'] || null;
  }
  return rows;
}

try {
  const md = await readMetadata();

  if (mode === 'check') {
    console.log(`Table ${md.ent.LogicalName}: EntitySetName=${md.ent.EntitySetName}, PrimaryNameAttribute=${md.ent.PrimaryNameAttribute}, OwnershipType=${md.ent.OwnershipType}`);
    const live = new Map(md.attrs.map((a) => [a.LogicalName, a]));
    console.table(Object.entries(EXPECT_COLUMNS).map(([n, type]) => {
      const a = live.get(n);
      const level = a?.RequiredLevel?.Value;
      return { column: n, AttributeType: a?.AttributeType, expectedType: type, RequiredLevel: level, expectedRequired: EXPECT_REQUIRED(n), requiredMatches: level === EXPECT_REQUIRED(n) };
    }));
    console.log('Option sets (live, local/global):');
    for (const [n, o] of Object.entries(md.options)) console.log(`  ${n} (IsGlobal=${o.isGlobal}): ${JSON.stringify(o.map)}`);
    console.log('Decimal columns:', JSON.stringify(md.dec));
    const problems = compareMetadata(md);
    if (problems.length) throw new Stop(`Metadata differs from the expected list:\n - ${problems.join('\n - ')}`);
    console.log('\nCHECK PASS: logical names, types and option values match the expected list.');
  }

  if (mode === 'load') {
    const problems = compareMetadata(md);
    if (problems.length) throw new Stop(`Metadata differs from the expected list, nothing was created:\n - ${problems.join('\n - ')}`);
    const set = md.ent.EntitySetName;
    const csv = parseCsv(CSV);
    const names = csv.map((r) => r.mwf_rulename);
    if (new Set(names).size !== names.length) throw new Stop('the CSV has duplicate Rule Names. Nothing was created.');
    const existing = new Set((await allRows(set)).map((r) => r.mwf_rulename));
    const val = (col, label) => {
      const v = md.options[col].map[label];
      if (v === undefined) throw new Stop(`no option "${label}" in ${col}. Nothing more was created.`);
      return v;
    };
    let created = 0; let skipped = 0;
    for (const r of csv) {
      if (existing.has(r.mwf_rulename)) { skipped++; continue; }
      const body = {
        mwf_rulename: r.mwf_rulename,
        mwf_contracttype: val('mwf_contracttype', r.mwf_contracttype),
        mwf_contractdirection: val('mwf_contractdirection', r.mwf_contractdirection),
        mwf_minvalueusd: Number(r.mwf_minvalueusd),
        mwf_steporder: Number(r.mwf_steporder),
        mwf_approverrole: val('mwf_approverrole', r.mwf_approverrole),
        mwf_actiontype: val('mwf_actiontype', r.mwf_actiontype),
      };
      if (r.mwf_maxvalueusd !== '') body.mwf_maxvalueusd = Number(r.mwf_maxvalueusd);
      const res = await fetch(`${API}/${set}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`create failed for "${r.mwf_rulename}": HTTP ${res.status} ${noGuid(await res.text()).slice(0, 300)}`);
      created++;
    }
    console.log(`LOAD: CSV rows ${csv.length} | created ${created} | skipped (already existed) ${skipped}`);
  }

  if (mode === 'validate') {
    const set = md.ent.EntitySetName;
    const rows = await allRows(set);
    const label = (col, v) => Object.entries(md.options[col].map).find(([, x]) => x === v)?.[0];
    const R = rows.map((r) => ({
      type: label('mwf_contracttype', r.mwf_contracttype), dir: label('mwf_contractdirection', r.mwf_contractdirection),
      min: r.mwf_minvalueusd, max: r.mwf_maxvalueusd, step: r.mwf_steporder, role: label('mwf_approverrole', r.mwf_approverrole), action: label('mwf_actiontype', r.mwf_actiontype),
    }));
    const checks = [];
    const add = (name, ok, detail) => checks.push({ check: name, result: ok ? 'PASS' : 'FAIL', detail });
    add('row count = 110', rows.length === 110, `${rows.length} rows`);

    const combos = new Map();
    for (const r of R) { const k = `${r.type}|${r.dir}`; (combos.get(k) ?? combos.set(k, []).get(k)).push(r); }
    add('10 combinations (5 types x 2 directions)', combos.size === 10, `${combos.size} combinations`);

    let badBands = 0; let badSteps = 0; let badInform = 0; let bandCount = 0;
    for (const [, list] of combos) {
      const bands = new Map();
      for (const r of list) { const k = `${r.min}|${r.max ?? ''}`; (bands.get(k) ?? bands.set(k, []).get(k)).push(r); }
      const ordered = [...bands.values()].sort((a, b) => a[0].min - b[0].min);
      bandCount += ordered.length;
      // contiguous: first Min = 0, each Max equals the next Min, last Max empty (unbounded)
      let ok = ordered[0][0].min === 0 && ordered[ordered.length - 1][0].max == null;
      for (let i = 0; i < ordered.length - 1; i++) if (ordered[i][0].max !== ordered[i + 1][0].min) ok = false;
      if (!ok) badBands++;
      // step orders 1..n with no gaps and no duplicates, per band
      for (const b of ordered) {
        const steps = b.map((r) => r.step).sort((x, y) => x - y);
        if (!steps.every((s, i) => s === i + 1)) { badSteps++; break; }
      }
      // exactly one Owner/Inform row, and it is in the top band
      const informs = list.filter((r) => r.role === 'Owner' && r.action === 'Inform');
      const top = ordered[ordered.length - 1];
      if (informs.length !== 1 || !top.includes(informs[0])) badInform++;
    }
    add('bands contiguous, no gaps or overlaps (first Min 0, last Max empty)', badBands === 0, `${badBands} combinations failing, ${bandCount} bands in total`);
    add('step orders 1..n per band, no gaps', badSteps === 0, `${badSteps} combinations failing`);
    add('exactly one Owner/Inform row per combination, in the top band', badInform === 0, `${badInform} combinations failing`);
    console.table(checks);
    if (checks.some((c) => c.result === 'FAIL')) throw new Stop('one or more validation checks FAILED');
    console.log('VALIDATE PASS');
  }
} catch (e) {
  if (e instanceof Stop) { console.error('\nSTOP: ' + e.message); process.exit(3); }
  console.error('\nFAILED: ' + noGuid(e.message));
  process.exit(1);
}
