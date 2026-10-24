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
  return flattenRole(role).map((x) => ({ key: privKey(x.action, tables[x.table].logical), depth: x.depth, action: x.action, table: x.table }));
}

/** A readable matrix, one line per table: "Contract: Create U, Read U ..." (U = User, O = Organization). Used by the plan and the ADR. */
export function describeRole(role, tables = TABLES) {
  const short = { Basic: 'User', Global: 'Organization', Local: 'BU', Deep: 'Parent-Child BU' };
  return Object.keys(tables).map((t) => {
    const acts = role.grants[t];
    return `${tables[t].title}: ${acts ? ACTIONS.filter((a) => acts[a]).map((a) => `${a} ${short[acts[a]]}`).join(', ') : 'none'}`;
  });
}
