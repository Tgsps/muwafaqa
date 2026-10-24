/**
 * Pure part of scripts/configure-auditing.mjs and scripts/test-auditing.mjs (ADR-009, Dataverse auditing). No network, no ids, no addresses.
 *
 * Facts from Learn (read 2026-10-24, "Configure auditing", "Create and update table definitions using the Web API", "Create and update column
 * definitions using the Web API", "Retrieve the history of audited data changes", "Manage Dataverse auditing"):
 *  - Auditing has three levels: the Organization row (isauditenabled, auditretentionperiodv2, isreadauditenabled, isuseraccessauditenabled), the table
 *    (EntityMetadata.IsAuditEnabled) and the column (AttributeMetadata.IsAuditEnabled). IsAuditEnabled is a managed property { Value, CanBeChanged }.
 *  - The organization settings are changed with PATCH organizations(<id>) (If-Match: *). A table or a column definition is changed with PUT (PATCH is
 *    not allowed for metadata) of the WHOLE definition, with the header MSCRM.MergeLabels (without it the default is false and other-language labels
 *    are removed), and the change is not active until PublishXml.
 *  - Audit rows are read from the audits table; RetrieveRecordChangeHistory (all changes of one record) and RetrieveAuditDetails (Old/New values) are
 *    functions. Learn warns that the Web API result of RetrieveRecordChangeHistory does not carry the AuditRecord, so who and when must come from the audits table.
 */

export const AUDIT_TABLES = ['mwf_approvalmatrix', 'mwf_approverassignment', 'mwf_counterparty', 'mwf_approvalstep', 'mwf_contract'];   // lowest risk first
export const EXCLUDED_TABLES = {
  mwf_contractnumbercounter: 'written by the SYSTEM plug-in on every contract creation: high volume, no business value; the effect is visible in the contract number of each contract (owner decision)',
};
export const ORG_TARGET = Object.freeze({ isauditenabled: true, auditretentionperiodv2: 365, isreadauditenabled: false, isuseraccessauditenabled: false });

/** Columns that are OFF by default (lookups) and that the design wants audited. */
export const COLUMN_ENABLE = [
  { table: 'mwf_contract', column: 'mwf_counterpartyid', reason: 'who the contract is with; locked after Draft by the guard (ADR-004), so a change in Draft is the only one worth seeing' },
  { table: 'mwf_approvalstep', column: 'mwf_actualapprover', reason: 'who really decided the step' },
  { table: 'mwf_approvalstep', column: 'mwf_originalapprover', reason: 'who the step was assigned to' },
  { table: 'mwf_approverassignment', column: 'mwf_user', reason: 'who approves for a role: the most sensitive configuration of the chain' },
];
/** Columns left OFF on purpose, with the reason (the report and ADR-009 print this). */
export const COLUMN_EXCLUDE = [
  { table: 'mwf_approvalstep', column: 'mwf_contract', reason: 'the link to the parent contract is set once by the plug-in when the step is created and is never changed' },
];
/** System columns that are ON by default and must stay ON for the tables of the design (the ones that carry business meaning). */
export const SYSTEM_MUST_BE_ON = ['ownerid', 'statecode', 'statuscode', 'transactioncurrencyid', 'exchangerate'];
/** System columns that are ON by default, never change in normal operation, and are left as they are (not touched: fewer writes). */
export const SYSTEM_LEFT_AS_IS = ['importsequencenumber', 'overriddencreatedon', 'owningbusinessunit', 'organizationid'];
export const READ_PRIVILEGES = [
  { name: 'prvReadAuditSummary', depth: 'Global', why: 'View Audit Summary: the audits table' },
  { name: 'prvReadRecordAuditHistory', depth: 'Global', why: 'View Audit History: RetrieveRecordChangeHistory, RetrieveAuditDetails' },
];

/** Organization settings: what to PATCH (only the properties that differ) and whether they already equal the target. */
export function orgDiff(current, target = ORG_TARGET) {
  const patch = {};
  for (const [k, v] of Object.entries(target)) if (current?.[k] !== v) patch[k] = v;
  return { patch, same: Object.keys(patch).length === 0 };
}

/** A copy of a definition with IsAuditEnabled.Value set. Refuses when the managed property cannot be changed or is missing. */
export function setAuditValue(def, value) {
  const p = def?.IsAuditEnabled;
  if (!p || typeof p !== 'object' || !('Value' in p)) throw new Error('the definition has no IsAuditEnabled managed property');
  if (p.CanBeChanged === false) throw new Error('IsAuditEnabled cannot be changed on this definition (CanBeChanged is false)');
  const copy = JSON.parse(JSON.stringify(def));
  copy.IsAuditEnabled.Value = !!value;
  return copy;
}

/** The body of a PUT: the definition as read, without the OData annotations of the read response. */
export function stripForPut(def) {
  const copy = JSON.parse(JSON.stringify(def));
  delete copy['@odata.etag']; delete copy['@odata.context'];
  return copy;
}

/** Deep difference of two JSON values: [{ path, before, after }]. Arrays are compared index by index. */
export function diffDeep(a, b, path = '') {
  if (a === b) return [];
  const isObj = (x) => x !== null && typeof x === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return [{ path: path || '(root)', before: a, after: b }];
  const keys = Array.isArray(a) ? [...Array(Math.max(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.flatMap((k) => diffDeep(a[k], b[k], path ? `${path}${Array.isArray(a) ? `[${k}]` : `.${k}`}` : String(k)));
}
/** Differences that are not on the allowed paths (default: only IsAuditEnabled.Value). Empty = nothing else changed. */
export const unexpectedDiffs = (diffs, allowed = ['IsAuditEnabled.Value']) => diffs.filter((d) => !allowed.includes(d.path));

/** The metadata type used in the cast of a column read and in @odata.type of the PUT, from AttributeType. */
const CAST = { String: 'StringAttributeMetadata', Integer: 'IntegerAttributeMetadata', BigInt: 'BigIntAttributeMetadata', Picklist: 'PicklistAttributeMetadata', Money: 'MoneyAttributeMetadata', DateTime: 'DateTimeAttributeMetadata', Decimal: 'DecimalAttributeMetadata', Double: 'DoubleAttributeMetadata', Lookup: 'LookupAttributeMetadata', Boolean: 'BooleanAttributeMetadata', Memo: 'MemoAttributeMetadata' };
export function attributeCast(attributeType) {
  const c = CAST[attributeType];
  if (!c) throw new Error(`no known metadata type for AttributeType "${attributeType}"`);
  return `Microsoft.Dynamics.CRM.${c}`;
}

export const publishXmlBody = (entityLogicalName) => ({ ParameterXml: `<importexportxml><entities><entity>${entityLogicalName}</entity></entities></importexportxml>` });
/** Required header of every metadata PUT (Learn: without it labels of other languages are removed). */
export const PUT_HEADERS = Object.freeze({ 'MSCRM.MergeLabels': 'true' });

/**
 * The column work for one table. attrs: [{ LogicalName, IsAuditEnabled: { Value, CanBeChanged } }] as read.
 * @returns {{enable:string[], alreadyOn:string[], blocked:string[], missing:string[], systemOff:string[]}}
 */
export function columnPlan(table, attrs) {
  const byName = new Map((attrs || []).map((a) => [a.LogicalName, a]));
  const out = { enable: [], alreadyOn: [], blocked: [], missing: [], systemOff: [] };
  for (const w of COLUMN_ENABLE.filter((x) => x.table === table)) {
    const a = byName.get(w.column);
    if (!a) { out.missing.push(w.column); continue; }
    if (a.IsAuditEnabled?.Value) out.alreadyOn.push(w.column);
    else if (a.IsAuditEnabled?.CanBeChanged === false) out.blocked.push(w.column);
    else out.enable.push(w.column);
  }
  for (const c of SYSTEM_MUST_BE_ON) { const a = byName.get(c); if (a && !a.IsAuditEnabled?.Value) out.systemOff.push(c); }
  return out;
}

/** Whether a table meets the target: table audit on, every design lookup on, the system columns that matter on. */
export function tableMeetsTarget(table, def, attrs) {
  const plan = columnPlan(table, attrs);
  return { ok: !!def?.IsAuditEnabled?.Value && !plan.enable.length && !plan.blocked.length && !plan.missing.length && !plan.systemOff.length, plan };
}

// ---------------------------------------------------------------------------------------------------------------- reading the audit rows
export const OPERATION_NAMES = { 1: 'Create', 2: 'Update', 3: 'Delete', 4: 'Access' };
export const ACTION_NAMES = { 1: 'Create', 2: 'Update', 3: 'Delete', 13: 'Assign', 41: 'Set State', 57: 'Add Privileges to Role', 58: 'Remove Privileges From Role', 59: 'Replace Privileges In Role', 102: 'Audit Change at Entity Level', 103: 'Audit Change at Attribute Level', 104: 'Audit Change at Org Level', 105: 'Entity Audit Started', 106: 'Attribute Audit Started', 107: 'Audit Enabled' };
export const operationName = (n) => OPERATION_NAMES[n] ?? `operation ${n}`;
export const actionName = (n) => ACTION_NAMES[n] ?? `action ${n}`;

const isNoise = (k) => k.startsWith('@') || k.includes('@odata') || k.includes('@Microsoft') || k.includes('@OData');
/**
 * What an AttributeAuditDetail says changed: { column: { old, new } } for every column in OldValue or NewValue. A lookup appears as "_<name>_value".
 * Values are compared as JSON text; a column that is only in NewValue has old = undefined (a new value), only in OldValue has new = undefined (cleared).
 */
export function changesOf(detail) {
  const o = detail?.OldValue || {}; const n = detail?.NewValue || {};
  const cols = [...new Set([...Object.keys(o), ...Object.keys(n)].filter((k) => !isNoise(k)))];
  return Object.fromEntries(cols.map((c) => [c, { old: o[c], new: n[c] }]));
}
/** True when the detail shows column `col` going from `oldV` to `newV` (undefined means "not present"). */
export function showsChange(detail, col, oldV, newV) {
  const c = changesOf(detail)[col];
  return !!c && JSON.stringify(c.old) === JSON.stringify(oldV) && JSON.stringify(c.new) === JSON.stringify(newV);
}
/** Seconds between the moment an operation answered and the moment its audit row was first SEEN by the poll (null when it never appeared). */
export const visibleLagSeconds = (operationMs, seenMs) => (seenMs == null ? null : Math.max(0, Math.round((seenMs - operationMs) / 1000)));
/** The rows of one record in the order of the changes, with the names of the operation and the action. */
export function describeRows(rows) {
  return [...rows].sort((x, y) => Date.parse(x.createdon) - Date.parse(y.createdon)).map((r) => ({ id: r.auditid, at: r.createdon, operation: operationName(r.operation), action: actionName(r.action), userid: r._userid_value, callinguserid: r._callinguserid_value ?? null }));
}

// ---------------------------------------------------------------------------------------------------------------- the audit test (scripts/test-auditing.mjs)

/** min / median / max of a list of seconds (null for an empty list). */
export function lagStats(values) {
  const v = (values || []).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  return { count: v.length, min: v[0], median: v[Math.floor(v.length / 2)], max: v[v.length - 1] };
}

/** Who made a change: 'admin' (the account that ran the test), 'system' (a user in `systemIds`), or 'other'. Names are never used. */
export function classifyUser(userId, adminId, systemIds = []) {
  const u = String(userId || '').toLowerCase();
  if (!u) return 'none';
  if (u === String(adminId || '').toLowerCase()) return 'admin';
  if (systemIds.map((x) => String(x).toLowerCase()).includes(u)) return 'system';
  return 'other';
}

/**
 * The expectations that are not met yet. rows: audit rows; expected: [{ objectid, operation, min }] (min defaults to 1).
 * @returns {string[]} one text per unmet expectation (empty = all met)
 */
export function unmetExpectations(rows, expected) {
  const unmet = [];
  for (const e of expected) {
    const n = (rows || []).filter((r) => String(r._objectid_value).toLowerCase() === String(e.objectid).toLowerCase() && r.operation === e.operation).length;
    if (n < (e.min ?? 1)) unmet.push(`${e.label || e.objectid}: ${operationName(e.operation)} ${n}/${e.min ?? 1}`);
  }
  return unmet;
}

/** The polling is finished when every expectation is met and no new audit row has appeared for `quietMs`, or when the time is over. */
export function pollFinished({ unmet, lastNewRowMs, nowMs, quietMs, startedMs, timeoutMs }) {
  if (nowMs - startedMs >= timeoutMs) return { done: true, why: 'timeout' };
  if (unmet.length === 0 && nowMs - lastNewRowMs >= quietMs) return { done: true, why: 'all expectations met and quiet' };
  return { done: false };
}

/** Records the moment each audit row was first SEEN: seen = Map(auditid -> ms). Returns the rows that are new in this reading. */
export function noteNewRows(seen, rows, nowMs) {
  const fresh = [];
  for (const r of rows || []) if (!seen.has(r.auditid)) { seen.set(r.auditid, nowMs); fresh.push(r); }
  return fresh;
}

/** The URL of RetrieveRecordChangeHistory for a record (Learn form: Target=@target,PagingInfo=@paginginfo with the aliases in the query string). */
export function changeHistoryPath(entitySet, id, count = 50) {
  const target = encodeURIComponent(JSON.stringify({ '@odata.id': `${entitySet}(${id})` }));
  const paging = encodeURIComponent(JSON.stringify({ PageNumber: 1, Count: count, ReturnTotalRecordCount: true }));
  return `RetrieveRecordChangeHistory(Target=@target,PagingInfo=@paginginfo)?@target=${target}&@paginginfo=${paging}`;
}
export const auditDetailsPath = (auditId) => `audits(${auditId})/Microsoft.Dynamics.CRM.RetrieveAuditDetails`;

// ---------------------------------------------------------------------------------------------------------------- backup, restore, revert (outside the repository)

/** The name of a backup file: entity or attr, table, column, time. No id and no host in it. */
export function backupName(kind, table, column, atMs) {
  if (!['entity', 'attr'].includes(kind)) throw new Error(`unknown backup kind ${kind}`);
  const stamp = new Date(atMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return kind === 'entity' ? `${table}.entity.${stamp}.json` : `${table}.${column}.attr.${stamp}.json`;
}
/** The newest backup name of a target among the names of a directory (the stamp sorts as text). */
export function latestBackup(names, kind, table, column) {
  const prefix = kind === 'entity' ? `${table}.entity.` : `${table}.${column}.attr.`;
  return (names || []).filter((n) => n.startsWith(prefix) && n.endsWith('.json')).sort().pop() ?? null;
}
/** --target=entity:mwf_x  or  --target=attr:mwf_x.mwf_col */
export function parseTarget(text) {
  const m = /^(entity|attr):([a-z0-9_]+)(?:\.([a-z0-9_]+))?$/.exec(String(text || ''));
  if (!m) throw new Error('--target must be entity:<table> or attr:<table>.<column>');
  if (m[1] === 'attr' && !m[3]) throw new Error('--target=attr needs <table>.<column>');
  if (m[1] === 'entity' && m[3]) throw new Error('--target=entity takes only <table>');
  return { kind: m[1], table: m[2], column: m[3] || null };
}
/** A PUT with no change must leave NO difference at all. */
export const isNoopClean = (diffs) => diffs.length === 0;

// ---------------------------------------------------------------------------------------------------------------- the one tolerated difference
/**
 * A PUT of a COLUMN definition (even one that changes nothing) updates ModifiedOn, a timestamp the platform maintains (observed 2026-10-24: the no-op PUT of
 * a lookup column changed only ModifiedOn; the no-op PUT of a table changed nothing). The exception is deliberately narrow (owner decision): ONLY the TOP-LEVEL
 * path "ModifiedOn", ONLY for a column definition. A nested path, another spelling, another property, or a table definition is never excused.
 */
export const VOLATILE_COLUMN_PATHS = Object.freeze(['ModifiedOn']);
export function relevantDiffs(kind, diffs) {
  if (kind !== 'attr') return diffs;
  return diffs.filter((d) => !VOLATILE_COLUMN_PATHS.includes(d.path));
}
