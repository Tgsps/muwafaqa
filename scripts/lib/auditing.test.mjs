import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_TABLES, EXCLUDED_TABLES, ORG_TARGET, COLUMN_ENABLE, COLUMN_EXCLUDE, SYSTEM_MUST_BE_ON, SYSTEM_LEFT_AS_IS, READ_PRIVILEGES, orgDiff, setAuditValue, stripForPut, diffDeep, unexpectedDiffs, attributeCast, publishXmlBody, PUT_HEADERS, columnPlan, tableMeetsTarget, operationName, actionName, changesOf, showsChange, visibleLagSeconds, describeRows } from './auditing.mjs';

const prop = (value, canBeChanged = true) => ({ Value: value, CanBeChanged: canBeChanged, ManagedPropertyLogicalName: 'canmodifyauditsettings' });

test('the target: five tables, the counter excluded, the agreed organization values', () => {
  assert.deepEqual(AUDIT_TABLES, ['mwf_approvalmatrix', 'mwf_approverassignment', 'mwf_counterparty', 'mwf_approvalstep', 'mwf_contract']);
  assert.ok(!AUDIT_TABLES.includes('mwf_contractnumbercounter'));
  assert.ok(EXCLUDED_TABLES.mwf_contractnumbercounter);
  assert.deepEqual({ ...ORG_TARGET }, { isauditenabled: true, auditretentionperiodv2: 365, isreadauditenabled: false, isuseraccessauditenabled: false });
});

test('the lowest-risk table (the matrix) comes first', () => assert.equal(AUDIT_TABLES[0], 'mwf_approvalmatrix'));

test('every column to enable and every exclusion belongs to an audited table, with a reason; no column is in both lists', () => {
  for (const c of [...COLUMN_ENABLE, ...COLUMN_EXCLUDE]) { assert.ok(AUDIT_TABLES.includes(c.table), c.column); assert.ok(c.reason.length > 10, c.column); }
  for (const e of COLUMN_ENABLE) assert.ok(!COLUMN_EXCLUDE.some((x) => x.table === e.table && x.column === e.column));
  assert.deepEqual(SYSTEM_MUST_BE_ON.filter((c) => SYSTEM_LEFT_AS_IS.includes(c)), []);
});

test('the two read privileges are the ones read from the metadata, at Organization depth', () => {
  assert.deepEqual(READ_PRIVILEGES.map((p) => [p.name, p.depth]), [['prvReadAuditSummary', 'Global'], ['prvReadRecordAuditHistory', 'Global']]);
});

test('orgDiff patches only what differs', () => {
  const now = { isauditenabled: false, auditretentionperiodv2: null, isreadauditenabled: false, isuseraccessauditenabled: false };
  assert.deepEqual(orgDiff(now).patch, { isauditenabled: true, auditretentionperiodv2: 365 });
  assert.equal(orgDiff({ ...ORG_TARGET }).same, true);
  assert.deepEqual(orgDiff({ ...ORG_TARGET, isreadauditenabled: true }).patch, { isreadauditenabled: false });
  assert.deepEqual(orgDiff({ ...ORG_TARGET, auditretentionperiodv2: 30 }).patch, { auditretentionperiodv2: 365 });
});

test('setAuditValue changes only IsAuditEnabled.Value, does not mutate, refuses what cannot change', () => {
  const def = { LogicalName: 'x', IsAuditEnabled: prop(false), Other: { a: [1, 2] } };
  const out = setAuditValue(def, true);
  assert.equal(out.IsAuditEnabled.Value, true); assert.equal(def.IsAuditEnabled.Value, false);
  assert.deepEqual(unexpectedDiffs(diffDeep(def, out)), []);
  assert.throws(() => setAuditValue({ IsAuditEnabled: prop(false, false) }, true), /cannot be changed/);
  assert.throws(() => setAuditValue({}, true), /no IsAuditEnabled/);
});

test('stripForPut removes the OData annotations of the read and nothing else', () => {
  const s = stripForPut({ '@odata.context': 'c', '@odata.etag': 'e', A: 1, B: { C: 2 } });
  assert.deepEqual(s, { A: 1, B: { C: 2 } });
});

test('diffDeep finds changes, additions, removals, array differences; equal values give none', () => {
  assert.deepEqual(diffDeep({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(diffDeep({ a: 1 }, { a: 2 }), [{ path: 'a', before: 1, after: 2 }]);
  assert.deepEqual(diffDeep({ a: 1 }, { a: 1, b: 2 }), [{ path: 'b', before: undefined, after: 2 }]);
  assert.deepEqual(diffDeep({ a: [1, 2] }, { a: [1, 3] }), [{ path: 'a[1]', before: 2, after: 3 }]);
  assert.equal(diffDeep({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })[0].path, 'a.b.c');
  assert.equal(diffDeep({ a: [] }, { a: {} }).length, 1);
});

test('unexpectedDiffs is empty only when IsAuditEnabled.Value is the one change', () => {
  const before = { IsAuditEnabled: prop(false), DisplayName: { LocalizedLabels: [{ Label: 'A' }] }, Privileges: [{ Name: 'p' }] };
  const ok = setAuditValue(before, true);
  assert.deepEqual(unexpectedDiffs(diffDeep(before, ok)), []);
  const bad = JSON.parse(JSON.stringify(ok)); bad.DisplayName.LocalizedLabels[0].Label = 'B';
  assert.deepEqual(unexpectedDiffs(diffDeep(before, bad)).map((d) => d.path), ['DisplayName.LocalizedLabels[0].Label']);
  const lost = JSON.parse(JSON.stringify(ok)); delete lost.Privileges;
  assert.ok(unexpectedDiffs(diffDeep(before, lost)).some((d) => d.path === 'Privileges'));
});

test('attributeCast maps the types of the design and refuses an unknown one', () => {
  assert.equal(attributeCast('Lookup'), 'Microsoft.Dynamics.CRM.LookupAttributeMetadata');
  assert.equal(attributeCast('Money'), 'Microsoft.Dynamics.CRM.MoneyAttributeMetadata');
  assert.throws(() => attributeCast('Mystery'));
});

test('PublishXml body and the MergeLabels header', () => {
  assert.equal(publishXmlBody('mwf_contract').ParameterXml, '<importexportxml><entities><entity>mwf_contract</entity></entities></importexportxml>');
  assert.equal(PUT_HEADERS['MSCRM.MergeLabels'], 'true');
});

test('columnPlan: enable the lookups that are off, count the ones already on, report blocked and missing, find a system column that is off', () => {
  const attrs = [
    { LogicalName: 'mwf_counterpartyid', IsAuditEnabled: prop(false) },
    { LogicalName: 'statuscode', IsAuditEnabled: prop(true) }, { LogicalName: 'ownerid', IsAuditEnabled: prop(true) },
  ];
  assert.deepEqual(columnPlan('mwf_contract', attrs), { enable: ['mwf_counterpartyid'], alreadyOn: [], blocked: [], missing: [], systemOff: [] });
  assert.deepEqual(columnPlan('mwf_contract', [{ LogicalName: 'mwf_counterpartyid', IsAuditEnabled: prop(true) }]).alreadyOn, ['mwf_counterpartyid']);
  assert.deepEqual(columnPlan('mwf_contract', [{ LogicalName: 'mwf_counterpartyid', IsAuditEnabled: prop(false, false) }]).blocked, ['mwf_counterpartyid']);
  assert.deepEqual(columnPlan('mwf_contract', []).missing, ['mwf_counterpartyid']);
  assert.deepEqual(columnPlan('mwf_contract', [{ LogicalName: 'mwf_counterpartyid', IsAuditEnabled: prop(true) }, { LogicalName: 'statuscode', IsAuditEnabled: prop(false) }]).systemOff, ['statuscode']);
  assert.deepEqual(columnPlan('mwf_approvalmatrix', []), { enable: [], alreadyOn: [], blocked: [], missing: [], systemOff: [] });   // nothing to enable on the matrix
});

test('tableMeetsTarget needs the table on and no pending column', () => {
  const on = { IsAuditEnabled: prop(true) }; const off = { IsAuditEnabled: prop(false) };
  assert.equal(tableMeetsTarget('mwf_approvalmatrix', on, []).ok, true);
  assert.equal(tableMeetsTarget('mwf_approvalmatrix', off, []).ok, false);
  assert.equal(tableMeetsTarget('mwf_contract', on, [{ LogicalName: 'mwf_counterpartyid', IsAuditEnabled: prop(false) }]).ok, false);
});

test('operation and action names, with a fallback that never invents a name', () => {
  assert.equal(operationName(1), 'Create'); assert.equal(operationName(3), 'Delete'); assert.equal(operationName(99), 'operation 99');
  assert.equal(actionName(41), 'Set State'); assert.equal(actionName(58), 'Remove Privileges From Role'); assert.equal(actionName(7), 'action 7');
});

test('changesOf and showsChange read Old/New values and ignore OData annotations', () => {
  const d = { OldValue: { '@odata.type': '#x', mwf_name: 'A', 'm@OData.Community.Display.V1.FormattedValue': 'x' }, NewValue: { '@odata.type': '#x', mwf_name: 'B', mwf_value: 5 } };
  assert.deepEqual(changesOf(d), { mwf_name: { old: 'A', new: 'B' }, mwf_value: { old: undefined, new: 5 } });
  assert.equal(showsChange(d, 'mwf_name', 'A', 'B'), true);
  assert.equal(showsChange(d, 'mwf_value', undefined, 5), true);
  assert.equal(showsChange(d, 'mwf_name', 'A', 'C'), false);
  assert.equal(showsChange(d, 'nope', undefined, undefined), false);
  assert.deepEqual(changesOf(undefined), {});
});

test('visibleLagSeconds', () => {
  assert.equal(visibleLagSeconds(1000, 31000), 30); assert.equal(visibleLagSeconds(1000, null), null); assert.equal(visibleLagSeconds(5000, 1000), 0);
});

test('describeRows orders by time and names the operation and the action', () => {
  const rows = [{ auditid: 'b', createdon: '2026-10-24T10:00:02Z', operation: 2, action: 2, _userid_value: 'u' }, { auditid: 'a', createdon: '2026-10-24T10:00:01Z', operation: 1, action: 1, _userid_value: 'u', _callinguserid_value: 'c' }];
  const d = describeRows(rows);
  assert.deepEqual(d.map((x) => x.id), ['a', 'b']); assert.deepEqual(d.map((x) => x.operation), ['Create', 'Update']); assert.equal(d[0].callinguserid, 'c'); assert.equal(d[1].callinguserid, null);
});

import { lagStats, classifyUser, unmetExpectations, pollFinished, noteNewRows, changeHistoryPath, auditDetailsPath } from './auditing.mjs';

test('lagStats: min, median, max, count; null for nothing', () => {
  assert.deepEqual(lagStats([30, 5, 10]), { count: 3, min: 5, median: 10, max: 30 });
  assert.equal(lagStats([]), null); assert.equal(lagStats(undefined), null);
  assert.equal(lagStats([null, 4]).count, 1);
});

test('classifyUser never uses names', () => {
  assert.equal(classifyUser('A', 'a'), 'admin'); assert.equal(classifyUser('s1', 'a', ['S1']), 'system'); assert.equal(classifyUser('x', 'a', ['s1']), 'other'); assert.equal(classifyUser(null, 'a'), 'none');
});

test('unmetExpectations counts rows per record and operation', () => {
  const rows = [{ _objectid_value: 'R1', operation: 1 }, { _objectid_value: 'r1', operation: 2 }, { _objectid_value: 'r1', operation: 2 }, { _objectid_value: 'r2', operation: 1 }];
  assert.deepEqual(unmetExpectations(rows, [{ objectid: 'r1', operation: 1 }, { objectid: 'r1', operation: 2, min: 2 }]), []);
  assert.deepEqual(unmetExpectations(rows, [{ objectid: 'r1', operation: 3, label: 'contract' }, { objectid: 'r2', operation: 2, min: 2 }]), ['contract: Delete 0/1', 'r2: Update 0/2']);
});

test('pollFinished: quiet and met, or timeout; never before both', () => {
  const base = { startedMs: 0, timeoutMs: 600000, quietMs: 60000 };
  assert.equal(pollFinished({ ...base, unmet: [], lastNewRowMs: 100000, nowMs: 120000 }).done, false);
  assert.deepEqual(pollFinished({ ...base, unmet: [], lastNewRowMs: 100000, nowMs: 160000 }), { done: true, why: 'all expectations met and quiet' });
  assert.equal(pollFinished({ ...base, unmet: ['x'], lastNewRowMs: 0, nowMs: 300000 }).done, false);
  assert.deepEqual(pollFinished({ ...base, unmet: ['x'], lastNewRowMs: 0, nowMs: 600000 }), { done: true, why: 'timeout' });
});

test('noteNewRows keeps the first moment a row was seen', () => {
  const seen = new Map();
  assert.equal(noteNewRows(seen, [{ auditid: 'a' }, { auditid: 'b' }], 1000).length, 2);
  assert.equal(noteNewRows(seen, [{ auditid: 'a' }, { auditid: 'c' }], 2000).length, 1);
  assert.equal(seen.get('a'), 1000); assert.equal(seen.get('c'), 2000);
});

test('the function paths follow the Learn forms', () => {
  const p = changeHistoryPath('mwf_contracts', 'ID1');
  assert.ok(p.startsWith('RetrieveRecordChangeHistory(Target=@target,PagingInfo=@paginginfo)?@target='));
  assert.equal(decodeURIComponent(p.split('@target=')[1].split('&@paginginfo=')[0]), JSON.stringify({ '@odata.id': 'mwf_contracts(ID1)' }));
  assert.deepEqual(JSON.parse(decodeURIComponent(p.split('&@paginginfo=')[1])), { PageNumber: 1, Count: 50, ReturnTotalRecordCount: true });
  assert.equal(auditDetailsPath('A1'), 'audits(A1)/Microsoft.Dynamics.CRM.RetrieveAuditDetails');
});
