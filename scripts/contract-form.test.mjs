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

// The fake follows the real form (src/Entities/mwf_Contract/FormXml/main): the control NAME is a GUID for four of the five
// columns and equals the column name only for transactioncurrencyid. getControl(name) matches the control name and returns the
// first match or null (Learn: formContext.getControl); attribute.controls holds every control bound to the column.
const REAL_CONTROL_NAMES = {
  mwf_value: '86720022-4016-426a-82b0-9326d2328998',
  transactioncurrencyid: 'transactioncurrencyid',
  mwf_contracttype: '8e7003cd-3846-4dc4-ad60-5b3c6bb70469',
  mwf_direction: 'dd066f96-e071-41e6-ad70-1f84ecf0472a',
  mwf_counterpartyid: '7a090264-f378-403c-94e8-575ca6bce600',
};

// missing: attributes not on the form; extraControl: attributes that have a second control (header, other tab);
// throwSet: attributes whose controls throw in setDisabled; throwAttr: attributes for which getAttribute throws.
function fakeForm({ status, formType = 2, missing = [], extraControl = [], throwSet = [], throwAttr = [] }) {
  const state = { flags: {}, notifications: {}, cleared: [], postSave: [] };
  const controls = [];
  const attrs = {};
  for (const n of FIVE) {
    if (missing.includes(n)) continue;
    const names = [REAL_CONTROL_NAMES[n]];
    if (extraControl.includes(n)) names.push('header_' + n);
    state.flags[n] = [];
    const mine = names.map((name) => {
      const c = { name, setDisabled: (v) => { if (throwSet.includes(n)) throw new Error('boom ' + n); state.flags[n].push(v); } };
      controls.push(c);
      return c;
    });
    attrs[n] = { controls: { forEach: (fn) => mine.forEach(fn) } };
  }
  const fc = {
    getAttribute: (n) => {
      if (throwAttr.includes(n)) throw new Error('boom attr ' + n);
      return n === 'statuscode' ? { getValue: () => status } : attrs[n] || null;
    },
    getControl: (n) => controls.find((c) => c.name === n) || null,
    ui: {
      getFormType: () => formType,
      setFormNotification: (text, level, id) => { state.notifications[id] = { text, level }; },
      clearFormNotification: (id) => { state.cleared.push(id); delete state.notifications[id]; },
    },
    data: { entity: { addOnPostSave: (fn) => state.postSave.push(fn) } },
  };
  return { fc, state, ctx: { getFormContext: () => fc } };
}
const allWith = (state, names, flag) => names.every((n) => state.flags[n].length > 0 && state.flags[n].every((v) => v === flag));

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
  assert.ok(allWith(state, FIVE, true));
  assert.equal(state.notifications.mwf_contract_locked.level, 'INFO');
  assert.equal(state.postSave.length, 1);
  assert.equal(state.postSave[0], form.onPostSave);
});

test('onLoad on a Draft contract enables the five columns and clears the notification', () => {
  const { state, ctx } = fakeForm({ status: DRAFT });
  form.onLoad(ctx);
  assert.ok(allWith(state, FIVE, false));
  assert.deepEqual(state.cleared, ['mwf_contract_locked']);
  assert.equal(state.notifications.mwf_contract_locked, undefined);
});

test('PostSave works both ways: Draft -> Pending locks, Rejected -> Draft unlocks', () => {
  const a = fakeForm({ status: PENDING });
  form.onPostSave(a.ctx);
  assert.ok(allWith(a.state, FIVE, true));
  const b = fakeForm({ status: DRAFT });
  form.onPostSave(b.ctx);
  assert.ok(allWith(b.state, FIVE, false));
  assert.deepEqual(b.state.cleared, ['mwf_contract_locked']);
});

test('REGRESSION (first manual test): controls whose NAME differs from the column name (a GUID) are locked too', () => {
  const { state, ctx } = fakeForm({ status: PENDING });
  form.onLoad(ctx);
  for (const n of ['mwf_value', 'mwf_contracttype', 'mwf_direction', 'mwf_counterpartyid']) {
    assert.deepEqual(state.flags[n], [true], n + ' must be disabled although its control name is a GUID');
  }
  assert.deepEqual(state.flags.transactioncurrencyid, [true]);
});

test('REGRESSION: a column with two controls (for example a header copy) has both locked, and both unlocked for Draft', () => {
  const locked = fakeForm({ status: IN_FORCE, extraControl: ['mwf_value', 'mwf_direction'] });
  form.onLoad(locked.ctx);
  assert.deepEqual(locked.state.flags.mwf_value, [true, true]);
  assert.deepEqual(locked.state.flags.mwf_direction, [true, true]);
  const open = fakeForm({ status: DRAFT, extraControl: ['mwf_value'] });
  form.onLoad(open.ctx);
  assert.deepEqual(open.state.flags.mwf_value, [false, false]);
});

test('a column that throws (control or attribute) does not stop the others, and nothing is thrown out of onLoad', () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const { state, ctx } = fakeForm({ status: PENDING, throwSet: ['mwf_value'], throwAttr: ['mwf_contracttype'] });
    assert.doesNotThrow(() => form.onLoad(ctx));
    assert.deepEqual(state.flags.mwf_value, []);
    assert.equal(state.flags.mwf_contracttype.length, 0);
    for (const n of ['transactioncurrencyid', 'mwf_direction', 'mwf_counterpartyid']) assert.deepEqual(state.flags[n], [true]);
    assert.equal(state.postSave.length, 1);
    assert.equal(state.notifications.mwf_contract_locked.level, 'INFO');
  } finally { console.warn = warn; }
});

test('a column that is not on the form is skipped and the others are still locked', () => {
  const { state, ctx } = fakeForm({ status: IN_FORCE, missing: ['mwf_direction'] });
  assert.doesNotThrow(() => form.onLoad(ctx));
  assert.equal(state.flags.mwf_direction, undefined);
  assert.ok(allWith(state, FIVE.filter((n) => n !== 'mwf_direction'), true));
});

test('a missing status attribute locks (fail-safe), except on a Create form where only Draft is possible', () => {
  const existing = fakeForm({ status: null, formType: 2 });
  form.onLoad(existing.ctx);
  assert.ok(allWith(existing.state, FIVE, true));
  const created = fakeForm({ status: null, formType: 1 });
  form.onLoad(created.ctx);
  assert.ok(allWith(created.state, FIVE, false));
});

test('the file states that it is UX only and not security, and names the guard', () => {
  const src = fs.readFileSync(JS_PATH, 'utf8');
  assert.match(src, /UX ONLY, NOT SECURITY/);
  assert.match(src, /ADR-004/);
});
