import test from 'node:test';
import assert from 'node:assert/strict';
import { ENV_NAMES, PREFIX, NIL_ID, ROLE_ORDER, CASES, missingEnv, tokenRequest, associatePath, associateBody, disassociatePath, makeRedactor, judge, judgeProbeOnNilId, shortMessage, pollUntil, startRolesOk, phaseDecision, rolesToRelease, parseRolesArg, redactThenShorten } from './security-test.mjs';
import { ROLE_NAMES } from './security-roles.mjs';

test('the environment variable names are exactly the three agreed ones', () => {
  assert.deepEqual(ENV_NAMES, ['MWF_TEST_TENANT_ID', 'MWF_TEST_CLIENT_ID', 'MWF_TEST_CLIENT_SECRET']);
});

test('missingEnv returns names only, for absent, empty and blank values', () => {
  assert.deepEqual(missingEnv({}), ENV_NAMES);
  assert.deepEqual(missingEnv({ MWF_TEST_TENANT_ID: 'x', MWF_TEST_CLIENT_ID: '  ', MWF_TEST_CLIENT_SECRET: '' }), ['MWF_TEST_CLIENT_ID', 'MWF_TEST_CLIENT_SECRET']);
  assert.deepEqual(missingEnv({ MWF_TEST_TENANT_ID: 'a', MWF_TEST_CLIENT_ID: 'b', MWF_TEST_CLIENT_SECRET: 'c' }), []);
  const m = missingEnv({ MWF_TEST_TENANT_ID: 'super-secret-tenant' });
  assert.ok(!JSON.stringify(m).includes('super-secret'));
});

test('tokenRequest is a client credentials request with the environment scope', () => {
  const r = tokenRequest('tenant-1', 'client-1', 'dummy-secret', 'https://example.test/');
  assert.equal(r.url, 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
  const p = new URLSearchParams(r.body);
  assert.equal(p.get('grant_type'), 'client_credentials');
  assert.equal(p.get('client_id'), 'client-1');
  assert.equal(p.get('client_secret'), 'dummy-secret');
  assert.equal(p.get('scope'), 'https://example.test/.default');
});

test('role association paths and body', () => {
  assert.equal(associatePath('u1'), 'systemusers(u1)/systemuserroles_association/$ref');
  assert.deepEqual(associateBody('https://example.test/', 'r1'), { '@odata.id': 'https://example.test/api/data/v9.2/roles(r1)' });
  // the form chosen by the owner: $ref?$id= with the absolute url of the role (Learn documents it next to the form with the key in parentheses)
  assert.equal(disassociatePath('u1', 'r1', 'https://example.test/'), 'systemusers(u1)/systemuserroles_association/$ref?$id=https://example.test/api/data/v9.2/roles(r1)');
  assert.equal(disassociatePath('u1', 'r1', 'https://example.test'), disassociatePath('u1', 'r1', 'https://example.test/'));
});

test('the redactor removes the host, the org name, GUIDs and any secret value', () => {
  const red = makeRedactor('https://orgabc123.crm4.dynamics.com', ['s3cr3t-value-xyz']);
  const sample = ['0f8fad5b', 'd9cb', '469f', 'a165', '70867728950e'].join('-');   // a sample GUID built at run time
  const t = red(`GET https://orgabc123.crm4.dynamics.com/api failed for orgabc123 user ${sample} with s3cr3t-value-xyz`);
  assert.ok(!/orgabc123|dynamics\.com|s3cr3t|0f8fad5b/.test(t), t);
  assert.ok(t.includes('<id>'));
  assert.equal(makeRedactor('', []) ('plain text'), 'plain text');
});

test('judge: allow needs a 2xx; deny needs 401 or 403 or an accepted status', () => {
  assert.equal(judge('allow', 204), 'PASS'); assert.equal(judge('allow', 200), 'PASS'); assert.equal(judge('allow', 403), 'FAIL'); assert.equal(judge('allow', 400), 'FAIL');
  assert.equal(judge('deny', 403), 'PASS'); assert.equal(judge('deny', 401), 'PASS');
  assert.equal(judge('deny', 204), 'FAIL'); assert.equal(judge('deny', 404), 'FAIL'); assert.equal(judge('deny', 400), 'FAIL');
  assert.equal(judge('deny', 400, [400]), 'PASS'); assert.equal(judge('deny', 404, [404]), 'PASS');
  assert.throws(() => judge('maybe', 200));
});

test('judgeProbeOnNilId: 403 is conclusive, 404 is not, 2xx fails', () => {
  assert.equal(judgeProbeOnNilId(403), 'PASS'); assert.equal(judgeProbeOnNilId(404), 'OBS'); assert.equal(judgeProbeOnNilId(204), 'FAIL'); assert.equal(judgeProbeOnNilId(400), 'FAIL');
  assert.match(NIL_ID, /^0{8}-0{4}-0{4}-0{4}-0{11}1$/);
});

test('shortMessage is single line and bounded', () => {
  const s = shortMessage('a\n  b\t c ' + 'x'.repeat(500), 50);
  assert.ok(!/\s{2}/.test(s) && s.length <= 50);
});

test('pollUntil reaches the state, or gives up before the timeout without sleeping past it', async () => {
  let t = 0; const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); t += ms; };
  let n = 0;
  const ok = await pollUntil(async () => ++n >= 3, { timeoutMs: 100000, everyMs: 15000, sleep, now: () => t });
  assert.equal(ok.reached, true); assert.deepEqual(sleeps, [15000, 15000]);
  t = 0; sleeps.length = 0;
  const no = await pollUntil(async () => false, { timeoutMs: 40000, everyMs: 15000, sleep, now: () => t });
  assert.equal(no.reached, false); assert.ok(no.waitedMs <= 40000);
});

test('the role order and the cases match the four roles of ADR-008; the prefix is independent of the other test prefixes', () => {
  assert.deepEqual(ROLE_ORDER, ROLE_NAMES);
  assert.deepEqual(Object.keys(CASES), ROLE_NAMES);
  for (const other of ['TEST-TMP-FF', 'TEST-TMP-BULK', 'TEST-TMP-V2', 'TEST-TMP-CHAIN', 'TEST-TMP-GUARD', 'TEST-TMP-NUM', 'TEST-TMP-ROUND', 'TEST-TMP-STEP', 'TEST-TMP-USD', 'TEST-TMP-TRIG', 'TEST-TMP-GFLOW', 'TEST-TMP-CHK']) {
    assert.ok(!PREFIX.startsWith(other) && !other.startsWith(PREFIX), other);
  }
  const ids = Object.values(CASES).flat().map((c) => c[0]);
  assert.equal(new Set(ids).size, ids.length);
});

test('startRolesOk: none, or the Requester only', () => {
  assert.equal(startRolesOk([]), true);
  assert.equal(startRolesOk(['Muwafaqa Requester']), true);
  assert.equal(startRolesOk(['Muwafaqa Approver']), false);
  assert.equal(startRolesOk(['Muwafaqa Requester', 'Muwafaqa Admin']), false);
  assert.equal(startRolesOk(['Muwafaqa Requester', 'Basic User']), false);   // a role that is not ours also stops the start
  assert.equal(startRolesOk(undefined), true);
});

test('phaseDecision: assign when none is held, already when only the phase role is held, stop for anything else', () => {
  assert.deepEqual(phaseDecision([], 'Muwafaqa Approver'), { action: 'assign' });
  assert.deepEqual(phaseDecision(['Muwafaqa Requester'], 'Muwafaqa Requester'), { action: 'already' });
  assert.equal(phaseDecision(['Muwafaqa Requester'], 'Muwafaqa Approver').action, 'stop');
  assert.equal(phaseDecision(['Muwafaqa Approver', 'Muwafaqa Requester'], 'Muwafaqa Approver').action, 'stop');
  assert.equal(phaseDecision(['Basic User'], 'Muwafaqa Finance').action, 'stop');
  assert.match(phaseDecision(['Muwafaqa Admin'], 'Muwafaqa Finance').reason, /1 role\(s\) besides Muwafaqa Finance/);
});

test('rolesToRelease: only project roles, never another role', () => {
  assert.deepEqual(rolesToRelease(['Muwafaqa Requester', 'Basic User', 'Muwafaqa Admin']), ['Muwafaqa Requester', 'Muwafaqa Admin']);
  assert.deepEqual(rolesToRelease(['Basic User']), []);
  assert.deepEqual(rolesToRelease(undefined), []);
});

test('parseRolesArg: empty means all four; short and full names; the fixed order; unknown names are an error', () => {
  assert.deepEqual(parseRolesArg(''), ROLE_ORDER); assert.deepEqual(parseRolesArg(undefined), ROLE_ORDER);
  assert.deepEqual(parseRolesArg('Requester'), ['Muwafaqa Requester']);
  assert.deepEqual(parseRolesArg('admin, Muwafaqa Approver , requester'), ['Muwafaqa Requester', 'Muwafaqa Approver', 'Muwafaqa Admin']);
  assert.deepEqual(parseRolesArg('Finance,finance'), ['Muwafaqa Finance']);
  assert.throws(() => parseRolesArg('Requester,Boss'), /unknown role "Boss"/);
});

test('redactThenShorten redacts first, so identifiers shrink and the cut keeps more text; a cut never leaves part of a host or an id', () => {
  const red = makeRedactor('https://orgabc123.crm4.dynamics.com', []);
  const g1 = ['11111111', '2222', '3333', '4444', '555555555555'].join('-');
  const text = `Principal user (Id=${g1}, roleCount=1, host=orgabc123.crm4.dynamics.com) is missing prvReadmwf_ApprovalStep privilege (Id=${g1})`;
  const out = redactThenShorten(text, red, 90);
  assert.ok(out.includes('prvReadmwf_ApprovalStep'), out);
  assert.ok(!out.includes('orgabc123') && !out.includes('1111') && !out.includes('dynamics.com'));
  // cutting first would have cut inside the privilege name for the same budget
  assert.ok(!shortMessage(text, 90).includes('prvReadmwf_ApprovalStep'));
  assert.ok(redactThenShorten('x'.repeat(1000), red, 400).length <= 400);
  assert.equal(redactThenShorten(undefined, red), '');
});
