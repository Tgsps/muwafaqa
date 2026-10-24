import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, TABLES, ROLES, ROLE_NAMES, FORBIDDEN_BYPASS, privKey, flattenRole, validateDesign, resolvePrivilege, depthAllowed, depthOfMask, compareRolePrivileges, negativeFindings, desiredPrivileges, describeRole, parsePrivilegeName, PLATFORM_BASELINE, membersVerdict, AUDIT_READ, resolveDesired, describeExtras, missingDesigned, addPrivilegesBody, baselineState, checkBaselineExpectation, removePrivilegeBody, restoreBaselineBody, roleFromArg } from './security-roles.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));

test('the design as written has no violation', () => assert.deepEqual(validateDesign(), []));

test('four roles with the agreed names', () => {
  assert.deepEqual(ROLE_NAMES, ['Muwafaqa Requester', 'Muwafaqa Approver', 'Muwafaqa Finance', 'Muwafaqa Admin']);
});

test('no role holds Assign, Share, a counter privilege, or a Local / Deep depth', () => {
  for (const r of ROLES) for (const x of flattenRole(r)) {
    assert.ok(!['Assign', 'Share'].includes(x.action), `${r.name} ${x.action}`);
    assert.notEqual(x.table, 'counter', r.name);
    assert.ok(['Basic', 'Global'].includes(x.depth), `${r.name} ${x.table}.${x.action}`);
  }
});

test('organization-owned tables only get Global; only the Requester has User level, and only on the contract', () => {
  for (const r of ROLES) for (const x of flattenRole(r)) {
    if (TABLES[x.table].ownership === 'OrganizationOwned') assert.equal(x.depth, 'Global', `${r.name} ${x.table}`);
    if (x.depth === 'Basic') { assert.equal(r.name, 'Muwafaqa Requester'); assert.equal(x.table, 'contract'); }
  }
});

test('the Approver and the Finance role read the contract at Organization level and nothing more on it', () => {
  for (const n of ['Muwafaqa Approver', 'Muwafaqa Finance', 'Muwafaqa Admin']) {
    const r = ROLES.find((x) => x.name === n);
    assert.deepEqual(r.grants.contract, { Read: 'Global' }, n);
  }
});

test('the Admin role has no privilege on the counter table and no bypass privilege', () => {
  const admin = ROLES.find((r) => r.name === 'Muwafaqa Admin');
  assert.equal(admin.grants.counter, undefined);
  assert.deepEqual(negativeFindings({ admin: desiredPrivileges(admin).map((d) => ({ name: d.key })) }), []);
});

test('validateDesign catches every kind of violation', () => {
  const bad = (mutate) => { const r = clone(ROLES); mutate(r); return validateDesign(r); };
  assert.ok(bad((r) => { r[0].grants.contract.Assign = 'Basic'; }).some((v) => v.startsWith('R1')));
  assert.ok(bad((r) => { r[3].grants.contract.Share = 'Global'; }).some((v) => v.startsWith('R1')));
  assert.ok(bad((r) => { r[3].grants.counter = { Read: 'Global' }; }).some((v) => v.startsWith('R2')));
  assert.ok(bad((r) => { r[1].grants.step.Read = 'Basic'; }).some((v) => v.startsWith('R3')));
  assert.ok(bad((r) => { r[1].grants.contract.Read = 'Basic'; }).some((v) => v.startsWith('R4')));
  assert.ok(bad((r) => { r[1].grants.contract.Write = 'Global'; }).some((v) => v.startsWith('R4')));
  assert.ok(bad((r) => { r[0].grants.contract.Read = 'Local'; }).some((v) => v.startsWith('R5')));
  assert.ok(bad((r) => { r[0].grants.nothing = { Read: 'Global' }; }).some((v) => v.startsWith('R6')));
  assert.ok(bad((r) => { r[0].grants.contract.Fly = 'Basic'; }).some((v) => v.startsWith('R6')));
  assert.ok(bad((r) => { r[1].name = r[0].name; }).some((v) => v.startsWith('R7')));
});

test('privKey is case-insensitive and resolvePrivilege needs exactly one match', () => {
  assert.equal(privKey('Create', 'mwf_contract'), 'prvcreatemwf_contract');
  const rows = [{ name: 'prvCreatemwf_Contract' }, { name: 'prvReadmwf_Contract' }, { name: 'prvCreatemwf_approvalmatrix' }];
  assert.equal(resolvePrivilege(rows, 'Create', 'mwf_contract').ok, true);
  assert.equal(resolvePrivilege(rows, 'Create', 'mwf_approvalmatrix').ok, true);
  assert.equal(resolvePrivilege(rows, 'Delete', 'mwf_contract').ok, false);
  assert.equal(resolvePrivilege([...rows, { name: 'PRVCREATEMWF_CONTRACT' }], 'Create', 'mwf_contract').ok, false);
  assert.equal(resolvePrivilege(undefined, 'Create', 'x').ok, false);
});

test('depthAllowed reads the flags of the privilege row', () => {
  const row = { canbebasic: true, canbelocal: false, canbedeep: false, canbeglobal: true };
  assert.equal(depthAllowed(row, 'Basic'), true);
  assert.equal(depthAllowed(row, 'Local'), false);
  assert.equal(depthAllowed(row, 'Global'), true);
  assert.equal(depthAllowed(row, 'Nope'), false);
  assert.equal(depthAllowed(undefined, 'Basic'), false);
});

test('depthOfMask maps 1, 2, 4, 8 and never guesses another value', () => {
  assert.deepEqual([1, 2, 4, 8].map(depthOfMask), ['Basic', 'Local', 'Deep', 'Global']);
  assert.equal(depthOfMask(3), null);
  assert.equal(depthOfMask(undefined), null);
});

test('compareRolePrivileges finds missing, extra and wrong depth', () => {
  const want = [{ key: 'a', depth: 'Global' }, { key: 'b', depth: 'Basic' }];
  assert.equal(compareRolePrivileges(want, [{ name: 'A', depth: 'Global' }, { name: 'B', depth: 'Basic' }]).same, true);
  const r = compareRolePrivileges(want, [{ name: 'a', depth: 'Basic' }, { name: 'c', depth: 'Global' }]);
  assert.deepEqual(r.missing, ['b']); assert.deepEqual(r.extra, ['c']); assert.deepEqual(r.wrongDepth, ['a']); assert.equal(r.same, false);
  assert.equal(compareRolePrivileges(want, [{ name: 'a', depth: null }, { name: 'b', depth: 'Basic' }]).wrongDepth.length, 1);
});

test('the platform baseline is exactly the nine names of the owner decision', () => {
  assert.equal(PLATFORM_BASELINE.length, 9);
  assert.equal(new Set(PLATFORM_BASELINE.map((n) => n.toLowerCase())).size, 9);
  assert.ok(PLATFORM_BASELINE.every((n) => /^prv(Read|Write|Create)(SdkMessage|SdkMessageProcessingStep|SdkMessageProcessingStepImage|PluginType|PluginAssembly|SharePointDocument|SharePointData)$/.test(n)));
  assert.deepEqual(negativeFindings({ r: PLATFORM_BASELINE.map((name) => ({ name })) }), []);
});

test('compareRolePrivileges tolerates the baseline by name and only at Global', () => {
  const want = [{ key: 'a', depth: 'Global' }];
  const base = PLATFORM_BASELINE.map((name) => ({ name, depth: 'Global' }));
  const ok = compareRolePrivileges(want, [{ name: 'a', depth: 'Global' }, ...base], PLATFORM_BASELINE);
  assert.equal(ok.same, true); assert.equal(ok.tolerated, 9); assert.equal(ok.extra.length, 0);
  // without the tolerance list the same privileges are extra
  assert.equal(compareRolePrivileges(want, [{ name: 'a', depth: 'Global' }, ...base]).extra.length, 9);
  // a baseline name at another depth, or at an unknown depth, is NOT tolerated
  assert.equal(compareRolePrivileges(want, [{ name: 'a', depth: 'Global' }, { name: 'prvReadSdkMessage', depth: 'Basic' }], PLATFORM_BASELINE).same, false);
  assert.equal(compareRolePrivileges(want, [{ name: 'a', depth: 'Global' }, { name: 'prvReadSdkMessage', depth: null }], PLATFORM_BASELINE).same, false);
  // a baseline that is absent is fine (it is tolerated, not required: removing it later must still verify)
  assert.equal(compareRolePrivileges(want, [{ name: 'a', depth: 'Global' }], PLATFORM_BASELINE).same, true);
  // any privilege outside the design and outside the list fails
  const r = compareRolePrivileges(want, [{ name: 'a', depth: 'Global' }, ...base, { name: 'prvReadAccount', depth: 'Global' }, { name: 'prvBypassCustomPlugins', depth: 'Global' }], PLATFORM_BASELINE);
  assert.deepEqual(r.extra.sort(), ['prvbypasscustomplugins', 'prvreadaccount']); assert.equal(r.same, false);
});

test('negativeFindings flags bypass, counter and assign/share privileges in any role', () => {
  const clean = { r: [{ name: 'prvReadmwf_Contract' }] };
  assert.deepEqual(negativeFindings(clean), []);
  for (const bad of [...FORBIDDEN_BYPASS, 'prvCreatemwf_ContractNumberCounter', 'prvReadmwf_contractnumbercounter', 'prvAssignmwf_Contract', 'prvSharemwf_Contract', 'prvBypassSomethingNew']) {
    assert.equal(negativeFindings({ r: [{ name: 'prvReadmwf_Contract' }, { name: bad }] }).length, 1, bad);
  }
});

test('parsePrivilegeName reads the action and the table, AppendTo before Append, null for other names', () => {
  assert.deepEqual(parsePrivilegeName('prvAppendTomwf_Contract'), { action: 'AppendTo', logical: 'mwf_contract' });
  assert.deepEqual(parsePrivilegeName('prvAppendmwf_approvalmatrix'), { action: 'Append', logical: 'mwf_approvalmatrix' });
  assert.deepEqual(parsePrivilegeName('prvReadmwf_ContractNumberCounter'), { action: 'Read', logical: 'mwf_contractnumbercounter' });
  assert.equal(parsePrivilegeName('prvReadAccount'), null);
  assert.equal(parsePrivilegeName('prvBypassCustomBusinessLogic'), null);
  assert.equal(parsePrivilegeName(undefined), null);
});

test('desiredPrivileges and describeRole cover every grant', () => {
  for (const r of ROLES) {
    assert.equal(desiredPrivileges(r).length, flattenRole(r).length + (r.extra || []).length);
    assert.equal(describeRole(r).length, Object.keys(TABLES).length);
  }
  assert.ok(describeRole(ROLES[0])[0].startsWith('Contract: Create User, Read User'));
  assert.ok(ACTIONS.includes('AppendTo'));
});

test('membersVerdict: the application user is accepted as the one member of the Requester role only; any other member or any team fails', () => {
  const cid = 'client-1';
  const app = { applicationid: 'CLIENT-1' };   // compared case-insensitively
  const human = { applicationid: null };
  assert.deepEqual(membersVerdict('Muwafaqa Requester', [], 0, cid), { ok: true, appUsers: 0, others: 0 });
  assert.deepEqual(membersVerdict('Muwafaqa Requester', [app], 0, cid), { ok: true, appUsers: 1, others: 0 });
  assert.equal(membersVerdict('Muwafaqa Requester', [app, human], 0, cid).ok, false);
  assert.equal(membersVerdict('Muwafaqa Requester', [human], 0, cid).ok, false);
  assert.equal(membersVerdict('Muwafaqa Requester', [app], 1, cid).ok, false);          // a team member fails
  assert.equal(membersVerdict('Muwafaqa Requester', [app, app], 0, cid).ok, false);     // never more than one
  for (const r of ['Muwafaqa Approver', 'Muwafaqa Finance', 'Muwafaqa Admin']) assert.equal(membersVerdict(r, [app], 0, cid).ok, false, r);   // not allowed in the other roles
  assert.equal(membersVerdict('Muwafaqa Requester', [app], 0, undefined).ok, false);   // without the client id nobody is recognized
  assert.equal(membersVerdict('Muwafaqa Approver', [], 0, cid).ok, true);
});

test('baselineState: present at Global, wrong depth, missing', () => {
  const all = PLATFORM_BASELINE.map((name) => ({ name, depth: 'Global' }));
  assert.deepEqual(baselineState(all).missing, []); assert.equal(baselineState(all).present.length, 9);
  assert.equal(baselineState([]).missing.length, 9);
  const s = baselineState([{ name: 'prvreadsdkmessage', depth: 'Global' }, { name: 'prvReadPluginType', depth: 'Basic' }, { name: 'prvReadmwf_Contract', depth: 'Basic' }]);
  assert.deepEqual(s.present, ['prvReadSdkMessage']); assert.deepEqual(s.wrongDepth, ['prvReadPluginType']); assert.equal(s.missing.length, 7);
});

test('checkBaselineExpectation: none, all, any, and an invalid value', () => {
  assert.equal(checkBaselineExpectation('none', 0).ok, true); assert.equal(checkBaselineExpectation('none', 1).ok, false);
  assert.equal(checkBaselineExpectation('all', 9).ok, true); assert.equal(checkBaselineExpectation('all', 8).ok, false);
  for (const n of [0, 5, 9]) assert.equal(checkBaselineExpectation('any', n).ok, true);
  assert.equal(checkBaselineExpectation(undefined, 0).ok, true);   // the default is none: no baseline privilege present
  assert.equal(checkBaselineExpectation(undefined, 3).ok, false);  // ... and a re-addition is detected
  assert.equal(checkBaselineExpectation('', 1).ok, false);
  assert.throws(() => checkBaselineExpectation('some', 3));
});

test('the remove and restore bodies', () => {
  assert.deepEqual(removePrivilegeBody('p1'), { Privilege: { '@odata.type': 'Microsoft.Dynamics.CRM.privilege', privilegeid: 'p1' } });
  assert.deepEqual(restoreBaselineBody([{ privilegeid: 'a' }, { privilegeid: 'b' }]), { Privileges: [{ PrivilegeId: 'a', Depth: '3' }, { PrivilegeId: 'b', Depth: '3' }] });
});

test('roleFromArg accepts the short and the full name, case-insensitively, and rejects the rest', () => {
  assert.equal(roleFromArg('Requester'), 'Muwafaqa Requester');
  assert.equal(roleFromArg('muwafaqa admin'), 'Muwafaqa Admin');
  assert.throws(() => roleFromArg('Manager')); assert.throws(() => roleFromArg(''));
});

test('the Admin role alone holds the two audit read privileges (22 privileges), at Global; the others are unchanged (8 / 3 / 9)', () => {
  const counts = Object.fromEntries(ROLES.map((r) => [r.name, desiredPrivileges(r).length]));
  assert.deepEqual(counts, { 'Muwafaqa Requester': 8, 'Muwafaqa Approver': 3, 'Muwafaqa Finance': 9, 'Muwafaqa Admin': 22 });
  assert.deepEqual(AUDIT_READ.map((a) => [a.name, a.depth]), [['prvReadAuditSummary', 'Global'], ['prvReadRecordAuditHistory', 'Global']]);
  for (const r of ROLES) assert.equal((r.extra || []).length, r.name === 'Muwafaqa Admin' ? 2 : 0, r.name);
  assert.deepEqual(describeExtras(ROLES.find((r) => r.name === 'Muwafaqa Admin')), ['prvReadAuditSummary: Organization', 'prvReadRecordAuditHistory: Organization']);
  assert.deepEqual(validateDesign(), []);
});

test('validateDesign R8: an extra privilege for another role, an unknown extra, or another depth is a violation; the design with the extras has none', () => {
  const clone = () => JSON.parse(JSON.stringify(ROLES));
  const a = clone(); a[0].extra = [{ name: 'prvReadAuditSummary', depth: 'Global' }];
  assert.ok(validateDesign(a).some((v) => v.startsWith('R8')));
  const b = clone(); b[3].extra = [{ name: 'prvDeleteRecordChangeHistory', depth: 'Global' }];
  assert.ok(validateDesign(b).some((v) => v.startsWith('R8')));
  const c = clone(); c[3].extra = [{ name: 'prvReadAuditSummary', depth: 'Basic' }];
  assert.ok(validateDesign(c).some((v) => v.startsWith('R8')));
  const d = clone(); d[3].extra = [{ name: 'prvBypassCustomBusinessLogic', depth: 'Global' }];
  assert.ok(validateDesign(d).some((v) => v.startsWith('R8')));
});

test('resolveDesired finds an extra privilege by its exact name and a table privilege by table and action', () => {
  const rows = [{ name: 'prvReadAuditSummary' }, { name: 'prvReadmwf_Contract' }];
  const admin = ROLES.find((r) => r.name === 'Muwafaqa Admin');
  const extra = desiredPrivileges(admin).find((d) => d.extraName === 'prvReadAuditSummary');
  assert.equal(resolveDesired(rows, extra).ok, true);
  assert.equal(resolveDesired(rows, { extraName: 'prvReadRecordAuditHistory' }).ok, false);
  assert.equal(resolveDesired(rows, { action: 'Read', table: 'contract' }).ok, true);
});

test('missingDesigned finds the audit read privileges an existing Admin role lacks, and a wrong depth', () => {
  const admin = ROLES.find((r) => r.name === 'Muwafaqa Admin');
  const designedWithoutExtra = desiredPrivileges(admin).filter((d) => !d.extraName).map((d) => ({ name: d.key, depth: d.depth }));
  const m = missingDesigned(admin, designedWithoutExtra);
  assert.deepEqual(m.missing.map((d) => d.extraName), ['prvReadAuditSummary', 'prvReadRecordAuditHistory']); assert.deepEqual(m.wrongDepth, []);
  const full = [...designedWithoutExtra, { name: 'prvreadauditsummary', depth: 'Global' }, { name: 'prvReadRecordAuditHistory', depth: 'Basic' }];
  const m2 = missingDesigned(admin, full);
  assert.deepEqual(m2.missing, []); assert.deepEqual(m2.wrongDepth.map((d) => d.extraName), ['prvReadRecordAuditHistory']);
});

test('addPrivilegesBody uses the depth numbers (Global = 3, Basic = 0)', () => {
  assert.deepEqual(addPrivilegesBody([{ privilegeid: 'a', depth: 'Global' }, { privilegeid: 'b', depth: 'Basic' }]), { Privileges: [{ PrivilegeId: 'a', Depth: '3' }, { PrivilegeId: 'b', Depth: '0' }] });
});
