#!/usr/bin/env node
/**
 * Behavioral test of the four project security roles (ADR-008) with a Dataverse APPLICATION USER (service principal) that the owner creates
 * in the environment. NOT RUN YET. FICTIONAL rows only, prefix TEST-TMP-SEC. Both approval flows must be OFF the whole time (read; the script stops if
 * one is ON and never turns one on or off).
 *
 * Authentication of the application user: OAuth 2.0 client credentials. The tenant id, client id and secret come ONLY from the environment variables
 *   MWF_TEST_TENANT_ID   MWF_TEST_CLIENT_ID   MWF_TEST_CLIENT_SECRET
 * Their values are never printed, never written to a file or a log (every message goes through a redactor that also removes them, the host, the
 * organization name and every GUID); when a variable is missing only its NAME is printed. The token stays in memory.
 *
 * The admin account (the one that runs the other scripts, `--auth=az`) assigns ONE project role at a time to the application user through the Web API
 * (POST systemusers(<user>)/systemuserroles_association/$ref), polls a read as the application user until the privilege cache shows the grant (up to
 * 5 minutes), runs the cases of that role, and ALWAYS removes the role in a finally block and polls until the read is refused again. A role that cannot
 * be shown removed stops the run (no other role is assigned on top of it). The Web API association syntax is the standard one and was not tested here.
 *
 * Cases (see lib/security-test.mjs CASES; PASS / FAIL / OBS, nothing assumed; every failure prints the literal error message, redacted):
 *   Requester  R1 create a Draft (number generated) R2 read own R3 edit own Draft R4 submit (builder builds steps, USD frozen) R5 read steps denied
 *              R6 create Counterparty denied R7 delete Draft allowed / delete Pending refused R8 withdraw then delete a Draft with steps (observed)
 *              R9 matrix, assignments, counter: read, create, write denied R10 bypass headers refused R11 a contract owned by someone else not visible R12 read Counterparty
 *   Approver   A1 read contracts A2 read steps A3 read Counterparty A4 create contract denied A5 write contract denied A6 write step denied
 *   Finance    F1 read matrix and assignments F2 create Counterparty F3 edit it F4 delete denied F5 write matrix / assignments denied F6 counter denied F7 read contracts, write denied
 *   Admin      D1 matrix create, edit, delete D2 assignment edit (same value) D3 counter denied D4 contracts: read only D5 Counterparty C/E/D D6 read steps
 * Denial tests on a real row use a SAME-VALUE write (a refused write changes nothing; if it is wrongly accepted the value is the same and the run stops after
 * that role). Deletes are tried on a row that cannot exist (403 is conclusive, 404 is only an observation) or on a row this test created.
 *
 * After the roles: cleanup with the admin account (a Pending contract is withdrawn to Draft, then deleted; the administrative bypass is never needed
 * for these rows), the counters are restored by the usual rule, check-clean.
 *
 * Modes (every mode that writes needs --confirm-mutates-environment; --dry-run reads and prints what it would send, sends nothing):
 *   --mode=plan       offline: the sequence, the cases and the variable names
 *   --mode=baseline   read only (and one token request): flows OFF, the four roles exist with 0 members, the application user is found and has no project role,
 *                     its token works, the state is clean
 *   --mode=run        the whole test
 *   --mode=cleanup    removes any project role from the application user, deletes the TEST-TMP-SEC rows, restores the counters (--counters-before/--counters-consumed)
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, openSession, noGuid, sleep, Stop } from './lib/dv-session.mjs';
import { snapshotCounters, ctrIo, trackCreate, restoreAfterRun, restoreFromArgs, printHandoff, requireStableConnection } from './lib/counter-snapshot.mjs';
import { deleteContracts } from './lib/contract-cleanup.mjs';
import { enterCleanupPhase, resilientFetch } from './lib/resilient-fetch.mjs';
import { allFlowsOff } from './lib/bulk-messages.mjs';
import { BUILDER_STEP_NAME } from './lib/flow-failures.mjs';
import { ENV_NAMES, PREFIX, NIL_ID, ROLE_ORDER, CASES, missingEnv, tokenRequest, associatePath, associateBody, disassociatePath, makeRedactor, judge, judgeProbeOnNilId, shortMessage, pollUntil } from './lib/security-test.mjs';

const MODE = (process.argv.find((a) => a.startsWith('--mode=')) || '').slice(7);
const q = encodeURIComponent;

if (MODE === 'plan') {
  console.log(`Behavioral test of the project roles (offline plan; nothing is read or written). Prefix ${PREFIX}. Both flows OFF.\n`);
  console.log(`Environment variables (names only; values are never printed or stored): ${ENV_NAMES.join(', ')}`);
  console.log('Sequence: read state -> token of the application user -> admin fixtures (counterparty, a Draft owned by the admin, a submitted contract of USD 25,000 owned by the admin)');
  console.log('          -> for each role in order: assign ONE role, poll until it is effective (max 5 min), run its cases, ALWAYS unassign, poll until it is refused again (max 5 min)');
  console.log('          -> cleanup with the admin account, restore the counters, check-clean.\n');
  for (const role of ROLE_ORDER) { console.log(role); for (const [id, t] of CASES[role]) console.log(`   ${id.padEnd(4)} ${t}`); }
  console.log('\nSide effects to know: the Admin case D1 creates and deletes one matrix row (a band far above the seed data, in the table for a few seconds); D2 writes the same value into one assignment row (its modifiedon changes);');
  console.log('a FAIL of a denial case stops the run after that role (cleanup always runs); a FAIL of an allowed case is recorded and the run continues (that is the list of missing basic privileges).');
  process.exit(0);
}

const { argOf, env: ENV, auth: AUTH, has } = parseArgs();
const DRY = has('--dry-run');
if (!['baseline', 'run', 'cleanup'].includes(MODE)) { console.error('Missing or invalid --mode=plan|baseline|run|cleanup. Nothing was run.'); process.exit(2); }
if (['run', 'cleanup'].includes(MODE) && !DRY && !has('--confirm-mutates-environment')) {
  console.error(`WARNING: --mode=${MODE} assigns roles to the application user and creates and deletes ${PREFIX}* rows. Add --confirm-mutates-environment to run it on purpose, or --dry-run to see what it would do. Nothing was run.`);
  process.exit(2);
}
const missing = missingEnv(process.env);
if (missing.length && MODE !== 'cleanup') {
  console.error(`Missing environment variable(s): ${missing.join(', ')}. Set them in the shell (values are never printed or stored). Nothing was run.`);
  process.exit(2);
}
const TENANT = process.env.MWF_TEST_TENANT_ID || ''; const CLIENT = process.env.MWF_TEST_CLIENT_ID || ''; const SECRET = process.env.MWF_TEST_CLIENT_SECRET || '';
const RED = makeRedactor(ENV, [SECRET, TENANT, CLIENT]);
const API = `${ENV}/api/data/v9.2`;

let S; let SNAP = null; let USERID = null; let leaks = 0;
const results = [];
const out = (id, status, name, detail = '') => { results.push({ id, status }); console.log(RED(`${status.padEnd(4)}  ${id.padEnd(5)} ${name}${detail ? `  [${detail}]` : ''}`)); };
const get = async (p) => (await S.must('GET', p)).j;
const count = async (path) => (await get(`${path}${path.includes('?') ? '&' : '?'}$count=true&$top=1`))['@odata.count'];
const gate = () => requireStableConnection(S.call, { need: 3, maxAttempts: 6, pauseMs: 1500 });
async function write(method, path, body, extra, note) {
  if (DRY) { console.log(RED(`DRY-RUN  would ${method} ${noGuid(path).slice(0, 90)}${note ? `  ${note}` : ''}`)); return { ok: true, status: 0, id: null, j: {}, dry: true }; }
  await gate();
  return S.call(method, path, body, extra);
}

// ---------------------------------------------------------------------------------------------------------------- the application user
let appTok = null; let appTokAt = 0;
async function appToken() {
  const { url, body } = tokenRequest(TENANT, CLIENT, SECRET, ENV);
  let r; let t;
  try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); t = await r.text(); }
  catch (e) { throw new Stop(`token request: network error (${RED(String(e?.cause?.code || e?.code || e?.name || 'fetch failed'))})`); }
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  if (!r.ok || !j?.access_token) throw new Stop(`token request failed HTTP ${r.status}: ${RED(shortMessage(j?.error_description || j?.error || ''))}`);
  appTok = j.access_token; appTokAt = Date.now();
}
/** One request as the application user. Reads are retried on network errors only (shared wrapper); a write never is. */
async function app(method, path, body, extra = {}) {
  if (!appTok || Date.now() - appTokAt > 40 * 60 * 1000) await appToken();
  const r = await resilientFetch(`${API}/${path}`, { method, headers: { Authorization: `Bearer ${appTok}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Content-Type': 'application/json; charset=utf-8', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* not json */ }
  const m = /\(([0-9a-fA-F-]{36})\)/.exec(r.headers.get('OData-EntityId') || '');
  return { ok: r.ok, status: r.status, j, id: m ? m[1] : null, message: RED(shortMessage(j?.error?.message || (r.ok ? '' : text))) };
}
async function findUser() {
  const u = (await get(`systemusers?$select=fullname,isdisabled,applicationid&$filter=applicationid eq ${CLIENT}`)).value;
  if (u.length !== 1) throw new Stop(`Expected exactly one application user for the client id (read from the environment variable), found ${u.length}. The owner creates it in the environment first. Nothing was changed.`);
  if (u[0].isdisabled) throw new Stop('The application user is disabled. Nothing was changed.');
  USERID = u[0].systemuserid; return USERID;
}
async function rolesOfUser() {
  const r = await get(`systemusers(${USERID})?$select=fullname&$expand=systemuserroles_association($select=name)`);
  return (r.systemuserroles_association || []).map((x) => x.name);
}
async function roleIds() {
  const ids = {};
  for (const n of ROLE_ORDER) {
    const r = (await get(`roles?$select=name&$filter=${q(`name eq '${n}'`)}`)).value;
    if (r.length !== 1) throw new Stop(`Expected one role named "${n}", found ${r.length}. Run scripts/create-security-roles.mjs first. Nothing was changed.`);
    ids[n] = r[0].roleid;
  }
  return ids;
}
async function membersOf(roleId) {
  const r = await get(`roles(${roleId})?$select=name&$expand=systemuserroles_association($select=systemuserid),teamroles_association($select=teamid)`);
  return { users: (r.systemuserroles_association || []).length, teams: (r.teamroles_association || []).length };
}

// ---------------------------------------------------------------------------------------------------------------- state
async function flowsOff() {
  const rows = (await get(`workflows?$select=name,statecode&$filter=${q("category eq 5 and contains(name,'Contract Approval')")}`)).value;
  return { ok: allFlowsOff(rows), line: rows.map((r) => `${/v\d\s*$/.exec(r.name)?.[0] || 'flow'} ${r.statecode === 0 ? 'OFF' : 'ON'}`).join(', ') };
}
async function checkClean() {
  const a = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value.length;
  const b = (await get(`mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value.length;
  const mx = (await get(`mwf_approvalmatrixes?$select=mwf_rulename&$filter=${q(`startswith(mwf_rulename,'${PREFIX}')`)}`)).value.length;
  const total = await count('mwf_contracts'); const steps = await count('mwf_approvalsteps');
  const m = await count('mwf_approvalmatrixes?$filter=statecode eq 0'); const asg = await count('mwf_approverassignments?$filter=statecode eq 0');
  console.log(`check-clean (prefix ${PREFIX}): contracts ${a}, counterparties ${b}, matrix rows ${mx}, total contracts ${total}, steps ${steps}, active matrix rows ${m}, active assignments ${asg} (expected 0, 0, 0, 11, 0, 110, 5)`);
  return { a, b, mx, total, steps, m, asg };
}
async function baseline() {
  const f = await flowsOff(); out('state', f.ok ? 'PASS' : 'FAIL', `both approval flows are OFF (${f.line})`);
  const ids = await roleIds();
  for (const n of ROLE_ORDER) { const m = await membersOf(ids[n]); out('state', m.users === 0 && m.teams === 0 ? 'PASS' : 'FAIL', `${n}: 0 members before the test`, `${m.users} user(s), ${m.teams} team(s)`); }
  await findUser(); out('state', 'PASS', 'the application user exists and is enabled');
  const names = await rolesOfUser(); out('state', names.filter((n) => ROLE_ORDER.includes(n)).length === 0 ? 'PASS' : 'FAIL', 'the application user holds no project role', `${names.length} role(s) of any kind`);
  try { await appToken(); out('state', 'PASS', 'a token was obtained for the application user (client credentials)'); } catch (e) { out('state', 'FAIL', 'token for the application user', RED(e.message)); }
  const c = await checkClean();
  out('state', c.a === 0 && c.b === 0 && c.mx === 0 && c.total === 11 && c.steps === 0 && c.m === 110 && c.asg === 5 ? 'PASS' : 'FAIL', 'the starting state is clean');
  return !results.some((r) => r.status === 'FAIL');
}

// ---------------------------------------------------------------------------------------------------------------- role assignment
const CACHE = { timeoutMs: 5 * 60 * 1000, everyMs: 15 * 1000 };
const probeRead = () => app('GET', 'mwf_contracts?$select=mwf_contractid&$top=1');
async function assign(role, ids) {
  const r = await write('POST', associatePath(USERID), associateBody(ENV, ids[role]), undefined, `[assign ${role}]`);
  if (!r.ok) throw new Stop(`assigning ${role} failed HTTP ${r.status} ${RED(S.msgOf(r))}. Not retried. Read the state with --mode=baseline.`);
  if (DRY) return true;
  const w = await pollUntil(async () => (await probeRead()).status === 200, { ...CACHE, sleep });
  out('role', w.reached ? 'PASS' : 'FAIL', `${role}: effective for the application user (a read of contracts answers 200)`, `${Math.round(w.waitedMs / 1000)} s`);
  return w.reached;
}
async function unassign(role, ids) {
  const r = await write('DELETE', disassociatePath(USERID, ids[role]), undefined, undefined, `[unassign ${role}]`);
  if (DRY) return;
  if (!r.ok && r.status !== 404) console.error(RED(`WARNING: removing ${role} answered HTTP ${r.status} ${S.msgOf(r)}. Not retried.`));
  const m = await membersOf(ids[role]);
  if (m.users !== 0) throw new Stop(`STATE UNKNOWN: ${role} still has ${m.users} user member(s) after the removal. Remove it by hand, then run --mode=cleanup. Stopping before any other role is assigned.`);
  const w = await pollUntil(async () => { const x = await probeRead(); return x.status === 401 || x.status === 403; }, { ...CACHE, sleep });
  out('role', w.reached ? 'PASS' : 'FAIL', `${role}: removed, and the read of contracts is refused again`, `${Math.round(w.waitedMs / 1000)} s`);
  if (!w.reached) throw new Stop(`${role} was removed but the application user can still read contracts after 5 minutes (cache). Stopping before another role is assigned.`);
}

// ---------------------------------------------------------------------------------------------------------------- recording helpers
const RET = { Prefer: 'return=representation' };
/** Record one request. expect 'allow' | 'deny'; probe = the request was on a row that cannot exist. A deny that was ACCEPTED counts as a leak. */
function A(id, name, resp, expect, { accept = [], probe = false } = {}) {
  const v = probe ? judgeProbeOnNilId(resp.status) : judge(expect, resp.status, accept);
  if (expect === 'deny' && resp.ok) leaks++;
  out(id, v, name, `HTTP ${resp.status}${resp.message ? `: ${resp.message}` : ''}`);
  return v === 'PASS';
}
const skip = (id, name, why) => out(id, 'OBS', `${name}: skipped`, why);

// ---------------------------------------------------------------------------------------------------------------- fixtures and suites
const F = {};   // fixtures: cp, usd, other, submitted, steps, matrix, assignment, counter, sets, builderStepId
const contractBody = (name, value = 25000) => ({ mwf_name: name, mwf_contracttype: 867640000, mwf_direction: 867640001, mwf_value: value,
  'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${F.cp})`, 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${F.usd})` });
const createdByApp = (r) => { if (r.ok) trackCreate('POST', 'mwf_contracts', { mwf_contracttype: 867640000 }, true); };

async function makeFixtures() {
  F.usd = (await get("transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0")).value[0].transactioncurrencyid;
  F.sets = { matrix: 'mwf_approvalmatrixes', assignment: 'mwf_approverassignments', counter: (await get("EntityDefinitions(LogicalName='mwf_contractnumbercounter')?$select=EntitySetName")).EntitySetName };
  const b = (await get(`sdkmessageprocessingsteps?$select=name&$filter=${q(`name eq '${BUILDER_STEP_NAME}'`)}`)).value; if (b.length !== 1) throw new Stop(`builder step: expected 1, found ${b.length}`);
  F.builderStepId = b[0].sdkmessageprocessingstepid;
  const mx = (await get('mwf_approvalmatrixes?$select=mwf_rulename&$top=1')).value[0]; F.matrix = { id: mx.mwf_approvalmatrixid, name: mx.mwf_rulename };
  const as = (await get('mwf_approverassignments?$select=mwf_name&$filter=mwf_approverrole eq 867640004')).value[0]; F.assignment = { id: as.mwf_approverassignmentid, name: as.mwf_name };
  const ct = (await get(`${F.sets.counter}?$select=mwf_prefix&$top=1`)).value[0]; F.counter = { id: ct[`mwf_contractnumbercounterid`], prefix: ct.mwf_prefix };
  const cpOpt = (await get("EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)")).OptionSet.Options[0].Value;
  F.cpOpt = cpOpt;
  const cp = await write('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} Fictional Counterparty (delete me)`, mwf_counterpartytype: cpOpt });
  if (!cp.ok) throw new Stop(`counterparty create failed HTTP ${cp.status} ${RED(S.msgOf(cp))}`); F.cp = cp.id || '<dry-run>';
  const o = await write('POST', 'mwf_contracts?$select=mwf_contractnumber', contractBody(`${PREFIX}-OTHER owned by the admin`, 1000), RET);
  if (!o.ok) throw new Stop(`fixture contract failed HTTP ${o.status} ${RED(S.msgOf(o))}`); F.other = o.j?.mwf_contractid;
  const s = await write('POST', 'mwf_contracts?$select=mwf_contractnumber', contractBody(`${PREFIX}-SUBMITTED owned by the admin`, 25000), RET);
  if (!s.ok) throw new Stop(`fixture contract failed HTTP ${s.status} ${RED(S.msgOf(s))}`); F.submitted = s.j?.mwf_contractid;
  if (DRY) return;
  printHandoff(SNAP);
  const sub = await write('PATCH', `mwf_contracts(${F.submitted})`, { statuscode: 867640000 }, { 'If-Match': '*' });
  if (!sub.ok) throw new Stop(`fixture submission failed HTTP ${sub.status} ${RED(S.msgOf(sub))}`);
  F.steps = (await get(`mwf_approvalsteps?$select=mwf_steporder,mwf_decision&$filter=_mwf_contract_value eq ${F.submitted}&$orderby=mwf_steporder asc`)).value;
  out('fixture', F.steps.length === 2 ? 'PASS' : 'FAIL', 'the submitted fixture contract (USD 25,000) has its 2 steps (flows OFF, the builder built them)', `${F.steps.length}`);
  if (F.steps.length !== 2) throw new Stop('fixture chain is not what the matrix says. Stopping.');
}

async function requesterSuite() {
  const c = {};
  let r = await app('POST', 'mwf_contracts?$select=mwf_contractnumber', contractBody(`${PREFIX}-R1`), RET);
  A('R1', 'create a Draft with an existing Counterparty', r, 'allow'); createdByApp(r);
  if (r.ok) { c.id = r.j.mwf_contractid; c.number = r.j.mwf_contractnumber; out('R1', /^[A-Z]+-\d{4,}$/.test(String(c.number)) ? 'PASS' : 'FAIL', 'the contract number is generated (PREFIX-NNNN)', String(c.number)); }
  if (c.id) {
    A('R2', 'read own contract', await app('GET', `mwf_contracts(${c.id})?$select=mwf_name`), 'allow');
    A('R3', 'edit own Draft', await app('PATCH', `mwf_contracts(${c.id})`, { mwf_name: `${PREFIX}-R1 edited` }, { 'If-Match': '*' }), 'allow');
    const sub = await app('PATCH', `mwf_contracts(${c.id})`, { statuscode: 867640000 }, { 'If-Match': '*' });
    A('R4', 'submit Draft to Pending', sub, 'allow');
    if (sub.ok) {
      const row = await get(`mwf_contracts(${c.id})?$select=statuscode,mwf_approvalround,mwf_valueusdfrozen`);
      const n = (await get(`mwf_approvalsteps?$select=mwf_steporder&$filter=_mwf_contract_value eq ${c.id}`)).value.length;
      out('R4', row.statuscode === 867640000 && row.mwf_approvalround === 1 && Number(row.mwf_valueusdfrozen) === 25000 && n === 2 ? 'PASS' : 'FAIL', 'the builder built 2 steps (round 1) and the USD value is frozen (read by the admin)', `status ${row.statuscode}, round ${row.mwf_approvalround}, frozen ${row.mwf_valueusdfrozen}, ${n} step(s)`);
    }
  } else for (const id of ['R2', 'R3', 'R4']) skip(id, 'own-contract case', 'R1 did not create the contract');
  A('R5', 'read approval steps', await app('GET', 'mwf_approvalsteps?$select=mwf_name&$top=1'), 'deny');
  A('R6', 'create a Counterparty', await app('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} requester counterparty`, mwf_counterpartytype: F.cpOpt }), 'deny');
  const d = await app('POST', 'mwf_contracts?$select=mwf_contractnumber', contractBody(`${PREFIX}-R7`), RET); createdByApp(d);
  if (d.ok) A('R7', 'delete an own Draft', await app('DELETE', `mwf_contracts(${d.j.mwf_contractid})`), 'allow'); else skip('R7', 'delete a Draft', `could not create it: HTTP ${d.status} ${d.message}`);
  if (c.id) {
    A('R7', 'delete a Pending contract is refused (by the guard, 400, or by the privilege)', await app('DELETE', `mwf_contracts(${c.id})`), 'deny', { accept: [400] });
    const w = await app('PATCH', `mwf_contracts(${c.id})`, { statuscode: 1 }, { 'If-Match': '*' });
    A('R8', 'withdraw own Pending contract to Draft', w, 'allow');
    if (w.ok) {
      const del = await app('DELETE', `mwf_contracts(${c.id})`);
      const left = (await get(`mwf_approvalsteps?$select=mwf_steporder&$filter=_mwf_contract_value eq ${c.id}`)).value.length;
      out('R8', del.ok ? 'PASS' : 'OBS', 'delete a Draft that still has steps, without a Delete privilege on the steps', `HTTP ${del.status}${del.message ? `: ${del.message}` : ''}; steps left ${left}`);
    }
  }
  for (const [key, label, body] of [['matrix', 'the matrix', { mwf_rulename: PREFIX }], ['assignment', 'the assignments', { mwf_name: PREFIX }], ['counter', 'the counter', { mwf_prefix: 'SEC' }]]) {
    const set = F.sets[key];
    A('R9', `read ${label}`, await app('GET', `${set}?$top=1`), 'deny');
    A('R9', `create in ${label}`, await app('POST', set, body), 'deny');
    A('R9', `write ${label} (row that cannot exist)`, await app('PATCH', `${set}(${NIL_ID})`, body, { 'If-Match': '*' }), 'deny', { probe: true });
  }
  const t = await app('POST', 'mwf_contracts?$select=mwf_contractnumber', contractBody(`${PREFIX}-R10`), RET); createdByApp(t);
  if (t.ok) {
    A('R10', 'header MSCRM.BypassBusinessLogicExecutionStepIds is refused', await app('PATCH', `mwf_contracts(${t.j.mwf_contractid})`, { mwf_name: `${PREFIX}-R10 b` }, { 'If-Match': '*', 'MSCRM.BypassBusinessLogicExecutionStepIds': F.builderStepId }), 'deny', { accept: [400] });
    A('R10', 'header MSCRM.BypassBusinessLogicExecution: CustomSync is refused', await app('PATCH', `mwf_contracts(${t.j.mwf_contractid})`, { mwf_name: `${PREFIX}-R10 c` }, { 'If-Match': '*', 'MSCRM.BypassBusinessLogicExecution': 'CustomSync' }), 'deny', { accept: [400] });
  } else skip('R10', 'bypass header', `could not create the Draft: HTTP ${t.status} ${t.message}`);
  A('R11', 'a contract owned by someone else (by id) is not readable', await app('GET', `mwf_contracts(${F.other})?$select=mwf_name`), 'deny', { accept: [404] });
  const lst = await app('GET', `mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}-OTHER') or startswith(mwf_name,'${PREFIX}-SUBMITTED')`)}`);
  const seen = lst.j?.value?.length;
  if (lst.ok && seen > 0) leaks++;
  out('R11', lst.ok && seen === 0 ? 'PASS' : 'FAIL', 'a list query does not show the contracts owned by the admin', `HTTP ${lst.status}, ${seen ?? '?'} row(s)${lst.message ? ': ' + lst.message : ''}`);
  A('R12', 'read a Counterparty', await app('GET', 'mwf_counterparties?$select=mwf_name&$top=1'), 'allow');
}

async function approverSuite() {
  A('A1', 'read a contract owned by someone else (Draft)', await app('GET', `mwf_contracts(${F.other})?$select=mwf_name`), 'allow');
  A('A1', 'read a contract owned by someone else (submitted)', await app('GET', `mwf_contracts(${F.submitted})?$select=mwf_name`), 'allow');
  const st = await app('GET', `mwf_approvalsteps?$select=mwf_steporder&$filter=_mwf_contract_value eq ${F.submitted}`);
  A('A2', 'read the steps of a contract', st, 'allow'); out('A2', st.ok && st.j.value.length === 2 ? 'PASS' : 'FAIL', 'both steps are returned', `${st.j?.value?.length ?? '?'} row(s)`);
  A('A3', 'read a Counterparty', await app('GET', 'mwf_counterparties?$select=mwf_name&$top=1'), 'allow');
  const cr = await app('POST', 'mwf_contracts?$select=mwf_contractnumber', contractBody(`${PREFIX}-A4`), RET); createdByApp(cr);
  A('A4', 'create a contract', cr, 'deny');
  A('A5', 'write a contract (same value)', await app('PATCH', `mwf_contracts(${F.submitted})`, { mwf_name: `${PREFIX}-SUBMITTED owned by the admin` }, { 'If-Match': '*' }), 'deny');
  A('A6', 'write a step (same value)', await app('PATCH', `mwf_approvalsteps(${F.steps[0].mwf_approvalstepid})`, { mwf_decision: F.steps[0].mwf_decision }, { 'If-Match': '*' }), 'deny');
}

async function financeSuite() {
  A('F1', 'read the matrix', await app('GET', `${F.sets.matrix}?$select=mwf_rulename&$top=1`), 'allow');
  A('F1', 'read the assignments', await app('GET', `${F.sets.assignment}?$select=mwf_name&$top=1`), 'allow');
  const cp = await app('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} Finance counterparty`, mwf_counterpartytype: F.cpOpt });
  A('F2', 'create a Counterparty', cp, 'allow');
  if (cp.ok && cp.id) {
    A('F3', 'edit it', await app('PATCH', `mwf_counterparties(${cp.id})`, { mwf_name: `${PREFIX} Finance counterparty edited` }, { 'If-Match': '*' }), 'allow');
    A('F4', 'delete it (this row was created by the test)', await app('DELETE', `mwf_counterparties(${cp.id})`), 'deny');
  } else { skip('F3', 'edit a Counterparty', 'F2 did not create it'); skip('F4', 'delete a Counterparty', 'F2 did not create it'); }
  A('F5', 'create in the matrix', await app('POST', F.sets.matrix, { mwf_rulename: PREFIX }), 'deny');
  A('F5', 'write the matrix (same value)', await app('PATCH', `${F.sets.matrix}(${F.matrix.id})`, { mwf_rulename: F.matrix.name }, { 'If-Match': '*' }), 'deny');
  A('F5', 'write the assignments (same value)', await app('PATCH', `${F.sets.assignment}(${F.assignment.id})`, { mwf_name: F.assignment.name }, { 'If-Match': '*' }), 'deny');
  A('F6', 'read the counter', await app('GET', `${F.sets.counter}?$top=1`), 'deny');
  A('F7', 'read a contract owned by someone else', await app('GET', `mwf_contracts(${F.submitted})?$select=mwf_name`), 'allow');
  A('F7', 'write a contract (same value)', await app('PATCH', `mwf_contracts(${F.submitted})`, { mwf_name: `${PREFIX}-SUBMITTED owned by the admin` }, { 'If-Match': '*' }), 'deny');
}

async function adminSuite() {
  const row = await app('POST', F.sets.matrix, { mwf_rulename: `${PREFIX} band`, mwf_contracttype: 867640004, mwf_contractdirection: 867640000, mwf_minvalueusd: 900000000, mwf_maxvalueusd: 900000001, mwf_steporder: 1, mwf_approverrole: 867640000, mwf_actiontype: 867640000 });
  A('D1', 'create a matrix row (a band far above the seed data)', row, 'allow');
  if (row.ok && row.id) {
    A('D1', 'edit it', await app('PATCH', `${F.sets.matrix}(${row.id})`, { mwf_rulename: `${PREFIX} band edited` }, { 'If-Match': '*' }), 'allow');
    A('D1', 'delete it', await app('DELETE', `${F.sets.matrix}(${row.id})`), 'allow');
  } else { skip('D1', 'edit and delete a matrix row', 'the create did not work'); }
  A('D2', 'edit an assignment (same value; its modifiedon changes)', await app('PATCH', `${F.sets.assignment}(${F.assignment.id})`, { mwf_name: F.assignment.name }, { 'If-Match': '*' }), 'allow');
  A('D3', 'read the counter', await app('GET', `${F.sets.counter}?$top=1`), 'deny');
  A('D3', 'create in the counter', await app('POST', F.sets.counter, { mwf_prefix: 'SEC' }), 'deny');
  A('D3', 'write the counter (same value)', await app('PATCH', `${F.sets.counter}(${F.counter.id})`, { mwf_prefix: F.counter.prefix }, { 'If-Match': '*' }), 'deny');
  A('D4', 'read a contract owned by someone else', await app('GET', `mwf_contracts(${F.submitted})?$select=mwf_name`), 'allow');
  const cr = await app('POST', 'mwf_contracts?$select=mwf_contractnumber', contractBody(`${PREFIX}-D4`), RET); createdByApp(cr);
  A('D4', 'create a contract', cr, 'deny');
  A('D4', 'write a contract (same value)', await app('PATCH', `mwf_contracts(${F.submitted})`, { mwf_name: `${PREFIX}-SUBMITTED owned by the admin` }, { 'If-Match': '*' }), 'deny');
  const cp = await app('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} Admin counterparty`, mwf_counterpartytype: F.cpOpt });
  A('D5', 'create a Counterparty', cp, 'allow');
  if (cp.ok && cp.id) {
    A('D5', 'edit it', await app('PATCH', `mwf_counterparties(${cp.id})`, { mwf_name: `${PREFIX} Admin counterparty edited` }, { 'If-Match': '*' }), 'allow');
    A('D5', 'delete it', await app('DELETE', `mwf_counterparties(${cp.id})`), 'allow');
  } else skip('D5', 'edit and delete a Counterparty', 'the create did not work');
  A('D6', 'read the steps', await app('GET', `mwf_approvalsteps?$select=mwf_steporder&$top=1`), 'allow');
}
const SUITES = { 'Muwafaqa Requester': requesterSuite, 'Muwafaqa Approver': approverSuite, 'Muwafaqa Finance': financeSuite, 'Muwafaqa Admin': adminSuite };

// ---------------------------------------------------------------------------------------------------------------- run and cleanup
async function runAll() {
  if (!(await baseline())) throw new Stop('The starting state is not clean or not ready (see FAIL above). Nothing was created.');
  const ids = await roleIds();
  SNAP = await snapshotCounters(S.ctr);
  console.log('INFO  counters before: ' + Object.values(SNAP.byType).map((c) => `${c.prefix}=${c.last}`).join(' '));
  try {
    await makeFixtures();
    for (const role of ROLE_ORDER) {
      console.log(`\n=== ${role} ===`);
      let effective = false; const leaksBefore = leaks;
      try {
        effective = await assign(role, ids);
        if (DRY) { for (const [id, t] of CASES[role]) console.log(`DRY-RUN  case ${id}: ${t}`); }
        else if (effective) await SUITES[role]();
        else out('role', 'FAIL', `${role}: the cases were not run because the role was not effective in time`);
      } finally {
        if (USERID) await unassign(role, ids);
      }
      if (leaks > leaksBefore) throw new Stop(`${role}: a denial case was ACCEPTED (a privilege is granted that the design denies). Stopped after this role; cleanup runs.`);
    }
  } finally {
    enterCleanupPhase();
    if (!DRY) await cleanupData();
  }
  const bad = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\nSUMMARY: ${results.filter((r) => r.status === 'PASS').length} PASS, ${bad} FAIL, ${results.filter((r) => r.status === 'OBS').length} OBS.`);
  return bad === 0;
}

async function cleanupData(fromArgs = false) {
  if (USERID) {
    const ids = await roleIds();
    for (const n of await rolesOfUser()) if (ROLE_ORDER.includes(n)) { const d = await S.call('DELETE', disassociatePath(USERID, ids[n])); console.log(`INFO  cleanup: removed ${n} from the application user, HTTP ${d.status}`); }
  }
  const rows = (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value;
  const del = await deleteContracts(S.io, rows.map((r) => r.mwf_contractid));
  console.log(`INFO  cleanup: ${rows.length} contract row(s) found, ${del.deleted} deleted, ${del.failed.length} failed (their steps go by the cascade)`);
  for (const x of (await get(`mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value) { const d = await S.call('DELETE', `mwf_counterparties(${x.mwf_counterpartyid})`); console.log(`INFO  cleanup: counterparty delete HTTP ${d.status}`); }
  for (const x of (await get(`mwf_approvalmatrixes?$select=mwf_rulename&$filter=${q(`startswith(mwf_rulename,'${PREFIX}')`)}`)).value) { const d = await S.call('DELETE', `mwf_approvalmatrixes(${x.mwf_approvalmatrixid})`); console.log(`INFO  cleanup: matrix row delete HTTP ${d.status}`); }
  const rs = fromArgs ? await restoreFromArgs(S.ctr) : await restoreAfterRun(S.ctr, SNAP);
  const c = await checkClean();
  out('D', c.a === 0 && c.b === 0 && c.mx === 0 && c.total === 11 && c.steps === 0 && c.m === 110 && c.asg === 5 && rs.refused === 0 ? 'PASS' : 'FAIL', 'check-clean after the test: no TEST-TMP-SEC rows, 11 contracts, 0 steps, 110 matrix rows, 5 assignments, counters restored', `refused ${rs.refused}`);
}

(async () => {
  try {
    S = await openSession({ env: ENV, auth: AUTH });
    // every create by the ADMIN account goes through this wrapper so that the counters are tracked (creates by the application user are tracked in createdByApp)
    const raw = S.call; S.call = async (m, p, b, x) => { const r = await raw(m, p, b, x); trackCreate(m, p, b, r.ok); return r; };
    S.ctr = ctrIo(S.call);
    await requireStableConnection(raw);
    let ok = true;
    if (MODE === 'baseline') { await findUser().catch(() => null); ok = await baseline(); }
    else if (MODE === 'run') ok = await runAll();
    else { if (CLIENT) await findUser().catch(() => null); enterCleanupPhase(); await cleanupData(true); }
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(RED(`\nSTOPPED: ${noGuid(e.message)}`));
    if (MODE === 'run') console.error('Read the state with --mode=baseline; clean up with: node scripts/test-security-roles.mjs --mode=cleanup --env=<url> --auth=az --confirm-mutates-environment --counters-before=... --counters-consumed=...  (the values were printed after the fixtures)');
    process.exit(4);
  }
})();
