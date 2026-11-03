/**
 * The two tables of ADR-011 (status Proposed): mwf_obligation (audit ON) and mwf_alertlog (service table, audit OFF, no project role).
 * Pure parts only: the definitions, the request bodies, the plan text and the read-back checks. The script that uses them is
 * scripts/add-obligation-schema.mjs. No id, address or token is written by this module. NOTHING here has run against an environment.
 *
 * Facts used: the Web API shapes are those of scripts/create-approval-chain-tables.mjs and scripts/lib/reminder-schema.mjs (both ran).
 * IsAuditEnabled in the creation body of a TABLE is the same managed property as for a column (Learn, "Create and update table definitions
 * using the Web API"); it has not been tested here (not tested), so the verify mode reads the flag back and the script never PUTs a definition.
 * A custom column can be ApplicationRequired at most (not SystemRequired), so "required" is NOT enforced by the server for a caller of the
 * Web API: that is why the key builder (alert-key.mjs) refuses null and empty and why the uniqueness test observes what the server does.
 */

export const OPTION_VALUE_BASE = 867640000;   // the base of the Choice values of this publisher, as in the other tables

export const PARTY = Object.freeze({ 'First Party': 867640000, 'Second Party': 867640001 });
export const OBLIGATION_STATUS = Object.freeze({ Open: 867640000, Done: 867640001, Disputed: 867640002 });

/** Tables. Both are created in the solution. mwf_obligation follows the ownership of its parent (mwf_contract is UserOwned); mwf_alertlog is a service table. */
export const TABLES = Object.freeze({
  obligation: Object.freeze({
    logical: 'mwf_obligation', schema: 'mwf_Obligation', display: 'Obligation', plural: 'Obligations', ownership: 'UserOwned', audit: true,
    description: 'One obligation of one contract: what a party owes, by when, and its state. Overdue is not stored: it is derived (Open and due before now).',
    primaryDescription: 'The obligation in a few words (this is the description of the obligation).',
  }),
  alertlog: Object.freeze({
    logical: 'mwf_alertlog', schema: 'mwf_AlertLog', display: 'Alert Log', plural: 'Alert Logs', ownership: 'OrganizationOwned', audit: false,
    description: 'Service table: one row per alert already claimed by the alert flow (written BEFORE the email is sent). No project role has any privilege on it; deleting a row would send its alert again.',
    primaryDescription: 'Copy of the alert key, for people only; the alert key column is the one that counts.',
  }),
});

const FOUR_NO_CASCADE = { Assign: 'NoCascade', Merge: 'NoCascade', Reparent: 'NoCascade', Share: 'NoCascade', Unshare: 'NoCascade', RollupView: 'NoCascade' };

/** Columns in creation order. kind: string | picklist | datetime | lookup. The primary name column (mwf_name) is part of the table body, not listed here. */
export const COLUMNS = Object.freeze([
  Object.freeze({ table: 'mwf_obligation', kind: 'lookup', logical: 'mwf_contract', schema: 'mwf_Contract', display: 'Contract', required: 'ApplicationRequired', audit: true,
    description: 'The contract this obligation belongs to. Deleting the contract deletes its obligations.',
    referenced: 'mwf_contract', relationship: 'mwf_contract_obligation', delete: 'Cascade' }),
  Object.freeze({ table: 'mwf_obligation', kind: 'picklist', logical: 'mwf_party', schema: 'mwf_Party', display: 'Party', required: 'ApplicationRequired', audit: true,
    description: 'Which party owes the obligation: the first party or the second party of the contract.', options: PARTY }),
  Object.freeze({ table: 'mwf_obligation', kind: 'datetime', logical: 'mwf_duedate', schema: 'mwf_DueDate', display: 'Due Date', required: 'ApplicationRequired', audit: true,
    description: 'The final date by which the obligation is due, entered by hand as a final date (no working-day calendar). Date and Time, stored in UTC.' }),
  Object.freeze({ table: 'mwf_obligation', kind: 'picklist', logical: 'mwf_status', schema: 'mwf_Status', display: 'Obligation Status', required: 'ApplicationRequired', audit: true,
    description: 'Open, Done or Disputed. Overdue is not a value: it is derived (Open and due before now). A Disputed obligation is not alerted.', options: OBLIGATION_STATUS, defaultValue: OBLIGATION_STATUS.Open }),
  Object.freeze({ table: 'mwf_alertlog', kind: 'string', logical: 'mwf_alertkey', schema: 'mwf_AlertKey', display: 'Alert Key', required: 'ApplicationRequired', audit: false, maxLength: 100,
    description: '<source GUID>-<TYPE>-<yyyyMMdd>, built by scripts/lib/alert-key.mjs. Never empty. The date is the due date or the expiry date, so a changed date arms the alert again. Alternate key.' }),
]);

/** The alternate key. Its index is built asynchronously (Pending, In Progress, Active, Failed): nothing may rely on it before it is Active. */
export const KEYS = Object.freeze([
  Object.freeze({ table: 'mwf_alertlog', schema: 'mwf_AlertLogKey', display: 'Alert Log Key', attributes: Object.freeze(['mwf_alertkey']) }),
]);

const lbl = (text) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: 1033 }] });
const reqLevel = (v) => ({ Value: v, CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const auditFlag = (on) => ({ Value: on, CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyauditsettings' });

/** The creation body of a table, with its primary name column. Audit is set in the creation request. */
export function tableBody(t) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata', SchemaName: t.schema,
    DisplayName: lbl(t.display), DisplayCollectionName: lbl(t.plural), Description: lbl(t.description),
    OwnershipType: t.ownership, IsActivity: false, HasActivities: false, HasNotes: false, IsAuditEnabled: auditFlag(t.audit),
    Attributes: [{
      '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' },
      SchemaName: 'mwf_Name', DisplayName: lbl('Name'), Description: lbl(t.primaryDescription),
      RequiredLevel: reqLevel('ApplicationRequired'), FormatName: { Value: 'Text' }, MaxLength: 200, IsPrimaryName: true, IsAuditEnabled: auditFlag(t.audit),
    }],
  };
}

/** The creation body of a string, picklist or datetime column (a lookup is created with lookupBody). */
export function columnBody(c) {
  const common = { SchemaName: c.schema, LogicalName: c.logical, DisplayName: lbl(c.display), Description: lbl(c.description), RequiredLevel: reqLevel(c.required), IsAuditEnabled: auditFlag(c.audit) };
  if (c.kind === 'string') return { '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' }, ...common, FormatName: { Value: 'Text' }, MaxLength: c.maxLength };
  if (c.kind === 'datetime') return { '@odata.type': 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata', ...common, Format: 'DateAndTime', DateTimeBehavior: { Value: 'UserLocal' } };
  if (c.kind === 'picklist') {
    const body = { '@odata.type': 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata', ...common,
      OptionSet: { '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata', IsGlobal: false, OptionSetType: 'Picklist', Options: Object.entries(c.options).map(([l, v]) => ({ Value: v, Label: lbl(l) })) } };
    if (c.defaultValue !== undefined) body.DefaultFormValue = c.defaultValue;
    return body;
  }
  throw new Error(`columnBody: kind ${c.kind} is not a plain column`);
}

/** The creation body of a lookup relationship (the lookup column is created with it). */
export function lookupBody(c) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata', SchemaName: c.relationship, ReferencedEntity: c.referenced, ReferencingEntity: c.table,
    CascadeConfiguration: { ...FOUR_NO_CASCADE, Delete: c.delete },
    Lookup: { '@odata.type': 'Microsoft.Dynamics.CRM.LookupAttributeMetadata', SchemaName: c.schema, DisplayName: lbl(c.display), Description: lbl(c.description), RequiredLevel: reqLevel(c.required), IsAuditEnabled: auditFlag(c.audit) },
  };
}

export const keyBody = (k) => ({ SchemaName: k.schema, DisplayName: lbl(k.display), KeyAttributes: [...k.attributes] });

/** The order of creation: table, then its columns (a lookup after the table it points to exists), then the key. */
export function creationOrder() {
  const steps = [];
  for (const t of Object.values(TABLES)) {
    steps.push({ step: 'table', table: t.logical });
    for (const c of COLUMNS.filter((x) => x.table === t.logical)) steps.push({ step: c.kind === 'lookup' ? 'lookup' : 'column', table: t.logical, logical: c.logical });
    for (const k of KEYS.filter((x) => x.table === t.logical)) steps.push({ step: 'key', table: t.logical, schema: k.schema });
  }
  return steps;
}

/** What `--mode=plan` prints: exactly what the apply mode would create. Pure. @returns {string[]} */
export function planLines() {
  const L = [];
  for (const t of Object.values(TABLES)) {
    L.push(`TABLE ${t.logical} (${t.schema}) "${t.display}" / "${t.plural}": ${t.ownership}, no notes, no activities, table audit ${t.audit ? 'ON' : 'OFF'}, in the solution`);
    L.push(`    ${t.description}`);
    L.push(`  COLUMN ${t.logical}.mwf_name (primary name) String 200, required level ApplicationRequired, audit ${t.audit ? 'ON' : 'OFF'}`);
    for (const c of COLUMNS.filter((x) => x.table === t.logical)) {
      let shape;
      if (c.kind === 'lookup') shape = `Lookup to ${c.referenced}, relationship ${c.relationship}, DELETE ${c.delete}, assign/share/reparent NoCascade`;
      else if (c.kind === 'string') shape = `String ${c.maxLength}, text`;
      else if (c.kind === 'datetime') shape = 'Date and Time, user local behavior (stored in UTC, as mwf_decidedon)';
      else shape = `Choice (local) ${Object.entries(c.options).map(([l, v]) => `${l}=${v}`).join(', ')}${c.defaultValue !== undefined ? `; default ${Object.entries(c.options).find(([, v]) => v === c.defaultValue)[0]}` : ''}`;
      L.push(`  COLUMN ${c.table}.${c.logical} (${c.schema}) "${c.display}": ${shape}; required level ${c.required}; audit ${c.audit ? 'ON' : 'OFF'}`);
      L.push(`      ${c.description}`);
    }
    for (const k of KEYS.filter((x) => x.table === t.logical)) L.push(`  KEY ${k.schema} on (${k.attributes.join(', ')}) "${k.display}"; the index is built asynchronously, the script waits for Active`);
  }
  L.push('NOT created by this script: any security role or privilege (no project role gets anything on mwf_alertlog; the roles for mwf_obligation are not designed yet, ADR-011 open question).');
  return L;
}

const text = (l) => l?.LocalizedLabels?.[0]?.Label ?? l?.UserLocalizedLabel?.Label;
const TYPE = { string: 'String', picklist: 'Picklist', datetime: 'DateTime', lookup: 'Lookup' };

/** Read-back checks of one table: { name, ok, got }[]. md = the table metadata; attrs = [{LogicalName, AttributeType, RequiredLevel, IsAuditEnabled, MaxLength?}]. */
export function tableChecks(t, md, attrs) {
  const out = [
    { name: `${t.logical}: ownership ${t.ownership}`, ok: md?.OwnershipType === t.ownership, got: md?.OwnershipType },
    { name: `${t.logical}: no notes, no activities`, ok: md?.HasNotes === false && md?.HasActivities === false, got: `${md?.HasNotes}/${md?.HasActivities}` },
    { name: `${t.logical}: table audit ${t.audit ? 'ON' : 'OFF'}`, ok: md?.IsAuditEnabled?.Value === t.audit, got: md?.IsAuditEnabled?.Value },
  ];
  const by = Object.fromEntries((attrs || []).map((a) => [a.LogicalName, a]));
  const cols = [{ logical: 'mwf_name', kind: 'string', required: 'ApplicationRequired', audit: t.audit }, ...COLUMNS.filter((c) => c.table === t.logical)];
  for (const c of cols) {
    const a = by[c.logical];
    out.push({ name: `${t.logical}.${c.logical}: ${TYPE[c.kind]}, ${c.required}, audit ${c.audit ? 'ON' : 'OFF'}`, ok: !!a && a.AttributeType === TYPE[c.kind] && a.RequiredLevel?.Value === c.required && a.IsAuditEnabled?.Value === c.audit,
      got: a ? `${a.AttributeType}, ${a.RequiredLevel?.Value}, audit ${a.IsAuditEnabled?.Value}` : 'missing' });
  }
  return out;
}

/** Checks of the Choice options of one picklist column read back: { name, ok, got }. */
export function optionChecks(c, md) {
  const got = Object.fromEntries((md?.OptionSet?.Options || []).map((o) => [text(o.Label), o.Value]));
  const out = [{ name: `${c.table}.${c.logical}: local option set with exactly ${Object.keys(c.options).length} values`, ok: md?.OptionSet?.IsGlobal === false && JSON.stringify(got) === JSON.stringify(c.options), got: md?.OptionSet?.IsGlobal ? 'GLOBAL' : JSON.stringify(got) }];
  if (c.defaultValue !== undefined) out.push({ name: `${c.table}.${c.logical}: default value ${c.defaultValue}`, ok: md?.DefaultFormValue === c.defaultValue, got: md?.DefaultFormValue });
  return out;
}

/** Checks of the lookups read back from ManyToOneRelationships. */
export function lookupChecks(c, rels) {
  const r = (rels || []).find((x) => x.ReferencingAttribute === c.logical);
  const cc = r?.CascadeConfiguration;
  return [{ name: `${c.table}.${c.logical} -> ${c.referenced}, delete ${c.delete}, no other cascade`, ok: !!r && r.ReferencedEntity === c.referenced && cc?.Delete === c.delete && cc?.Assign === 'NoCascade' && cc?.Share === 'NoCascade' && cc?.Reparent === 'NoCascade',
    got: r ? `${r.ReferencedEntity}, delete ${cc?.Delete}` : 'missing' }];
}

/** The gate of every script and flow run that touches mwf_alertlog: only Active passes. @returns {{ok:boolean, status:string, why:string}} */
export function keyGate(keys, schema = KEYS[0].schema) {
  const k = (keys || []).find((x) => x.SchemaName === schema);
  if (!k) return { ok: false, status: 'missing', why: `the alternate key ${schema} does not exist` };
  const status = k.EntityKeyIndexStatus;
  if (status === 'Active') return { ok: true, status, why: 'the key index is Active' };
  if (status === 'Failed') return { ok: false, status, why: 'the key index Failed (ReactivateEntityKey exists; not used by this project yet)' };
  return { ok: false, status: String(status), why: `the key index is ${status}, not Active: uniqueness is not in effect yet` };
}

/** Checks of the key read back: attributes and Active. */
export function keyChecks(k, keys) {
  const found = (keys || []).find((x) => x.SchemaName === k.schema);
  const same = !!found && JSON.stringify([...(found.KeyAttributes || [])].sort()) === JSON.stringify([...k.attributes].sort());
  const g = keyGate(keys, k.schema);
  return [
    { name: `${k.table} key ${k.schema} on (${k.attributes.join(', ')})`, ok: same, got: found ? (found.KeyAttributes || []).join(', ') : 'missing' },
    { name: `${k.table} key ${k.schema}: EntityKeyIndexStatus == Active`, ok: g.ok, got: g.status },
  ];
}

/** Entries shaped like COLUMN_ENABLE of lib/auditing.mjs for the audited table (Obligation): created with audit ON, listed so `configure-auditing --mode=verify` can cover them AFTER the tables exist. Not appended automatically. */
export const AUDIT_TABLE_ENTRIES = Object.freeze(['mwf_obligation']);
