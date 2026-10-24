#!/usr/bin/env node
/**
 * Dataverse auditing of the project (ADR-009). The target: organization isauditenabled = true, auditretentionperiodv2 = 365 (provisional), isreadauditenabled = false,
 * isuseraccessauditenabled = false; the tables mwf_approvalmatrix, mwf_approverassignment, mwf_counterparty, mwf_approvalstep, mwf_contract (NOT the counter table);
 * and the lookup columns that are off by default and matter (see scripts/lib/auditing.mjs). Nothing is written without --confirm-mutates-environment (or with --dry-run).
 *
 *   --mode=check    read only: the organization settings, the table and column state, the plan (what apply would change), the audit read privileges, how many
 *                   tables of the PLATFORM are audited already (turning the organization switch on makes them write audit rows too)
 *   --mode=apply    needs at least one of  --org  (PATCH organizations(<id>) with only the properties that differ)
 *                                          --tables=mwf_approvalmatrix[,...]  (for each table: the table-level IsAuditEnabled and, with --columns, its lookup columns)
 *                   For a table or a column the logic is the one Learn describes, plus a proof that nothing else changed:
 *                     1. read the WHOLE definition   2. change IsAuditEnabled.Value only   3. PUT the whole definition (header MSCRM.MergeLabels: true)
 *                     4. read it again and compare with a deep diff: ANY difference other than IsAuditEnabled.Value STOPS the script before anything else is written
 *                     5. after the table's changes: PublishXml for that table, then a last read and the same comparison.
 *                   Start with ONE low-risk table: --tables=mwf_approvalmatrix. Before every write: 3 consecutive successful reads. No write is ever retried.
 *   --mode=verify   read only: organization, tables and columns against the target (exit 1 if anything is missing)
 *
 * Usage: node scripts/configure-auditing.mjs --env=https://<org>.crm4.dynamics.com --auth=az --mode=check|apply|verify [--org] [--tables=...] [--columns] [--dry-run] [--confirm-mutates-environment]
 * The token stays in memory and is never printed. No id, host or address is printed.
 */
import { parseArgs, openSession, noGuid, Stop } from './lib/dv-session.mjs';
import { requireStableConnection } from './lib/counter-snapshot.mjs';
import { allFlowsOff } from './lib/bulk-messages.mjs';
import { AUDIT_TABLES, EXCLUDED_TABLES, ORG_TARGET, COLUMN_ENABLE, COLUMN_EXCLUDE, SYSTEM_LEFT_AS_IS, READ_PRIVILEGES, PUT_HEADERS, orgDiff, setAuditValue, stripForPut, diffDeep, unexpectedDiffs, attributeCast, publishXmlBody, columnPlan, tableMeetsTarget } from './lib/auditing.mjs';

const { argOf, env: ENV, auth: AUTH, has } = parseArgs();
const MODE = argOf('mode');
const DRY = has('--dry-run');
const DO_ORG = has('--org');
const DO_COLUMNS = has('--columns');
const TABLES_ARG = argOf('tables');
const q = encodeURIComponent;
if (!['check', 'apply', 'verify'].includes(MODE)) { console.error('Missing or invalid --mode=check|apply|verify. Nothing was run.'); process.exit(2); }
const SELECTED = TABLES_ARG ? TABLES_ARG.split(',').map((x) => x.trim()).filter(Boolean) : [];
for (const t of SELECTED) {
  if (t in EXCLUDED_TABLES) { console.error(`${t} is excluded on purpose: ${EXCLUDED_TABLES[t]}. Nothing was run.`); process.exit(2); }
  if (!AUDIT_TABLES.includes(t)) { console.error(`${t} is not one of the audited tables (${AUDIT_TABLES.join(', ')}). Nothing was run.`); process.exit(2); }
}
if (MODE === 'apply') {
  if (!DO_ORG && !SELECTED.length) { console.error('apply needs --org and/or --tables=<table>[,<table>] (start with --tables=mwf_approvalmatrix). Nothing was run.'); process.exit(2); }
  if (!DRY && !has('--confirm-mutates-environment')) { console.error('WARNING: --mode=apply changes the audit configuration of the environment. Add --confirm-mutates-environment to run it on purpose, or --dry-run to see what it would send. Nothing was run.'); process.exit(2); }
}

let S;
const results = [];
const out = (id, status, name, detail = '') => { results.push({ id, status }); console.log(`${status.padEnd(4)}  ${id.padEnd(7)} ${name}${detail ? `  [${detail}]` : ''}`); };
const check = (id, name, ok, detail) => out(id, ok ? 'PASS' : 'FAIL', name, detail);
const get = async (p) => (await S.must('GET', p)).j;
const gate = () => requireStableConnection(S.call, { need: 3, maxAttempts: 6, pauseMs: 1500 });
const shortVal = (v) => noGuid(JSON.stringify(v) ?? 'undefined').slice(0, 90);

/** Every write goes through here: 3 consecutive reads first, no retry, and in dry-run only a printed line. */
async function write(method, path, body, extra, note) {
  if (DRY) { console.log(`DRY-RUN  would ${method} ${noGuid(path).slice(0, 110)}${note ? `  ${note}` : ''}`); return { ok: true, status: 0, dry: true }; }
  await gate();
  return S.call(method, path, body, extra);
}

// ---------------------------------------------------------------------------------------------------------------- reads
const ENT = (t) => `EntityDefinitions(LogicalName='${t}')`;
async function readOrg() { return (await get('organizations?$select=isauditenabled,auditretentionperiodv2,isreadauditenabled,isuseraccessauditenabled,useraccessauditinginterval,auditsettings')).value[0]; }
async function readTable(t) { return get(ENT(t)); }
async function readAttrs(t) { return (await get(`${ENT(t)}/Attributes?$select=LogicalName,AttributeType,IsAuditEnabled,IsCustomAttribute,IsLogical,AttributeOf&$orderby=LogicalName`)).value.filter((a) => !a.IsLogical && !a.AttributeOf); }
async function flowsLine() {
  const rows = (await get(`workflows?$select=name,statecode&$filter=${q("category eq 5 and contains(name,'Contract Approval')")}`)).value;
  return { ok: allFlowsOff(rows), line: rows.map((r) => `${/v\d\s*$/.exec(r.name)?.[0] || 'flow'} ${r.statecode === 0 ? 'OFF' : 'ON'}`).join(', ') };
}

// ---------------------------------------------------------------------------------------------------------------- check / verify
async function report(strict) {
  const f = await flowsLine(); out('flows', 'OBS', `approval flows (read only, not changed by this script): ${f.line}`);
  const org = await readOrg(); const od = orgDiff(org);
  console.log(`INFO  organization now: isauditenabled ${org.isauditenabled}, retention ${org.auditretentionperiodv2 === null ? 'not set (null)' : org.auditretentionperiodv2} days, isreadauditenabled ${org.isreadauditenabled}, isuseraccessauditenabled ${org.isuseraccessauditenabled}, auditsettings ${org.auditsettings}`);
  if (strict) check('org', 'organization settings equal the target (audit on, retention 365 days, read audit off, user access audit off)', od.same, od.same ? 'equal' : `would patch ${Object.keys(od.patch).join(', ')}`);
  else out('org', od.same ? 'PASS' : 'OBS', od.same ? 'organization settings already equal the target' : `apply --org would PATCH: ${JSON.stringify(od.patch)}`);
  for (const t of AUDIT_TABLES) {
    const def = await readTable(t); const attrs = await readAttrs(t); const m = tableMeetsTarget(t, def, attrs);
    const p = m.plan;
    const line = `table audit ${def.IsAuditEnabled.Value ? 'ON' : 'off'} (CanBeChanged ${def.IsAuditEnabled.CanBeChanged}); lookups to enable: ${p.enable.join(', ') || 'none'}; already on: ${p.alreadyOn.join(', ') || 'none'}${p.blocked.length ? `; BLOCKED: ${p.blocked.join(', ')}` : ''}${p.missing.length ? `; MISSING: ${p.missing.join(', ')}` : ''}${p.systemOff.length ? `; system columns off: ${p.systemOff.join(', ')}` : ''}`;
    if (strict) check('table', `${t}: meets the target`, m.ok, line); else out('table', m.ok ? 'PASS' : 'OBS', `${t}`, line);
    const custom = attrs.filter((a) => a.IsCustomAttribute);
    console.log(`        custom columns audited: ${custom.filter((a) => a.IsAuditEnabled.Value).length} of ${custom.length}; off: ${custom.filter((a) => !a.IsAuditEnabled.Value).map((a) => a.LogicalName).join(', ') || 'none'}`);
  }
  for (const [t, why] of Object.entries(EXCLUDED_TABLES)) { const def = await readTable(t); out('excluded', def.IsAuditEnabled.Value ? 'FAIL' : 'PASS', `${t}: audit ${def.IsAuditEnabled.Value ? 'ON (it must stay off)' : 'off'}`, why.slice(0, 80)); }
  for (const c of COLUMN_EXCLUDE) console.log(`INFO  left off on purpose: ${c.table}.${c.column}: ${c.reason}`);
  console.log(`INFO  system columns left as they are (never change in normal operation): ${SYSTEM_LEFT_AS_IS.join(', ')}`);
  for (const p of READ_PRIVILEGES) { const r = (await get(`privileges?$select=name,canbeglobal,canbebasic&$filter=name eq '${p.name}'`)).value; check('priv', `${p.name} exists and can be given at Organization level`, r.length === 1 && r[0].canbeglobal === true, `${r.length} row(s)`); }
  const on = (await get(`EntityDefinitions?$select=LogicalName&$filter=${q('IsAuditEnabled/Value eq true and IsPrivate eq false')}`)).value.length;
  console.log(`INFO  tables of the whole environment with IsAuditEnabled = true right now: ${on}. Turning the organization switch on makes ALL of them write audit rows (log storage).`);
  const a = await get('audits?$select=auditid&$top=1&$count=true'); console.log(`INFO  audit rows readable now by this account: ${a['@odata.count']}`);
  return !results.some((r) => r.status === 'FAIL');
}

// ---------------------------------------------------------------------------------------------------------------- apply
function stopOnDiff(what, before, after) {
  const diffs = diffDeep(stripForPut(before), stripForPut(after));
  const bad = unexpectedDiffs(diffs);
  const ok = diffs.some((d) => d.path === 'IsAuditEnabled.Value') && !bad.length;
  out('diff', ok ? 'PASS' : 'FAIL', `${what}: the only difference between the definition read before and after is IsAuditEnabled.Value`, `${diffs.length} difference(s) in total, ${bad.length} unexpected`);
  if (!ok) {
    for (const d of bad.slice(0, 12)) console.log(`        UNEXPECTED ${d.path}: ${shortVal(d.before)} -> ${shortVal(d.after)}`);
    if (!diffs.some((d) => d.path === 'IsAuditEnabled.Value')) console.log('        IsAuditEnabled.Value did NOT change');
    throw new Stop(`${what}: the definition after the write differs from the one before in more than IsAuditEnabled.Value (or not at all). Stopped before anything else was written. Nothing was retried; read the state with --mode=check.`);
  }
}

async function applyOrg() {
  const org = await readOrg(); const d = orgDiff(org);
  if (d.same) { out('org', 'PASS', 'organization settings already equal the target, nothing written'); return; }
  const id = (await get('organizations?$select=organizationid')).value[0].organizationid;
  const w = await write('PATCH', `organizations(${id})`, d.patch, { 'If-Match': '*' }, `with ${JSON.stringify(d.patch)}`);
  if (DRY) return;
  if (!w.ok) throw new Stop(`PATCH organizations answered HTTP ${w.status} ${noGuid(S.msgOf(w))}. Not retried; read the state with --mode=check.`);
  const after = await readOrg(); const d2 = orgDiff(after);
  check('org', 'organization settings equal the target after the write (read back)', d2.same, d2.same ? 'equal' : JSON.stringify(d2.patch));
  if (!d2.same) throw new Stop('The organization settings differ from the target after the write. Stopped.');
}

async function applyDefinition(label, path, before, doWrite) {
  const want = setAuditValue(before, true);
  const body = stripForPut(want);
  const w = await write('PUT', path, body, { ...PUT_HEADERS }, `(whole definition, IsAuditEnabled.Value true; ${label})`);
  if (DRY) return null;
  if (!w.ok) throw new Stop(`PUT of ${label} answered HTTP ${w.status} ${noGuid(S.msgOf(w))}. Not retried; nothing else is written. Read the state with --mode=check.`);
  return true;
}

async function applyTable(t) {
  console.log(`\n--- ${t}`);
  const before = await readTable(t);
  if (before.IsAuditEnabled.Value) out('table', 'PASS', `${t}: table-level audit already ON, no write`);
  else {
    const did = await applyDefinition(`table ${t}`, ENT(t), before);
    if (!DRY && did) { const after = await readTable(t); stopOnDiff(`table ${t}`, before, after); }
  }
  if (DO_COLUMNS) {
    const attrs = await readAttrs(t); const plan = columnPlan(t, attrs);
    if (plan.blocked.length || plan.missing.length) throw new Stop(`${t}: cannot change ${plan.blocked.join(', ') || '-'}; missing ${plan.missing.join(', ') || '-'}. Nothing written for columns.`);
    if (plan.systemOff.length) out('cols', 'OBS', `${t}: system columns that are off and matter: ${plan.systemOff.join(', ')} (not changed by this plan)`);
    console.log(`INFO  ${t}: lookup columns to enable: ${plan.enable.join(', ') || 'none'}`);
    for (const c of plan.enable) {
      const type = attrs.find((a) => a.LogicalName === c).AttributeType; const cast = attributeCast(type);
      const cpath = `${ENT(t)}/Attributes(LogicalName='${c}')`;
      const cbefore = await get(`${cpath}/${cast}`);
      const did = await applyDefinition(`column ${t}.${c}`, cpath, { ...cbefore, '@odata.type': cast });
      if (!DRY && did) { const cafter = await get(`${cpath}/${cast}`); stopOnDiff(`column ${t}.${c}`, cbefore, { ...cafter }); }
    }
  }
  if (DRY) { console.log(`DRY-RUN  would then POST PublishXml for ${t} and read the definition again`); return; }
  const pub = await write('POST', 'PublishXml', publishXmlBody(t), undefined, `(${t})`);
  if (!pub.ok) throw new Stop(`PublishXml for ${t} answered HTTP ${pub.status} ${noGuid(S.msgOf(pub))}. Not retried. The audit setting is saved but not published: read the state with --mode=check.`);
  const fin = await readTable(t); const attrs2 = await readAttrs(t); const m = tableMeetsTarget(t, fin, attrs2);
  const keep = DO_COLUMNS ? m.ok : fin.IsAuditEnabled.Value;
  check('table', `${t}: after PublishXml the table${DO_COLUMNS ? ' and its lookups meet' : ' is audited per'} the target (read back)`, keep, JSON.stringify(m.plan));
  if (!keep) throw new Stop(`${t} does not meet the target after PublishXml. Stopped.`);
}

async function modeApply() {
  const f = await flowsLine(); console.log(`INFO  approval flows (read only): ${f.line}`);
  if (DO_ORG) { console.log('\n--- organization'); await applyOrg(); }
  for (const t of SELECTED) await applyTable(t);
  if (DRY) { console.log('\nDRY-RUN: nothing was sent.'); return true; }
  console.log('\nNEXT: --mode=verify');
  return !results.some((r) => r.status === 'FAIL');
}

(async () => {
  try {
    S = await openSession({ env: ENV, auth: AUTH });
    await requireStableConnection(S.call);
    const ok = MODE === 'check' ? await report(false) : MODE === 'verify' ? await report(true) : await modeApply();
    const bad = results.filter((r) => r.status === 'FAIL').length;
    console.log(`\n${MODE.toUpperCase()}: ${results.filter((r) => r.status === 'PASS').length} PASS, ${bad} FAIL, ${results.filter((r) => r.status === 'OBS').length} OBS.`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
