import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalFlowState, describeFlowState, requireFlowOff } from './contract-cleanup.mjs';

const NAME = (v) => `Muwafaqa - Contract Approval ${v}`;
const ioOf = (rows, ok = true, message) => ({ get: async () => ({ ok, status: ok ? 200 : 503, json: ok ? { value: rows } : null, message }) });

test('one row: v2 alone, OFF', async () => {
  const f = await approvalFlowState(ioOf([{ name: NAME('v2'), statecode: 0 }]));
  assert.equal(f.known, true); assert.equal(f.on, false); assert.equal(f.onCount, 0); assert.equal(f.count, 1); assert.equal(f.state, 0);
  assert.deepEqual(f.flows, [{ label: 'v2', on: false }]);
  assert.equal(describeFlowState(f), '1 flow row: v2 OFF');
});

test('one row: v2 alone, ON', async () => {
  const f = await approvalFlowState(ioOf([{ name: NAME('v2'), statecode: 1 }]));
  assert.deepEqual([f.known, f.on, f.onCount, f.state], [true, true, 1, 1]);
  assert.equal(describeFlowState(f), '1 flow row: v2 ON');
});

test('two rows are read truthfully, not as "not known" (the old behavior)', async () => {
  const f = await approvalFlowState(ioOf([{ name: NAME('v1'), statecode: 0 }, { name: NAME('v2'), statecode: 0 }]));
  assert.deepEqual([f.known, f.on, f.count, f.onCount], [true, false, 2, 0]);
  assert.equal(describeFlowState(f), '2 flow rows: v1 OFF, v2 OFF');
});

test('two rows: any ON makes the state ON, and onCount says how many (both ON = 2)', async () => {
  let f = await approvalFlowState(ioOf([{ name: NAME('v1'), statecode: 0 }, { name: NAME('v2'), statecode: 1 }]));
  assert.deepEqual([f.known, f.on, f.onCount], [true, true, 1]);
  f = await approvalFlowState(ioOf([{ name: NAME('v1'), statecode: 1 }, { name: NAME('v2'), statecode: 1 }]));
  assert.deepEqual([f.on, f.onCount], [true, 2]);
});

test('no row: not known, with the reason (silence is never read as OFF)', async () => {
  const f = await approvalFlowState(ioOf([]));
  assert.deepEqual([f.known, f.on, f.count], [false, false, 0]);
  assert.match(f.reason, /no approval flow row/);
  assert.match(describeFlowState(f), /^not known: no approval flow row/);
});

test('a failed read: not known, with the reason and the message', async () => {
  const f = await approvalFlowState(ioOf(null, false, 'HTTP 503'));
  assert.equal(f.known, false);
  assert.match(f.reason, /could not be read \(HTTP 503\)/);
});

test('a name without a version suffix keeps its whole name as the label', async () => {
  const f = await approvalFlowState(ioOf([{ name: 'Contract Approval X', statecode: 0 }]));
  assert.equal(f.flows[0].label, 'Contract Approval X');
});

test('requireFlowOff: passes with every row OFF (one or two), stops when any is ON', async () => {
  await requireFlowOff(ioOf([{ name: NAME('v2'), statecode: 0 }]));
  await requireFlowOff(ioOf([{ name: NAME('v1'), statecode: 0 }, { name: NAME('v2'), statecode: 0 }]));
  await assert.rejects(requireFlowOff(ioOf([{ name: NAME('v1'), statecode: 0 }, { name: NAME('v2'), statecode: 1 }])), /An approval flow is ON \(2 flow rows: v1 OFF, v2 ON\)/);
});

test('requireFlowOff: an unknown state stops unless the user confirmed it, and says why', async () => {
  await assert.rejects(requireFlowOff(ioOf([])), /not known: no approval flow row.*--flow-off-confirmed/);
  await assert.rejects(requireFlowOff(ioOf(null, false, 'HTTP 503')), /could not be read \(HTTP 503\)/);
  await requireFlowOff(ioOf([]), { confirmedByUser: true });
  // confirmation never overrides a flow that is ON
  await assert.rejects(requireFlowOff(ioOf([{ name: NAME('v2'), statecode: 1 }]), { confirmedByUser: true }), /is ON/);
});
