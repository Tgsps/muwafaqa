import test from 'node:test';
import assert from 'node:assert/strict';
import { idFrom, keysOfColumn, lookupValueOf, assertUserChange, otherChangedColumns, kindOf, pickUserB, describeB, isNonInteractive, expectationsFor, createBody, moveBody, isTestRow, PREFIX } from './user-change-audit.mjs';

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

const U = (id, fullname, extra = {}) => ({ systemuserid: id, fullname, isdisabled: false, accessmode: 0, applicationid: null, ...extra });
const ID = (n) => `${String(n).repeat(8)}-aaaa-4aaa-8aaa-${String(n).repeat(12)}`;

test('kindOf: application user, non-interactive user, interactive user, and null for the kinds never used', () => {
  assert.equal(kindOf(U(ID(1), 'x', { applicationid: 'app', accessmode: 4 })), 'application user');
  assert.equal(kindOf(U(ID(1), 'x', { accessmode: 3 })), 'non-interactive user');
  assert.equal(kindOf(U(ID(1), 'x', { accessmode: 0 })), 'interactive user');
  assert.equal(kindOf(U(ID(1), 'x', { accessmode: 1 })), 'interactive user');
  assert.equal(kindOf(U(ID(1), 'x', { accessmode: 2 })), null);   // support user
  assert.equal(kindOf(U(ID(1), 'x', { accessmode: 5 })), null);
  assert.equal(kindOf(null), null);
});

test('pickUserB: never the owner, SYSTEM, INTEGRATION, a disabled user, a name starting with # or an unused kind', () => {
  const users = [
    U(A, 'Owner'),
    U(ID(4), 'SYSTEM', { accessmode: 4 }), U(ID(5), 'integration', { accessmode: 4 }),
    U(ID(6), '# Platform app', { applicationid: 'p', accessmode: 4 }), U(ID(7), '#Other', { applicationid: 'q', accessmode: 4 }),
    U(ID(8), 'Disabled app', { applicationid: 'r', accessmode: 4, isdisabled: true }),
    U(ID(9), 'Support', { accessmode: 2 }), U(ID(2), 'Unknown kind', { accessmode: 5 }),
  ];
  assert.equal(pickUserB(users, A.toUpperCase()), null);
  assert.equal(pickUserB([], A), null);
  assert.equal(pickUserB(undefined, A), null);
  assert.equal(pickUserB([null, {}], A), null);
});

test('pickUserB prefers an application user, then a non-interactive user, then an interactive user', () => {
  const owner = U(A, 'Owner'); const person = U(B, 'Second person'); const noninter = U(C, 'Batch account', { accessmode: 3 }); const app = U(ID(7), 'Zeta app', { applicationid: 'a', accessmode: 4 });
  assert.deepEqual(pickUserB([owner, person, noninter, app], A), { id: ID(7), kind: 'application user', namePrefix: 'Zeta' });
  assert.equal(pickUserB([owner, person, noninter], A).kind, 'non-interactive user');
  assert.equal(pickUserB([owner, person], A).kind, 'interactive user');
});

test('pickUserB is deterministic: the order of the input does not matter (name, then id)', () => {
  const a = U(ID(6), 'beta', { applicationid: 'a', accessmode: 4 }); const b = U(ID(5), 'Alpha', { applicationid: 'b', accessmode: 4 }); const c = U(ID(4), 'alpha', { applicationid: 'c', accessmode: 4 });
  const orders = [[a, b, c], [c, b, a], [b, a, c], [c, a, b]];
  const picks = orders.map((o) => pickUserB(o, A).id);
  assert.deepEqual([...new Set(picks)], [ID(4)]);   // 'alpha' = 'Alpha' case-insensitively, then the smaller id (the owner A is ID(1), never chosen)
});

test('pickUserB returns only the first 4 characters of the name, and describeB / isNonInteractive show the limitation', () => {
  const b = pickUserB([U(A, 'Owner'), U(ID(7), 'Muwafaqa test app', { applicationid: 'a', accessmode: 4 })], A);
  assert.equal(b.namePrefix, 'Muwa');
  assert.ok(!JSON.stringify(b).includes('Muwafaqa'));
  assert.equal(describeB(b), 'application user, name starts with "Muwa"');
  assert.equal(isNonInteractive(b), true);
  assert.equal(isNonInteractive({ kind: 'non-interactive user', namePrefix: 'S' }), true);
  assert.equal(isNonInteractive({ kind: 'interactive user', namePrefix: 'S' }), false);
  assert.equal(isNonInteractive(null), false);
  assert.equal(describeB(null), 'none');
});

test('expectations: phase 1 is Create and Update, phase 2 is Delete, all on the same row', () => {
  assert.deepEqual(expectationsFor('r', 1).map((e) => e.operation), [1, 2]);
  assert.deepEqual(expectationsFor('r', 2).map((e) => e.operation), [3]);
  assert.ok(expectationsFor('r', 1).every((e) => e.objectid === 'r'));
});

test('request bodies: the temporary row has no role (the key allows one row per role) and only the lookup moves', () => {
  const c = createBody(A);
  assert.equal(c.mwf_name, `${PREFIX} assignment`);
  assert.equal(c[USER_BIND_KEY], `/systemusers(${A})`);
  assert.equal('mwf_approverrole' in c, false);
  assert.deepEqual(moveBody(B), { [USER_BIND_KEY]: `/systemusers(${B})` });
  assert.equal(isTestRow(c.mwf_name), true);
  assert.equal(isTestRow('Owner assignment'), false);
  assert.equal(isTestRow(undefined), false);
});

// ---- the bind key of the lookup mwf_user: HTTP 400 on 2026-10-25 when it was written in lower case (the navigation property name is case-sensitive)
import { USER_BIND_KEY } from './assignment-columns.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const LOADER = readFileSync(join(HERE, '..', 'load-approver-assignment.mjs'), 'utf8');

test('the bind key of mwf_user is exactly the one the approver loader uses: mwf_User@odata.bind (capital U)', () => {
  assert.equal(USER_BIND_KEY, 'mwf_User@odata.bind');
  // the loader sends this key through the shared constant and keeps no copy of its own (a copy in another letter case is the defect of 2026-10-25)
  const importsConstant = LOADER.includes("import { USER_BIND_KEY } from './lib/assignment-columns.mjs'");
  const sendsConstant = LOADER.includes('[USER_BIND_KEY]:');
  const literalCopies = [...LOADER.matchAll(/'(mwf_user@odata\.bind)'/gi)].map((m) => m[1]);
  assert.ok(importsConstant && sendsConstant, 'the loader must import USER_BIND_KEY and send it');
  assert.deepEqual(literalCopies, [], 'the loader must not keep its own copy of the key');
});

test('createBody and moveBody use that key, with no lower-case variant anywhere in the body', () => {
  assert.deepEqual(Object.keys(createBody(A)).sort(), ['mwf_name', USER_BIND_KEY].sort());
  assert.deepEqual(Object.keys(moveBody(B)), [USER_BIND_KEY]);
  assert.ok(!JSON.stringify([createBody(A), moveBody(B)]).includes('mwf_user@odata.bind'));
});
