#!/usr/bin/env node
/**
 * The two tables of ADR-011 (status Proposed): mwf_obligation (audit ON) and mwf_alertlog (service table, audit OFF, alternate key on mwf_alertkey).
 * Written for review. NOT RUN against any environment: ADR-011 has not been approved and the data model must be reviewed first.
 *
 *   --mode=plan    (default) prints exactly what --mode=apply would create for the stage, the solution it would use, and the gates. No network, no
 *                  sign-in, no --env needed. Writes nothing.
 *   --mode=verify  READ ONLY: ownership, notes and activities, table audit flag, every column (type, required level, audit flag), the Choice values,
 *                  the lookup and its DELETE behavior, solution membership, row counts (expected 0) and the alternate key with EntityKeyIndexStatus
 *                  == Active. Needs --solution. Exit 1 when a check fails (including a key that is not Active).
 *   --mode=apply   needs ALL of: --confirm-mutates-environment, --auth=az, --stage=tables|key, --solution=<unique name> (no default), --env.
 *                  Order: connection gate, solution check, baseline (11 contracts by default, 110 matrix rows, 5 assignments, 0 steps, ADR-011 tables 0 rows)
 *                  and only then the first write; the connection gate runs again before every write. Every write is a POST with the solution header.
 *                  Resumable: existing objects are read, only what is missing is created, a difference is reported as DRIFT and never overwritten.
 *                  There is no delete, no PUT and no PATCH in this script (lib/obligation-apply.mjs, guardedCall). No security role or privilege is created.
 *     --stage=tables  both tables, their columns and the lookup. No key.
 *     --stage=key     the alternate key only, then a bounded poll of EntityKeyIndexStatus (--poll-seconds=5, --max-wait-seconds=300); stops on Failed.
 *                     It never starts the uniqueness test; that is a separate, later step.
 *
 * Usage:
 *   node scripts/add-obligation-schema.mjs [--stage=tables|key] [--solution=<unique name>]                      (plan, offline)
 *   node scripts/add-obligation-schema.mjs --mode=verify --env=https://<org>.crm4.dynamics.com [--auth=device|az] --solution=<unique name>
 *   node scripts/add-obligation-schema.mjs --mode=apply --stage=tables --env=https://<org>.crm4.dynamics.com --auth=az --solution=<unique name> --confirm-mutates-environment
 *   node scripts/add-obligation-schema.mjs --mode=apply --stage=key    --env=https://<org>.crm4.dynamics.com --auth=az --solution=<unique name> --confirm-mutates-environment
 *
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
import { TABLES, COLUMNS, KEYS, planLines, tableChecks, optionChecks, lookupChecks, keyChecks } from './lib/obligation-schema.mjs';
import { STAGES, applyPreflight, runApply } from './lib/obligation-apply.mjs';

const argv = process.argv;
const argOfRaw = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const MODE = argOfRaw('mode') || 'plan';
const STAGE = argOfRaw('stage');
const SOLUTION = argOfRaw('solution');   // a named parameter; there is no default
if (!['plan', 'verify', 'apply'].includes(MODE)) { console.error('Invalid --mode=plan|verify|apply. Nothing was run.'); process.exit(2); }
if (STAGE && !STAGES.includes(STAGE)) { console.error(`Invalid --stage=${STAGES.join('|')}. Nothing was run.`); process.exit(2); }

if (MODE === 'plan') {
  console.log(`PLAN (offline, nothing is sent). Stage: ${STAGE || 'both, in this order: tables, then key (apply runs ONE stage per run)'}.`);
  console.log(`Solution: ${SOLUTION || 'NOT GIVEN: apply and verify refuse without --solution=<unique name>; there is no default'}. Every POST would carry the header MSCRM.SolutionUniqueName with this name.`);
  console.log('Gates of --mode=apply: --confirm-mutates-environment and --auth=az and --stage and --solution are required (else exit 2, before any sign-in); then the connection gate, the solution check (exactly one unmanaged solution) and the baseline (contracts, 110 matrix rows, 5 assignments, 0 steps, ADR-011 tables 0 rows) before the FIRST write; the connection gate again before every write; no delete, PUT or PATCH exists.');
  if (STAGE === 'key') console.log('Key stage: needs both tables and mwf_alertkey; the poll of EntityKeyIndexStatus is bounded (--poll-seconds, --max-wait-seconds); Failed stops the script; the uniqueness test is never started.');
  console.log('The script would create, if missing (existing objects are read and compared, never overwritten):');
  for (const l of planLines(STAGE || undefined)) console.log(l);
  console.log('Use --mode=verify (read only) or --mode=apply with the gates above to go further. Nothing was written.');
  process.exit(0);
}

if (MODE === 'apply') {
  const why = applyPreflight({ confirm: argv.includes('--confirm-mutates-environment'), auth: argOfRaw('auth'), stage: STAGE, solution: SOLUTION });
  if (why.length) { console.error(`REFUSED (exit 2). ${why.join('; ')}. Nothing was run.`); process.exit(2); }
}
if (MODE === 'verify' && !SOLUTION) { console.error('REFUSED (exit 2). --solution=<unique name> is required; there is no default. Nothing was run.'); process.exit(2); }

const { parseArgs, openSession, noGuid, sleep, Stop } = await import('./lib/dv-session.mjs');
const { requireStableConnection } = await import('./lib/counter-snapshot.mjs');
const { expectContractsOrExit, describeExpectContracts } = await import('./lib/expect-contracts.mjs');
const { env: ENV, auth: AUTH } = parseArgs();
let S; let bad = 0;
const out = (status, name, detail = '') => { if (status === 'FAIL') bad++; console.log(`${status.padEnd(4)}  ${name}${detail !== '' ? `  [${detail}]` : ''}`); };
const show = (checks) => { for (const c of checks) out(c.ok ? 'PASS' : 'FAIL', c.name, String(c.got)); };

async function exists(path) {
  const r = await S.call('GET', path);
  if (r.ok) return r;
  if (r.status === 404) return null;
  throw new Stop(`could not read ${noGuid(path).slice(0, 90)}: HTTP ${r.status} ${S.msgOf(r)}`);
}

async function verify() {
  const sol = (await S.must('GET', `solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid`)).j.value;
  if (sol.length !== 1) throw new Stop(`solution ${SOLUTION}: expected 1, found ${sol.length}`);
  for (const t of Object.values(TABLES)) {
    const md = await exists(`EntityDefinitions(LogicalName='${t.logical}')?$select=LogicalName,OwnershipType,HasNotes,HasActivities,IsAuditEnabled,EntitySetName,MetadataId`);
    if (!md) { out('MISS', `table ${t.logical} does not exist yet`); bad++; continue; }
    const attrs = (await S.must('GET', `EntityDefinitions(LogicalName='${t.logical}')/Attributes?$select=LogicalName,AttributeType,RequiredLevel,IsAuditEnabled`)).j.value;
    show(tableChecks(t, md.j, attrs));
    for (const c of COLUMNS.filter((x) => x.table === t.logical && x.kind === 'picklist')) {
      const p = await exists(`EntityDefinitions(LogicalName='${t.logical}')/Attributes(LogicalName='${c.logical}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName,DefaultFormValue&$expand=OptionSet($select=IsGlobal,Options)`);
      if (p) show(optionChecks(c, p.j)); else out('FAIL', `${c.table}.${c.logical} option set could not be read`);
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
    if (MODE === 'apply') {
      const EXPECT = expectContractsOrExit();
      console.log(describeExpectContracts(EXPECT));
      const r = await runApply({
        call: S.call, stage: STAGE, solution: SOLUTION, expectContracts: EXPECT.value, sleep,
        gate: () => requireStableConnection(S.call, { need: 3, maxAttempts: 6, pauseMs: 1500 }),
        log: (l) => console.log(noGuid(l)),
        pollSeconds: Number(argOfRaw('poll-seconds')) || 5, maxWaitSeconds: Number(argOfRaw('max-wait-seconds')) || 300,
      });
      console.log(`\nSUMMARY (stage ${STAGE}): ${r.created.length} created, ${r.skipped.length} already existed, ${r.drift.length} drift line(s)${r.keyStatus ? `, key status ${r.keyStatus}` : ''}${r.stopped ? `. STOPPED: ${noGuid(r.stopped)}` : ''}`);
      if (STAGE === 'tables' && r.ok) console.log('NEXT: --stage=key (separate run), then --mode=verify. The uniqueness test is a separate step after the key is Active.');
      process.exit(r.ok ? 0 : r.stopped ? 4 : 1);
    }
    const sol = (await S.must('GET', `solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid,ismanaged`)).j.value;
    if (sol.length !== 1 || sol[0].ismanaged) throw new Stop(`solution ${SOLUTION}: expected 1 unmanaged solution, found ${sol.length}${sol[0]?.ismanaged ? ' (managed)' : ''}`);
    console.log('--- read back');
    await verify();
    console.log(`\nSUMMARY: ${bad} failed check(s).`);
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
