#!/usr/bin/env node
/**
 * Adds the two columns of the reminder and escalation design (ADR-010, status Proposed) to mwf_approvalstep, in the solution:
 *   mwf_remindedon   Date and Time (user local, as mwf_decidedon), audit ON
 *   mwf_escalatedon  Date and Time (user local, as mwf_decidedon), audit ON
 * Written for review. NOT RUN against any environment (ADR-010 has not been approved, and the data model must be reviewed first).
 *
 *   --mode=plan    (default) prints what would be created. No network, no sign-in, no --env needed. Writes nothing.
 *   --mode=check   read only: for each column, exists or not, and the checks on the ones that exist.
 *   --mode=apply   creates the missing columns (POST with the solution header, audit ON in the creation request), reads each back and runs the checks.
 *                  Needs --confirm-mutates-environment. An existing column is only read back (idempotent). Nothing is retried, a 4xx stops the
 *                  script, and no other form of the request is tried. Before the first write: 3 consecutive successful reads.
 *
 * It never PUTs a column definition. If a column reads back with audit OFF, it says so and stops: the way this project changes that flag is
 * scripts/configure-auditing.mjs (ADR-009: whole-definition backup, no-op PUT, deep diff). After the columns exist, append
 * AUDIT_PLAN_ENTRIES of lib/reminder-schema.mjs to COLUMN_ENABLE in lib/auditing.mjs so `configure-auditing.mjs --mode=verify` covers them.
 *
 * Usage:
 *   node scripts/add-reminder-columns.mjs                                  (plan, offline)
 *   node scripts/add-reminder-columns.mjs --mode=check --env=https://<org>.crm4.dynamics.com [--auth=device|az]
 *   node scripts/add-reminder-columns.mjs --mode=apply --env=https://<org>.crm4.dynamics.com [--auth=device|az] [--solution=Muwafaqa] --confirm-mutates-environment
 *
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
import { COLUMNS, TABLE, columnBody, planFor, checksFor, onlyAuditFails } from './lib/reminder-schema.mjs';

const argv = process.argv;
const argOf = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const MODE = argOf('mode') || 'plan';
if (!['plan', 'check', 'apply'].includes(MODE)) { console.error('Invalid --mode=plan|check|apply. Nothing was run.'); process.exit(2); }

if (MODE === 'plan') {
  console.log(`PLAN (offline, nothing is sent): on ${TABLE} the script would create, if missing, these columns with audit ON in the creation request:`);
  for (const c of COLUMNS) {
    const b = columnBody(c);
    console.log(`  ${c.logical}  (${b.SchemaName}) "${c.display}"  ${b['@odata.type'].split('.').pop()}, ${b.Format}, ${b.DateTimeBehavior.Value}, required ${b.RequiredLevel.Value}, audit ${b.IsAuditEnabled.Value ? 'ON' : 'OFF'}`);
    console.log(`      ${c.description}`);
  }
  console.log('Use --mode=check (read only) or --mode=apply --confirm-mutates-environment with --env to go further. Nothing was written.');
  process.exit(0);
}

const { parseArgs, openSession, noGuid, sleep, Stop } = await import('./lib/dv-session.mjs');
const { requireStableConnection } = await import('./lib/counter-snapshot.mjs');
const { argOf: arg, env: ENV, auth: AUTH, has } = parseArgs();
const SOLUTION = arg('solution') || 'Muwafaqa';
if (MODE === 'apply' && !has('--confirm-mutates-environment')) {
  console.error(`WARNING: --mode=apply creates ${COLUMNS.length} columns on ${TABLE} in the environment and adds them to the solution ${SOLUTION}. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
  process.exit(2);
}

const attrPath = (logical) => `EntityDefinitions(LogicalName='${TABLE}')/Attributes(LogicalName='${logical}')`;
const SELECT = 'LogicalName,SchemaName,AttributeType,Format,DateTimeBehavior,RequiredLevel,IsCustomAttribute,IsAuditEnabled,IsValidForCreate,IsValidForUpdate,MetadataId,DisplayName,Description';
let S; let bad = 0;

async function readBack(spec, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const r = await S.call('GET', `${attrPath(spec.logical)}/Microsoft.Dynamics.CRM.DateTimeAttributeMetadata?$select=${SELECT}`);
    if (r.ok) return r.j;
    await sleep(3000);
  }
  return null;
}

function report(spec, md) {
  const checks = checksFor(spec, md);
  for (const c of checks) { console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${spec.logical}: ${c.name}: ${c.got}`); if (!c.ok) bad++; }
  if (onlyAuditFails(checks)) console.log(`NOTE  ${spec.logical}: audit is OFF although it was requested. This script never PUTs a column: use scripts/configure-auditing.mjs (ADR-009), column-list ${TABLE}.${spec.logical}.`);
}

(async () => {
  try {
    S = await openSession({ env: ENV, auth: AUTH });
    const sol = (await S.must('GET', `solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid,ismanaged`)).j.value;
    if (sol.length !== 1 || sol[0].ismanaged) throw new Stop(`solution ${SOLUTION}: expected 1 unmanaged solution, found ${sol.length}${sol[0]?.ismanaged ? ' (managed)' : ''}`);
    const attrs = (await S.must('GET', `EntityDefinitions(LogicalName='${TABLE}')/Attributes?$select=LogicalName`)).j.value.map((a) => a.LogicalName);
    const plan = planFor(attrs);
    for (const p of plan) console.log(`PLAN  ${p.logical}: ${p.action}`);
    if (MODE === 'apply') {
      for (const spec of COLUMNS) {
        if (plan.find((p) => p.logical === spec.logical).action !== 'create') { console.log(`SKIP  ${spec.logical} already exists (idempotent), no create`); continue; }
        await requireStableConnection(S.call, { need: 3, maxAttempts: 6, pauseMs: 1500 });
        const w = await S.call('POST', `EntityDefinitions(LogicalName='${TABLE}')/Attributes`, columnBody(spec), { 'MSCRM.SolutionUniqueName': SOLUTION });
        if (!w.ok) throw new Stop(`creating ${spec.logical} answered HTTP ${w.status} ${noGuid(S.msgOf(w))}. Not retried, no other form is tried; nothing else is written. Read the state with --mode=check.`);
        console.log(`CREATED  ${spec.logical} with the solution header ${SOLUTION}`);
      }
    }
    console.log('--- metadata read back');
    for (const spec of COLUMNS) {
      if (!attrs.includes(spec.logical) && MODE === 'check') { console.log(`MISSING  ${spec.logical} does not exist yet`); continue; }
      const md = await readBack(spec);
      if (!md) { console.log(`FAIL  ${spec.logical}: could not be read back`); bad++; continue; }
      report(spec, md);
    }
    console.log(`\nSUMMARY: ${bad} failed check(s). ${MODE === 'apply' ? 'NEXT: append AUDIT_PLAN_ENTRIES to COLUMN_ENABLE (lib/auditing.mjs) and run configure-auditing.mjs --mode=verify.' : ''}`);
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
