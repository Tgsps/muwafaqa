// Unit tests of the Contract form web resource (src/WebResources/mwf_contract_form.js).
// The pure function is tested directly; onLoad / onPostSave are tested against a FAKE formContext written here,
// so they show the logic, not that the real Xrm object behaves the same (that is the owner's manual test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const JS_PATH = new URL('../src/WebResources/mwf_contract_form.js', import.meta.url);
const ADR_PATH = new URL('../docs/decisions/ADR-004-contract-state-guard.md', import.meta.url);
const form = require(fileURLToPath(JS_PATH));

const FIVE = ['mwf_value', 'transactioncurrencyid', 'mwf_contracttype', 'mwf_direction', 'mwf_counterpartyid'];
const PENDING = 867640000, IN_FORCE = 867640001, REJECTED = 2, DRAFT = 1;

function fakeForm({ status, formType = 2, missing = [] }) {
  const state = { disabled: {}, notifications: {}, cleared: [], postSave: [] };
  const fc = {
    getAttribute: (n) => (n === 'statuscode' ? { getValue: () => status } : null),
    getControl: (n) => (missing.includes(n) ? null : { setDisabled: (v) => { state.disabled[n] = v; } }),
    ui: {
      getFormType: () => formType,
      setFormNotification: (text, level, id) => { state.notifications[id] = { text, level }; },
      clearFormNotification: (id) => { state.cleared.push(id); delete state.notifications[id]; },
    },
    data: { entity: { addOnPostSave: (fn) => state.postSave.push(fn) } },
  };
  return { fc, state, ctx: { getFormContext: () => fc } };
}

test('lockedColumnsFor: Draft locks nothing', () => {
  assert.deepEqual(form.lockedColumnsFor(DRAFT), []);
});
for (const [name, v] of [['Pending Approval', PENDING], ['In Force', IN_FORCE], ['Rejected', REJECTED]]) {
  test(`lockedColumnsFor: ${name} locks the five columns`, () => {
    assert.deepEqual(form.lockedColumnsFor(v), FIVE);
  });
}
test('lockedColumnsFor: null, undefined, unknown or a string "1" is treated as locked (fail-safe)', () => {
  for (const v of [null, undefined, 999, '1', NaN]) assert.deepEqual(form.lockedColumnsFor(v), FIVE);
});
test('lockedColumnsFor returns a copy, so a caller cannot change the list', () => {
  form.lockedColumnsFor(PENDING).push('x');
  assert.deepEqual(form.lockedColumnsFor(PENDING), FIVE);
  assert.throws(() => form.LOCKED_COLUMNS.push('x'));
});

test('the locked-column list equals the columns ADR-004 locks after submission (not Subject, not Number, not USD frozen)', () => {
  const rows = fs.readFileSync(ADR_PATH, 'utf8').split(/\r?\n/).filter((l) => /^\| .*`[a-z_]+`/.test(l));
  const fromAdr = rows
    .map((l) => l.split('|').map((c) => c.trim()))
    .filter((c) => c[2] === 'editable' && c[3] === 'locked' && c[4] === 'locked' && c[5] === 'locked')
    .map((c) => c[1].match(/`([a-z_]+)`/)[1]);
  assert.deepEqual([...form.LOCKED_COLUMNS].sort(), fromAdr.sort());
  assert.equal(fromAdr.length, 5);
});

test('onLoad on a Pending contract disables the five columns, shows one INFO notification and registers PostSave', () => {
  const { state, ctx } = fakeForm({ status: PENDING });
  form.onLoad(ctx);
  assert.deepEqual(Object.keys(state.disabled).sort(), [...FIVE].sort());
  assert.ok(Object.values(state.disabled).every((v) => v === true));
  assert.equal(state.notifications.mwf_contract_locked.level, 'INFO');
  assert.equal(state.postSave.length, 1);
  assert.equal(state.postSave[0], form.onPostSave);
});

test('onLoad on a Draft contract enables the five columns and clears the notification', () => {
  const { state, ctx } = fakeForm({ status: DRAFT });
  form.onLoad(ctx);
  assert.ok(FIVE.every((n) => state.disabled[n] === false));
  assert.deepEqual(state.cleared, ['mwf_contract_locked']);
  assert.equal(state.notifications.mwf_contract_locked, undefined);
});

test('PostSave works both ways: Draft -> Pending locks, Rejected -> Draft unlocks', () => {
  const a = fakeForm({ status: PENDING });
  form.onPostSave(a.ctx);
  assert.ok(FIVE.every((n) => a.state.disabled[n] === true));
  const b = fakeForm({ status: DRAFT });
  form.onPostSave(b.ctx);
  assert.ok(FIVE.every((n) => b.state.disabled[n] === false));
  assert.deepEqual(b.state.cleared, ['mwf_contract_locked']);
});

test('a missing control on the form is skipped, nothing throws', () => {
  const { state, ctx } = fakeForm({ status: IN_FORCE, missing: ['mwf_direction'] });
  form.onLoad(ctx);
  assert.equal(state.disabled.mwf_direction, undefined);
  assert.equal(state.disabled.mwf_value, true);
});

test('a missing status attribute locks (fail-safe), except on a Create form where only Draft is possible', () => {
  const existing = fakeForm({ status: null, formType: 2 });
  form.onLoad(existing.ctx);
  assert.ok(FIVE.every((n) => existing.state.disabled[n] === true));
  const created = fakeForm({ status: null, formType: 1 });
  form.onLoad(created.ctx);
  assert.ok(FIVE.every((n) => created.state.disabled[n] === false));
});

test('the file states that it is UX only and not security, and names the guard', () => {
  const src = fs.readFileSync(JS_PATH, 'utf8');
  assert.match(src, /UX ONLY, NOT SECURITY/);
  assert.match(src, /ADR-004/);
});
