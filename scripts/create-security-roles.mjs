#!/usr/bin/env node
/**
 * Creates and verifies the four project security roles (ADR-008): Muwafaqa Requester / Approver / Finance / Admin. The design is in
 * scripts/lib/security-roles.mjs (pure, unit tested). This script assigns NO role to any user, touches NO flow and NO plug-in.
 *
 *   --mode=check    read only: both approval flows OFF, the ownership of the six tables, every privilege of the design found BY NAME in the `privileges`
 *                   table (never typed in) and allowed at the planned depth, the design rules, the existing roles, the root business unit, the solution
 *   --mode=create   check first, then for each role that does not exist: POST roles (into the solution) and AddPrivilegesRole. An existing role is left
 *                   alone if it already equals the design; a role that differs STOPS the run (nothing is replaced). Needs --confirm-mutates-environment
 *                   (or --dry-run: reads and prints the requests, sends nothing)
 *   --mode=verify   read only: for each role, the privileges and depths really stored (roleprivileges), compared with the design, the solution membership,
 *                   the member count (must be 0), and the NEGATIVE check: no bypass privilege and no privilege on the counter table in any role
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
import { membersVerdict, TABLES, ROLES, ROLE_NAMES, DEPTH_VALUE, DEPTH_LABEL, FORBIDDEN_BYPASS, ACTIONS, validateDesign, resolvePrivilege, depthAllowed, depthOfMask, compareRolePrivileges, negativeFindings, desiredPrivileges, describeRole, parsePrivilegeName, PLATFORM_BASELINE } from './lib/security-roles.mjs';

const { argOf, env: ENV, auth: AUTH, has } = parseArgs();
const MODE = argOf('mode');
const DRY = has('--dry-run');
const SOLUTION = 'Muwafaqa';
const q = encodeURIComponent;
if (!['check', 'create', 'verify', 'cleanup'].includes(MODE)) { console.error('Missing or invalid --mode=check|create|verify|cleanup. Nothing was run.'); process.exit(2); }
if (['create', 'cleanup'].includes(MODE) && !DRY && !has('--confirm-mutates-environment')) {
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
  check('flows', `both approval flows are OFF (${f.line})`, f.ok);
  if (!f.ok) throw new Stop('An approval flow is ON or not readable. Nothing was changed.');
  const v = validateDesign();
  check('design', 'the design rules R1 to R7 hold (no Assign / Share, no counter privilege, organization-owned tables only Global, User level only for the Requester on the contract)', v.length === 0, v.join('; ') || `${ROLES.length} roles`);
  const meta = await tableMeta();
  for (const [key, t] of Object.entries(TABLES)) check('table', `${t.logical}: ${meta[key].ownership}`, meta[key].ownership === t.ownership, `expected ${t.ownership}`);
  const rows = await privilegeRows();
  console.log(`INFO  privilege rows found for the six tables: ${rows.length}`);
  let bad = 0;
  for (const role of ROLES) {
    for (const d of desiredPrivileges(role)) {
      const logical = TABLES[d.table].logical;
      const r = resolvePrivilege(rows, d.action, logical);
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
    const privs = desiredPrivileges(role).map((d) => ({ ...d, row: resolvePrivilege(rows, d.action, TABLES[d.table].logical).row }));
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
  check('flows', `both approval flows are OFF (${f.line})`, f.ok);
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
    const other = stored.filter((x) => !parsePrivilegeName(x.name));
    if (other.length) console.log(`         platform baseline (tolerated by name, Global only): ${other.map((x) => `${x.name}:${DEPTH_LABEL[x.depth] ?? '?'}`).join(', ')}`);
  }
  const hits = negativeFindings(actualByRole);
  check('NEG', 'no role holds a bypass privilege (prvBypassCustomBusinessLogic, prvBypassCustomPlugins, any prvBypass*), any privilege on the counter table, or any Assign / Share', hits.length === 0, hits.join('; ') || 'none found');
  const bad = results.filter((x) => x.status === 'FAIL').length;
  console.log(`\nVERIFY: ${results.filter((x) => x.status === 'PASS').length} PASS, ${bad} FAIL, ${results.filter((x) => x.status === 'OBS').length} OBS.`);
  return bad === 0;
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
    const ok = MODE === 'check' ? await modeCheck() : MODE === 'create' ? await modeCreate() : MODE === 'verify' ? await modeVerify() : await modeCleanup();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
