// node --test scripts/test-flow-v2.test.mjs   (offline: the plan of the v2 flow-ON session)
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, titleOf, expectedSteps } from './test-flow-v2.mjs';
import { subjectOfTitle, isInformTitle, stepOfTitle } from './lib/run-attribution.mjs';

// the fictional seed of the ApprovalMatrix for one type and direction (data/approval-matrix.csv structure): 4 bands, 1 + 2 + 3 + 5 steps
const DH = 867640000, FM = 867640001, GM = 867640002, RO = 867640003, OW = 867640004;
const row = (min, max, order, role, action = 867640000) => ({ min, max, order, role, action });
const MATRIX = [
  row(0, 10000, 1, DH),
  row(10000, 50000, 1, DH), row(10000, 50000, 2, FM),
  row(50000, 100000, 1, DH), row(50000, 100000, 2, FM), row(50000, 100000, 3, GM),
  row(100000, null, 1, DH), row(100000, null, 2, FM), row(100000, null, 3, GM), row(100000, null, 4, RO), row(100000, null, 5, OW, 867640001),
];

test('no prefix of a case is a prefix of another case, nor of the prefixes of the other scripts', () => {
  const mine = Object.values(CASES).map((c) => c.prefix);
  assert.equal(new Set(mine).size, 4);
  for (const a of mine) for (const b of mine) if (a !== b) assert.ok(!b.startsWith(a), `${a} is a prefix of ${b}`);
  const others = ['TEST-TMP-ROUND', 'TEST-TMP-RND-1', 'TEST-TMP-USD', 'TEST-TMP-GUARD', 'TEST-TMP-GFLOW', 'TEST-TMP-CHK', 'TEST-TMP-TRIG', 'TEST-TMP-NUM', 'TEST-TMP-CHAIN', 'TEST-TMP-STEP', 'TEST-TMP-PROBE'];
  for (const a of mine) for (const o of others) { assert.ok(!o.startsWith(a), `${a} is a prefix of ${o}`); assert.ok(!a.startsWith(o), `${o} is a prefix of ${a}`); }
});

test('every Subject starts with the prefix of its case', () => {
  for (const c of Object.values(CASES)) assert.ok(c.subject.startsWith(c.prefix));
});

test('the chain planned for each case equals the chain the ApprovalMatrix gives for its value', () => {
  for (const [k, c] of Object.entries(CASES)) {
    const exp = expectedSteps(c.value, MATRIX);
    assert.ok(exp, `case ${k}: no single band for ${c.value}`);
    assert.deepEqual(exp.map((r) => r.role), c.chain, `case ${k}`);
    assert.equal(exp[exp.length - 1].action === 867640001, c.informLast, `case ${k}: the Inform step`);
  }
});

test('expectedSteps: bounds are (min, max], zero falls on the first band, a gap or an overlap gives no single band', () => {
  assert.equal(expectedSteps(10000, MATRIX).length, 1);
  assert.equal(expectedSteps(10000.01, MATRIX).length, 2);
  assert.equal(expectedSteps(100000, MATRIX).length, 3);
  assert.equal(expectedSteps(100000.01, MATRIX).length, 5);
  assert.equal(expectedSteps(0, MATRIX).length, 1);
  assert.equal(expectedSteps(5, [row(0, 10, 1, DH), row(10, 20, 1, DH), row(20, 30, 1, DH)].filter((r) => r.min !== 0)), null);   // gap: no band
  assert.equal(expectedSteps(7, [row(0, 10, 1, DH), row(5, 20, 1, DH)]), null);                                                    // overlap
});

test('titles are the ones the flow builds, and the Subject comes back out of them', () => {
  for (const c of Object.values(CASES)) {
    c.chain.forEach((role, i) => {
      const inform = c.informLast && i === c.chain.length - 1;
      const t = titleOf(c, i + 1, c.chain.length, role, inform);
      assert.equal(subjectOfTitle(t), c.subject);
      assert.equal(isInformTitle(t), inform);
      assert.deepEqual(stepOfTitle(t), { index: i + 1, total: c.chain.length, role: t.match(/, ([^)]*)\)$/)[1] });
    });
  }
  assert.equal(titleOf(CASES.a, 1, 1, DH), 'Approve contract: TEST-TMP-V2A one step (step 1 of 1, Department Head)');
  assert.equal(titleOf(CASES.c, 5, 5, OW, true), 'For information: contract TEST-TMP-V2C top band with inform (step 5 of 5, Owner)');
});

test('the owner is asked to answer Approve steps only, one request at a time, and never an Inform request', () => {
  for (const c of Object.values(CASES)) {
    for (const a of c.answers) {
      assert.ok(a.step >= 1 && a.step <= c.chain.length);
      const inform = c.informLast && a.step === c.chain.length;
      assert.equal(inform, false, 'an answer is planned for an Inform step');
      assert.ok(['Approve', 'Reject'].includes(a.choice));
    }
  }
});

test('the cases cover what the plan says', () => {
  assert.equal(CASES.a.chain.length, 1);
  assert.deepEqual(CASES.b.answers.map((a) => a.choice), ['Approve', 'Reject']);
  assert.equal(CASES.c.chain.length, 5);
  assert.equal(CASES.c.inform, 1);
  assert.deepEqual(CASES.c.answers.map((a) => a.step), [1, 2, 3, 4]);
  assert.deepEqual(CASES.d.runs.slice().sort(), ['Cancelled', 'Succeeded']);
  assert.equal(CASES.d.answers[1].which, 'oldest');
  assert.deepEqual(CASES.d.steps, { 1: ['Approved', 'Cancelled'], 2: ['Approved', 'Approved'] });
});
