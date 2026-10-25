// Pure helpers of scripts/test-auditing-user-change.mjs: reading a lookup to a user out of an audit detail, choosing the second user, the expectations.
// No network, no ids written anywhere. Tested in lib/user-change-audit.test.mjs.

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The id inside a lookup value, whatever its shape: "guid", "/systemusers(guid)", { Id }, { id }, { systemuserid }, { "@odata.id": "systemusers(guid)" }. null when there is none. */
export function idFrom(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { const m = GUID.exec(v); return m ? m[0].toLowerCase() : null; }
  if (typeof v === 'object') return idFrom(v.Id ?? v.id ?? v.systemuserid ?? v['@odata.id'] ?? null);
  return null;
}

const isNoiseKey = (k) => /@(OData|odata)\.Community|@Microsoft/.test(k) || k.startsWith('@');
/** The keys of one side (OldValue / NewValue) that belong to the column `col`: "<col>", "_<col>_value", "<col>_value", "<col>@odata.bind". Noise annotations (formatted values) are not counted. */
export function keysOfColumn(side, col) {
  const re = new RegExp(`^_?${col}(_value|@odata\\.bind)?$`, 'i');
  return Object.keys(side || {}).filter((k) => !isNoiseKey(k) && re.test(k));
}

/**
 * What an audit detail says about a lookup column: { old, new } as lowercase ids (null when the side has no value) and the key names used (names only, for a diagnostic).
 * `found` is false when neither side carries the column at all.
 */
export function lookupValueOf(detail, col) {
  const read = (side) => { const ks = keysOfColumn(side, col); return { ks, id: ks.length ? ks.map((k) => idFrom(side[k])).find((x) => x) ?? null : null }; };
  const o = read(detail?.OldValue); const n = read(detail?.NewValue);
  return { found: o.ks.length + n.ks.length > 0, old: o.id, new: n.id, keys: { old: o.ks, new: n.ks } };
}

/** Does this audit detail show `col` going from user `oldId` to user `newId`? Ids are compared without regard to case. */
export function assertUserChange(detail, col, oldId, newId) {
  const v = lookupValueOf(detail, col);
  const eq = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
  if (!v.found) return { ok: false, reason: `the detail has no value for ${col}`, ...v };
  if (!eq(v.old, oldId)) return { ok: false, reason: `old value is ${v.old ? 'a different user' : 'empty'}`, ...v };
  if (!eq(v.new, newId)) return { ok: false, reason: `new value is ${v.new ? 'a different user' : 'empty'}`, ...v };
  return { ok: true, reason: 'old and new user match', ...v };
}

/** Columns (other than `col`) that the same detail says changed, ignoring housekeeping columns; names only. */
export function otherChangedColumns(detail, col, ignore = ['modifiedon', 'modifiedby', 'modifiedonbehalfby', 'versionnumber']) {
  const o = detail?.OldValue || {}; const n = detail?.NewValue || {};
  const norm = (k) => k.replace(/^_/, '').replace(/(_value|@odata\.bind)$/i, '').toLowerCase();
  const keys = new Set([...Object.keys(o), ...Object.keys(n)].filter((k) => !isNoiseKey(k) && !k.includes('@odata.type') && k !== '@odata.type').map(norm));
  keys.delete(col.toLowerCase()); for (const i of ignore) keys.delete(i);
  return [...keys].sort();
}

/** The second user to move the lookup to: the first active, interactive user that is neither the owner nor SYSTEM / INTEGRATION nor an application user. Returns the id or null. */
export function pickSecondUser(users, ownerId) {
  const owner = String(ownerId || '').toLowerCase();
  const u = (users || []).find((x) => x && x.systemuserid && String(x.systemuserid).toLowerCase() !== owner
    && x.isdisabled === false && !x.applicationid && [0, 1].includes(x.accessmode) && !/^(SYSTEM|INTEGRATION)$/i.test(String(x.fullname || '').trim()));
  return u ? u.systemuserid : null;
}

/** Audit expectations (for unmetExpectations in lib/auditing.mjs). phase 1: the Create row and one Update row after the lookup was changed; phase 2: the Delete row. */
export function expectationsFor(rowId, phase) {
  return phase === 1
    ? [{ objectid: rowId, operation: 1, label: 'assignment row' }, { objectid: rowId, operation: 2, label: 'assignment row' }]
    : [{ objectid: rowId, operation: 3, label: 'assignment row' }];
}

/** The name of the temporary row and the prefix every row of this test carries. */
export const PREFIX = 'TEST-TMP-AUDUSER';
export const rowName = () => `${PREFIX} assignment`;

/** Whether the row is a leftover of this test (by name prefix). */
export const isTestRow = (name) => String(name || '').startsWith(PREFIX);

/** The request body that creates the temporary assignment row with the user A. No role is sent: the five real rows already use the five role values, and the alternate key allows one row per role. */
export function createBody(userAId) {
  return { mwf_name: rowName(), 'mwf_user@odata.bind': `/systemusers(${userAId})` };
}
/** The request body that moves the lookup to the user B. */
export const moveBody = (userBId) => ({ 'mwf_user@odata.bind': `/systemusers(${userBId})` });
