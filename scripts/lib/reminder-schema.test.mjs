import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COLUMNS, TABLE, columnBody, planFor, checksFor, onlyAuditFails, AUDIT_PLAN_ENTRIES } from './reminder-schema.mjs';

const SCRIPT = fileURLToPath(new URL('../add-reminder-columns.mjs', import.meta.url));

// what the metadata would read back for a column created with columnBody
const readBackOf = (spec) => {
  const b = columnBody(spec);
  const l = (x) => ({ LocalizedLabels: x.LocalizedLabels });
  return { LogicalName: b.LogicalName, AttributeType: 'DateTime', Format: b.Format, DateTimeBehavior: b.DateTimeBehavior, RequiredLevel: { Value: 'None' },
    DisplayName: l(b.DisplayName), Description: l(b.Description), IsCustomAttribute: true, IsValidForCreate: true, IsValidForUpdate: true, IsAuditEnabled: { Value: true } };
};

test('the table and the two columns are the ones of ADR-010', () => {
  assert.equal(TABLE, 'mwf_approvalstep');
  assert.deepEqual(COLUMNS.map((c) => c.logical), ['mwf_remindedon', 'mwf_escalatedon']);
  assert.deepEqual(COLUMNS.map((c) => c.schema), ['mwf_RemindedOn', 'mwf_EscalatedOn']);
  assert.ok(Object.isFrozen(COLUMNS));
});

test('the creation body: Date and Time, user local like mwf_decidedon, not required, audit ON, no other audit-relevant setting', () => {
  for (const c of COLUMNS) {
    const b = columnBody(c);
    assert.equal(b['@odata.type'], 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata');
    assert.equal(b.SchemaName, c.schema); assert.equal(b.LogicalName, c.logical);
    assert.equal(b.Format, 'DateAndTime');
    assert.deepEqual(b.DateTimeBehavior, { Value: 'UserLocal' });
    assert.equal(b.RequiredLevel.Value, 'None');
    assert.equal(b.IsAuditEnabled.Value, true);
    assert.equal(b.DisplayName.LocalizedLabels[0].Label, c.display);
    assert.equal(b.Description.LocalizedLabels[0].LanguageCode, 1033);
  }
});

test('the descriptions say that the value is written BEFORE sending (claim-first), and no description holds an id or an address', () => {
  for (const c of COLUMNS) {
    assert.match(c.description, /BEFORE/);
    assert.doesNotMatch(c.description, /[0-9a-f]{8}-[0-9a-f]{4}|https?:|@/i);
  }
});

test('planFor: create what is missing, verify what exists (idempotent), case-insensitive', () => {
  assert.deepEqual(planFor([]).map((p) => p.action), ['create', 'create']);
  assert.deepEqual(planFor(['mwf_remindedon', 'name']).map((p) => p.action), ['verify', 'create']);
  assert.deepEqual(planFor(['MWF_REMINDEDON', 'mwf_escalatedon']).map((p) => p.action), ['verify', 'verify']);
  assert.deepEqual(planFor(undefined).map((p) => p.action), ['create', 'create']);
});

test('checksFor: a column that reads back as requested passes every check', () => {
  for (const c of COLUMNS) {
    const checks = checksFor(c, readBackOf(c));
    assert.equal(checks.length, 10);
    assert.ok(checks.every((x) => x.ok), JSON.stringify(checks.filter((x) => !x.ok)));
  }
});

test('checksFor: every check can fail on its own', () => {
  const c = COLUMNS[0];
  const base = readBackOf(c);
  const breaks = {
    'logical name': { ...base, LogicalName: 'x' },
    'type DateTime': { ...base, AttributeType: 'String' },
    'format DateAndTime': { ...base, Format: 'DateOnly' },
    'behavior UserLocal (same as mwf_decidedon)': { ...base, DateTimeBehavior: { Value: 'TimeZoneIndependent' } },
    'required level None': { ...base, RequiredLevel: { Value: 'ApplicationRequired' } },
    'custom column': { ...base, IsCustomAttribute: false },
    'valid for create and update': { ...base, IsValidForUpdate: false },
    'audit ON': { ...base, IsAuditEnabled: { Value: false } },
  };
  for (const [name, md] of Object.entries(breaks)) {
    const failed = checksFor(c, md).filter((x) => !x.ok).map((x) => x.name);
    assert.deepEqual(failed, [name]);
  }
  assert.ok(checksFor(c, { ...base, DisplayName: { LocalizedLabels: [{ Label: 'Other' }] } }).some((x) => !x.ok && x.name.startsWith('display name')));
  assert.ok(checksFor(c, null).some((x) => !x.ok));
});

test('onlyAuditFails is true only when the audit flag is the single failure (then the answer is configure-auditing, never a PUT here)', () => {
  const c = COLUMNS[1];
  const base = readBackOf(c);
  assert.equal(onlyAuditFails(checksFor(c, base)), false);
  assert.equal(onlyAuditFails(checksFor(c, { ...base, IsAuditEnabled: { Value: false } })), true);
  assert.equal(onlyAuditFails(checksFor(c, { ...base, IsAuditEnabled: { Value: false }, Format: 'DateOnly' })), false);
});

test('AUDIT_PLAN_ENTRIES have the shape of COLUMN_ENABLE (table, column, reason) for the two columns', () => {
  assert.deepEqual(AUDIT_PLAN_ENTRIES.map((e) => `${e.table}.${e.column}`), ['mwf_approvalstep.mwf_remindedon', 'mwf_approvalstep.mwf_escalatedon']);
  assert.ok(AUDIT_PLAN_ENTRIES.every((e) => typeof e.reason === 'string' && e.reason.length > 10));
});

test('the script in its default mode prints a plan, needs no --env, sends nothing and exits 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PLAN \(offline, nothing is sent\)/);
  assert.match(r.stdout, /mwf_remindedon/);
  assert.match(r.stdout, /mwf_escalatedon/);
  assert.match(r.stdout, /audit ON/);
  assert.match(r.stdout, /Nothing was written/);
});

test('--mode=apply without --confirm-mutates-environment refuses before any sign-in, and an unknown mode is refused', () => {
  const apply = spawnSync(process.execPath, [SCRIPT, '--mode=apply', '--env=https://example.invalid'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(apply.status, 2);
  assert.match(apply.stderr, /--confirm-mutates-environment/);
  assert.match(apply.stderr, /Nothing was run/);
  const bad = spawnSync(process.execPath, [SCRIPT, '--mode=delete'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(bad.status, 2);
  const noEnv = spawnSync(process.execPath, [SCRIPT, '--mode=check'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(noEnv.status, 2);
  assert.match(noEnv.stderr, /--env/);
});

import { COLUMN_ENABLE } from './auditing.mjs';

test('since 2026-10-26 the two columns are in the audit plan, so configure-auditing --mode=verify covers them', () => {
  for (const e of AUDIT_PLAN_ENTRIES) assert.ok(COLUMN_ENABLE.some((x) => x.table === e.table && x.column === e.column), e.column);
});
