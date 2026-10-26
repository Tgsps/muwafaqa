import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCandidates, timersFor, validateTimers, PRODUCTION_TIMERS, TEST_TIMERS, DECISION, ACTION_TYPE, STATUS_PENDING_APPROVAL } from './reminder-candidates.mjs';

const C1 = 'c0000001-0000-4000-8000-000000000001';
const C2 = 'c0000002-0000-4000-8000-000000000002';
const T0 = Date.parse('2026-01-01T10:00:00Z');
const min = (n) => T0 + n * 60000;
const iso = (n) => new Date(min(n)).toISOString();
const TIMERS = { remindAfterMinutes: 3, escalateAfterMinutes: 6 };

const contract = (id = C1, extra = {}) => ({ mwf_contractid: id, statuscode: STATUS_PENDING_APPROVAL, mwf_approvalround: 1, ...extra });
let n = 0;
const step = (order, extra = {}) => ({
  mwf_approvalstepid: `s${++n}`, _mwf_contract_value: C1, mwf_approvalround: 1, mwf_steporder: order,
  mwf_decision: DECISION.Waiting, mwf_actiontype: ACTION_TYPE.Approve,
  createdon: iso(0), mwf_decidedon: null, mwf_remindedon: null, mwf_escalatedon: null, ...extra,
});
const run = (steps, now, contracts = [contract()], timers = TIMERS) => pickCandidates({ steps, contracts, nowMs: min(now), timers });
const only = (r) => r.actions.map((a) => `${a.stepId}:${a.action}`);

// ---- R1: a step that waits and is not answered
test('R1: step 1 is not due before the reminder time, due at it, and the waiting time comes from createdon', () => {
  const s = step(1);
  assert.deepEqual(run([s], 2.9).actions, []);
  const r = run([s], 3);
  assert.deepEqual(only(r), [`${s.mwf_approvalstepid}:remind`]);
  assert.equal(r.actions[0].waitingSinceMs, min(0));
  assert.equal(r.actions[0].waitingMinutes, 3);
  assert.equal(r.notDue, 0);
});

test('R1: after the reminder, the escalation is due at the escalation time and not before', () => {
  const s = step(1, { mwf_remindedon: iso(3) });
  assert.deepEqual(run([s], 5.9).actions, []);
  assert.deepEqual(only(run([s], 6)), [`${s.mwf_approvalstepid}:escalate`]);
});

// ---- R2: answered before the time
test('R2: a step that is no longer Waiting (Approved, Rejected, Informed, Cancelled, Pending) is never a candidate, and is not an anomaly', () => {
  for (const d of [DECISION.Approved, DECISION.Rejected, DECISION.Informed, DECISION.Cancelled, DECISION.Pending]) {
    const r = run([step(1, { mwf_decision: d })], 1000);
    assert.deepEqual(r.actions, [], String(d));
    assert.deepEqual(r.skipped, [], String(d));
  }
});

// ---- R3: idempotency (no second reminder, no second escalation)
test('R3: a step that was reminded is not reminded again, however long it waits', () => {
  const s = step(1, { mwf_remindedon: iso(3) });
  for (const now of [3, 4, 5]) assert.deepEqual(run([s], now).actions, []);
});

test('R3: a step that was escalated gets nothing more', () => {
  const s = step(1, { mwf_remindedon: iso(3), mwf_escalatedon: iso(6) });
  const r = run([s], 100000);
  assert.deepEqual(r.actions, []);
  assert.equal(r.notDue, 1);
});

test('R3: the reminder is never skipped: both times passed and no reminder yet gives the reminder only; the escalation comes in the next scan', () => {
  const s = step(1);
  assert.deepEqual(only(run([s], 100)), [`${s.mwf_approvalstepid}:remind`]);
  const after = { ...s, mwf_remindedon: iso(100) };
  assert.deepEqual(only(run([after], 101)), [`${s.mwf_approvalstepid}:escalate`]);
});

test('R3: an escalated step with no reminder recorded still gets its reminder (inconsistent data is not trusted)', () => {
  const s = step(1, { mwf_escalatedon: iso(6) });
  assert.deepEqual(only(run([s], 7)), [`${s.mwf_approvalstepid}:remind`]);
});

// ---- R4: orphans
test('R4: a step of an old round is never reminded', () => {
  const s = step(1, { mwf_approvalround: 1 });
  const r = run([s], 100, [contract(C1, { mwf_approvalround: 2 })]);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.skipped, [{ stepId: s.mwf_approvalstepid, reason: 'stale-round' }]);
});

test('R4: a contract that is not Pending Approval (Draft 1, In Force, Rejected 2) is never reminded', () => {
  for (const statuscode of [1, 867640001, 2]) {
    const s = step(1);
    const r = run([s], 100, [contract(C1, { statuscode })]);
    assert.deepEqual(r.actions, [], String(statuscode));
    assert.equal(r.skipped[0].reason, 'contract-not-pending-approval');
  }
});

test('R4: a step whose contract was not read is skipped (fail-safe)', () => {
  const s = step(1);
  const r = run([s], 100, []);
  assert.deepEqual(r.actions, []);
  assert.equal(r.skipped[0].reason, 'contract-missing');
});

test('R4: the contract id is compared without case', () => {
  const s = step(1, { _mwf_contract_value: C1.toUpperCase() });
  assert.deepEqual(only(run([s], 3)), [`${s.mwf_approvalstepid}:remind`]);
});

// ---- derived waiting-since for step k > 1
test('step 2 waits since the decidedon of step 1 (Approved), not since createdon', () => {
  const s1 = step(1, { mwf_decision: DECISION.Approved, mwf_decidedon: iso(50) });
  const s2 = step(2);
  assert.deepEqual(run([s1, s2], 52.9).actions, []);
  const r = run([s1, s2], 53);
  assert.deepEqual(only(r), [`${s2.mwf_approvalstepid}:remind`]);
  assert.equal(r.actions[0].waitingSinceMs, min(50));
});

test('an Informed previous step counts: the next step waits since its decidedon', () => {
  const s1 = step(1, { mwf_decision: DECISION.Informed, mwf_decidedon: iso(20) });
  const s2 = step(2);
  assert.deepEqual(only(run([s1, s2], 23)), [`${s2.mwf_approvalstepid}:remind`]);
  assert.deepEqual(run([s1, s2], 22).actions, []);
});

test('a missing previous step: skipped, never sent', () => {
  const s3 = step(3);
  const r = run([s3], 100000);
  assert.deepEqual(r.actions, []);
  assert.equal(r.skipped[0].reason, 'previous-step-missing');
});

test('a previous step in another round or another contract does not count', () => {
  const other = step(1, { mwf_approvalround: 2, mwf_decision: DECISION.Approved, mwf_decidedon: iso(0) });
  const elsewhere = step(1, { _mwf_contract_value: C2, mwf_decision: DECISION.Approved, mwf_decidedon: iso(0) });
  const s2 = step(2);
  const r = run([other, elsewhere, s2], 1000);
  assert.deepEqual(r.actions, []);
  assert.equal(r.skipped[0].reason, 'previous-step-missing');
});

test('a previous step that is not decided (Waiting, Pending, Rejected, Cancelled): skipped', () => {
  for (const d of [DECISION.Waiting, DECISION.Pending, DECISION.Rejected, DECISION.Cancelled]) {
    const s1 = step(1, { mwf_decision: d, mwf_decidedon: iso(0) });
    const s2 = step(2);
    const r = run([s1, s2], 1000);
    assert.equal(r.actions.some((a) => a.stepId === s2.mwf_approvalstepid), false, String(d));
    assert.ok(r.skipped.some((x) => x.stepId === s2.mwf_approvalstepid && x.reason === 'previous-step-not-decided'), String(d));
  }
});

test('a previous step without a usable decidedon: skipped', () => {
  for (const bad of [null, '', 'not a date']) {
    const s1 = step(1, { mwf_decision: DECISION.Approved, mwf_decidedon: bad });
    const s2 = step(2);
    const r = run([s1, s2], 1000);
    assert.equal(r.actions.length, 0, String(bad));
    assert.equal(r.skipped[0].reason, 'previous-decidedon-missing', String(bad));
  }
});

test('anomalies are skipped, not sent: no createdon, a waiting time in the future, an Inform step that is Waiting, a bad step order', () => {
  const noCreated = step(1, { createdon: null });
  const future = step(1, { createdon: iso(60) });
  const inform = step(1, { mwf_actiontype: ACTION_TYPE.Inform });
  const badOrder = step(0);
  const r = run([noCreated, future, inform, badOrder], 10);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.skipped.map((x) => x.reason), ['createdon-missing', 'waiting-since-in-the-future', 'not-an-approve-step', 'bad-step-order']);
});

test('several contracts and steps in one scan: each gets its own decision', () => {
  const a = step(1);
  const b = step(1, { _mwf_contract_value: C2, createdon: iso(5) });
  const c = step(1, { mwf_remindedon: iso(3) });
  const r = run([a, b, c], 6, [contract(C1), contract(C2)]);
  const byStep = Object.fromEntries(r.actions.map((x) => [x.stepId, x.action]));
  assert.equal(byStep[a.mwf_approvalstepid], 'remind');
  assert.equal(byStep[b.mwf_approvalstepid], undefined);
  assert.equal(byStep[c.mwf_approvalstepid], 'escalate');
  assert.equal(r.notDue, 1);
});

test('empty input gives an empty result, and a bad clock or bad timers throw', () => {
  assert.deepEqual(pickCandidates({ steps: [], contracts: [], nowMs: min(0), timers: TIMERS }), { actions: [], skipped: [], notDue: 0 });
  assert.throws(() => pickCandidates({ steps: [], contracts: [], nowMs: NaN, timers: TIMERS }));
  assert.throws(() => validateTimers({ remindAfterMinutes: 6, escalateAfterMinutes: 3 }));
  assert.throws(() => validateTimers({ remindAfterMinutes: 0, escalateAfterMinutes: 3 }));
  assert.throws(() => validateTimers({ remindAfterMinutes: 1.5, escalateAfterMinutes: 3 }));
});

// ---- the timers
test('the test and the production timers are valid, and differ only in the two numbers (same keys, nothing else)', () => {
  validateTimers(TEST_TIMERS); validateTimers(PRODUCTION_TIMERS);
  assert.deepEqual(Object.keys(TEST_TIMERS), Object.keys(PRODUCTION_TIMERS));
  assert.deepEqual(Object.keys(PRODUCTION_TIMERS).sort(), ['escalateAfterMinutes', 'remindAfterMinutes']);
  assert.deepEqual(PRODUCTION_TIMERS, { remindAfterMinutes: 2880, escalateAfterMinutes: 5760 });   // 48 h and 96 h, placeholders
  assert.deepEqual(TEST_TIMERS, { remindAfterMinutes: 3, escalateAfterMinutes: 6 });
  assert.equal(timersFor('test'), TEST_TIMERS);
  assert.equal(timersFor('production'), PRODUCTION_TIMERS);
  assert.throws(() => timersFor('prod'));
  assert.ok(Object.isFrozen(TEST_TIMERS) && Object.isFrozen(PRODUCTION_TIMERS));
});
