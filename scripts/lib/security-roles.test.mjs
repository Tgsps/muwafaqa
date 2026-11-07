import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('organization-owned tables only get Global; only the Requester has User level, and only on the contract and the obligation', () => {
  for (const r of ROLES) for (const x of flattenRole(r)) {
    if (TABLES[x.table].ownership === 'OrganizationOwned') assert.equal(x.depth, 'Global', `${r.name} ${x.table}`);
    if (x.depth === 'Basic') { assert.equal(r.name, 'Muwafaqa Requester'); assert.ok(['contract', 'obligation'].includes(x.table), x.table); }
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
  for (const bad of [...FORBIDDEN_BYPASS, 'prvCreatemwf_ContractNumberCounter', 'prvReadmwf_contractnumbercounter', 'prvReadmwf_AlertLog', 'prvCreatemwf_alertlog', 'prvAssignmwf_Contract', 'prvSharemwf_Contract', 'prvBypassSomethingNew']) {
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

test('the Admin role alone holds the two audit read privileges, at Global; the counts with the obligation are 13 / 4 / 10 / 28 (22 for the Admin before it)', () => {
  const counts = Object.fromEntries(ROLES.map((r) => [r.name, desiredPrivileges(r).length]));
  assert.deepEqual(counts, { 'Muwafaqa Requester': 13, 'Muwafaqa Approver': 4, 'Muwafaqa Finance': 10, 'Muwafaqa Admin': 28 });
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

// ---- S8 of verify-approval-chain-schema: the project roles on the steps and the assignments, against the design
import { compareProjectRolesOnTables } from './security-roles.mjs';

const TWO = ['mwf_approvalstep', 'mwf_approverassignment'];
const designedOnTwo = () => Object.fromEntries(ROLES.map((r) => [r.name, desiredPrivileges(r).filter((d) => d.table === 'step' || d.table === 'assignment').map((d) => d.key)]));

test('S8: the design itself passes (Requester none, Approver steps Read, Finance steps and assignments Read, Admin steps Read and all six on the assignments)', () => {
  const a = designedOnTwo();
  assert.equal(a['Muwafaqa Requester'].length, 0);
  assert.deepEqual(a['Muwafaqa Approver'], ['prvreadmwf_approvalstep']);
  assert.equal(a['Muwafaqa Finance'].length, 2);
  assert.equal(a['Muwafaqa Admin'].length, 7);
  assert.deepEqual(compareProjectRolesOnTables(a, TWO), { ok: true, unknownRoles: [], extra: [], missing: [] });
});

test('S8: privilege names are compared without regard to letter case', () => {
  const a = designedOnTwo();
  a['Muwafaqa Admin'] = a['Muwafaqa Admin'].map((n) => n.replace('prvr', 'prvR').replace('mwf_approverassignment', 'mwf_ApproverAssignment'));
  assert.equal(compareProjectRolesOnTables(a, TWO).ok, true);
});

test('S8: Write, Create, Delete or Append on the steps is an extra privilege, for any role', () => {
  for (const role of ['Muwafaqa Requester', 'Muwafaqa Approver', 'Muwafaqa Finance', 'Muwafaqa Admin']) for (const act of ['create', 'write', 'delete', 'append', 'appendto']) {
    const a = designedOnTwo(); a[role].push(`prv${act}mwf_approvalstep`);
    const v = compareProjectRolesOnTables(a, TWO);
    assert.equal(v.ok, false, `${role} ${act}`);
    assert.deepEqual(v.extra, [{ role, name: `prv${act}mwf_approvalstep` }]);
  }
});

test('S8: the Requester reading the steps, or any role reading the assignments beyond the design, is extra', () => {
  let a = designedOnTwo(); a['Muwafaqa Requester'].push('prvreadmwf_approvalstep');
  assert.equal(compareProjectRolesOnTables(a, TWO).ok, false);
  a = designedOnTwo(); a['Muwafaqa Approver'].push('prvreadmwf_approverassignment');
  assert.equal(compareProjectRolesOnTables(a, TWO).ok, false);
});

test('S8: Assign and Share are extra, whatever the role', () => {
  for (const n of ['prvassignmwf_approvalstep', 'prvsharemwf_approverassignment']) {
    const a = designedOnTwo(); a['Muwafaqa Admin'].push(n);
    assert.deepEqual(compareProjectRolesOnTables(a, TWO).extra, [{ role: 'Muwafaqa Admin', name: n }]);
  }
});

test('S8: a designed privilege that a role lacks is missing, and so is a whole role that is absent', () => {
  let a = designedOnTwo(); a['Muwafaqa Admin'] = a['Muwafaqa Admin'].filter((n) => n !== 'prvdeletemwf_approverassignment');
  assert.deepEqual(compareProjectRolesOnTables(a, TWO).missing, [{ role: 'Muwafaqa Admin', name: 'prvdeletemwf_approverassignment' }]);
  a = designedOnTwo(); delete a['Muwafaqa Approver'];
  assert.deepEqual(compareProjectRolesOnTables(a, TWO).missing, [{ role: 'Muwafaqa Approver', name: 'prvreadmwf_approvalstep' }]);
});

test('S8: a project role that is not one of the four and holds a privilege on the tables is unknown; one that holds none is ignored', () => {
  let a = designedOnTwo(); a['Some Other Role'] = ['prvreadmwf_approvalstep'];
  assert.deepEqual(compareProjectRolesOnTables(a, TWO).unknownRoles, ['Some Other Role']);
  a = designedOnTwo(); a['Some Other Role'] = [];
  assert.equal(compareProjectRolesOnTables(a, TWO).ok, true);
});

test('S8: privileges on other tables are not looked at', () => {
  const a = designedOnTwo(); a['Muwafaqa Requester'].push('prvcreatemwf_contract', 'prvdeletemwf_counterparty');
  assert.equal(compareProjectRolesOnTables(a, TWO).ok, true);
});

// ---------------------------------------------------------------------------------------------------------------- the obligation (ADR-008, update 2026-11-07): design, counts, rules, verify, the mode add-obligation
import { EXPECTED_COUNTS, countCheck, roleVerdict, ADDED_TABLES, roleWithoutTables, addedTablesPlan } from './security-roles.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REQ = 'Muwafaqa Requester'; const APR = 'Muwafaqa Approver'; const FIN = 'Muwafaqa Finance'; const ADM = 'Muwafaqa Admin';
const roleOf = (n) => ROLES.find((r) => r.name === n);
const OLD = (role) => desiredPrivileges(roleWithoutTables(role)).map((d) => ({ name: d.key, depth: d.depth }));   // what the live role holds today (the design of before)
const FULL = (role) => desiredPrivileges(role).map((d) => ({ name: d.key, depth: d.depth }));                       // what the role holds when the design is applied
const BASE9 = PLATFORM_BASELINE.map((n) => ({ name: n, depth: 'Global' }));
const NEW_ON = { [REQ]: 5, [APR]: 1, [FIN]: 1, [ADM]: 6 };

test('the grants on the obligation are exactly the owner\'s design: Requester Create, Read, Write, Delete, Append at User (no Append To); Approver and Finance Read at Organization; Admin the six at Organization; no grant on the alert log', () => {
  assert.deepEqual(roleOf(REQ).grants.obligation, { Create: 'Basic', Read: 'Basic', Write: 'Basic', Delete: 'Basic', Append: 'Basic' });
  assert.deepEqual(roleOf(APR).grants.obligation, { Read: 'Global' }); assert.deepEqual(roleOf(FIN).grants.obligation, { Read: 'Global' });
  assert.deepEqual(roleOf(ADM).grants.obligation, { Create: 'Global', Read: 'Global', Write: 'Global', Delete: 'Global', Append: 'Global', AppendTo: 'Global' });
  for (const r of ROLES) assert.equal(r.grants.alertlog, undefined, r.name);
  assert.equal(TABLES.obligation.ownership, 'UserOwned'); assert.equal(TABLES.alertlog.ownership, 'OrganizationOwned');
  assert.deepEqual(ADDED_TABLES, ['obligation']);
  assert.deepEqual(validateDesign(), []);
});

test('the counts: Requester 13, Approver 4, Finance 10, Admin 28 by the design, equal to the fixed table EXPECTED_COUNTS (8 / 3 / 9 / 22 before the obligation)', () => {
  const counts = Object.fromEntries(ROLES.map((r) => [r.name, desiredPrivileges(r).length]));
  assert.deepEqual(counts, { [REQ]: 13, [APR]: 4, [FIN]: 10, [ADM]: 28 }); assert.deepEqual({ ...EXPECTED_COUNTS }, counts);
  assert.deepEqual(Object.fromEntries(ROLES.map((r) => [r.name, desiredPrivileges(roleWithoutTables(r)).length])), { [REQ]: 8, [APR]: 3, [FIN]: 9, [ADM]: 22 });
  for (const r of ROLES) { const c = countCheck(r, FULL(r)); assert.equal(c.designed, c.expected, r.name); assert.equal(c.designOk, true); assert.equal(c.storedOk, true); assert.equal(c.tolerated, 0); }
  assert.ok(Object.isFrozen(EXPECTED_COUNTS));
});

test('R9: any grant on the alert log, in any role and at any depth, is a violation (the design has none); R10: User level on the obligation only for the Requester', () => {
  const bad = (mutate) => { const r = clone(ROLES); mutate(r); return validateDesign(r); };
  for (let i = 0; i < 4; i++) for (const [action, depth] of [['Read', 'Global'], ['Create', 'Global'], ['Delete', 'Global'], ['Read', 'Basic']]) {
    assert.ok(bad((r) => { r[i].grants.alertlog = { [action]: depth }; }).some((v) => v.startsWith('R9')), `${ROLES[i].name} ${action} ${depth}`);
  }
  assert.ok(bad((r) => { r[3].grants.alertlog = g6(); }).filter((v) => v.startsWith('R9')).length === 6);
  assert.ok(bad((r) => { r[1].grants.obligation.Read = 'Basic'; }).some((v) => v.startsWith('R10')));
  assert.ok(bad((r) => { r[3].grants.obligation.Create = 'Basic'; }).some((v) => v.startsWith('R10')));
  assert.ok(!bad((r) => { r[0].grants.obligation.Write = 'Basic'; }).some((v) => v.startsWith('R10')));   // the Requester may have User level
  assert.equal(negativeFindings({ [APR]: [{ name: 'prvReadmwf_AlertLog' }] }).length, 1);   // the real roles: any privilege on the alert log is a finding
  assert.equal(negativeFindings({ [ADM]: [{ name: 'prvCreatemwf_alertlog' }, { name: 'prvReadmwf_Obligation' }] }).length, 1);
  function g6() { return Object.fromEntries(ACTIONS.filter((a) => !['Assign', 'Share'].includes(a)).map((a) => [a, 'Global'])); }
});

test('privilege names: derived by the same rule as every other table (prv + action + the logical name, matched case-insensitively against the privileges table); Append and Append To follow it and are told apart', () => {
  assert.deepEqual(desiredPrivileges(roleOf(REQ)).filter((d) => d.table === 'obligation').map((d) => d.key), ['prvcreatemwf_obligation', 'prvreadmwf_obligation', 'prvwritemwf_obligation', 'prvdeletemwf_obligation', 'prvappendmwf_obligation']);
  assert.ok(desiredPrivileges(roleOf(ADM)).some((d) => d.key === 'prvappendtomwf_obligation'));
  // the 14 rows as the environment holds them (read on 2026-11-07): the obligation has eight, the alert log six
  const rows = ['Append', 'AppendTo', 'Assign', 'Create', 'Delete', 'Read', 'Share', 'Write'].map((a) => ({ name: `prv${a}mwf_Obligation` })).concat(['Append', 'AppendTo', 'Create', 'Delete', 'Read', 'Write'].map((a) => ({ name: `prv${a}mwf_AlertLog` })));
  for (const r of ROLES) for (const d of desiredPrivileges(r).filter((x) => x.table === 'obligation')) assert.equal(resolveDesired(rows, d).ok, true, `${r.name} ${d.key}`);
  assert.equal(resolvePrivilege(rows, 'Append', 'mwf_obligation').row.name, 'prvAppendmwf_Obligation'); assert.equal(resolvePrivilege(rows, 'AppendTo', 'mwf_obligation').row.name, 'prvAppendTomwf_Obligation');
  assert.deepEqual(parsePrivilegeName('prvAppendTomwf_Obligation'), { action: 'AppendTo', logical: 'mwf_obligation' }); assert.deepEqual(parsePrivilegeName('prvAppendmwf_Obligation'), { action: 'Append', logical: 'mwf_obligation' });
  assert.deepEqual(parsePrivilegeName('prvReadmwf_AlertLog'), { action: 'Read', logical: 'mwf_alertlog' });
});

test('countCheck: the stored count is the stored privileges minus the nine baseline privileges tolerated at Global; a baseline privilege at another depth, a missing privilege or an extra one is not', () => {
  const r = roleOf(APR);
  assert.equal(countCheck(r, [...FULL(r), ...BASE9]).storedOk, true); assert.equal(countCheck(r, [...FULL(r), ...BASE9]).tolerated, 9);
  assert.equal(countCheck(r, [...FULL(r), { name: PLATFORM_BASELINE[0], depth: 'Basic' }]).storedOk, false);   // at another depth it is not tolerated
  assert.equal(countCheck(r, FULL(r).slice(1)).storedOk, false);
  assert.equal(countCheck(r, [...FULL(r), { name: 'prvReadmwf_AlertLog', depth: 'Global' }]).storedOk, false);
  const broken = clone(r); delete broken.grants.obligation; assert.equal(countCheck(broken, FULL(broken)).designOk, false);   // an edit of the design is caught
  assert.equal(countCheck(r, undefined).stored, 0);
});

test('verify against a mock, correct and incorrect (roleVerdict): the designed state passes with or without the baseline; the state of before, an extra, a wrong depth, an unknown mask and any alert log privilege fail', () => {
  for (const r of ROLES) { assert.equal(roleVerdict(r, FULL(r)).ok, true, r.name); assert.equal(roleVerdict(r, [...FULL(r), ...BASE9]).ok, true, `${r.name} + baseline`); }
  for (const r of ROLES) {   // the live roles today: the obligation privileges are missing
    const v = roleVerdict(r, [...OLD(r), ...BASE9]); assert.equal(v.ok, false, r.name); assert.equal(v.diff.missing.length, NEW_ON[r.name]); assert.equal(v.count.storedOk, false); assert.equal(v.count.designOk, true);
  }
  const req = roleOf(REQ);
  const wrong = FULL(req).map((x) => (x.name === 'prvreadmwf_obligation' ? { ...x, depth: 'Global' } : x)); const vw = roleVerdict(req, wrong); assert.equal(vw.ok, false); assert.deepEqual(vw.diff.wrongDepth, ['prvreadmwf_obligation']);
  const ex = roleVerdict(req, [...FULL(req), { name: 'prvAppendTomwf_Obligation', depth: 'Basic' }]); assert.equal(ex.ok, false); assert.deepEqual(ex.diff.extra, ['prvappendtomwf_obligation']); assert.equal(ex.count.storedOk, false);
  const unk = roleVerdict(req, [...FULL(req).slice(1), { ...FULL(req)[0], depth: null }]); assert.equal(unk.ok, false); assert.equal(unk.unknown.length, 1);
  const al = roleVerdict(roleOf(ADM), [...FULL(roleOf(ADM)), { name: 'prvReadmwf_AlertLog', depth: 'Global' }]); assert.equal(al.ok, false); assert.equal(al.negative.length, 1); assert.deepEqual(al.diff.extra, ['prvreadmwf_alertlog']);
});

test('add-obligation, the plan (addedTablesPlan): from the state of before it sends exactly the obligation privileges (5 / 1 / 1 / 6) at their designed depth, and nothing on any other table or on the alert log', () => {
  for (const r of ROLES) {
    const p = addedTablesPlan(r, [...OLD(r), ...BASE9]);
    assert.equal(p.ok, true, r.name); assert.equal(p.missing.length, NEW_ON[r.name], r.name);
    for (const d of p.missing) { assert.equal(d.table, 'obligation'); assert.equal(parsePrivilegeName(d.key).logical, 'mwf_obligation'); assert.ok(!d.key.includes('mwf_alertlog')); assert.equal(d.depth, r.grants.obligation[d.action]); }
    const body = addPrivilegesBody(p.missing.map((d) => ({ privilegeid: d.key, depth: d.depth })));
    assert.equal(body.Privileges.length, NEW_ON[r.name]); assert.ok(body.Privileges.every((x) => x.Depth === (r.name === REQ ? '0' : '3')), r.name);
  }
});

test('add-obligation is idempotent: after the plan is applied (to the mock) the second plan has nothing to send, and again after a third; a partial state sends only the rest', () => {
  for (const r of ROLES) {
    let stored = [...OLD(r), ...BASE9];
    const apply = (plan) => { stored = [...stored, ...plan.missing.map((d) => ({ name: d.key, depth: d.depth }))]; };
    const first = addedTablesPlan(r, stored); assert.equal(first.missing.length, NEW_ON[r.name]); apply(first);
    const second = addedTablesPlan(r, stored); assert.equal(second.ok, true); assert.equal(second.missing.length, 0, `${r.name} second run`); apply(second);
    assert.equal(addedTablesPlan(r, stored).missing.length, 0); assert.equal(roleVerdict(r, stored).ok, true, `${r.name} verifies after the apply`);
  }
  const adm = roleOf(ADM); const part = addedTablesPlan(adm, [...OLD(adm), ...BASE9, ...FULL(adm).filter((x) => x.name.endsWith('mwf_obligation')).slice(0, 2)]);
  assert.equal(part.ok, true); assert.equal(part.missing.length, 4);
});

test('add-obligation refuses (ok false, nothing to send) when the rest of the role is not as designed, when it holds any privilege on the alert log, or when an obligation privilege is at another depth or not designed', () => {
  const req = roleOf(REQ); const base = [...OLD(req), ...BASE9];
  const noContractRead = addedTablesPlan(req, base.filter((x) => x.name !== 'prvreadmwf_contract')); assert.equal(noContractRead.ok, false); assert.equal(noContractRead.rest.missing.length, 1);
  const alertlog = addedTablesPlan(req, [...base, { name: 'prvReadmwf_AlertLog', depth: 'Global' }]); assert.equal(alertlog.ok, false); assert.deepEqual(alertlog.rest.extra, ['prvreadmwf_alertlog']);
  const wrongDepth = addedTablesPlan(req, [...base, { name: 'prvReadmwf_Obligation', depth: 'Global' }]); assert.equal(wrongDepth.ok, false); assert.equal(wrongDepth.wrongDepth.length, 1);
  const notDesigned = addedTablesPlan(req, [...base, { name: 'prvAppendTomwf_Obligation', depth: 'Basic' }]); assert.equal(notDesigned.ok, false); assert.deepEqual(notDesigned.extra, ['prvappendtomwf_obligation']);
  const baselineBasic = addedTablesPlan(req, [...OLD(req), { name: PLATFORM_BASELINE[0], depth: 'Basic' }]); assert.equal(baselineBasic.ok, false);   // a baseline privilege is tolerated only at Global
  const assign = addedTablesPlan(req, [...base, { name: 'prvAssignmwf_Obligation', depth: 'Basic' }]); assert.equal(assign.ok, false);   // Assign and Share are never designed
});

test('roleWithoutTables removes the grants of the added tables and keeps everything else, the audit read of the Admin included', () => {
  const adm = roleOf(ADM); const w = roleWithoutTables(adm);
  assert.equal(w.grants.obligation, undefined); assert.deepEqual(w.extra, adm.extra); assert.equal(desiredPrivileges(w).length, 22);
  assert.deepEqual(Object.keys(w.grants), Object.keys(adm.grants).filter((t) => t !== 'obligation'));
  assert.equal(adm.grants.obligation !== undefined, true);   // the original is not changed
});

test('the script: add-obligation is a known mode that needs --confirm-mutates-environment (exit 2 before any network access), an unknown mode is refused, and the source never lists a privilege on the alert log', () => {
  const SCRIPT = fileURLToPath(new URL('../create-security-roles.mjs', import.meta.url));
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', timeout: 30000 });
  const refused = run('--mode=add-obligation', '--role=Approver', '--env=https://example.invalid', '--auth=az'); assert.equal(refused.status, 2); assert.match(refused.stderr, /--mode=add-obligation writes security roles/); assert.match(refused.stderr, /Nothing was run/);
  const unknown = run('--mode=add-nothing', '--env=https://example.invalid', '--auth=az'); assert.equal(unknown.status, 2); assert.match(unknown.stderr, /add-obligation/);
  const src = fs.readFileSync(SCRIPT, 'utf8'); assert.match(src, /async function modeAddObligation/); assert.match(src, /addedTablesPlan\(r\.role, stored\)/); assert.match(src, /roleVerdict\(role, stored\)/);
});
