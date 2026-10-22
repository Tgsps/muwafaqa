import test from 'node:test';
import assert from 'node:assert/strict';
import { bulkPath, bulkBody, updateTarget, parseNumber, checkSequence, movedCounters, chainLengthFor, failureText, allFlowsOff } from './lib/bulk-messages.mjs';

test('bulkPath names the message on the entity set', () => {
  assert.equal(bulkPath('CreateMultiple'), 'mwf_contracts/Microsoft.Dynamics.CRM.CreateMultiple');
  assert.equal(bulkPath('UpdateMultiple'), 'mwf_contracts/Microsoft.Dynamics.CRM.UpdateMultiple');
});

test('bulkBody adds @odata.type to every target and does not mutate the input', () => {
  const input = [{ mwf_name: 'a' }, { mwf_name: 'b' }];
  const body = bulkBody(input);
  assert.equal(body.Targets.length, 2);
  assert.ok(body.Targets.every((t) => t['@odata.type'] === 'Microsoft.Dynamics.CRM.mwf_contract'));
  assert.equal(input[0]['@odata.type'], undefined);
});

test('bulkBody refuses an empty batch', () => {
  assert.throws(() => bulkBody([]));
  assert.throws(() => bulkBody(undefined));
});

test('updateTarget carries the primary key and only the changed columns', () => {
  assert.deepEqual(updateTarget('x', { statuscode: 5 }), { mwf_contractid: 'x', statuscode: 5 });
});

test('parseNumber', () => {
  assert.deepEqual(parseNumber('MNT-0012'), { prefix: 'MNT', n: 12 });
  assert.deepEqual(parseNumber('SLS-12345'), { prefix: 'SLS', n: 12345 });
  assert.equal(parseNumber('MNT-12'), null);
  assert.equal(parseNumber('MNT0012'), null);
  assert.equal(parseNumber(null), null);
});

test('checkSequence: consecutive numbers after the counter value', () => {
  const r = checkSequence(3, 'MNT', ['MNT-0004', 'MNT-0005']);
  assert.ok(r.ok && r.setOk && r.inOrder);
});

test('checkSequence: right set in a different order is ok as a set but not in order', () => {
  const r = checkSequence(3, 'MNT', ['MNT-0005', 'MNT-0004']);
  assert.ok(r.ok && r.setOk && !r.inOrder);
});

test('checkSequence: a gap, a duplicate or a wrong prefix fails', () => {
  assert.equal(checkSequence(3, 'MNT', ['MNT-0004', 'MNT-0006']).ok, false);
  assert.equal(checkSequence(3, 'MNT', ['MNT-0004', 'MNT-0004']).ok, false);
  assert.equal(checkSequence(3, 'MNT', ['PRC-0004']).ok, false);
  assert.equal(checkSequence(3, 'MNT', ['junk']).ok, false);
});

test('movedCounters lists only the types that changed', () => {
  const before = { 1: { last: 0 }, 2: { last: 4 } };
  assert.deepEqual(movedCounters(before, { 1: { last: 0 }, 2: { last: 5 } }), ['2']);
  assert.deepEqual(movedCounters(before, { 1: { last: 0 }, 2: { last: 4 } }), []);
  assert.deepEqual(movedCounters(before, { 1: { last: 0 } }), ['2']);
});

test('chainLengthFor follows the bands (min, max]', () => {
  const cases = [[0, 1], [5000, 1], [10000, 1], [10000.01, 2], [50000, 2], [50000.01, 3], [100000, 3], [100000.01, 5], [250000, 5]];
  for (const [v, n] of cases) assert.equal(chainLengthFor(v), n, String(v));
});

test('failureText is short and single line', () => {
  const t = failureText(400, 'line one\n   line two ' + 'x'.repeat(400));
  assert.ok(t.startsWith('HTTP 400: line one line two'));
  assert.ok(!t.includes('\n') && t.length < 200);
  assert.equal(failureText(204, ''), 'HTTP 204');
});

test('allFlowsOff: every row OFF, and an empty list is not accepted', () => {
  assert.equal(allFlowsOff([{ statecode: 0 }, { statecode: 0 }]), true);
  assert.equal(allFlowsOff([{ statecode: 0 }, { statecode: 1 }]), false);
  assert.equal(allFlowsOff([]), false);
  assert.equal(allFlowsOff(undefined), false);
});
