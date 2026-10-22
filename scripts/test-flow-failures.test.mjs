import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CASES, BUILDER_STEP_NAME, BYPASS_HEADER, prefixesAreIndependent, bypassHeaders, manualStepBody, runsSince, finished, judgeRun, assignmentActive, sessionFlowState } from './lib/flow-failures.mjs';

test('the two prefixes are independent, and also of the v2 and bulk prefixes', () => {
  assert.equal(prefixesAreIndependent(Object.values(CASES).map((c) => c.prefix)), true);
  assert.equal(prefixesAreIndependent(['TEST-TMP-FF1', 'TEST-TMP-FF2', 'TEST-TMP-V2A', 'TEST-TMP-BULK']), true);
  assert.equal(prefixesAreIndependent(['TEST-TMP-FF', 'TEST-TMP-FF1']), false);
});

test('every Subject starts with its own prefix', () => {
  for (const c of Object.values(CASES)) assert.ok(c.subject.startsWith(c.prefix));
});

test('the expected texts equal the ones in the flow builder (the source of truth)', () => {
  const src = readFileSync(new URL('./build-flow-v2.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes(`code: '${CASES.f1.expect.code}'`));
  assert.ok(src.includes(CASES.f1.expect.message));
  assert.ok(src.includes(`code: '${CASES.f2.expect.code}'`));
  assert.ok(src.includes(CASES.f2.expect.message));
});

test('the bypass header names the step id and nothing else is bypassed', () => {
  const h = bypassHeaders('abc');
  assert.equal(h[BYPASS_HEADER], 'abc');
  assert.deepEqual(Object.keys(h).sort(), [BYPASS_HEADER, 'If-Match'].sort());
  assert.ok(BUILDER_STEP_NAME.includes('ApprovalChainBuilder'));
});

test('manualStepBody: round 1, order 1, Department Head, Approve, Pending, like the builder', () => {
  const b = manualStepBody({ contractId: 'c1', userId: 'u1', number: 'MNT-0001' });
  assert.equal(b.mwf_name, 'MNT-0001 R1 S1 Department Head');
  assert.equal(b['mwf_Contract@odata.bind'], '/mwf_contracts(c1)');
  assert.equal(b['mwf_OriginalApprover@odata.bind'], '/systemusers(u1)');
  assert.deepEqual([b.mwf_approvalround, b.mwf_steporder, b.mwf_approverrole, b.mwf_actiontype, b.mwf_decision], [1, 1, 867640000, 867640000, 867640000]);
  assert.equal('mwf_OriginalApprover@odata.bind' in manualStepBody({ contractId: 'c1', number: 'x' }), false);
});

test('runsSince keeps only the runs of v2 that started at or after the time', () => {
  const rows = [
    { starttime: '2026-10-22T10:00:00Z', _workflow_value: 'AA' }, { starttime: '2026-10-22T10:10:00Z', _workflow_value: 'aa' },
    { starttime: '2026-10-22T10:10:00Z', _workflow_value: 'bb' },
  ];
  assert.equal(runsSince(rows, ['aa'], Date.parse('2026-10-22T10:05:00Z')).length, 1);
  assert.equal(runsSince(rows, ['aa'], Date.parse('2026-10-22T09:00:00Z')).length, 2);
  assert.equal(runsSince(rows, [], 0).length, 0);
  // the upper bound keeps the run of a later case out of the earlier case
  assert.equal(runsSince(rows, ['aa'], Date.parse('2026-10-22T09:00:00Z'), Date.parse('2026-10-22T10:05:00Z')).length, 1);
});

test('finished needs an end time and a status', () => {
  assert.equal(finished({ endtime: 'x', status: 'Failed' }), true);
  assert.equal(finished({ status: 'Running' }), false);
  assert.equal(finished(undefined), false);
});

test('judgeRun finds the code or the message in either field and needs status Failed', () => {
  const e = CASES.f1.expect;
  assert.deepEqual(judgeRun({ status: 'Failed', errorcode: 'Terminated', errormessage: `x ${e.code} ${e.message}` }, e), { statusFailed: true, codeSeen: true, messageSeen: true });
  assert.deepEqual(judgeRun({ status: 'Failed', errorcode: e.code, errormessage: '' }, e), { statusFailed: true, codeSeen: true, messageSeen: false });
  assert.deepEqual(judgeRun({ status: 'Succeeded', errorcode: '', errormessage: '' }, e), { statusFailed: false, codeSeen: false, messageSeen: false });
  assert.equal(judgeRun(undefined, e).statusFailed, false);
});

test('assignmentActive and sessionFlowState', () => {
  assert.equal(assignmentActive({ statecode: 0 }), true);
  assert.equal(assignmentActive({ statecode: 1 }), false);
  assert.equal(assignmentActive(null), false);
  assert.equal(sessionFlowState({ statecode: 0 }, { statecode: 1 }).ok, true);
  assert.equal(sessionFlowState({ statecode: 1 }, { statecode: 1 }).ok, false);
  assert.equal(sessionFlowState({ statecode: 0 }, { statecode: 0 }).ok, false);
  assert.equal(sessionFlowState(undefined, { statecode: 1 }).ok, false);
});
