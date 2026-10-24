#!/usr/bin/env node
/**
 * Dataverse auditing of the project (ADR-009). The target: organization isauditenabled = true, auditretentionperiodv2 = 365 (provisional), isreadauditenabled = false,
 * isuseraccessauditenabled = false; the tables mwf_approvalmatrix, mwf_approverassignment, mwf_counterparty, mwf_approvalstep, mwf_contract (NOT the counter table);
 * and the lookup columns that are off by default and matter (see scripts/lib/auditing.mjs). Nothing is written without --confirm-mutates-environment (or with --dry-run).
 *
 *   --mode=check    read only: the organization settings, the table and column state, the plan, the audit read privileges, how many tables of the PLATFORM are
 *                   audited already (turning the organization switch on makes them write audit rows too)
 *   --mode=apply    needs  --org  and/or  --tables=mwf_approvalmatrix[,...]  (with --columns: the lookup columns of those tables, or --column-list=table.column,...)
 *                   For every table or column definition, in this order:
 *                     1. read the WHOLE definition and SAVE it to a file OUTSIDE the repository (the temp directory, folder muwafaqa-audit-backups)
 *                     2. a no-op PUT (the definition unchanged, MSCRM.MergeLabels: true) and a read: the deep diff must show NO difference at all
 *                        (one exception, owner decision 2026-10-24: for a COLUMN definition the TOP-LEVEL ModifiedOn, a timestamp the platform updates on every PUT)
 *                     3. change IsAuditEnabled.Value only, PUT, read, deep diff: only IsAuditEnabled.Value may differ
 *                   In step 2 or 3, ANY other difference: the saved definition is PUT back (restore), the difference is printed, and the script STOPS.
 *                   After the changes of a table: PublishXml for that table, a last read, the same checks.
 *                   Before every write: 3 consecutive successful reads. No write is ever retried; a 4xx stops the script (no other form is tried).
 *   --mode=restore  --target=entity:<table> | attr:<table>.<column> [--file=<backup name>]: PUT the saved definition back (the newest backup by default), PublishXml, diff against the backup
 *   --mode=revert-org   PATCH organizations(<id>) with isauditenabled = false only (the other settings are not touched)
 *   --mode=verify   read only: organization, tables and columns against the target (exit 1 if anything is missing)
 *
 * Usage: node scripts/configure-auditing.mjs --env=https://<org>.crm4.dynamics.com --auth=az --mode=check|apply|verify|restore|revert-org [options] [--dry-run] [--confirm-mutates-environment]
 * The token stays in memory and is never printed. No id, host or address is printed.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, openSession, noGuid, Stop } from './lib/dv-session.mjs';
import { requireStableConnection } from './lib/counter-snapshot.mjs';
import { allFlowsOff } from './lib/bulk-messages.mjs';
import { AUDIT_TABLES, EXCLUDED_TABLES, COLUMN_ENABLE, COLUMN_EXCLUDE, SYSTEM_LEFT_AS_IS, READ_PRIVILEGES, PUT_HEADERS, orgDiff, setAuditValue, stripForPut, diffDeep, unexpectedDiffs, attributeCast, publishXmlBody, columnPlan, tableMeetsTarget, backupName, latestBackup, parseTarget, isNoopClean, relevantDiffs } from './lib/auditing.mjs';

const { argOf, env: ENV, auth: AUTH, has } = parseArgs();
const MODE = argOf('mode');
const DRY = has('--dry-run');
const DO_ORG = has('--org');
const DO_COLUMNS = has('--columns');
const TABLES_ARG = argOf('tables');
const COLUMN_LIST = (argOf('column-list') || '').split(',').map((x) => x.trim()).filter(Boolean);
const BACKUP_DIR = join(tmpdir(), 'muwafaqa-audit-backups');
const q = encodeURIComponent;
if (!['check', 'apply', 'verify', 'restore', 'revert-org'].includes(MODE)) { console.error('Missing or invalid --mode=check|apply|verify|restore|revert-org. Nothing was run.'); process.exit(2); }
const SELECTED = TABLES_ARG ? TABLES_ARG.split(',').map((x) => x.trim()).filter(Boolean) : [];
for (const t of SELECTED) {
  if (t in EXCLUDED_TABLES) { console.error(`${t} is excluded on purpose: ${EXCLUDED_TABLES[t]}. Nothing was run.`); process.exit(2); }
  if (!AUDIT_TABLES.includes(t)) { console.error(`${t} is not one of the audited tables (${AUDIT_TABLES.join(', ')}). Nothing was run.`); process.exit(2); }
}
for (const c of COLUMN_LIST) { const [t, col] = c.split('.'); if (!COLUMN_ENABLE.some((x) => x.table === t && x.column === col)) { console.error(`${c} is not one of the columns of the plan. Nothing was run.`); process.exit(2); } }
const writes = ['apply', 'restore', 'revert-org'].includes(MODE);
if (MODE === 'apply' && !DO_ORG && !SELECTED.length && !COLUMN_LIST.length) { console.error('apply needs --org, --tables=<table>[,<table>] (start with --tables=mwf_approvalmatrix) and/or --column-list=<table>.<column>. Nothing was run.'); process.exit(2); }
let TARGET = null;
if (MODE === 'restore') { try { TARGET = parseTarget(argOf('target')); } catch (e) { console.error(`${e.message}. Nothing was run.`); process.exit(2); } }
if (writes && !DRY && !has('--confirm-mutates-environment')) { console.error(`WARNING: --mode=${MODE} changes the audit configuration of the environment. Add --confirm-mutates-environment to run it on purpose, or --dry-run to see what it would send. Nothing was run.`); process.exit(2); }

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

// ---------------------------------------------------------------------------------------------------------------- backup and restore
function saveBackup(kind, table, column, cast, definition) {
  const name = backupName(kind, table, column, Date.now());
  if (DRY) { console.log(`DRY-RUN  would save the whole definition to <temp>/muwafaqa-audit-backups/${name}`); return name; }
  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(join(BACKUP_DIR, name), JSON.stringify({ kind, table, column, cast, savedAt: new Date().toISOString(), definition }, null, 2), 'utf8');
  console.log(`INFO  backup saved outside the repository: <temp>/muwafaqa-audit-backups/${name}`);
  return name;
}
const pathOf = (kind, table, column) => (kind === 'entity' ? ENT(table) : `${ENT(table)}/Attributes(LogicalName='${column}')`);
const readDef = async (kind, table, column, cast) => (kind === 'entity' ? readTable(table) : get(`${pathOf(kind, table, column)}/${cast}`));
const bodyOf = (kind, def, cast) => (kind === 'entity' ? stripForPut(def) : { ...stripForPut(def), '@odata.type': cast });

/** PUT the saved definition back. One attempt. Returns true when the read-back equals the backup. */
async function putBack(rec, why) {
  console.log(`INFO  restoring ${rec.kind} ${rec.table}${rec.column ? '.' + rec.column : ''} from the backup (${why})`);
  const w = await write('PUT', pathOf(rec.kind, rec.table, rec.column), bodyOf(rec.kind, rec.definition, rec.cast), { ...PUT_HEADERS }, '(the saved definition)');
  if (DRY) return true;
  if (!w.ok) { console.error(`RESTORE FAILED: HTTP ${w.status} ${noGuid(S.msgOf(w))}. The backup file is kept; restore by hand with --mode=restore.`); return false; }
  const after = await readDef(rec.kind, rec.table, rec.column, rec.cast);
  const diffs = relevantDiffs(rec.kind, diffDeep(stripForPut(rec.definition), stripForPut(after)));
  out('restore', diffs.length === 0 ? 'PASS' : 'FAIL', `${rec.kind} ${rec.table}${rec.column ? '.' + rec.column : ''}: after the restore the definition equals the backup`, `${diffs.length} difference(s)`);
  return diffs.length === 0;
}

// ---------------------------------------------------------------------------------------------------------------- apply
async function applyOrg() {
  const org = await readOrg(); const d = orgDiff(org);
  if (d.same) { out('org', 'PASS', 'organization settings already equal the target, nothing written'); return; }
  const id = (await get('organizations?$select=organizationid')).value[0].organizationid;
  const w = await write('PATCH', `organizations(${id})`, d.patch, { 'If-Match': '*' }, `with ${JSON.stringify(d.patch)}`);
  if (DRY) return;
  if (!w.ok) throw new Stop(`PATCH organizations answered HTTP ${w.status} ${noGuid(S.msgOf(w))}. Not retried; read the state with --mode=check.`);
  const d2 = orgDiff(await readOrg());
  check('org', 'organization settings equal the target after the write (read back)', d2.same, d2.same ? 'equal' : JSON.stringify(d2.patch));
  if (!d2.same) throw new Stop('The organization settings differ from the target after the write. Stopped.');
}

/** One definition: backup, no-op PUT + diff (must be empty), the real change + diff (only IsAuditEnabled.Value). On an unexpected difference: restore from the backup and stop. */
async function applyDefinition(kind, table, column, cast) {
  const label = kind === 'entity' ? `table ${table}` : `column ${table}.${column}`;
  const before = await readDef(kind, table, column, cast);
  if (before.IsAuditEnabled?.Value) { out('def', 'PASS', `${label}: audit already ON, no write`); return false; }
  const rec = { kind, table, column, cast, definition: before };
  saveBackup(kind, table, column, cast, before);
  const path = pathOf(kind, table, column);
  // step 2: a PUT that changes nothing must leave no difference at all
  const w1 = await write('PUT', path, bodyOf(kind, before, cast), { ...PUT_HEADERS }, `(no-op: the definition unchanged; ${label})`);
  if (!DRY) {
    if (!w1.ok) throw new Stop(`no-op PUT of ${label} answered HTTP ${w1.status} ${noGuid(S.msgOf(w1))}. Not retried; nothing else is written. The backup is kept.`);
    const d1 = relevantDiffs(kind, diffDeep(stripForPut(before), stripForPut(await readDef(kind, table, column, cast))));
    out('noop', isNoopClean(d1) ? 'PASS' : 'FAIL', `${label}: the no-op PUT left no difference in the definition`, `${d1.length} difference(s)`);
    if (!isNoopClean(d1)) {
      for (const d of d1.slice(0, 12)) console.log(`        DIFFERENCE ${d.path}: ${shortVal(d.before)} -> ${shortVal(d.after)}`);
      await putBack(rec, 'the no-op PUT changed something');
      throw new Stop(`${label}: even a PUT of the unchanged definition changes it, so this way of writing is not safe. Restored from the backup and stopped.`);
    }
  }
  // step 3: the real change
  const want = setAuditValue(before, true);
  const w2 = await write('PUT', path, bodyOf(kind, want, cast), { ...PUT_HEADERS }, `(IsAuditEnabled.Value true; ${label})`);
  if (DRY) return true;
  if (!w2.ok) throw new Stop(`PUT of ${label} answered HTTP ${w2.status} ${noGuid(S.msgOf(w2))}. Not retried; nothing else is written. Read the state with --mode=check; the backup is kept.`);
  const after = await readDef(kind, table, column, cast);
  const diffs = relevantDiffs(kind, diffDeep(stripForPut(before), stripForPut(after))); const bad = unexpectedDiffs(diffs);
  const ok = diffs.some((d) => d.path === 'IsAuditEnabled.Value') && !bad.length;
  out('diff', ok ? 'PASS' : 'FAIL', `${label}: the only difference between the definition before and after is IsAuditEnabled.Value`, `${diffs.length} difference(s) in total, ${bad.length} unexpected`);
  if (!ok) {
    for (const d of bad.slice(0, 12)) console.log(`        UNEXPECTED ${d.path}: ${shortVal(d.before)} -> ${shortVal(d.after)}`);
    await putBack(rec, 'unexpected difference after the change');
    throw new Stop(`${label}: the definition after the write differs in more than IsAuditEnabled.Value (or the flag did not change). Restored from the backup and stopped.`);
  }
  return true;
}

async function publishAndCheck(t, needColumns, onlyColumn = null) {
  const pub = await write('POST', 'PublishXml', publishXmlBody(t), undefined, `(${t})`);
  if (DRY) return;
  if (!pub.ok) throw new Stop(`PublishXml for ${t} answered HTTP ${pub.status} ${noGuid(S.msgOf(pub))}. Not retried. The audit setting is saved but not published: read the state with --mode=check.`);
  const fin = await readTable(t); const attrs = await readAttrs(t); const m = tableMeetsTarget(t, fin, attrs);
  const colOn = onlyColumn ? !!attrs.find((a) => a.LogicalName === onlyColumn)?.IsAuditEnabled?.Value : null;
  const ok = onlyColumn ? colOn : needColumns ? m.ok : fin.IsAuditEnabled.Value;
  check('table', onlyColumn ? `${t}.${onlyColumn}: after PublishXml the column is audited (read back)` : `${t}: after PublishXml the table${needColumns ? ' and its lookups meet' : ' is audited per'} the target (read back)`, ok, onlyColumn ? `column ${colOn ? 'ON' : 'off'}` : JSON.stringify(m.plan));
  if (!ok) throw new Stop(`${t} does not meet the target after PublishXml. Stopped.`);
}

async function applyTable(t) {
  console.log(`\n--- ${t}`);
  const changed = await applyDefinition('entity', t, null, null);
  if (DO_COLUMNS) {
    const attrs = await readAttrs(t); const plan = columnPlan(t, attrs);
    if (plan.blocked.length || plan.missing.length) throw new Stop(`${t}: cannot change ${plan.blocked.join(', ') || '-'}; missing ${plan.missing.join(', ') || '-'}. Nothing written for columns.`);
    console.log(`INFO  ${t}: lookup columns to enable: ${plan.enable.join(', ') || 'none'}`);
    for (const c of plan.enable) await applyDefinition('attr', t, c, attributeCast(attrs.find((a) => a.LogicalName === c).AttributeType));
  }
  if (changed || DO_COLUMNS) await publishAndCheck(t, DO_COLUMNS); else if (DRY) console.log(`DRY-RUN  would then POST PublishXml for ${t} and read the definition again`);
}

async function applyColumns() {
  // the order of the owner: mwf_user first, then the rest
  const order = [...COLUMN_LIST].sort((a, b) => (a === 'mwf_approverassignment.mwf_user' ? -1 : b === 'mwf_approverassignment.mwf_user' ? 1 : 0));
  const published = new Set();
  for (const c of order) {
    const [t, col] = c.split('.');
    console.log(`\n--- column ${c}`);
    const attrs = await readAttrs(t); const a = attrs.find((x) => x.LogicalName === col);
    if (!a) throw new Stop(`${c} was not found. Nothing written.`);
    if (a.IsAuditEnabled?.CanBeChanged === false) throw new Stop(`${c} cannot be changed (CanBeChanged false). Nothing written.`);
    const did = await applyDefinition('attr', t, col, attributeCast(a.AttributeType));
    if (did || DRY) { await publishAndCheck(t, false, col); published.add(t); }
  }
}

async function modeApply() {
  const f = await flowsLine(); console.log(`INFO  approval flows (read only): ${f.line}`);
  for (const t of SELECTED) await applyTable(t);
  if (COLUMN_LIST.length) await applyColumns();
  if (DO_ORG) { console.log('\n--- organization'); await applyOrg(); }
  if (DRY) { console.log('\nDRY-RUN: nothing was sent.'); return true; }
  console.log('\nNEXT: --mode=verify');
  return !results.some((r) => r.status === 'FAIL');
}

async function modeRestore() {
  let names = []; try { names = readdirSync(BACKUP_DIR); } catch { /* no directory */ }
  const name = argOf('file') || latestBackup(names, TARGET.kind, TARGET.table, TARGET.column);
  if (!name || !names.includes(name)) throw new Stop(`No backup found for ${argOf('target')} in <temp>/muwafaqa-audit-backups. Nothing was written.`);
  const rec = JSON.parse(readFileSync(join(BACKUP_DIR, name), 'utf8'));
  console.log(`INFO  using the backup ${name} (saved ${rec.savedAt})`);
  const ok = await putBack(rec, 'owner asked for a restore');
  if (!DRY) { const pub = await write('POST', 'PublishXml', publishXmlBody(rec.table), undefined, `(${rec.table})`); if (!pub.ok) throw new Stop(`PublishXml answered HTTP ${pub.status} ${noGuid(S.msgOf(pub))}. Not retried.`); out('publish', 'PASS', `${rec.table}: published`); }
  else console.log(`DRY-RUN  would then POST PublishXml for ${rec.table}`);
  return ok;
}

async function modeRevertOrg() {
  const org = await readOrg();
  if (org.isauditenabled === false) { out('org', 'PASS', 'isauditenabled is already false, nothing written'); return true; }
  const id = (await get('organizations?$select=organizationid')).value[0].organizationid;
  const w = await write('PATCH', `organizations(${id})`, { isauditenabled: false }, { 'If-Match': '*' }, 'with {"isauditenabled":false} (the other settings are not touched)');
  if (DRY) { console.log('\nDRY-RUN: nothing was sent.'); return true; }
  if (!w.ok) throw new Stop(`PATCH organizations answered HTTP ${w.status} ${noGuid(S.msgOf(w))}. Not retried; read the state with --mode=check.`);
  const now = await readOrg(); check('org', 'isauditenabled is false (read back)', now.isauditenabled === false);
  return now.isauditenabled === false;
}

(async () => {
  try {
    S = await openSession({ env: ENV, auth: AUTH });
    await requireStableConnection(S.call);
    const ok = MODE === 'check' ? await report(false) : MODE === 'verify' ? await report(true) : MODE === 'apply' ? await modeApply() : MODE === 'restore' ? await modeRestore() : await modeRevertOrg();
    const bad = results.filter((r) => r.status === 'FAIL').length;
    console.log(`\n${MODE.toUpperCase()}: ${results.filter((r) => r.status === 'PASS').length} PASS, ${bad} FAIL, ${results.filter((r) => r.status === 'OBS').length} OBS.`);
    process.exit(ok && !bad ? 0 : 1);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
