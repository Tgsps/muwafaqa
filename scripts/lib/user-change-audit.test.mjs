import test from 'node:test';
import assert from 'node:assert/strict';
import { idFrom, keysOfColumn, lookupValueOf, assertUserChange, otherChangedColumns, pickSecondUser, expectationsFor, createBody, moveBody, isTestRow, PREFIX } from './user-change-audit.mjs';

const A = '11111111-aaaa-4aaa-8aaa-111111111111';
const B = '22222222-bbbb-4bbb-8bbb-222222222222';
const C = '33333333-cccc-4ccc-8ccc-333333333333';

test('idFrom reads the id out of every shape of a lookup value and returns it in lower case', () => {
  assert.equal(idFrom(A.toUpperCase()), A);
  assert.equal(idFrom(`/systemusers(${A})`), A);
  assert.equal(idFrom({ Id: A }), A);
  assert.equal(idFrom({ id: A.toUpperCase() }), A);
  assert.equal(idFrom({ systemuserid: A }), A);
  assert.equal(idFrom({ '@odata.id': `systemusers(${A})` }), A);
  assert.equal(idFrom('not an id'), null);
  assert.equal(idFrom(null), null);
  assert.equal(idFrom(undefined), null);
  assert.equal(idFrom(42), null);
  assert.equal(idFrom({}), null);
});

test('keysOfColumn finds the column in its forms and ignores formatted-value annotations', () => {
  const side = { '@odata.type': '#x', _mwf_user_value: A, 'mwf_user@OData.Community.Display.V1.FormattedValue': 'name', mwf_name: 'n' };
  assert.deepEqual(keysOfColumn(side, 'mwf_user'), ['_mwf_user_value']);
  assert.deepEqual(keysOfColumn({ mwf_user: { Id: A } }, 'mwf_user'), ['mwf_user']);
  assert.deepEqual(keysOfColumn({ 'mwf_user@odata.bind': `/systemusers(${A})` }, 'mwf_user'), ['mwf_user@odata.bind']);
  assert.deepEqual(keysOfColumn({ mwf_username: 'x' }, 'mwf_user'), []);   // another column that starts with the same letters
  assert.deepEqual(keysOfColumn(null, 'mwf_user'), []);
});

test('lookupValueOf returns old and new ids, whichever form the detail uses', () => {
  const d1 = { OldValue: { _mwf_user_value: A }, NewValue: { _mwf_user_value: B } };
  assert.deepEqual(lookupValueOf(d1, 'mwf_user'), { found: true, old: A, new: B, keys: { old: ['_mwf_user_value'], new: ['_mwf_user_value'] } });
  const d2 = { OldValue: { mwf_user: { Id: A.toUpperCase() } }, NewValue: { mwf_user: { Id: B } } };
  const v2 = lookupValueOf(d2, 'mwf_user'); assert.equal(v2.old, A); assert.equal(v2.new, B);
  const d3 = { NewValue: { _mwf_user_value: A } };   // a Create: only a new value
  const v3 = lookupValueOf(d3, 'mwf_user'); assert.equal(v3.old, null); assert.equal(v3.new, A); assert.equal(v3.found, true);
  assert.equal(lookupValueOf({ OldValue: { mwf_name: 'x' }, NewValue: { mwf_name: 'y' } }, 'mwf_user').found, false);
  assert.equal(lookupValueOf(undefined, 'mwf_user').found, false);
});

test('assertUserChange: passes for A to B, fails for the wrong user, an empty side, a missing column and the reverse direction', () => {
  const d = { OldValue: { _mwf_user_value: A }, NewValue: { _mwf_user_value: B } };
  assert.equal(assertUserChange(d, 'mwf_user', A, B).ok, true);
  assert.equal(assertUserChange(d, 'mwf_user', A.toUpperCase(), B.toUpperCase()).ok, true);
  assert.equal(assertUserChange(d, 'mwf_user', B, A).ok, false);
  const wrongNew = assertUserChange(d, 'mwf_user', A, C); assert.equal(wrongNew.ok, false); assert.match(wrongNew.reason, /new value is a different user/);
  const wrongOld = assertUserChange(d, 'mwf_user', C, B); assert.equal(wrongOld.ok, false); assert.match(wrongOld.reason, /old value is a different user/);
  const emptyOld = assertUserChange({ NewValue: { _mwf_user_value: B } }, 'mwf_user', A, B); assert.equal(emptyOld.ok, false); assert.match(emptyOld.reason, /old value is empty/);
  const none = assertUserChange({ OldValue: { mwf_name: 'a' }, NewValue: { mwf_name: 'b' } }, 'mwf_user', A, B); assert.equal(none.ok, false); assert.match(none.reason, /no value for mwf_user/);
  assert.equal(assertUserChange(d, 'mwf_user', null, B).ok, false);   // a missing expected id never passes
});

test('otherChangedColumns lists the other columns of the detail without housekeeping and annotations', () => {
  const d = { OldValue: { '@odata.type': '#x', _mwf_user_value: A, mwf_name: 'a', modifiedon: 't1', 'mwf_user@OData.Community.Display.V1.FormattedValue': 'n' }, NewValue: { _mwf_user_value: B, mwf_name: 'a', modifiedon: 't2', _modifiedby_value: B } };
  assert.deepEqual(otherChangedColumns(d, 'mwf_user'), ['mwf_name']);
  assert.deepEqual(otherChangedColumns({ OldValue: { _mwf_user_value: A }, NewValue: { _mwf_user_value: B } }, 'mwf_user'), []);
});

test('pickSecondUser: first active interactive user that is not the owner, SYSTEM, INTEGRATION or an application user', () => {
  const users = [
    { systemuserid: A, fullname: 'Owner', isdisabled: false, accessmode: 0, applicationid: null },
    { systemuserid: C.replace('3', '4'), fullname: 'SYSTEM', isdisabled: false, accessmode: 4, applicationid: null },
    { systemuserid: C.replace('3', '5'), fullname: 'INTEGRATION', isdisabled: false, accessmode: 4, applicationid: null },
    { systemuserid: C.replace('3', '6'), fullname: 'App', isdisabled: false, accessmode: 4, applicationid: 'some-app' },
    { systemuserid: C.replace('3', '7'), fullname: 'Disabled', isdisabled: true, accessmode: 0, applicationid: null },
    { systemuserid: B, fullname: 'Second', isdisabled: false, accessmode: 0, applicationid: null },
    { systemuserid: C, fullname: 'Third', isdisabled: false, accessmode: 0, applicationid: null },
  ];
  assert.equal(pickSecondUser(users, A.toUpperCase()), B);
  assert.equal(pickSecondUser(users.slice(0, 5), A), null);
  assert.equal(pickSecondUser([], A), null);
  assert.equal(pickSecondUser(undefined, A), null);
});

test('expectations: phase 1 is Create and Update, phase 2 is Delete, all on the same row', () => {
  assert.deepEqual(expectationsFor('r', 1).map((e) => e.operation), [1, 2]);
  assert.deepEqual(expectationsFor('r', 2).map((e) => e.operation), [3]);
  assert.ok(expectationsFor('r', 1).every((e) => e.objectid === 'r'));
});

test('request bodies: the temporary row has no role (the key allows one row per role) and only the lookup moves', () => {
  const c = createBody(A);
  assert.equal(c.mwf_name, `${PREFIX} assignment`);
  assert.equal(c['mwf_user@odata.bind'], `/systemusers(${A})`);
  assert.equal('mwf_approverrole' in c, false);
  assert.deepEqual(moveBody(B), { 'mwf_user@odata.bind': `/systemusers(${B})` });
  assert.equal(isTestRow(c.mwf_name), true);
  assert.equal(isTestRow('Owner assignment'), false);
  assert.equal(isTestRow(undefined), false);
});
