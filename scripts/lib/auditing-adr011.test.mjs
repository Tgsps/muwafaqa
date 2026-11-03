// The two column audit settings of ADR-011 in scripts/configure-auditing.mjs: pure parts and the refusals before any sign-in. Nothing here talks to an environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COLUMN_AUDIT_TARGETS, COLUMN_ENABLE, AUDIT_TABLES, auditTargetValue, auditChange, auditTargetPlanLines, setAuditValue, diffDeep, unexpectedDiffs, stripForPut, auditRowsPath, AUDIT_SELECT } from './auditing.mjs';

const SCRIPT = fileURLToPath(new URL('../configure-auditing.mjs', import.meta.url));
const SRC = fs.readFileSync(SCRIPT, 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', timeout: 30000 });
const prop = (value, canBeChanged = true) => ({ Value: value, CanBeChanged: canBeChanged, ManagedPropertyLogicalName: 'canmodifyauditsettings' });
const def = (value, canBeChanged = true) => ({ LogicalName: 'x', SchemaName: 'x', IsAuditEnabled: prop(value, canBeChanged), ModifiedOn: 'a', DisplayName: { LocalizedLabels: [{ Label: 'X' }] } });

test('exactly two ADR-011 targets: mwf_alertlog.mwf_name OFF and mwf_obligation.mwf_contract ON, each with a reason, frozen', () => {
  assert.deepEqual(COLUMN_AUDIT_TARGETS.map((t) => [t.table, t.column, t.value]), [['mwf_alertlog', 'mwf_name', false], ['mwf_obligation', 'mwf_contract', true]]);
  assert.ok(COLUMN_AUDIT_TARGETS.every((t) => t.reason.length > 20) && Object.isFrozen(COLUMN_AUDIT_TARGETS) && COLUMN_AUDIT_TARGETS.every(Object.isFrozen));
});

test('the targets are NOT part of the existing plan: not in COLUMN_ENABLE, and their tables are not in AUDIT_TABLES (the five audited tables are unchanged)', () => {
  for (const t of COLUMN_AUDIT_TARGETS) { assert.ok(!COLUMN_ENABLE.some((x) => x.table === t.table && x.column === t.column)); assert.ok(!AUDIT_TABLES.includes(t.table)); }
  assert.deepEqual(AUDIT_TABLES, ['mwf_approvalmatrix', 'mwf_approverassignment', 'mwf_counterparty', 'mwf_approvalstep', 'mwf_contract']);
});

test('auditTargetValue: true for every column of the existing plan, the explicit value for the two targets, undefined for anything else', () => {
  for (const c of COLUMN_ENABLE) assert.equal(auditTargetValue(c.table, c.column), true, c.column);
  assert.equal(auditTargetValue('mwf_alertlog', 'mwf_name'), false);
  assert.equal(auditTargetValue('mwf_obligation', 'mwf_contract'), true);
  for (const [t, c] of [['mwf_alertlog', 'mwf_alertkey'], ['mwf_obligation', 'mwf_name'], ['mwf_obligation', 'mwf_duedate'], ['mwf_alertlog', 'mwf_contract'], ['mwf_contract', 'mwf_name'], ['mwf_contract', 'mwf_value'], ['mwf_approvalstep', 'mwf_decision'], ['', ''], [undefined, undefined]]) assert.equal(auditTargetValue(t, c), undefined, `${t}.${c}`);
});

test('auditChange: nothing to do when the value already is the target (both directions), a change otherwise, blocked when CanBeChanged is false or the property is missing', () => {
  assert.deepEqual(auditChange(def(false), false), { action: 'none', now: false });
  assert.deepEqual(auditChange(def(true), true), { action: 'none', now: true });
  assert.deepEqual(auditChange(def(true), false), { action: 'change', now: true });
  assert.deepEqual(auditChange(def(false), true), { action: 'change', now: false });
  assert.equal(auditChange(def(true, false), false).action, 'blocked'); assert.match(auditChange(def(true, false), false).why, /CanBeChanged/);
  assert.equal(auditChange(def(false, false), false).action, 'none');   // already right: not blocked
  assert.equal(auditChange({}, true).action, 'blocked'); assert.equal(auditChange(null, true).action, 'blocked');
});

test('setting the value to FALSE changes only IsAuditEnabled.Value, does not mutate the original, and is refused when it cannot be changed (as for TRUE)', () => {
  const before = def(true); const copy = JSON.parse(JSON.stringify(before));
  const after = setAuditValue(before, false);
  assert.deepEqual(before, copy);
  const diffs = diffDeep(stripForPut(before), stripForPut(after));
  assert.deepEqual(diffs.map((d) => d.path), ['IsAuditEnabled.Value']); assert.deepEqual(unexpectedDiffs(diffs), []);
  const up = diffDeep(stripForPut(def(false)), stripForPut(setAuditValue(def(false), true)));
  assert.deepEqual(up.map((d) => d.path), ['IsAuditEnabled.Value']);
  assert.throws(() => setAuditValue(def(true, false), false), /cannot be changed/);
  assert.throws(() => setAuditValue({}, false), /no IsAuditEnabled/);
});

test('the offline plan names both targets with their values and says that nothing else is touched', () => {
  const t = auditTargetPlanLines().join('\n');
  assert.match(t, /mwf_alertlog\.mwf_name: IsAuditEnabled\.Value -> false/); assert.match(t, /mwf_obligation\.mwf_contract: IsAuditEnabled\.Value -> true/);
  assert.match(t, /no-op PUT/); assert.match(t, /PublishXml for mwf_alertlog/); assert.match(t, /PublishXml for mwf_obligation/); assert.match(t, /No other column, no table definition and no organization setting/);
  assert.doesNotMatch(t, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|https?:\/\/[a-z0-9-]+\.crm/i);
});

test('the script: --mode=plan runs offline (no --env, exit 0); only the two new columns are accepted besides the old plan; table-level work on the new tables is refused', () => {
  const p = run('--mode=plan'); assert.equal(p.status, 0, p.stderr); assert.match(p.stdout, /^PLAN \(offline, nothing is sent\)/); assert.match(p.stdout, /mwf_obligation\.mwf_contract/);
  for (const c of ['mwf_alertlog.mwf_alertkey', 'mwf_obligation.mwf_name', 'mwf_contract.mwf_name', 'mwf_alertlog.mwf_contract']) {
    const r = run('--env=https://example.invalid', '--mode=apply', `--column-list=${c}`, '--dry-run'); assert.equal(r.status, 2, c); assert.match(r.stderr, /not one of the columns of the plan/); assert.match(r.stderr, /Nothing was run/);
  }
  for (const t of ['mwf_obligation', 'mwf_alertlog']) { const r = run('--env=https://example.invalid', '--mode=apply', `--tables=${t}`, '--dry-run'); assert.equal(r.status, 2, t); assert.match(r.stderr, /not one of the audited tables/); }
});

test('the script: a write without --dry-run and without --confirm-mutates-environment is refused before any sign-in, for the new targets too', () => {
  const r = run('--env=https://example.invalid', '--mode=apply', '--column-list=mwf_obligation.mwf_contract,mwf_alertlog.mwf_name');
  assert.equal(r.status, 2); assert.match(r.stderr, /--confirm-mutates-environment/); assert.match(r.stderr, /Nothing was run|--dry-run/);
});

test('the script source: the value to set comes from auditTargetValue, a write still goes through write() with the PUT headers, and no delete exists', () => {
  assert.match(CODE, /auditTargetValue\(t, col\)/); assert.match(CODE, /applyDefinition\('attr', t, col, attributeCast\(a\.AttributeType\), value\)/);
  assert.match(CODE, /setAuditValue\(before, value\)/); assert.match(CODE, /colOn === value/);
  assert.doesNotMatch(CODE, /'DELETE'|\.del\(/);
  assert.doesNotMatch(CODE, /setAuditValue\(before, true\)/);
  assert.match(CODE, /if \(process\.argv\.includes\('--mode=plan'\)\)/);
});

test('auditRowsPath: the audit rows of given records, read only, same select as test-auditing; empty list and a non-GUID are refused', () => {
  const a = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'; const b = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
  const p = auditRowsPath([a, b]);
  assert.ok(p.startsWith(`audits?$select=${AUDIT_SELECT}&$filter=`)); assert.ok(p.endsWith('&$orderby=createdon asc&$top=500'));
  assert.equal(decodeURIComponent(/\$filter=([^&]*)/.exec(p)[1]), `_objectid_value eq ${a} or _objectid_value eq ${b}`);
  assert.match(AUDIT_SELECT, /_objectid_value/); assert.match(AUDIT_SELECT, /operation/);
  assert.throws(() => auditRowsPath([]), /at least one/); assert.throws(() => auditRowsPath(["x') or 1 eq 1"]), /not a GUID/); assert.throws(() => auditRowsPath(undefined), /at least one/);
});
