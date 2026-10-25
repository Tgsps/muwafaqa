#!/usr/bin/env node
/**
 * Audit test for the approver-user lookup `mwf_approverassignment.mwf_user` (ADR-009 left a change of this column "not tested"). NOT RUN YET.
 * FICTIONAL row only, prefix TEST-TMP-AUDUSER. Signs in as the OWNER (device code by default, or --auth=az), never as an application user.
 *
 * Scenario (plan mode by default; a write needs --mode=run and --confirm-mutates-environment):
 *   1  create ONE temporary assignment row `TEST-TMP-AUDUSER assignment` with mwf_user = user A (the signed-in owner)
 *   2  change its mwf_user from user A to user B (another existing, enabled user; an application or non-interactive user is accepted because the environment has only one
 *      interactive user (owner decision 2026-10-25); rules in lib/user-change-audit.mjs pickUserB; if there is none the script stops before writing)
 *   3  poll the audits table (every 10 s, at most 3 minutes, until the expected rows are there and nothing new appeared for 30 s)
 *   4  assert: an Update audit row whose RetrieveAuditDetails show mwf_user OLD = A and NEW = B; that the row was made by the owner (userid / callinguserid);
 *      that the Create row shows A; which other columns the Update row lists (observation)
 *   5  delete the temporary row, poll again, assert the Delete audit row and its user
 *   6  always (finally): delete any TEST-TMP-AUDUSER row, check-clean (110 matrix rows, 5 active assignments, the contracts and 0 steps of the baseline)
 *
 * WHAT IT TOUCHES: exactly one temporary row in mwf_approverassignment. The 5 real assignment rows are only READ (their count is checked), never changed.
 * WHY NO ROLE VALUE IS USED: the alternate key mwf_ApproverAssignmentKey allows one row per mwf_approverrole (the key ignores the state), the Choice has five values and the five real
 * rows use all five. A sixth non-empty value does not exist (adding one would be a metadata change). So the temporary row is created WITHOUT a role. Whether the server accepts a row
 * with an empty key column is NOT KNOWN: if it refuses (any 4xx), the script stops with nothing created and says so. Safer alternatives are listed by --mode=plan.
 *
 * Modes:
 *   --mode=plan     (default) offline: the scenario above
 *   --mode=check    read only: flows OFF, audit configuration, the audit flag of mwf_user, baseline counts, whether a second user exists. Writes nothing.
 *   --mode=run      the scenario (needs --confirm-mutates-environment; --dry-run prints what it would send)
 *   --mode=cleanup  deletes any TEST-TMP-AUDUSER row and runs check-clean (needs --confirm-mutates-environment)
 * Common: --env=https://<org>.crm4.dynamics.com [--auth=device|az] [--expect-contracts=N]
 * Every write is preceded by 3 consecutive successful reads and is never retried. Test audit rows stay in the audits table (they cannot be deleted directly; see ADR-009).
 */
import { parseArgs, openSession, noGuid, sleep, Stop } from './lib/dv-session.mjs';
import { requireStableConnection } from './lib/counter-snapshot.mjs';
import { enterCleanupPhase, recheckAfterWait } from './lib/resilient-fetch.mjs';
import { allFlowsOff } from './lib/bulk-messages.mjs';
import { AUDIT_TABLES, changesOf, describeRows, operationName, actionName, lagStats, classifyUser, unmetExpectations, pollFinished, noteNewRows, auditDetailsPath } from './lib/auditing.mjs';
import { expectContractsOrExit, describeExpectContracts, contractsVerdict } from './lib/expect-contracts.mjs';
import { PREFIX, assertUserChange, lookupValueOf, otherChangedColumns, pickUserB, describeB, isNonInteractive, expectationsFor, createBody, moveBody } from './lib/user-change-audit.mjs';

const MODE = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=plan').slice(7);
const POLL_MS = 10 * 1000; const MAX_WAIT_MS = 3 * 60 * 1000; const QUIET_MS = 30 * 1000;
const q = encodeURIComponent;
const EXPECT = expectContractsOrExit();   // contracts expected in the starting and the final state (argument, variable or default 11)

if (MODE === 'plan') {
  console.log(describeExpectContracts(EXPECT));
  console.log(`Audit test of mwf_approverassignment.mwf_user (offline plan). Prefix ${PREFIX}; signs in as the owner; every approval flow must be OFF; the audit configuration must be applied.\n`);
  console.log('Rows touched: ONE temporary assignment row (created, changed, deleted). The 5 real assignment rows are only counted.\n');
  console.log('Sequence (each write: 3 reads first, no retry):\n  1 create the row with mwf_user = A (the owner), no role\n  2 PATCH mwf_user to B: an enabled user that is not the owner, not SYSTEM / INTEGRATION and not named with a leading #; preferred: application user, then non-interactive user, then interactive user; always the same choice (full name, then id); none = stop before writing. B is printed as its type and the first 4 characters of its name only, and an OBS line records that B was a non-interactive user\n  wait: poll audits every 10 s, at most 3 minutes, quiet for 30 s\n  assert: Update row shows mwf_user old = A and new = B; made by the owner; Create row shows A\n  3 DELETE the row, wait, assert the Delete row\n  finally: delete any leftover TEST-TMP-AUDUSER row; check-clean.\n');
  console.log('Why the row has no role: the alternate key allows one row per role, there are five role values and the five real rows use them all. A row with an EMPTY key column may be refused by the server (not known): then the script stops with nothing created.');
  console.log('Safer alternatives if it is refused (the owner decides; none is implemented here):\n  (1) the same scenario on a TEST-TMP approval step (its lookups mwf_actualapprover / mwf_originalapprover are audited too): needs a TEST-TMP contract (consumes a number, counters restored), tests the same mechanism but not the column mwf_user;\n  (2) a controlled change of one real assignment row from A to B and back to A, read back, with the owner present: tests the real column, modifies a real row for a few minutes.');
  console.log('\nNot tested here: changes by a non-admin or application user, impersonation, bulk messages, the flows\' own changes, read audit.');
  process.exit(0);
}

const { env: ENV, auth: AUTH, has } = parseArgs();
const DRY = has('--dry-run');
if (!['check', 'run', 'cleanup'].includes(MODE)) { console.error('Missing or invalid --mode=plan|check|run|cleanup. Nothing was run.'); process.exit(2); }
if (['run', 'cleanup'].includes(MODE) && !DRY && !has('--confirm-mutates-environment')) { console.error(`WARNING: --mode=${MODE} creates, changes and deletes ONE ${PREFIX} assignment row. Add --confirm-mutates-environment to run it on purpose, or --dry-run. Nothing was run.`); process.exit(2); }

let S; let OWNER = null; let B = null; let BINFO = null;
const results = [];
const out = (id, status, name, detail = '') => { results.push({ id, status }); console.log(`${status.padEnd(4)}  ${id.padEnd(6)} ${name}${detail ? `  [${detail}]` : ''}`); };
const check = (id, name, ok, detail) => out(id, ok ? 'PASS' : 'FAIL', name, detail);
const get = async (p) => (await S.must('GET', p)).j;
const count = async (path) => (await get(`${path}${path.includes('?') ? '&' : '?'}$count=true&$top=1`))['@odata.count'];
const gate = () => requireStableConnection(S.call, { need: 3, maxAttempts: 6, pauseMs: 1500 });
async function write(method, path, body, extra, note) {
  if (DRY) { console.log(`DRY-RUN  would ${method} ${noGuid(path).slice(0, 90)}${note ? `  ${note}` : ''}`); return { ok: true, status: 0, id: null, j: {}, dry: true }; }
  await gate();
  return S.call(method, path, body, extra);
}
const must = (r, what) => { if (!r.ok) throw new Stop(`${what} failed HTTP ${r.status} ${noGuid(S.msgOf(r))}. Not retried. Read the state, then run --mode=cleanup.`); return r; };

// ---------------------------------------------------------------------------------------------------------------- state
async function flowsOff() {
  const rows = (await get(`workflows?$select=name,statecode&$filter=${q("category eq 5 and contains(name,'Contract Approval')")}`)).value;
  return { ok: allFlowsOff(rows), line: rows.map((r) => `${/v\d\s*$/.exec(r.name)?.[0] || 'flow'} ${r.statecode === 0 ? 'OFF' : 'ON'}`).join(', ') };
}
async function auditConfigApplied() {
  const org = (await get('organizations?$select=isauditenabled,auditretentionperiodv2')).value[0];
  const bad = [];
  if (!org.isauditenabled) bad.push('organization auditing is off');
  for (const t of AUDIT_TABLES) { const e = await get(`EntityDefinitions(LogicalName='${t}')?$select=IsAuditEnabled`); if (!e.IsAuditEnabled.Value) bad.push(`${t} is not audited`); }
  const col = await get("EntityDefinitions(LogicalName='mwf_approverassignment')/Attributes(LogicalName='mwf_user')?$select=IsAuditEnabled");
  if (!col.IsAuditEnabled?.Value) bad.push('the column mwf_user is not audited');
  out('config', bad.length ? 'FAIL' : 'PASS', 'the audit configuration is applied (organization on, the five tables on, mwf_user on)', bad.join('; ') || `retention ${org.auditretentionperiodv2} days`);
  return !bad.length;
}
async function checkClean() {
  const mine = (await get(`mwf_approverassignments?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value.length;
  const total = await count('mwf_contracts'); const steps = await count('mwf_approvalsteps');
  const m = await count('mwf_approvalmatrixes?$filter=statecode eq 0'); const asg = await count('mwf_approverassignments?$filter=statecode eq 0');
  console.log(`check-clean (prefix ${PREFIX}): temporary assignment rows ${mine}, total contracts ${total}, steps ${steps}, active matrix rows ${m}, active assignments ${asg} (expected 0, ${EXPECT.value}, 0, 110, 5)`);
  return { mine, total, steps, m, asg };
}
const cleanOk = (c) => c.mine === 0 && c.total === EXPECT.value && c.steps === 0 && c.m === 110 && c.asg === 5;
async function secondUser() {
  const users = (await get(`systemusers?$select=systemuserid,fullname,isdisabled,accessmode,applicationid&$filter=${q('isdisabled eq false')}&$top=500`)).value;
  return pickUserB(users, OWNER);
}

// ---------------------------------------------------------------------------------------------------------------- audit reading
const AUDIT_SEL = 'auditid,createdon,operation,action,objecttypecode,_userid_value,_callinguserid_value,_objectid_value';
const seen = new Map(); const allRows = new Map();
async function auditsOf(id) { return (await get(`audits?$select=${AUDIT_SEL}&$filter=${q(`_objectid_value eq ${id}`)}&$orderby=createdon asc&$top=100`)).value; }
async function pollAudits(id, expected, label) {
  const startedMs = Date.now(); let lastNew = startedMs;
  for (;;) {
    const rows = await auditsOf(id);
    for (const r of rows) allRows.set(r.auditid, r);
    const fresh = noteNewRows(seen, rows, Date.now());
    if (fresh.length) { lastNew = Date.now(); console.log(`  poll ${label}: +${fresh.length} row(s) after ${Math.round((Date.now() - startedMs) / 1000)} s (${rows.length} in total)`); }
    const last = pollFinished({ unmet: unmetExpectations(rows, expected), lastNewRowMs: lastNew, nowMs: Date.now(), quietMs: QUIET_MS, startedMs, timeoutMs: MAX_WAIT_MS });
    if (last.done) { console.log(`  poll ${label}: finished (${last.why}) after ${Math.round((Date.now() - startedMs) / 1000)} s`); return { rows, why: last.why, unmet: unmetExpectations(rows, expected) }; }
    await sleep(POLL_MS); await recheckAfterWait(S.call, 'This is a read step; nothing is written by it.');
  }
}
const detailOf = async (auditId) => (await get(auditDetailsPath(auditId))).AuditDetail;
const who = (r) => classifyUser(r._userid_value, OWNER, []);

// ---------------------------------------------------------------------------------------------------------------- check (read only)
async function modeCheck() {
  OWNER = (await get('WhoAmI')).UserId;
  const f = await flowsOff(); check('flows', `every approval flow is OFF (${f.line})`, f.ok);
  await auditConfigApplied();
  await checkClean();
  BINFO = await secondUser(); B = BINFO && BINFO.id;
  out('users', B ? 'PASS' : 'FAIL', 'a suitable user B exists to move the lookup to (id not printed)', B ? describeB(BINFO) : 'none found: the run would stop before writing');
  if (B) out('userB', 'OBS', 'user B is a non-interactive user, not a person who can sign in: the test shows the audit of the lookup, not a person-to-person change', String(isNonInteractive(BINFO)));
  const users = (await get(`systemusers?$select=systemuserid&$filter=${q('isdisabled eq false')}&$count=true&$top=1`))['@odata.count'];
  console.log(`INFO  enabled users in the environment (all kinds): ${users}; nothing was written`);
}

// ---------------------------------------------------------------------------------------------------------------- the run
async function run() {
  const f = await flowsOff(); check('flows', `every approval flow is OFF (${f.line})`, f.ok); if (!f.ok) throw new Stop('A flow is ON. Nothing was created.');
  if (!(await auditConfigApplied()) && !DRY) throw new Stop('Apply the audit configuration first (scripts/configure-auditing.mjs). Nothing was created.');
  const pre = await checkClean();
  if (!cleanOk(pre)) throw new Stop(`The starting state is not clean (see the line above; ${contractsVerdict(EXPECT, pre.total).text}). Nothing was created.`);
  OWNER = (await get('WhoAmI')).UserId;
  BINFO = await secondUser(); B = BINFO && BINFO.id;
  if (!B) throw new Stop('No suitable user B was found to move the lookup to (enabled, not the owner, not SYSTEM / INTEGRATION, not named with a leading #). Nothing was created.');
  console.log(`INFO  user A = the signed-in owner; user B = ${describeB(BINFO)} (ids are not printed)`);
  out('userB', 'OBS', 'user B is a non-interactive user, not a person who can sign in: the test shows the audit of the lookup, not a person-to-person change', `${isNonInteractive(BINFO)}; ${describeB(BINFO)}`);
  let rowId = null; const ts = {};
  try {
    const c = await write('POST', 'mwf_approverassignments', createBody(OWNER));
    if (!c.ok) throw new Stop(`The temporary row could not be created: HTTP ${c.status} ${noGuid(String(c.j?.error?.message ?? c.text ?? ''))} [full error body, not shortened; the id is masked]. Nothing was created. If the alternate key or a required rule refuses a row without a role, the safer alternatives are listed by --mode=plan.`);
    rowId = c.id; ts.create = Date.now();
    if (DRY) { console.log('\nDRY-RUN: the update, the waits, the assertions and the delete are not shown further; nothing was sent.'); return; }
    out('create', 'PASS', 'the temporary assignment row (no role) was created', 'the server accepted an empty key column');
    must(await write('PATCH', `mwf_approverassignments(${rowId})`, moveBody(B), { 'If-Match': '*' }), 'lookup change A to B'); ts.update = Date.now();

    console.log(`\nWaiting for the audit rows (poll every ${POLL_MS / 1000} s, at most ${MAX_WAIT_MS / 60000} minutes, quiet for ${QUIET_MS / 1000} s)...`);
    const p1 = await pollAudits(rowId, expectationsFor(rowId, 1), 'phase 1');
    check('rows', 'a Create row and an Update row appeared', p1.unmet.length === 0, `${p1.why}; ${p1.unmet.join('; ') || 'none missing'}`);

    // the Update row that shows mwf_user A to B
    const updates = p1.rows.filter((r) => r.operation === 2); let hit = null; const reasons = [];
    for (const r of updates) { const d = await detailOf(r.auditid); const a = assertUserChange(d, 'mwf_user', OWNER, B); if (a.ok) { hit = { r, d }; break; } reasons.push(`${a.reason} (keys old: ${a.keys.old.join(',') || '-'}; new: ${a.keys.new.join(',') || '-'})`); }
    check('U1', 'an Update audit row shows mwf_user OLD = user A and NEW = user B (RetrieveAuditDetails)', !!hit, hit ? `${operationName(hit.r.operation)} row, ${actionName(hit.r.action)}` : `${updates.length} Update row(s) read; ${reasons.join(' | ') || 'none'}`);
    if (hit) {
      check('U2', 'that Update row was made by the signed-in owner (userid)', who(hit.r) === 'admin', `userid class ${who(hit.r)}; callinguserid ${hit.r._callinguserid_value ? classifyUser(hit.r._callinguserid_value, OWNER, []) : 'not set'}`);
      const others = otherChangedColumns(hit.d, 'mwf_user'); out('U3', 'OBS', 'other columns listed by the same Update row', others.join(', ') || 'none');
    }
    const cr = p1.rows.find((r) => r.operation === 1);
    if (cr) { const v = lookupValueOf(await detailOf(cr.auditid), 'mwf_user'); out('U4', v.found && v.new && String(v.new).toLowerCase() === String(OWNER).toLowerCase() ? 'PASS' : 'FAIL', 'the Create row shows mwf_user = user A', `found ${v.found}; keys ${v.keys.new.join(',') || '-'}`); }
    else out('U4', 'FAIL', 'the Create row shows mwf_user = user A', 'no Create row');
    const history = changesOf((hit && hit.d) || {}); out('U5', 'OBS', 'the audit detail of the change as the library reads it (column names only)', Object.keys(history).join(', ') || 'empty');

    // delete, then the Delete row
    must(await write('DELETE', `mwf_approverassignments(${rowId})`), 'temporary row delete'); ts.delete = Date.now(); const deleted = rowId; rowId = null;
    const p2 = await pollAudits(deleted, expectationsFor(deleted, 2), 'phase 2');
    check('rows', 'the Delete audit row appeared', p2.unmet.length === 0, `${p2.why}; ${p2.unmet.join('; ') || 'none missing'}`);
    const dr = p2.rows.find((r) => r.operation === 3); check('U6', 'the Delete row was made by the signed-in owner', !!dr && who(dr) === 'admin', dr ? who(dr) : 'no Delete row');
    const ls = lagStats([...seen.entries()].map(([id, ms]) => Math.max(0, Math.round((ms - Date.parse(allRows.get(id).createdon)) / 1000))));
    out('lag', 'OBS', 'the real delay between an operation and the moment the poll first saw its row', ls ? `${ls.count} rows: min ${ls.min} s, median ${ls.median} s, max ${ls.max} s (polling every ${POLL_MS / 1000} s)` : 'no rows');
    console.log('\nRows seen, in order:'); for (const r of describeRows([...allRows.values()])) console.log(`  ${r.at.slice(11, 19)}Z ${r.operation.padEnd(6)} ${r.action.padEnd(8)} by ${who({ _userid_value: r.userid })}${r.callinguserid ? ' (calling user set)' : ''}`);
  } finally {
    enterCleanupPhase();
    await cleanupRows();
    const c = await checkClean();
    check('D', `check-clean: no ${PREFIX} row, ${EXPECT.value} contracts, 0 steps, 110 matrix rows, 5 active assignments`, cleanOk(c), '');
  }
}
async function cleanupRows() {
  const rows = (await get(`mwf_approverassignments?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).value;
  for (const x of rows) { const d = await S.call('DELETE', `mwf_approverassignments(${x.mwf_approverassignmentid})`); console.log(`INFO  cleanup: temporary assignment row delete HTTP ${d.status}`); }
  if (!rows.length) console.log('INFO  cleanup: no temporary assignment row left');
}
async function cleanupOnly() { enterCleanupPhase(); await cleanupRows(); await checkClean(); }

(async () => {
  try {
    S = await openSession({ env: ENV, auth: AUTH });
    await requireStableConnection(S.call);
    console.log(describeExpectContracts(EXPECT));
    if (MODE === 'check') await modeCheck(); else if (MODE === 'cleanup') await cleanupOnly(); else await run();
    const bad = results.filter((r) => r.status === 'FAIL').length;
    console.log(`\nSUMMARY: ${results.filter((r) => r.status === 'PASS').length} PASS, ${bad} FAIL, ${results.filter((r) => r.status === 'OBS').length} OBS.`);
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    if (MODE === 'run') console.error(`Read the state; clean up with: node scripts/test-auditing-user-change.mjs --mode=cleanup --env=<url> --confirm-mutates-environment`);
    process.exit(4);
  }
})();
