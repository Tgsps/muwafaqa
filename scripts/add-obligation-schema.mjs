#!/usr/bin/env node
/**
 * The two tables of ADR-011 (status Proposed): mwf_obligation (audit ON) and mwf_alertlog (service table, audit OFF, alternate key on mwf_alertkey).
 * Written for review. NOT RUN against any environment: ADR-011 has not been approved and the data model must be reviewed first.
 *
 *   --mode=plan    (default) prints exactly what --mode=apply would create. No network, no sign-in, no --env needed. Writes nothing.
 *   --mode=verify  READ ONLY: for both tables, ownership, notes and activities, the table audit flag, every column (type, required level, audit flag),
 *                  the Choice values, the lookup and its DELETE behavior, solution membership, the row counts (expected 0) and the alternate key
 *                  with EntityKeyIndexStatus == Active. Writes nothing. Exit 1 when a check fails (including a key that is not Active).
 *   --mode=apply   creates what is missing, in the solution (one POST per object, the solution header, audit set in the creation request), then runs the
 *                  verify checks. Needs --confirm-mutates-environment. An existing object is only read back (idempotent). Nothing is retried, a 4xx
 *                  stops the script. Before each write: 3 consecutive successful reads. It never PUTs a definition: an audit flag that reads back
 *                  wrong is changed only by scripts/configure-auditing.mjs (ADR-009). It creates NO security role and NO privilege.
 *
 * Usage:
 *   node scripts/add-obligation-schema.mjs                                   (plan, offline)
 *   node scripts/add-obligation-schema.mjs --mode=verify --env=https://<org>.crm4.dynamics.com [--auth=device|az] [--solution=Muwafaqa]
 *   node scripts/add-obligation-schema.mjs --mode=apply  --env=https://<org>.crm4.dynamics.com [--auth=device|az] [--solution=Muwafaqa] --confirm-mutates-environment
 *
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
import { TABLES, COLUMNS, KEYS, tableBody, columnBody, lookupBody, keyBody, planLines, tableChecks, optionChecks, lookupChecks, keyChecks } from './lib/obligation-schema.mjs';

const argv = process.argv;
const argOfRaw = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const MODE = argOfRaw('mode') || 'plan';
if (!['plan', 'verify', 'apply'].includes(MODE)) { console.error('Invalid --mode=plan|verify|apply. Nothing was run.'); process.exit(2); }

if (MODE === 'plan') {
  console.log('PLAN (offline, nothing is sent): the script would create, if missing, in this order:');
  for (const l of planLines()) console.log(l);
  console.log('Use --mode=verify (read only) or --mode=apply --confirm-mutates-environment with --env to go further. Nothing was written.');
  process.exit(0);
}

const { parseArgs, openSession, noGuid, sleep, Stop } = await import('./lib/dv-session.mjs');
const { requireStableConnection } = await import('./lib/counter-snapshot.mjs');
const { argOf: arg, env: ENV, auth: AUTH, has } = parseArgs();
const SOLUTION = arg('solution') || 'Muwafaqa';
if (MODE === 'apply' && !has('--confirm-mutates-environment')) {
  console.error(`WARNING: --mode=apply creates ${Object.keys(TABLES).length} tables, ${COLUMNS.length} columns, a relationship and an alternate key in the environment and adds them to the solution ${SOLUTION}. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
  process.exit(2);
}

const SOL = { 'MSCRM.SolutionUniqueName': SOLUTION };
let S; let bad = 0;
const out = (status, name, detail = '') => { if (status === 'FAIL') bad++; console.log(`${status.padEnd(4)}  ${name}${detail !== '' ? `  [${detail}]` : ''}`); };
const show = (checks) => { for (const c of checks) out(c.ok ? 'PASS' : 'FAIL', c.name, String(c.got)); };

async function exists(path) {
  const r = await S.call('GET', path);
  if (r.ok) return r;
  if (r.status === 404) return null;
  throw new Stop(`could not read ${noGuid(path).slice(0, 90)}: HTTP ${r.status} ${S.msgOf(r)}`);
}
async function waitFor(fn, what, tries = 15) {
  for (let i = 0; i < tries; i++) { if (await fn()) return; await sleep(2000); }
  throw new Stop(`${what} was created but is not readable after ${tries * 2} s.`);
}
async function write(method, path, body, what) {
  await requireStableConnection(S.call, { need: 3, maxAttempts: 6, pauseMs: 1500 });
  const w = await S.call(method, path, body, SOL);
  if (!w.ok) throw new Stop(`creating ${what} answered HTTP ${w.status} ${noGuid(S.msgOf(w))}. Not retried, no other form is tried. Read the state with --mode=verify.`);
  console.log(`CREATED  ${what}`);
}

async function apply() {
  for (const t of Object.values(TABLES)) {
    if (await exists(`EntityDefinitions(LogicalName='${t.logical}')?$select=LogicalName`)) console.log(`SKIP     table ${t.logical} (exists)`);
    else {
      await write('POST', 'EntityDefinitions', tableBody(t), `table ${t.logical}`);
      await waitFor(async () => !!(await exists(`EntityDefinitions(LogicalName='${t.logical}')?$select=LogicalName`)), `table ${t.logical}`);
    }
    for (const c of COLUMNS.filter((x) => x.table === t.logical)) {
      if (await exists(`EntityDefinitions(LogicalName='${t.logical}')/Attributes(LogicalName='${c.logical}')?$select=LogicalName`)) { console.log(`SKIP     ${c.kind} ${c.table}.${c.logical} (exists)`); continue; }
      if (c.kind === 'lookup') await write('POST', 'RelationshipDefinitions', lookupBody(c), `lookup ${c.table}.${c.logical} -> ${c.referenced} (delete ${c.delete})`);
      else await write('POST', `EntityDefinitions(LogicalName='${t.logical}')/Attributes`, columnBody(c), `column ${c.table}.${c.logical}`);
    }
    for (const k of KEYS.filter((x) => x.table === t.logical)) {
      const keys = (await S.must('GET', `EntityDefinitions(LogicalName='${t.logical}')/Keys?$select=SchemaName,EntityKeyIndexStatus`)).j.value;
      if (keys.some((x) => x.SchemaName === k.schema)) console.log(`SKIP     key ${k.schema} (exists)`);
      else await write('POST', `EntityDefinitions(LogicalName='${t.logical}')/Keys`, keyBody(k), `key ${k.schema} on (${k.attributes.join(', ')})`);
    }
  }
}

async function verify() {
  const sol = (await S.must('GET', `solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid`)).j.value;
  for (const t of Object.values(TABLES)) {
    const md = await exists(`EntityDefinitions(LogicalName='${t.logical}')?$select=LogicalName,OwnershipType,HasNotes,HasActivities,IsAuditEnabled,EntitySetName,MetadataId`);
    if (!md) { out('MISS', `table ${t.logical} does not exist yet`); bad++; continue; }
    const attrs = (await S.must('GET', `EntityDefinitions(LogicalName='${t.logical}')/Attributes?$select=LogicalName,AttributeType,RequiredLevel,IsAuditEnabled`)).j.value;
    show(tableChecks(t, md.j, attrs));
    for (const c of COLUMNS.filter((x) => x.table === t.logical && x.kind === 'picklist')) {
      const p = await exists(`EntityDefinitions(LogicalName='${t.logical}')/Attributes(LogicalName='${c.logical}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName,DefaultFormValue&$expand=OptionSet($select=IsGlobal,Options)`);
      if (p) show(optionChecks(c, p.j)); else { out('FAIL', `${c.table}.${c.logical} option set could not be read`); }
    }
    const rels = (await S.must('GET', `EntityDefinitions(LogicalName='${t.logical}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,CascadeConfiguration`)).j.value;
    for (const c of COLUMNS.filter((x) => x.table === t.logical && x.kind === 'lookup')) show(lookupChecks(c, rels));
    const keys = (await S.must('GET', `EntityDefinitions(LogicalName='${t.logical}')/Keys?$select=SchemaName,KeyAttributes,EntityKeyIndexStatus`)).j.value;
    for (const k of KEYS.filter((x) => x.table === t.logical)) show(keyChecks(k, keys));
    const own = (await S.must('GET', `solutioncomponents?$filter=_solutionid_value eq ${sol[0].solutionid} and objectid eq ${md.j.MetadataId}&$select=componenttype`)).j.value;
    out(own.length >= 1 ? 'PASS' : 'FAIL', `${t.logical} is a component of the solution ${SOLUTION}`, `${own.length} row(s)`);
    const n = (await S.must('GET', `${md.j.EntitySetName}?$select=${t.logical}id&$count=true&$top=1`)).j['@odata.count'];
    out(n === 0 ? 'PASS' : 'FAIL', `${t.logical} holds 0 rows (the baseline)`, String(n));
  }
}

(async () => {
  try {
    S = await openSession({ env: ENV, auth: AUTH });
    const sol = (await S.must('GET', `solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid,ismanaged`)).j.value;
    if (sol.length !== 1 || sol[0].ismanaged) throw new Stop(`solution ${SOLUTION}: expected 1 unmanaged solution, found ${sol.length}${sol[0]?.ismanaged ? ' (managed)' : ''}`);
    if (MODE === 'apply') await apply();
    console.log('--- read back');
    await verify();
    console.log(`\nSUMMARY: ${bad} failed check(s).${MODE === 'apply' ? ' NEXT: scripts/configure-auditing.mjs --mode=verify, then pac solution sync + scripts/scrub-emails.mjs. The key index may still be building: rerun --mode=verify until Active.' : ''}`);
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
