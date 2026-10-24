#!/usr/bin/env node
/**
 * Creates and verifies the four project security roles (ADR-008): Muwafaqa Requester / Approver / Finance / Admin. The design is in
 * scripts/lib/security-roles.mjs (pure, unit tested). This script assigns NO role to any user, touches NO flow and NO plug-in.
 *
 *   --mode=check    read only: every approval flow OFF (v2, and v1 while it exists), the ownership of the six tables, every privilege of the design found BY NAME in the `privileges`
 *                   table (never typed in) and allowed at the planned depth, the design rules, the existing roles, the root business unit, the solution
 *   --mode=create   check first, then for each role that does not exist: POST roles (into the solution) and AddPrivilegesRole. An existing role is left
 *                   alone if it already equals the design; a role that differs STOPS the run (nothing is replaced). Needs --confirm-mutates-environment
 *                   (or --dry-run: reads and prints the requests, sends nothing)
 *   --mode=verify   read only: for each role, the privileges and depths really stored (roleprivileges), compared with the design, the solution membership,
 *                   the member count (must be 0), and the NEGATIVE check: no bypass privilege and no privilege on the counter table in any role
 *   --mode=remove-baseline --role=<Requester|Approver|Finance|Admin>   controlled experiment (ADR-008): one RemovePrivilegeRole call per baseline privilege that is there (up to 9), idempotent, --dry-run reads and prints.
 *                   A 4xx stops at once, no other form is tried, nothing is retried. Needs --confirm-mutates-environment.
 *   --mode=restore-baseline --role=...   one AddPrivilegesRole call that puts the missing baseline privileges back at Global (idempotent)
 *   --mode=add-missing --role=Admin   one AddPrivilegesRole call for the designed audit-read privileges the role lacks (never removes anything; refuses if the role differs in anything else)
 *   verify takes --expect-baseline=none|all|any (default none: any of the nine that appears again fails): how many of the nine must be there
 *   --mode=cleanup  deletes ONLY the four roles named in the design, and only if no user and no team is a member of it. Needs --confirm-mutates-environment
 *
 * Before every write: 3 consecutive successful reads. A write is never retried. If the result of a write is unknown the script stops and says so.
 * The token stays in memory and is never printed. No id, host or address is printed.
 *
 * Usage: node scripts/create-security-roles.mjs --env=https://<org>.crm4.dynamics.com --auth=az --mode=check|create|verify|cleanup [--dry-run] [--confirm-mutates-environment]
 */
import { parseArgs, openSession, noGuid, Stop } from './lib/dv-session.mjs';
import { requireStableConnection } from './lib/counter-snapshot.mjs';
import { allFlowsOff } from './lib/bulk-messages.mjs';
import { resolveDesired, describeExtras, missingDesigned, addPrivilegesBody, AUDIT_READ, membersVerdict, baselineState, checkBaselineExpectation, removePrivilegeBody, restoreBaselineBody, roleFromArg, TABLES, ROLES, ROLE_NAMES, DEPTH_VALUE, DEPTH_LABEL, FORBIDDEN_BYPASS, ACTIONS, validateDesign, resolvePrivilege, depthAllowed, depthOfMask, compareRolePrivileges, negativeFindings, desiredPrivileges, describeRole, parsePrivilegeName, PLATFORM_BASELINE } from './lib/security-roles.mjs';

const { argOf, env: ENV, auth: AUTH, has } = parseArgs();
const MODE = argOf('mode');
const DRY = has('--dry-run');
const SOLUTION = 'Muwafaqa';
const q = encodeURIComponent;
if (!['check', 'create', 'verify', 'cleanup', 'remove-baseline', 'restore-baseline', 'add-missing'].includes(MODE)) { console.error('Missing or invalid --mode=check|create|verify|cleanup|remove-baseline|restore-baseline|add-missing. Nothing was run.'); process.exit(2); }
const EXPECT = argOf('expect-baseline') || 'none';
try { checkBaselineExpectation(EXPECT, 0); } catch (e) { console.error(`${e.message}. Nothing was run.`); process.exit(2); }
if (['create', 'cleanup', 'remove-baseline', 'restore-baseline', 'add-missing'].includes(MODE) && !DRY && !has('--confirm-mutates-environment')) {
  console.error(`WARNING: --mode=${MODE} writes security roles to the environment. Add --confirm-mutates-environment to run it on purpose, or --dry-run to see what it would send. Nothing was run.`);
  process.exit(2);
}

let S;
const results = [];
const out = (id, status, name, detail = '') => { results.push({ id, status }); console.log(`${status.padEnd(4)}  ${id.padEnd(7)} ${name}${detail ? `  [${detail}]` : ''}`); };
const check = (id, name, ok, detail) => out(id, ok ? 'PASS' : 'FAIL', name, detail);
const get = async (p) => (await S.must('GET', p)).j;
const gate = () => requireStableConnection(S.call, { need: 3, maxAttempts: 6, pauseMs: 1500 });
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Every write goes through here: 3 consecutive reads first, no retry, and in dry-run only a printed line. */
async function write(method, path, body, extra, note) {
  if (DRY) { console.log(`DRY-RUN  would ${method} ${noGuid(path).replace(/\(<[^)]*>\)/g, '(<id>)').slice(0, 90)}${note ? `  ${note}` : ''}`); return { ok: true, status: 0, id: null, dry: true }; }
  await gate();
  return S.call(method, path, body, extra);
}

// ---------------------------------------------------------------------------------------------------------------- reads
async function flowsOff() {
  const rows = (await get(`workflows?$select=name,statecode&$filter=${q("category eq 5 and contains(name,'Contract Approval')")}`)).value;
  const line = rows.map((r) => `${/v\d\s*$/.exec(r.name)?.[0] || 'flow'} ${r.statecode === 0 ? 'OFF' : 'ON'}`).join(', ');
  return { ok: allFlowsOff(rows), line };
}
async function tableMeta() {
  const meta = {};
  for (const [key, t] of Object.entries(TABLES)) {
    const e = await get(`EntityDefinitions(LogicalName='${t.logical}')?$select=LogicalName,SchemaName,OwnershipType`);
    meta[key] = { ownership: e.OwnershipType, schema: e.SchemaName };
  }
  return meta;
}
async function privilegeRows() {
  const rows = [];
  for (const t of Object.values(TABLES)) rows.push(...(await get(`privileges?$select=name,canbebasic,canbelocal,canbedeep,canbeglobal&$filter=${q(`contains(name,'${t.logical}')`)}`)).value);
  for (const e of AUDIT_READ) rows.push(...(await get(`privileges?$select=name,canbebasic,canbelocal,canbedeep,canbeglobal&$filter=${q(`name eq '${e.name}'`)}`)).value);
  return rows;
}
async function rolesByName() {
  const found = {};
  for (const n of ROLE_NAMES) found[n] = (await get(`roles?$select=name,isinherited,_businessunitid_value&$filter=${q(`name eq '${n}'`)}`)).value;
  return found;
}
async function membersOf(roleId) {
  const r = await get(`roles(${roleId})?$select=name&$expand=systemuserroles_association($select=systemuserid,applicationid),teamroles_association($select=teamid)`);
  return { users: (r.systemuserroles_association || []).length, teams: (r.teamroles_association || []).length, userRows: r.systemuserroles_association || [] };
}
/** [{ name, depth, mask }] really stored for a role. The depth is null (never guessed) for a mask that is not 1, 2, 4 or 8. */
async function storedPrivileges(roleId) {
  const rp = (await get(`roleprivilegescollection?$select=privilegeid,privilegedepthmask&$filter=roleid eq ${roleId}`)).value;
  const names = new Map();
  for (const c of chunks(rp.map((x) => x.privilegeid), 15)) {
    for (const p of (await get(`privileges?$select=name&$filter=${q(c.map((id) => `privilegeid eq ${id}`).join(' or '))}`)).value) names.set(p.privilegeid, p.name);
  }
  return rp.map((x) => ({ name: names.get(x.privilegeid) || '?', depth: depthOfMask(x.privilegedepthmask), mask: x.privilegedepthmask }));
}

// ---------------------------------------------------------------------------------------------------------------- check
async function modeCheck() {
  const f = await flowsOff();
  check('flows', `every approval flow is OFF (${f.line})`, f.ok);
  if (!f.ok) throw new Stop('An approval flow is ON or not readable. Nothing was changed.');
  const v = validateDesign();
  check('design', 'the design rules R1 to R8 hold (no Assign / Share, no counter privilege, organization-owned tables only Global, User level only for the Requester on the contract, audit read only for the Admin)', v.length === 0, v.join('; ') || `${ROLES.length} roles`);
  const meta = await tableMeta();
  for (const [key, t] of Object.entries(TABLES)) check('table', `${t.logical}: ${meta[key].ownership}`, meta[key].ownership === t.ownership, `expected ${t.ownership}`);
  const rows = await privilegeRows();
  console.log(`INFO  privilege rows found for the six tables: ${rows.length}`);
  let bad = 0;
  for (const role of ROLES) {
    for (const d of desiredPrivileges(role)) {
      const logical = d.extraName || TABLES[d.table].logical;
      const r = resolveDesired(rows, d);
      if (!r.ok) { bad++; out('priv', 'FAIL', `${role.name}: ${d.action} on ${logical} not resolved`, r.error); continue; }
      if (!depthAllowed(r.row, d.depth)) { bad++; out('priv', 'FAIL', `${role.name}: ${d.action} on ${logical} is not allowed at ${d.depth}`, `flags B ${r.row.canbebasic} L ${r.row.canbelocal} D ${r.row.canbedeep} G ${r.row.canbeglobal}`); }
    }
  }
  check('priv', `every privilege of the design is found by name and allowed at its depth (${ROLES.reduce((n, r) => n + desiredPrivileges(r).length, 0)} grants in 4 roles)`, bad === 0, `${bad} problem(s)`);
  for (const n of FORBIDDEN_BYPASS) {
    const r = (await get(`privileges?$select=name&$filter=name eq '${n}'`)).value;
    out('bypass', r.length === 1 ? 'PASS' : 'FAIL', `${n} exists (it is never granted to a project role)`, `${r.length} row(s)`);
  }
  const bu = (await get('businessunits?$select=name&$filter=parentbusinessunitid eq null')).value;
  check('bu', 'exactly one root business unit (the roles are created in it)', bu.length === 1, `${bu.length}`);
  const sol = (await get(`solutions?$select=uniquename&$filter=uniquename eq '${SOLUTION}'`)).value;
  check('solution', `the solution ${SOLUTION} exists`, sol.length === 1, `${sol.length}`);
  const existing = await rolesByName();
  for (const n of ROLE_NAMES) out('exists', 'OBS', `${n}: ${existing[n].length === 0 ? 'does not exist yet' : `${existing[n].length} row(s) exist`}`);
  return !results.some((x) => x.status === 'FAIL');
}

// ---------------------------------------------------------------------------------------------------------------- create
async function modeCreate() {
  if (!(await modeCheck())) throw new Stop('The checks failed (see above). Nothing was written.');
  const rows = await privilegeRows();
  const bu = (await get('businessunits?$select=name&$filter=parentbusinessunitid eq null')).value[0].businessunitid;
  const existing = await rolesByName();
  for (const role of ROLES) {
    const privs = desiredPrivileges(role).map((d) => ({ ...d, row: resolveDesired(rows, d).row }));
    if (existing[role.name].length > 1) throw new Stop(`${existing[role.name].length} roles named "${role.name}" exist. Nothing was written for it.`);
    if (existing[role.name].length === 1) {
      const id = existing[role.name][0].roleid;
      const stored = await storedPrivileges(id);
      const diff = compareRolePrivileges(desiredPrivileges(role), stored, PLATFORM_BASELINE);
      if (diff.same) { out('create', 'OBS', `${role.name}: already exists with exactly the designed privileges, left alone`); continue; }
      throw new Stop(`${role.name} exists but differs from the design (${diff.missing.length} missing, ${diff.extra.length} extra, ${diff.wrongDepth.length} wrong depth). Nothing was replaced; use --mode=cleanup (no members) and create again.`);
    }
    console.log(`\n${role.name}: ${privs.length} privileges`);
    for (const line of describeRole(role)) console.log(`   ${line}`);
    const r = await write('POST', 'roles', { name: role.name, description: role.description, isinherited: 1, 'businessunitid@odata.bind': `/businessunits(${bu})` }, { 'MSCRM.SolutionUniqueName': SOLUTION }, '[into the solution; Direct User (Basic) access level and Team privileges]');
    if (!r.ok) throw new Stop(`POST roles failed HTTP ${r.status} ${S.msgOf(r)}. Not retried. Read the state with --mode=verify.`);
    if (DRY) { await write('POST', 'roles(<id>)/Microsoft.Dynamics.CRM.AddPrivilegesRole', {}, {}, `with ${privs.length} privileges: ${privs.map((p) => `${p.row.name}=${p.depth}`).join(', ')}`); continue; }
    if (!r.id) throw new Stop('The role was created but its id was not returned. Not retried. Read the state with --mode=verify, then --mode=cleanup if needed.');
    const a = await write('POST', `roles(${r.id})/Microsoft.Dynamics.CRM.AddPrivilegesRole`, { Privileges: privs.map((p) => ({ PrivilegeId: p.row.privilegeid, Depth: String(DEPTH_VALUE[p.depth]) })) });
    if (!a.ok) throw new Stop(`AddPrivilegesRole failed HTTP ${a.status} ${S.msgOf(a)}. Not retried. The role exists without (all of) its privileges: read with --mode=verify, then --mode=cleanup.`);
    out('create', 'PASS', `${role.name}: role created and ${privs.length} privileges added`, `HTTP ${a.status}`);
  }
  if (DRY) { console.log('\nDRY-RUN: nothing was sent.'); return true; }
  console.log('\nNEXT: --mode=verify (reads what the platform really stored).');
  return true;
}

// ---------------------------------------------------------------------------------------------------------------- verify
async function modeVerify() {
  const f = await flowsOff();
  check('flows', `every approval flow is OFF (${f.line})`, f.ok);
  const sol = (await get(`solutions?$select=uniquename&$filter=uniquename eq '${SOLUTION}'`)).value;
  const comp = sol.length === 1 ? new Set((await get(`solutioncomponents?$select=objectid&$filter=${q(`_solutionid_value eq ${sol[0].solutionid} and componenttype eq 20`)}`)).value.map((x) => String(x.objectid).toLowerCase())) : new Set();
  const existing = await rolesByName();
  const actualByRole = {};
  for (const role of ROLES) {
    const rows = existing[role.name];
    if (rows.length !== 1) { check('role', `${role.name}: exactly one role with this name`, false, `${rows.length}`); continue; }
    const id = rows[0].roleid;
    const stored = await storedPrivileges(id);
    actualByRole[role.name] = stored;
    const unknown = stored.filter((x) => x.depth === null);
    const diff = compareRolePrivileges(desiredPrivileges(role), stored, PLATFORM_BASELINE);
    check('role', `${role.name}: privileges and depths equal the design, plus only the platform baseline at Global (${stored.length} stored: ${desiredPrivileges(role).length} designed + ${diff.tolerated} tolerated)`, diff.same && unknown.length === 0, `missing ${diff.missing.length}, extra ${diff.extra.length}${diff.extra.length ? ` (${diff.extra.join(', ')})` : ''}, wrong depth ${diff.wrongDepth.length}, unknown mask ${unknown.length}${unknown.length ? ` (${[...new Set(unknown.map((x) => x.mask))].join(',')})` : ''}, tolerated baseline ${diff.tolerated} of ${PLATFORM_BASELINE.length}`);
    const be = checkBaselineExpectation(EXPECT, baselineState(stored).present.length);
    check('role', `${role.name}: the platform baseline matches --expect-baseline=${EXPECT} (${be.expected})`, be.ok, `${baselineState(stored).present.length} of ${PLATFORM_BASELINE.length} present at Global, ${baselineState(stored).wrongDepth.length} at another depth`);
    check('role', `${role.name}: in the solution ${SOLUTION}`, comp.has(String(id).toLowerCase()));
    check('role', `${role.name}: Direct User (Basic) access level and Team privileges (isinherited 1)`, rows[0].isinherited === 1, `isinherited ${rows[0].isinherited}`);
    const m = await membersOf(id);
    const mv = membersVerdict(role.name, m.userRows, m.teams, process.env.MWF_TEST_CLIENT_ID);   // the value is only compared, never printed
    check('role', `${role.name}: no member, except the application user of the behavioral test in the Requester role (no other user, no team)`, mv.ok, `${m.users} user(s) (application user ${mv.appUsers}, others ${mv.others}), ${m.teams} team(s)`);
    // the table the owner asked for: per table, the privilege and the depth really stored
    const byTable = {};
    for (const x of stored) { const p = parsePrivilegeName(x.name); if (p) (byTable[p.logical] ||= {})[p.action] = x.depth; }
    for (const [key, t] of Object.entries(TABLES)) {
      const acts = byTable[t.logical];
      console.log(`         ${t.title.padEnd(24)} ${acts ? ACTIONS.filter((a) => acts[a]).map((a) => `${a}:${DEPTH_LABEL[acts[a]] ?? '?'}`).join(', ') : 'none'}`);
    }
    const designedExtra = (role.extra || []).map((e) => e.name.toLowerCase());
    if (designedExtra.length) console.log(`         Audit read (designed): ${stored.filter((x) => designedExtra.includes(String(x.name).toLowerCase())).map((x) => `${x.name}:${DEPTH_LABEL[x.depth] ?? '?'}`).join(', ') || 'none stored yet'}`);
    const other = stored.filter((x) => !parsePrivilegeName(x.name) && !designedExtra.includes(String(x.name).toLowerCase()));
    if (other.length) console.log(`         platform baseline (tolerated by name, Global only): ${other.map((x) => `${x.name}:${DEPTH_LABEL[x.depth] ?? '?'}`).join(', ')}`);
  }
  const hits = negativeFindings(actualByRole);
  check('NEG', 'no role holds a bypass privilege (prvBypassCustomBusinessLogic, prvBypassCustomPlugins, any prvBypass*), any privilege on the counter table, or any Assign / Share', hits.length === 0, hits.join('; ') || 'none found');
  const bad = results.filter((x) => x.status === 'FAIL').length;
  console.log(`\nVERIFY: ${results.filter((x) => x.status === 'PASS').length} PASS, ${bad} FAIL, ${results.filter((x) => x.status === 'OBS').length} OBS.`);
  return bad === 0;
}

// ---------------------------------------------------------------------------------------------------------------- the nine baseline privileges: remove / restore (controlled experiment, ADR-008)
async function oneRole() {
  let name; try { name = roleFromArg(argOf('role')); } catch (e) { throw new Stop(`${e.message}. One role per run: --role=Requester|Approver|Finance|Admin. Nothing was changed.`); }
  const rows = (await get(`roles?$select=name&$filter=${q(`name eq '${name}'`)}`)).value;
  if (rows.length !== 1) throw new Stop(`Expected one role named "${name}", found ${rows.length}. Nothing was changed.`);
  return { name, id: rows[0].roleid, role: ROLES.find((r) => r.name === name) };
}
async function baselineRows() {
  const rows = [];
  for (const n of PLATFORM_BASELINE) {
    const r = (await get(`privileges?$select=name&$filter=${q(`name eq '${n}'`)}`)).value;
    if (r.length !== 1) throw new Stop(`Expected one privilege named ${n}, found ${r.length}. Nothing was changed.`);
    rows.push({ name: n, privilegeid: r[0].privilegeid });
  }
  return rows;
}
async function preconditions(r) {
  const f = await flowsOff(); check('flows', `every approval flow is OFF (${f.line})`, f.ok);
  if (!f.ok) throw new Stop('An approval flow is ON or not readable. Nothing was changed.');
  const m = await membersOf(r.id); const mv = membersVerdict(r.name, m.userRows, m.teams, process.env.MWF_TEST_CLIENT_ID);
  check('role', `${r.name}: no member except, for the Requester, the application user`, mv.ok, `${m.users} user(s), ${m.teams} team(s)`);
  if (!mv.ok) throw new Stop('The role has a member that is not allowed. Nothing was changed.');
  const stored = await storedPrivileges(r.id);
  const diff = compareRolePrivileges(desiredPrivileges(r.role), stored, PLATFORM_BASELINE);
  check('role', `${r.name}: the designed privileges are intact before the change`, diff.same, `missing ${diff.missing.length}, extra ${diff.extra.length}, wrong depth ${diff.wrongDepth.length}`);
  if (!diff.same) throw new Stop('The role differs from the design before the change. Nothing was changed.');
  return stored;
}
/** One RemovePrivilegeRole call per privilege that is there. Idempotent (a privilege that is already gone is skipped). A 4xx or any other failure stops at once; nothing is retried and no other form is tried. */
async function modeRemoveBaseline() {
  const r = await oneRole(); const stored = await preconditions(r);
  const st = baselineState(stored);
  if (st.wrongDepth.length) throw new Stop(`${st.wrongDepth.length} baseline privilege(s) are at a depth other than Global (${st.wrongDepth.join(', ')}). Unknown state; nothing was changed.`);
  const rows = await baselineRows();
  const todo = rows.filter((x) => st.present.includes(x.name));
  console.log(`INFO  ${r.name}: ${st.present.length} of ${PLATFORM_BASELINE.length} baseline privileges are there; ${todo.length} RemovePrivilegeRole call(s) (one per privilege)`);
  let done = 0;
  for (const x of todo) {
    const w = await write('POST', `roles(${r.id})/Microsoft.Dynamics.CRM.RemovePrivilegeRole`, removePrivilegeBody(x.privilegeid), undefined, `[remove ${x.name}]`);
    if (DRY) continue;
    if (!w.ok) throw new Stop(`RemovePrivilegeRole for ${x.name} answered HTTP ${w.status} ${S.msgOf(w)}. ${done} of ${todo.length} were removed before it. No other form is tried and nothing is retried; read the state with --mode=verify, restore with --mode=restore-baseline if needed.`);
    done++; console.log(`INFO  removed ${x.name} (HTTP ${w.status})`);
  }
  if (DRY) { console.log('\nDRY-RUN: nothing was sent.'); return true; }
  const after = await storedPrivileges(r.id);
  const diff = compareRolePrivileges(desiredPrivileges(r.role), after, PLATFORM_BASELINE);
  check('role', `${r.name}: after the removal the designed privileges are intact and ${baselineState(after).present.length} baseline privilege(s) remain`, diff.same && baselineState(after).present.length === 0, `stored ${after.length}, missing ${diff.missing.length}, extra ${diff.extra.length}, wrong depth ${diff.wrongDepth.length}`);
  console.log('\nNEXT: --mode=verify --expect-baseline=none, then read again after a few minutes, then run the behavioral test for this role (--roles=...).');
  return !results.some((x) => x.status === 'FAIL');
}
/** One AddPrivilegesRole call for the baseline privileges that are missing. Idempotent. */
async function modeRestoreBaseline() {
  const r = await oneRole(); const stored = await preconditions(r);
  const st = baselineState(stored);
  if (st.wrongDepth.length) throw new Stop(`${st.wrongDepth.length} baseline privilege(s) are at a depth other than Global. Unknown state; nothing was changed.`);
  const rows = await baselineRows();
  const todo = rows.filter((x) => st.missing.includes(x.name));
  console.log(`INFO  ${r.name}: ${st.missing.length} baseline privilege(s) are missing; ${todo.length ? '1 AddPrivilegesRole call' : 'nothing to restore'}`);
  if (!todo.length) return true;
  const w = await write('POST', `roles(${r.id})/Microsoft.Dynamics.CRM.AddPrivilegesRole`, restoreBaselineBody(todo), undefined, `[restore ${todo.length} privileges at Global]`);
  if (DRY) { console.log('\nDRY-RUN: nothing was sent.'); return true; }
  if (!w.ok) throw new Stop(`AddPrivilegesRole answered HTTP ${w.status} ${S.msgOf(w)}. Not retried; read the state with --mode=verify.`);
  const after = await storedPrivileges(r.id);
  check('role', `${r.name}: after the restore all ${PLATFORM_BASELINE.length} baseline privileges are back at Global`, baselineState(after).present.length === PLATFORM_BASELINE.length, `${baselineState(after).present.length} present`);
  return !results.some((x) => x.status === 'FAIL');
}

// ---------------------------------------------------------------------------------------------------------------- add-missing (audit read privileges of the Admin role, ADR-009)
/** One AddPrivilegesRole call for the designed EXTRA privileges (audit read) that a role lacks. Never removes anything; refuses if the role differs from its design in anything else. */
async function modeAddMissing() {
  const r = await oneRole();
  const f = await flowsOff(); check('flows', `every approval flow is OFF (${f.line})`, f.ok);
  if (!f.ok) throw new Stop('An approval flow is ON or not readable. Nothing was changed.');
  const stored = await storedPrivileges(r.id);
  const diff = compareRolePrivileges(desiredPrivileges(r.role).filter((d) => !d.extraName), stored.filter((s) => !(r.role.extra || []).some((e) => e.name.toLowerCase() === String(s.name).toLowerCase())), PLATFORM_BASELINE);
  if (!diff.same) throw new Stop(`${r.name} differs from its design in more than the audit read privileges (missing ${diff.missing.length}, extra ${diff.extra.length}, wrong depth ${diff.wrongDepth.length}). Nothing was changed.`);
  const m = missingDesigned(r.role, stored);
  if (m.wrongDepth.length) throw new Stop(`${m.wrongDepth.length} designed privilege(s) are stored at another depth. Nothing was changed.`);
  const rows = await privilegeRows();
  const todo = m.missing.map((d) => { const x = resolveDesired(rows, d); if (!x.ok) throw new Stop(x.error); return { name: x.row.name, privilegeid: x.row.privilegeid, depth: d.depth }; });
  console.log(`INFO  ${r.name}: ${todo.length} designed privilege(s) missing${todo.length ? ': ' + todo.map((x) => x.name + '=' + x.depth).join(', ') : ''}`);
  if (!todo.length) return true;
  const w = await write('POST', `roles(${r.id})/Microsoft.Dynamics.CRM.AddPrivilegesRole`, addPrivilegesBody(todo), undefined, `[add ${todo.length} privilege(s)]`);
  if (DRY) { console.log('\nDRY-RUN: nothing was sent.'); return true; }
  if (!w.ok) throw new Stop(`AddPrivilegesRole answered HTTP ${w.status} ${S.msgOf(w)}. Not retried; read the state with --mode=verify.`);
  const after = await storedPrivileges(r.id);
  check('role', `${r.name}: after the call the designed privileges are all there`, missingDesigned(r.role, after).missing.length === 0, `${after.length} stored`);
  return !results.some((x) => x.status === 'FAIL');
}

// ---------------------------------------------------------------------------------------------------------------- cleanup
async function modeCleanup() {
  const existing = await rolesByName();
  for (const n of ROLE_NAMES) {
    const rows = existing[n];
    if (rows.length === 0) { out('cleanup', 'OBS', `${n}: does not exist`); continue; }
    if (rows.length > 1) throw new Stop(`${rows.length} roles named "${n}". Nothing was deleted for it.`);
    const m = await membersOf(rows[0].roleid);
    if (m.users || m.teams) throw new Stop(`${n} has ${m.users} user member(s) and ${m.teams} team member(s). It is not deleted.`);
    const d = await write('DELETE', `roles(${rows[0].roleid})`);
    if (!d.ok) throw new Stop(`DELETE of ${n} failed HTTP ${d.status} ${S.msgOf(d)}. Not retried. Read the state with --mode=verify.`);
    out('cleanup', 'PASS', `${n}: deleted`, `HTTP ${d.status}`);
  }
  return true;
}

(async () => {
  try {
    S = await openSession({ env: ENV, auth: AUTH });
    await requireStableConnection(S.call);
    const ok = MODE === 'check' ? await modeCheck() : MODE === 'create' ? await modeCreate() : MODE === 'verify' ? await modeVerify() : MODE === 'remove-baseline' ? await modeRemoveBaseline() : MODE === 'restore-baseline' ? await modeRestoreBaseline() : MODE === 'add-missing' ? await modeAddMissing() : await modeCleanup();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
