// Unit tests of scripts/lib/run-attribution.mjs, with the real timing of the flow-checkpoints run of 2026-10-19 (times only, no ids).
//   node --test scripts/lib/run-attribution.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastApprovalByContract, attributeRuns } from './run-attribution.mjs';

const P = 'TEST-TMP-CHK';
const SUBJECTS = [`${P}1 normal`, `${P}2 withdrawn before stage 1`, `${P}3 withdrawn after stage 1`, `${P}4 rejected`];
const approvals = [
  { title: `Approve contract : ${SUBJECTS[0]}`, completedon: '2026-10-19T17:35:48Z' },
  { title: `Approve contract: ${SUBJECTS[0]}`, completedon: '2026-10-19T17:37:20Z' },       // stage 2 of CHK1
  { title: `Approve contract : ${SUBJECTS[1]}`, completedon: '2026-10-19T17:39:31Z' },
  { title: `Approve contract : ${SUBJECTS[2]}`, completedon: '2026-10-19T17:44:59Z' },
  { title: `Approve contract: ${SUBJECTS[2]}`, completedon: '2026-10-19T17:48:33Z' },       // stage 2 of CHK3
  { title: `Approve contract : ${SUBJECTS[3]}`, completedon: '2026-10-19T17:43:10Z' },       // the Reject
  { title: `Approve contract: ${SUBJECTS[3]}`, completedon: null },
];
// in START order, as the table lists them: runs 3 and 4 started in the SAME second
const runs = [
  { starttime: '2026-10-19T17:33:44Z', endtime: '2026-10-19T17:37:21Z', status: 'Succeeded' },
  { starttime: '2026-10-19T17:33:58Z', endtime: '2026-10-19T17:39:32Z', status: 'Cancelled' },
  { starttime: '2026-10-19T17:34:14Z', endtime: '2026-10-19T17:43:13Z', status: 'Succeeded' },
  { starttime: '2026-10-19T17:34:14Z', endtime: '2026-10-19T17:48:34Z', status: 'Cancelled' },
];

test('the last approval of each contract is its last completion', () => {
  const last = lastApprovalByContract(approvals);
  assert.equal(last[SUBJECTS[0]], Date.parse('2026-10-19T17:37:20Z'));
  assert.equal(last[SUBJECTS[2]], Date.parse('2026-10-19T17:48:33Z'));
  assert.equal(last[SUBJECTS[3]], Date.parse('2026-10-19T17:43:10Z'));   // the open one (no completedon) is ignored
});

test('runs are attributed by END time: the run that started 3rd belongs to CHK4, the 4th to CHK3 (NOT the start order)', () => {
  const r = attributeRuns(runs, lastApprovalByContract(approvals), SUBJECTS);
  assert.ok(SUBJECTS.every((s) => r[s].unique), 'every contract has exactly one run');
  assert.equal(r[SUBJECTS[0]].run.status, 'Succeeded');
  assert.equal(r[SUBJECTS[1]].run.status, 'Cancelled');
  assert.equal(r[SUBJECTS[2]].run.endtime, '2026-10-19T17:48:34Z');   // CHK3 = the long run, although it was listed 4th by the START order's tie
  assert.equal(r[SUBJECTS[2]].run.status, 'Cancelled');
  assert.equal(r[SUBJECTS[3]].run.endtime, '2026-10-19T17:43:13Z');   // CHK4 = the 8:58 run
  assert.equal(r[SUBJECTS[3]].run.status, 'Succeeded');
});

test('the attribution does not depend on the order in which the runs are listed', () => {
  const reversed = [...runs].reverse();
  const a = attributeRuns(reversed, lastApprovalByContract(approvals), SUBJECTS);
  assert.equal(a[SUBJECTS[2]].run.endtime, '2026-10-19T17:48:34Z');
  assert.equal(a[SUBJECTS[3]].run.endtime, '2026-10-19T17:43:13Z');
});

test('a run that ended long after the last approval is not attributed (no verdict)', () => {
  const late = runs.map((x) => (x.endtime === '2026-10-19T17:48:34Z' ? { ...x, endtime: '2026-10-19T18:30:00Z' } : x));
  const r = attributeRuns(late, lastApprovalByContract(approvals), SUBJECTS);
  assert.equal(r[SUBJECTS[2]].unique, false);
  assert.equal(r[SUBJECTS[2]].run, null);
});

test('two runs that fit the same contract make the attribution ambiguous (no verdict, not a guess)', () => {
  const dup = [...runs, { starttime: '2026-10-19T17:34:20Z', endtime: '2026-10-19T17:37:22Z', status: 'Failed' }];
  const r = attributeRuns(dup, lastApprovalByContract(approvals), SUBJECTS);
  assert.equal(r[SUBJECTS[0]].unique, false);
  assert.equal(r[SUBJECTS[0]].candidates.length, 2);
});

test('one run that fits two contracts is ambiguous for both', () => {
  const two = { ...Object.fromEntries(SUBJECTS.map((s) => [s, 0])) };
  two[SUBJECTS[0]] = Date.parse('2026-10-19T17:37:20Z');
  two[SUBJECTS[1]] = Date.parse('2026-10-19T17:37:19Z');
  const r = attributeRuns([runs[0]], two, [SUBJECTS[0], SUBJECTS[1]]);
  assert.equal(r[SUBJECTS[0]].unique, false);
  assert.equal(r[SUBJECTS[1]].unique, false);
});

test('a contract without any completed approval gets no run', () => {
  const r = attributeRuns(runs, lastApprovalByContract([]), SUBJECTS);
  assert.ok(SUBJECTS.every((s) => !r[s].unique && r[s].run === null));
});

test('a PASS on the statuses holds with the right attribution and would have FAILED with the start order', () => {
  const r = attributeRuns(runs, lastApprovalByContract(approvals), SUBJECTS);
  const expectCancelled = { [SUBJECTS[2]]: true, [SUBJECTS[1]]: true };
  for (const s of SUBJECTS) assert.equal(/cancel/i.test(r[s].run.status), !!expectCancelled[s]);
  // the old (wrong) rule paired contracts and runs by start order: CHK3 with the 3rd run (Succeeded) and CHK4 with the 4th (Cancelled)
  const byStart = { [SUBJECTS[2]]: runs[2], [SUBJECTS[3]]: runs[3] };
  assert.equal(/cancel/i.test(byStart[SUBJECTS[2]].status), false);   // CHK3 expects Cancelled: the start order would have said Succeeded
  assert.equal(/succeed/i.test(byStart[SUBJECTS[3]].status), false);  // CHK4 expects Succeeded: the start order would have said Cancelled
});
