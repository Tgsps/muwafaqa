import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TABLES, COLUMNS, KEYS, PARTY, OBLIGATION_STATUS, tableBody, columnBody, lookupBody, keyBody, creationOrder, planLines, tableChecks, optionChecks, lookupChecks, keyGate, keyChecks } from './obligation-schema.mjs';
import { MAX_KEY_LENGTH } from './alert-key.mjs';

const SCRIPT = fileURLToPath(new URL('../add-obligation-schema.mjs', import.meta.url));
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', timeout: 30000 });

const col = (l) => COLUMNS.find((c) => c.logical === l);

test('the two tables: names, ownership and audit flags as decided (Obligation audit ON, AlertLog audit OFF)', () => {
  assert.equal(TABLES.obligation.logical, 'mwf_obligation'); assert.equal(TABLES.obligation.audit, true);
  assert.equal(TABLES.alertlog.logical, 'mwf_alertlog'); assert.equal(TABLES.alertlog.audit, false);
  assert.equal(TABLES.alertlog.ownership, 'OrganizationOwned');
  assert.equal(TABLES.obligation.ownership, 'UserOwned');   // as its parent mwf_contract
  assert.ok(Object.isFrozen(TABLES) && Object.isFrozen(COLUMNS) && Object.isFrozen(KEYS));
});

test('Obligation columns: contract (required lookup, DELETE cascade), party, due date (Date and Time), status; no stored overdue column', () => {
  const o = COLUMNS.filter((c) => c.table === 'mwf_obligation');
  assert.deepEqual(o.map((c) => c.logical), ['mwf_contract', 'mwf_party', 'mwf_duedate', 'mwf_status']);
  assert.equal(col('mwf_contract').delete, 'Cascade'); assert.equal(col('mwf_contract').referenced, 'mwf_contract'); assert.equal(col('mwf_contract').required, 'ApplicationRequired');
  assert.deepEqual({ ...PARTY }, { 'First Party': 867640000, 'Second Party': 867640001 });
  assert.deepEqual({ ...OBLIGATION_STATUS }, { Open: 867640000, Done: 867640001, Disputed: 867640002 });
  assert.equal(col('mwf_status').defaultValue, OBLIGATION_STATUS.Open);
  assert.ok(!COLUMNS.some((c) => /overdue/i.test(c.logical)), 'overdue is derived, never stored');
  assert.ok(o.every((c) => c.audit === true && c.required === 'ApplicationRequired'));
});

test('AlertLog has exactly one custom column, mwf_alertkey: required string, audit OFF, as long as the key builder allows', () => {
  const a = COLUMNS.filter((c) => c.table === 'mwf_alertlog');
  assert.deepEqual(a.map((c) => c.logical), ['mwf_alertkey']);
  assert.equal(a[0].kind, 'string'); assert.equal(a[0].required, 'ApplicationRequired'); assert.equal(a[0].audit, false); assert.equal(a[0].maxLength, MAX_KEY_LENGTH);
});

test('exactly one alternate key, on mwf_alertkey of mwf_alertlog', () => {
  assert.equal(KEYS.length, 1);
  assert.equal(KEYS[0].table, 'mwf_alertlog'); assert.deepEqual([...KEYS[0].attributes], ['mwf_alertkey']);
  assert.deepEqual(keyBody(KEYS[0]).KeyAttributes, ['mwf_alertkey']);
});

test('table bodies carry the audit flag of the table and of the primary name; AlertLog is not audited', () => {
  const o = tableBody(TABLES.obligation); const a = tableBody(TABLES.alertlog);
  assert.equal(o.IsAuditEnabled.Value, true); assert.equal(a.IsAuditEnabled.Value, false);
  assert.equal(o.Attributes[0].IsAuditEnabled.Value, true); assert.equal(a.Attributes[0].IsAuditEnabled.Value, false);
  for (const b of [o, a]) { assert.equal(b.HasNotes, false); assert.equal(b.IsActivity, false); assert.equal(b.Attributes[0].IsPrimaryName, true); assert.equal(b.IsAuditEnabled.ManagedPropertyLogicalName, 'canmodifyauditsettings'); }
  assert.equal(o.OwnershipType, 'UserOwned'); assert.equal(a.OwnershipType, 'OrganizationOwned');
});

test('column bodies: Date and Time user local, Choice local with the values and the default, string length, audit flag per column', () => {
  const d = columnBody(col('mwf_duedate'));
  assert.equal(d['@odata.type'], 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata'); assert.equal(d.Format, 'DateAndTime'); assert.deepEqual(d.DateTimeBehavior, { Value: 'UserLocal' });
  const s = columnBody(col('mwf_status'));
  assert.equal(s.OptionSet.IsGlobal, false); assert.deepEqual(s.OptionSet.Options.map((x) => [x.Label.LocalizedLabels[0].Label, x.Value]), [['Open', 867640000], ['Done', 867640001], ['Disputed', 867640002]]);
  assert.equal(s.DefaultFormValue, 867640000);
  assert.equal(columnBody(col('mwf_party')).DefaultFormValue, undefined);
  const k = columnBody(col('mwf_alertkey'));
  assert.equal(k.MaxLength, 100); assert.equal(k.IsAuditEnabled.Value, false); assert.equal(k.RequiredLevel.Value, 'ApplicationRequired');
  assert.throws(() => columnBody(col('mwf_contract')), /not a plain column/);
});

test('the lookup body: to mwf_contract, DELETE cascade, assign, share, reparent, merge, unshare, rollup view do not cascade', () => {
  const b = lookupBody(col('mwf_contract'));
  assert.equal(b.ReferencedEntity, 'mwf_contract'); assert.equal(b.ReferencingEntity, 'mwf_obligation');
  assert.deepEqual(b.CascadeConfiguration, { Assign: 'NoCascade', Merge: 'NoCascade', Reparent: 'NoCascade', Share: 'NoCascade', Unshare: 'NoCascade', RollupView: 'NoCascade', Delete: 'Cascade' });
  assert.equal(b.Lookup.IsAuditEnabled.Value, true);
});

test('creation order: table first, then its columns, a key last; both tables', () => {
  const o = creationOrder();
  assert.deepEqual(o.map((s) => `${s.step}:${s.logical || s.schema || s.table}`), [
    'table:mwf_obligation', 'lookup:mwf_contract', 'column:mwf_party', 'column:mwf_duedate', 'column:mwf_status',
    'table:mwf_alertlog', 'column:mwf_alertkey', 'key:mwf_AlertLogKey']);
});

test('the plan lists every table, column and the key, says audit ON/OFF, and creates no security role', () => {
  const t = planLines().join('\n');
  for (const n of ['mwf_obligation', 'mwf_alertlog', 'mwf_duedate', 'mwf_status', 'mwf_party', 'mwf_alertkey', 'mwf_contract', 'mwf_AlertLogKey', 'DELETE Cascade', 'table audit ON', 'table audit OFF', 'Open=867640000, Done=867640001, Disputed=867640002', 'default Open']) assert.ok(t.includes(n), n);
  assert.match(t, /NOT created by this script: any security role or privilege/);
  assert.doesNotMatch(t, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|https?:|@/i);
});

// what the metadata would read back for the design
const attrsOf = (t) => [{ LogicalName: 'mwf_name', AttributeType: 'String', RequiredLevel: { Value: 'ApplicationRequired' }, IsAuditEnabled: { Value: t.audit } },
  ...COLUMNS.filter((c) => c.table === t.logical).map((c) => ({ LogicalName: c.logical, AttributeType: { string: 'String', picklist: 'Picklist', datetime: 'DateTime', lookup: 'Lookup' }[c.kind], RequiredLevel: { Value: c.required }, IsAuditEnabled: { Value: c.audit } }))];
const mdOf = (t) => ({ OwnershipType: t.ownership, HasNotes: false, HasActivities: false, IsAuditEnabled: { Value: t.audit } });

test('tableChecks: a table that reads back as designed passes; each deviation fails on its own', () => {
  for (const t of Object.values(TABLES)) {
    const ok = tableChecks(t, mdOf(t), attrsOf(t));
    assert.ok(ok.every((c) => c.ok), JSON.stringify(ok.filter((c) => !c.ok)));
  }
  const t = TABLES.alertlog;
  assert.ok(tableChecks(t, { ...mdOf(t), IsAuditEnabled: { Value: true } }, attrsOf(t)).some((c) => !c.ok && /table audit OFF/.test(c.name)));
  assert.ok(tableChecks(t, { ...mdOf(t), OwnershipType: 'UserOwned' }, attrsOf(t)).some((c) => !c.ok && /ownership/.test(c.name)));
  assert.ok(tableChecks(t, { ...mdOf(t), HasNotes: true }, attrsOf(t)).some((c) => !c.ok && /notes/.test(c.name)));
  const a = attrsOf(t); a[1].IsAuditEnabled = { Value: true };
  assert.ok(tableChecks(t, mdOf(t), a).some((c) => !c.ok && /mwf_alertkey/.test(c.name)));
  assert.ok(tableChecks(t, mdOf(t), a.slice(0, 1)).some((c) => !c.ok && c.got === 'missing'));
  const o = TABLES.obligation; const b = attrsOf(o); b[3].IsAuditEnabled = { Value: false };
  assert.ok(tableChecks(o, mdOf(o), b).some((c) => !c.ok && /mwf_duedate/.test(c.name)));
});

test('optionChecks and lookupChecks: as designed pass, a wrong value, a global set, a wrong default or a wrong cascade fail', () => {
  const c = col('mwf_status');
  const md = { OptionSet: { IsGlobal: false, Options: Object.entries(OBLIGATION_STATUS).map(([l, v]) => ({ Value: v, Label: { UserLocalizedLabel: { Label: l } } })) }, DefaultFormValue: 867640000 };
  assert.ok(optionChecks(c, md).every((x) => x.ok));
  assert.ok(optionChecks(c, { ...md, OptionSet: { ...md.OptionSet, IsGlobal: true } }).some((x) => !x.ok));
  assert.ok(optionChecks(c, { ...md, DefaultFormValue: 867640002 }).some((x) => !x.ok));
  assert.ok(optionChecks(c, { ...md, OptionSet: { IsGlobal: false, Options: md.OptionSet.Options.slice(1) } }).some((x) => !x.ok));
  const l = col('mwf_contract');
  const rel = { ReferencingAttribute: 'mwf_contract', ReferencedEntity: 'mwf_contract', CascadeConfiguration: { Delete: 'Cascade', Assign: 'NoCascade', Share: 'NoCascade', Reparent: 'NoCascade' } };
  assert.ok(lookupChecks(l, [rel]).every((x) => x.ok));
  assert.ok(lookupChecks(l, [{ ...rel, CascadeConfiguration: { ...rel.CascadeConfiguration, Delete: 'RemoveLink' } }]).some((x) => !x.ok));
  assert.ok(lookupChecks(l, [{ ...rel, CascadeConfiguration: { ...rel.CascadeConfiguration, Share: 'Cascade' } }]).some((x) => !x.ok));
  assert.ok(lookupChecks(l, []).some((x) => !x.ok));
});

test('keyGate: only Active passes; Pending, In Progress, Failed, a missing key and a missing status do not', () => {
  const k = (s) => [{ SchemaName: 'mwf_AlertLogKey', KeyAttributes: ['mwf_alertkey'], EntityKeyIndexStatus: s }];
  assert.equal(keyGate(k('Active')).ok, true);
  for (const s of ['Pending', 'InProgress', 'In Progress', 'Failed', undefined, null, 'active']) assert.equal(keyGate(k(s)).ok, false, String(s));
  assert.equal(keyGate([]).ok, false); assert.equal(keyGate(undefined).ok, false);
  assert.equal(keyGate([{ SchemaName: 'other', EntityKeyIndexStatus: 'Active' }]).ok, false);
  assert.match(keyGate(k('Failed')).why, /ReactivateEntityKey/);
  assert.match(keyGate(k('Pending')).why, /uniqueness is not in effect/);
});

test('keyChecks: right attributes and Active pass; Pending or another attribute fail', () => {
  const key = { SchemaName: 'mwf_AlertLogKey', KeyAttributes: ['mwf_alertkey'], EntityKeyIndexStatus: 'Active' };
  assert.ok(keyChecks(KEYS[0], [key]).every((x) => x.ok));
  assert.ok(keyChecks(KEYS[0], [{ ...key, EntityKeyIndexStatus: 'Pending' }]).some((x) => !x.ok && /Active/.test(x.name)));
  assert.ok(keyChecks(KEYS[0], [{ ...key, KeyAttributes: ['mwf_name'] }]).some((x) => !x.ok));
  assert.ok(keyChecks(KEYS[0], []).every((x) => !x.ok));
});

test('the script: the plan runs offline (exit 0) and prints the tables; the refusals come before any sign-in', () => {
  const p = run();
  assert.equal(p.status, 0, p.stderr); assert.match(p.stdout, /^PLAN \(offline, nothing is sent\)/); assert.match(p.stdout, /TABLE mwf_alertlog/); assert.match(p.stdout, /Nothing was written\.$/m);
  assert.equal(run('--mode=delete').status, 2);
  const noConfirm = run('--mode=apply', '--env=https://example.invalid'); assert.equal(noConfirm.status, 2); assert.match(noConfirm.stderr, /--confirm-mutates-environment/); assert.match(noConfirm.stderr, /Nothing was run/);
  const noEnv = run('--mode=verify', '--solution=TestSolution'); assert.equal(noEnv.status, 2); assert.match(noEnv.stderr, /--env/);
  assert.equal(run('--mode=apply', '--confirm-mutates-environment').status, 2);   // no --env
});

test('the script source: verify is read only (GET only), apply never PUTs, PATCHes or DELETEs, and creates no role or privilege', () => {
  const verify = CODE.slice(CODE.indexOf('async function verify()'), CODE.indexOf('(async () => {'));
  assert.doesNotMatch(verify, /'(POST|PUT|PATCH|DELETE)'|write\(/);
  assert.doesNotMatch(CODE, /'(PUT|PATCH|DELETE)'/);
  assert.doesNotMatch(CODE, /roleprivilege|AddPrivilegesRole|systemuserroles|\broles\b/i);
  assert.match(CODE, /requireStableConnection/);
  assert.match(SOURCE, /NOT RUN against any environment/);
});
