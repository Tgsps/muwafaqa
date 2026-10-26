/**
 * The two columns that reminders and escalation need on mwf_approvalstep (ADR-010, status Proposed). Pure parts only: the
 * definitions, the request bodies and the read-back checks. The script that uses them is scripts/add-reminder-columns.mjs.
 * No id, address or token is written by this module.
 *
 * Audit: both columns are created WITH IsAuditEnabled = true in the creation request (as scripts/add-approvalround-column.mjs
 * does). Nothing here changes a column definition afterwards: a PUT of a column definition is not used (ADR-009: the no-op PUT of
 * a column changes ModifiedOn, and a whole-definition PUT can change more than the audit flag). If a column ever reads back with
 * audit OFF, the only way this project changes it is scripts/configure-auditing.mjs (its saved-definition + deep-diff procedure).
 */

export const TABLE = 'mwf_approvalstep';

/** The columns, in creation order. Same type and behavior as mwf_decidedon (Date and Time, user local, stored in UTC). */
export const COLUMNS = Object.freeze([
  Object.freeze({
    logical: 'mwf_remindedon',
    schema: 'mwf_RemindedOn',
    display: 'Reminded On',
    description: 'When the reminder for this waiting step was claimed by the reminder flow (written BEFORE the reminder is sent). Empty = no reminder yet.',
    reason: 'the only record that a reminder was sent for the step; at most one write per step',
  }),
  Object.freeze({
    logical: 'mwf_escalatedon',
    schema: 'mwf_EscalatedOn',
    display: 'Escalated On',
    description: 'When the escalation notice for this waiting step was claimed by the reminder flow (written BEFORE the notice is sent). Empty = not escalated.',
    reason: 'the only record that an escalation notice was sent for the step; at most one write per step',
  }),
]);

const lbl = (text) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: 1033 }] });

/** The body of the creation request for one column. Audit is ON at creation. */
export function columnBody(spec) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata',
    SchemaName: spec.schema,
    LogicalName: spec.logical,
    DisplayName: lbl(spec.display),
    Description: lbl(spec.description),
    RequiredLevel: { Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
    Format: 'DateAndTime',
    DateTimeBehavior: { Value: 'UserLocal' },
    IsAuditEnabled: { Value: true, CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyauditsettings' },
  };
}

/** What to do for each column given the logical names that exist on the table. */
export function planFor(existingLogicalNames) {
  const have = new Set((existingLogicalNames || []).map((n) => String(n).toLowerCase()));
  return COLUMNS.map((c) => ({ logical: c.logical, action: have.has(c.logical) ? 'verify' : 'create' }));
}

/** The expected-state checks for a column read back from the metadata. @returns {{name:string, ok:boolean, got:any}[]} */
export function checksFor(spec, md) {
  const text = (l) => l?.LocalizedLabels?.[0]?.Label ?? l?.UserLocalizedLabel?.Label;
  return [
    { name: 'logical name', ok: md?.LogicalName === spec.logical, got: md?.LogicalName },
    { name: 'type DateTime', ok: md?.AttributeType === 'DateTime', got: md?.AttributeType },
    { name: 'format DateAndTime', ok: md?.Format === 'DateAndTime', got: md?.Format },
    { name: 'behavior UserLocal (same as mwf_decidedon)', ok: md?.DateTimeBehavior?.Value === 'UserLocal', got: md?.DateTimeBehavior?.Value },
    { name: 'required level None', ok: md?.RequiredLevel?.Value === 'None', got: md?.RequiredLevel?.Value },
    { name: `display name "${spec.display}"`, ok: text(md?.DisplayName) === spec.display, got: text(md?.DisplayName) },
    { name: 'description as specified', ok: text(md?.Description) === spec.description, got: text(md?.Description) === spec.description ? 'yes' : text(md?.Description) },
    { name: 'custom column', ok: md?.IsCustomAttribute === true, got: md?.IsCustomAttribute },
    { name: 'valid for create and update', ok: md?.IsValidForCreate === true && md?.IsValidForUpdate === true, got: `${md?.IsValidForCreate}/${md?.IsValidForUpdate}` },
    { name: 'audit ON', ok: md?.IsAuditEnabled?.Value === true, got: md?.IsAuditEnabled?.Value },
  ];
}

/** True when the only failing check is the audit flag (then the answer is configure-auditing.mjs, never a PUT from this script). */
export function onlyAuditFails(checks) {
  const bad = checks.filter((c) => !c.ok);
  return bad.length === 1 && bad[0].name === 'audit ON';
}

/** Entries shaped like COLUMN_ENABLE of lib/auditing.mjs, to append there AFTER the columns exist (so `configure-auditing --mode=verify` covers them). */
export const AUDIT_PLAN_ENTRIES = Object.freeze(COLUMNS.map((c) => Object.freeze({ table: TABLE, column: c.logical, reason: c.reason })));
