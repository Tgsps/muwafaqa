/**
 * Pure part of scripts/create-security-roles.mjs (ADR-008): the design of the four project roles and the checks on it.
 * No network, no ids, no addresses. Everything here is unit tested (scripts/lib/security-roles.test.mjs).
 *
 * Facts used (script, read from the environment metadata on 2026-10-22, not guessed):
 *   - mwf_contract is UserOwned; the other five tables are OrganizationOwned. The privileges of an OrganizationOwned table of this project exist only
 *     at the Global (Organization) depth and there are no Assign / Share privileges for them. mwf_contract has Basic / Local / Deep / Global, Assign and Share.
 *   - privilege names are "prv" + action + the SCHEMA name of the table with its own letter case (prvCreatemwf_Contract but prvCreatemwf_approvalmatrix),
 *     so a name is matched case-insensitively against the rows read from the `privileges` table, never typed in.
 * Facts from Learn: Depth of a RolePrivilege is the PrivilegeDepth enum (Global = 3); prvBypassCustomBusinessLogic is required by the headers
 * MSCRM.BypassBusinessLogicExecution and MSCRM.BypassBusinessLogicExecutionStepIds, prvBypassCustomPlugins by MSCRM.BypassCustomPluginExecution.
 * Not read from Learn: the numbers of Basic / Local / Deep (0, 1, 2 by the SDK enum) and the privilegedepthmask values (1, 2, 4, 8); the verify step
 * reads what the platform actually stored and fails on an unknown mask instead of assuming.
 */

export const ACTIONS = ['Create', 'Read', 'Write', 'Delete', 'Append', 'AppendTo', 'Assign', 'Share'];
export const DEPTH_VALUE = { Basic: 0, Local: 1, Deep: 2, Global: 3 };
export const DEPTH_LABEL = { Basic: 'User', Local: 'Business Unit', Deep: 'Parent: Child Business Unit', Global: 'Organization' };
const MASK_TO_DEPTH = { 1: 'Basic', 2: 'Local', 4: 'Deep', 8: 'Global' };
export const FORBIDDEN_BYPASS = ['prvBypassCustomBusinessLogic', 'prvBypassCustomPlugins'];

/** The six tables of the project. `ownership` is checked against the environment by the script (check mode). */
export const TABLES = {
  contract: { logical: 'mwf_contract', ownership: 'UserOwned', title: 'Contract' },
  counterparty: { logical: 'mwf_counterparty', ownership: 'OrganizationOwned', title: 'Counterparty' },
  step: { logical: 'mwf_approvalstep', ownership: 'OrganizationOwned', title: 'Approval Step' },
  matrix: { logical: 'mwf_approvalmatrix', ownership: 'OrganizationOwned', title: 'Approval Matrix' },
  assignment: { logical: 'mwf_approverassignment', ownership: 'OrganizationOwned', title: 'Approver Assignment' },
  counter: { logical: 'mwf_contractnumbercounter', ownership: 'OrganizationOwned', title: 'Contract Number Counter' },
};

const ALL = ['Create', 'Read', 'Write', 'Delete', 'Append', 'AppendTo'];
const g = (actions) => Object.fromEntries(actions.map((a) => [a, 'Global']));
const b = (actions) => Object.fromEntries(actions.map((a) => [a, 'Basic']));

/**
 * The four roles. `grants[table][action] = depth`; an action that is not listed is None. No role lists Assign, Share, any privilege on the counter table
 * or a bypass privilege (rules checked by validateDesign and again on the real roles by verify).
 */
/**
 * The two privileges that let the Admin role READ the audit history (ADR-009). Names and depth read from the environment metadata on 2026-10-24: both exist and
 * can be given at Global only. They are not table privileges, so they are listed apart from `grants`. No other role gets them.
 */
export const AUDIT_READ = [
  { name: 'prvReadAuditSummary', depth: 'Global' },
  { name: 'prvReadRecordAuditHistory', depth: 'Global' },
];

export const ROLES = [
  {
    name: 'Muwafaqa Requester',
    description: 'Creates and submits own contracts: Create, Read, Write and Delete of own contracts (User level), and picks a counterparty. No access to approval steps, the matrix, the assignments or the counter.',
    grants: { contract: b(ALL), counterparty: { Read: 'Global', AppendTo: 'Global' } },
  },
  {
    name: 'Muwafaqa Approver',
    description: 'Reads all contracts, their counterparties and their approval steps (Organization level). Decisions are made in the approval requests, not through this role.',
    grants: { contract: { Read: 'Global' }, counterparty: { Read: 'Global' }, step: { Read: 'Global' } },
  },
  {
    name: 'Muwafaqa Finance',
    description: 'Reads all contracts and approval steps, reads the matrix and the assignments, and maintains the counterparties (Organization level).',
    grants: { contract: { Read: 'Global' }, counterparty: g(['Create', 'Read', 'Write', 'Append', 'AppendTo']), step: { Read: 'Global' }, matrix: { Read: 'Global' }, assignment: { Read: 'Global' } },
  },
  {
    name: 'Muwafaqa Admin',
    description: 'Maintains the approval matrix, the approver assignments and the counterparties; reads contracts and approval steps (Organization level). Cannot assign or share records and has no bypass privilege.',
    grants: { contract: { Read: 'Global' }, counterparty: g(ALL), step: { Read: 'Global' }, matrix: g(ALL), assignment: g(ALL) },
    extra: AUDIT_READ,
  },
];

export const ROLE_NAMES = ROLES.map((r) => r.name);

/** The key a privilege is matched by (case-insensitive): "prv" + action + logical name. */
export const privKey = (action, logical) => `prv${action}${logical}`.toLowerCase();

/** Every (table, action, depth) a role grants. */
export function flattenRole(role) {
  const out = [];
  for (const [table, acts] of Object.entries(role.grants)) for (const [action, depth] of Object.entries(acts)) out.push({ table, action, depth });
  return out;
}

/**
 * Violations of the design rules, as text (an empty list means the design is acceptable):
 *  R1 no Assign or Share in any role;  R2 no privilege on the counter table in any role (the Admin role included);
 *  R3 a table that is OrganizationOwned only gets Global;  R4 the contract gets Basic only in the Requester role, every other role only Read at Global;
 *  R5 no Local or Deep depth anywhere;  R6 only known tables, actions and depths;  R7 the four role names are unique.
 */
export function validateDesign(roles = ROLES, tables = TABLES) {
  const v = [];
  const names = roles.map((r) => r.name);
  if (new Set(names).size !== names.length) v.push('R7 role names are not unique');
  for (const r of roles) {
    for (const { table, action, depth } of flattenRole(r)) {
      const where = `${r.name}: ${table}.${action}=${depth}`;
      if (!tables[table]) { v.push(`R6 unknown table in ${where}`); continue; }
      if (!ACTIONS.includes(action)) v.push(`R6 unknown action in ${where}`);
      if (!(depth in DEPTH_VALUE)) { v.push(`R6 unknown depth in ${where}`); continue; }
      if (action === 'Assign' || action === 'Share') v.push(`R1 ${action} is not allowed (${where})`);
      if (table === 'counter') v.push(`R2 no privilege on the counter table is allowed (${where})`);
      if (tables[table].ownership === 'OrganizationOwned' && depth !== 'Global') v.push(`R3 an organization-owned table only gets Global (${where})`);
      if (depth === 'Local' || depth === 'Deep') v.push(`R5 Local and Deep are not used (${where})`);
      if (table === 'contract' && depth === 'Basic' && r.name !== 'Muwafaqa Requester') v.push(`R4 only the Requester has User level on the contract (${where})`);
      if (table === 'contract' && r.name !== 'Muwafaqa Requester' && !(action === 'Read' && depth === 'Global')) v.push(`R4 outside the Requester only Read at Organization on the contract (${where})`);
    }
  }
  // R8 only the Admin role may hold extra (audit read) privileges, only the two named ones, only at Global
  for (const r of roles) {
    for (const e of r.extra || []) {
      if (r.name !== 'Muwafaqa Admin') v.push(`R8 only the Admin role may hold extra privileges (${r.name}: ${e.name})`);
      if (!AUDIT_READ.some((a) => a.name === e.name && a.depth === e.depth)) v.push(`R8 extra privilege not allowed: ${r.name}: ${e.name} at ${e.depth}`);
    }
  }
  return v;
}

/** The privilege row (from the `privileges` table) of one (action, table), or an error text. rows: [{ name, ... }] */
export function resolvePrivilege(rows, action, logical) {
  const key = privKey(action, logical);
  const hits = (rows || []).filter((r) => String(r.name).toLowerCase() === key);
  if (hits.length !== 1) return { ok: false, error: `${hits.length} privilege row(s) named like prv${action}${logical}` };
  return { ok: true, row: hits[0] };
}

/** Whether the privilege row allows a depth (its canbebasic / canbelocal / canbedeep / canbeglobal flags). */
export function depthAllowed(row, depth) {
  const flag = { Basic: 'canbebasic', Local: 'canbelocal', Deep: 'canbedeep', Global: 'canbeglobal' }[depth];
  return !!(row && flag && row[flag] === true);
}

/** The depth name of a privilegedepthmask value, or null for a value that is not one of 1, 2, 4, 8 (never guessed). */
export const depthOfMask = (mask) => MASK_TO_DEPTH[mask] ?? null;

/**
 * The nine privileges that the platform added by itself to each of the four roles when they were created on 2026-10-22 (script: the same nine, all at
 * Global, in all four roles; they were not part of the AddPrivilegesRole request; the cause is not documented and not tested). Owner decision
 * (ADR-008): they are TOLERATED by name and only at Global depth. Any other privilege outside the design fails the verification.
 */
export const PLATFORM_BASELINE = [
  'prvReadSdkMessage', 'prvReadSdkMessageProcessingStep', 'prvReadSdkMessageProcessingStepImage', 'prvReadPluginType', 'prvReadPluginAssembly',
  'prvReadSharePointDocument', 'prvReadSharePointData', 'prvWriteSharePointData', 'prvCreateSharePointData',
];

/**
 * Compares what a role should hold with what it holds.
 * @param desired   [{ key, depth }]  key = lowercase privilege name
 * @param actual    [{ name, depth }] depth = depth name or null when unknown
 * @param tolerated names of privileges that may be present beyond the design, only at Global depth (any other depth, or an unknown depth, is "extra")
 * @returns {{missing:string[], extra:string[], wrongDepth:string[], tolerated:number, same:boolean}}
 */
export function compareRolePrivileges(desired, actual, tolerated = []) {
  const want = new Map(desired.map((d) => [d.key, d.depth]));
  const have = new Map(actual.map((a) => [String(a.name).toLowerCase(), a.depth]));
  const tol = new Set(tolerated.map((n) => String(n).toLowerCase()));
  const missing = [...want.keys()].filter((k) => !have.has(k));
  const extra = []; let toleratedCount = 0;
  for (const [k, depth] of have) {
    if (want.has(k)) continue;
    if (tol.has(k) && depth === 'Global') toleratedCount++;
    else extra.push(k);
  }
  const wrongDepth = [...want.keys()].filter((k) => have.has(k) && have.get(k) !== want.get(k));
  return { missing, extra, wrongDepth, tolerated: toleratedCount, same: !missing.length && !extra.length && !wrongDepth.length };
}

/** The negative check on real roles: any bypass privilege, and any privilege on the counter table, in any role. actualByRole: { roleName: [{ name }] } */
export function negativeFindings(actualByRole) {
  const hits = [];
  const counter = TABLES.counter.logical.toLowerCase();
  for (const [role, privs] of Object.entries(actualByRole)) {
    for (const p of privs) {
      const n = String(p.name).toLowerCase();
      if (n.startsWith('prvbypass')) hits.push(`${role}: ${p.name}`);
      if (n.includes(counter)) hits.push(`${role}: ${p.name}`);
      if (/^prv(assign|share)mwf_/.test(n)) hits.push(`${role}: ${p.name}`);
    }
  }
  return hits;
}

/**
 * Members of a project role. Nobody may be a member, except that the Requester role may have ONE member: the application user of the behavioral test
 * (ADR-008), recognized by its applicationid (the value of MWF_TEST_CLIENT_ID, never printed). Any other member, and any team, fails.
 * @param users [{ applicationid }]  @returns {{ok:boolean, appUsers:number, others:number}}
 */
export function membersVerdict(roleName, users, teams, clientId) {
  const isApp = (u) => !!clientId && String(u?.applicationid ?? '').toLowerCase() === String(clientId).trim().toLowerCase();
  const appUsers = roleName === 'Muwafaqa Requester' ? (users || []).filter(isApp).length : 0;
  const others = (users || []).length - appUsers;
  return { ok: others === 0 && (teams || 0) === 0 && appUsers <= 1, appUsers, others };
}

/** "prvAppendTomwf_Contract" -> { action: 'AppendTo', logical: 'mwf_contract' } for the project tables, null for any other name. */
export function parsePrivilegeName(name, tables = TABLES) {
  const n = String(name || '');
  if (!/^prv/i.test(n)) return null;
  const rest = n.slice(3).toLowerCase();
  const logicals = Object.values(tables).map((t) => t.logical);
  for (const action of [...ACTIONS].sort((x, y) => y.length - x.length)) {
    const a = action.toLowerCase();
    if (rest.startsWith(a) && logicals.includes(rest.slice(a.length))) return { action, logical: rest.slice(a.length) };
  }
  return null;
}

/** The desired privileges of a role as [{ key, depth, action, table }] */
export function desiredPrivileges(role, tables = TABLES) {
  const fromTables = flattenRole(role).map((x) => ({ key: privKey(x.action, tables[x.table].logical), depth: x.depth, action: x.action, table: x.table }));
  const fromExtra = (role.extra || []).map((e) => ({ key: e.name.toLowerCase(), depth: e.depth, action: 'Read', table: '(audit)', extraName: e.name }));
  return [...fromTables, ...fromExtra];
}

/** The privilege row of one desired grant: by table and action, or, for an extra privilege (audit read), by its exact name. */
export function resolveDesired(rows, d) {
  if (d.extraName) {
    const hits = (rows || []).filter((r) => String(r.name).toLowerCase() === d.extraName.toLowerCase());
    return hits.length === 1 ? { ok: true, row: hits[0] } : { ok: false, error: `${hits.length} privilege row(s) named ${d.extraName}` };
  }
  return resolvePrivilege(rows, d.action, TABLES[d.table].logical);
}

/** The extra (audit read) privileges of a role as text, for the plan. */
export const describeExtras = (role) => (role.extra || []).map((e) => `${e.name}: ${DEPTH_LABEL[e.depth]}`);

/** What a role lacks of its design: { missing: [desired], wrongDepth: [desired] }. stored: [{ name, depth }] */
export function missingDesigned(role, stored) {
  const have = new Map((stored || []).map((s) => [String(s.name).toLowerCase(), s.depth]));
  const want = desiredPrivileges(role);
  return { missing: want.filter((d) => !have.has(d.key)), wrongDepth: want.filter((d) => have.has(d.key) && have.get(d.key) !== d.depth) };
}

/** The body of AddPrivilegesRole for a list of { privilegeid, depth }. */
export const addPrivilegesBody = (list) => ({ Privileges: list.map((x) => ({ PrivilegeId: x.privilegeid, Depth: String(DEPTH_VALUE[x.depth]) })) });

/** A readable matrix, one line per table: "Contract: Create U, Read U ..." (U = User, O = Organization). Used by the plan and the ADR. */
export function describeRole(role, tables = TABLES) {
  const short = { Basic: 'User', Global: 'Organization', Local: 'BU', Deep: 'Parent-Child BU' };
  return Object.keys(tables).map((t) => {
    const acts = role.grants[t];
    return `${tables[t].title}: ${acts ? ACTIONS.filter((a) => acts[a]).map((a) => `${a} ${short[acts[a]]}`).join(', ') : 'none'}`;
  });
}

// ---------------------------------------------------------------------------------------------------------------- the platform baseline (remove / restore experiment)

/**
 * Where the nine baseline privileges are in a role. stored: [{ name, depth }].
 * present = at Global; wrongDepth = the name is there at another (or an unknown) depth; missing = not there at all.
 */
export function baselineState(stored) {
  const wanted = new Map(PLATFORM_BASELINE.map((n) => [n.toLowerCase(), n]));
  const present = []; const wrongDepth = [];
  for (const s of stored || []) {
    const canon = wanted.get(String(s.name).toLowerCase());
    if (!canon) continue;
    if (s.depth === 'Global') present.push(canon); else wrongDepth.push(canon);
  }
  const missing = PLATFORM_BASELINE.filter((n) => !present.includes(n) && !wrongDepth.includes(n));
  return { present, wrongDepth, missing };
}

/** --expect-baseline=none|all|any for verify (default none): the number of baseline privileges that must be there (0, all nine, or any number). */
export function checkBaselineExpectation(expect, presentCount, total = PLATFORM_BASELINE.length) {
  const e = expect || 'none';   // the default of verify: none of the nine may be there (a re-addition is detected)
  if (!['none', 'all', 'any'].includes(e)) throw new Error(`invalid --expect-baseline=${e} (none|all|any)`);
  if (e === 'none') return { ok: presentCount === 0, expected: 'none of the nine' };
  if (e === 'all') return { ok: presentCount === total, expected: `all ${total}` };
  return { ok: true, expected: 'any number' };
}

/** The body of RemovePrivilegeRole (bound to roles(<id>)): one privilege. Learn gives the parameter (Privilege, a privilege row) but no sample body; this is the usual form for an entity parameter and is NOT tested. */
export const removePrivilegeBody = (privilegeId) => ({ Privilege: { '@odata.type': 'Microsoft.Dynamics.CRM.privilege', privilegeid: privilegeId } });

/** The body of AddPrivilegesRole that puts the given baseline privileges back at Global. rows: [{ privilegeid }] */
export const restoreBaselineBody = (rows) => ({ Privileges: rows.map((r) => ({ PrivilegeId: r.privilegeid, Depth: String(DEPTH_VALUE.Global) })) });

/** A role given as "Requester" or "Muwafaqa Requester" -> the full name, or an error. */
export function roleFromArg(value) {
  const v = String(value || '').trim().toLowerCase();
  const hit = ROLE_NAMES.find((n) => n.toLowerCase() === v || n.toLowerCase() === `muwafaqa ${v}`);
  if (!hit) throw new Error(`unknown role "${value || ''}" (use one of: ${ROLE_NAMES.join(', ')})`);
  return hit;
}

/**
 * S8 of verify-approval-chain-schema: what the project roles hold on a few tables, against the design (ADR-008), by privilege NAME only.
 * Depth is not looked at here; `create-security-roles --mode=verify` checks the depth of every privilege.
 * actualByRole: { roleName: [privilege names on those tables] }, only roles that are NOT managed (the project's own).
 * A project role that is not one of the four, an extra privilege (Create/Write/Delete/Append on the steps, Assign, Share, anything the design does not list) and a designed privilege
 * that is missing are all findings.
 * @returns {{ok:boolean, unknownRoles:string[], extra:{role:string,name:string}[], missing:{role:string,name:string}[]}}
 */
export function compareProjectRolesOnTables(actualByRole, logicals, roles = ROLES) {
  const want = new Set((logicals || []).map((l) => String(l).toLowerCase()));
  const onTables = (name) => { const p = parsePrivilegeName(name); return !!p && want.has(p.logical); };
  const designed = new Map(roles.map((r) => [r.name, new Set(desiredPrivileges(r).filter((d) => d.table !== '(audit)' && want.has(TABLES[d.table].logical.toLowerCase())).map((d) => d.key))]));
  const unknownRoles = []; const extra = []; const missing = [];
  const seen = new Map(Object.entries(actualByRole || {}).map(([role, names]) => [role, new Set((names || []).map((n) => String(n).toLowerCase()))]));
  for (const [role, names] of seen) {
    const held = [...names].filter((n) => onTables(n) || /^prv(assign|share)/.test(n));
    if (!designed.has(role)) { if (held.length) unknownRoles.push(role); continue; }
    for (const n of held) if (!designed.get(role).has(n)) extra.push({ role, name: n });
  }
  for (const [role, set] of designed) for (const n of set) if (!(seen.get(role) || new Set()).has(n)) missing.push({ role, name: n });
  return { ok: !unknownRoles.length && !extra.length && !missing.length, unknownRoles, extra, missing };
}
