// Tests of the offline generator of the obligation alerts flow (ADR-011; docs/flow-obligation-alerts.md). Nothing here touches an environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { walk } from './build-flow-v2.mjs';
import {
  FLOW_NAME, TEST_CONSTANTS, MAX_MINUTES, VariantError, testVariant, productionVariant, TYPES_USED, KEY_LENGTHS, KEY_EXPRESSION, TYPE_EXPRESSION, GUARD_CONDITION, KEY_SAMPLES, LIMITS,
  buildDefinition, buildClientdata, checkClientdata, statsOf, queryFilter, evaluateKey, evaluateGuard, compareWithAlertKey, actionOutline, planLines,
} from './build-flow-obligation-alerts.mjs';
import { ALERT_TYPES, buildAlertKey, validateAlertKey } from './lib/alert-key.mjs';
import { evalTemplate, evalCondition } from './lib/flow-expression-eval.mjs';

const SCRIPT = fileURLToPath(new URL('./build-flow-obligation-alerts.mjs', import.meta.url));
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SPEC = fs.readFileSync(fileURLToPath(new URL('../docs/flow-obligation-alerts.md', import.meta.url)), 'utf8');
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', timeout: 30000 });
const PROD = { intervalMinutes: 15, leadMinutes: 2880, lookbackMinutes: 1440 };   // arbitrary numbers for the tests, NOT proposals
const clone = (x) => JSON.parse(JSON.stringify(x));
const failedOf = (cd, variant = testVariant()) => checkClientdata(cd, variant).results.filter((r) => !r.pass).map((r) => r.name);
const failedWith = (cd, re, variant) => failedOf(cd, variant).some((n) => re.test(n));
const find = (cd, name) => walk(cd.properties.definition.actions).find((x) => x.name === name);

// ---------------------------------------------------------------------------------------------------------------- variants
test('the test variant is made of TEST CONSTANTS and nothing else: interval 1, lead 5, lookback 30, prefix [Muwafaqa test] ', () => {
  assert.deepEqual({ ...TEST_CONSTANTS }, { intervalMinutes: 1, leadMinutes: 5, lookbackMinutes: 30 });
  assert.ok(Object.isFrozen(TEST_CONSTANTS) && Object.isFrozen(testVariant()));
  assert.equal(testVariant().subjectPrefix, '[Muwafaqa test] ');
  assert.match(SOURCE, /TEST CONSTANTS\. Not business values/);
});

test('the production variant has NO default: each missing parameter, alone and together, refuses with a message that names it', () => {
  assert.throws(() => productionVariant(), VariantError);
  assert.throws(() => productionVariant({}), /interval-minutes is required.*lead-minutes is required.*lookback-minutes is required/);
  for (const k of ['intervalMinutes', 'leadMinutes', 'lookbackMinutes']) {
    const p = { ...PROD }; delete p[k];
    assert.throws(() => productionVariant(p), (e) => e instanceof VariantError && e.message.includes(k.replace('Minutes', '-minutes')) && /required/.test(e.message), k);
    assert.throws(() => productionVariant({ ...PROD, [k]: '' }), VariantError, `${k} empty`);
    assert.throws(() => productionVariant({ ...PROD, [k]: null }), VariantError, `${k} null`);
  }
  assert.doesNotMatch(CODE, /productionVariant\(\{[^}]*=\s*\d/);   // no default value in the signature
  const v = productionVariant(PROD); assert.deepEqual([v.name, v.intervalMinutes, v.leadMinutes, v.lookbackMinutes, v.subjectPrefix], ['production', 15, 2880, 1440, '']);
});

test('the production parameters are whole minutes from 1 to the sanity limit; digit strings (the command line) are accepted; lookback must be at least the interval', () => {
  for (const bad of [0, -1, 1.5, '1.5', 'abc', '1e3', NaN, MAX_MINUTES + 1, ' 5', '5 ']) for (const k of ['intervalMinutes', 'leadMinutes', 'lookbackMinutes']) assert.throws(() => productionVariant({ ...PROD, [k]: bad }), VariantError, `${k}=${bad}`);
  assert.equal(productionVariant({ intervalMinutes: '15', leadMinutes: '60', lookbackMinutes: '30' }).lookbackMinutes, 30);
  assert.equal(productionVariant({ intervalMinutes: 1, leadMinutes: 1, lookbackMinutes: MAX_MINUTES }).lookbackMinutes, MAX_MINUTES);
  assert.throws(() => productionVariant({ intervalMinutes: 30, leadMinutes: 60, lookbackMinutes: 29 }), /lookback-minutes \(29\) must be at least interval-minutes \(30\)/);
  assert.equal(productionVariant({ intervalMinutes: 30, leadMinutes: 60, lookbackMinutes: 30 }).intervalMinutes, 30);   // equal is allowed
});

test('buildDefinition refuses anything that is not a complete variant', () => {
  for (const bad of [null, {}, { intervalMinutes: 1, leadMinutes: 5 }, { intervalMinutes: '1', leadMinutes: 5, lookbackMinutes: 30 }, { intervalMinutes: 1, leadMinutes: 5, lookbackMinutes: 1.5 }]) assert.throws(() => buildDefinition(bad), VariantError);
  assert.deepEqual(buildDefinition(), buildDefinition(testVariant()));   // no argument means the test variant (the test constants), never a production one
});

test('the two variants differ ONLY in the interval, the lead time, the lookback and the subject prefix (a unit-test diff of the two definitions)', () => {
  const a = testVariant(); const b = productionVariant(PROD);
  const norm = (variant) => JSON.stringify(buildDefinition(variant))
    .split(`"interval":${variant.intervalMinutes}`).join('"interval":<I>')
    .split(`addMinutes(variables('runStartedAt'), -${variant.lookbackMinutes})`).join("addMinutes(variables('runStartedAt'), -<B>)")
    .split(`addMinutes(variables('runStartedAt'), ${variant.leadMinutes})`).join("addMinutes(variables('runStartedAt'), <L>)")
    .split(variant.subjectPrefix ? variant.subjectPrefix : '\u0000').join('<P>');
  const withPrefix = (variant) => norm(variant).replace(/(emailMessage\/Subject":")/, (m) => m + (variant.subjectPrefix ? '' : '<P>'));
  assert.equal(withPrefix(a), withPrefix(b));
});

// ---------------------------------------------------------------------------------------------------------------- the generated definition passes its own check
test('check passes for the test variant and for a production variant, and prints no failure', () => {
  for (const variant of [testVariant(), productionVariant(PROD), productionVariant({ intervalMinutes: 1, leadMinutes: 1, lookbackMinutes: 1 })]) {
    const r = checkClientdata(buildClientdata(variant), variant);
    assert.deepEqual(r.results.filter((x) => !x.pass), [], variant.name);
    assert.ok(r.results.length >= 35);
  }
});

test('the REAL numbers are computed from the definition (snapshot: a change must be noticed), and are far from the limits', () => {
  const cd = buildClientdata(testVariant()); const s = statsOf(cd);
  assert.equal(s.actions, walk(cd.properties.definition.actions).length);
  assert.deepEqual(s, { actions: 32, depth: 5 });
  assert.ok(s.actions <= LIMITS.maxActions && s.depth <= LIMITS.maxDepth);
  assert.deepEqual(statsOf(buildClientdata(productionVariant(PROD))), s);   // same shape
  assert.equal(actionOutline(cd).length, s.actions);
});

test('the limits are enforced: depth 9 fails, 501 actions fail, depth 8 and 500 actions pass', () => {
  const deepen = (cd, levels) => { const out = clone(cd); let holder = { actions: out.properties.definition.actions }; holder.actions.Deep_0 = { type: 'If', expression: { equals: [1, 1] }, actions: {}, else: { actions: {} }, runAfter: { Check_errors: ['Succeeded'] } }; holder = holder.actions.Deep_0; for (let i = 1; i < levels; i++) { holder.actions = { [`Deep_${i}`]: { type: 'If', expression: { equals: [1, 1] }, actions: {}, else: { actions: {} } } }; holder = holder.actions[`Deep_${i}`]; } holder.actions = { Deep_leaf: { type: 'Compose', inputs: 'x' } }; return out; };
  const base = buildClientdata(testVariant());
  assert.equal(statsOf(base).depth, 5);
  const d8 = deepen(base, 7); assert.equal(statsOf(d8).depth, 8); assert.ok(!failedWith(d8, /nesting depth/));
  const d9 = deepen(base, 8); assert.equal(statsOf(d9).depth, 9); assert.ok(failedWith(d9, /nesting depth is at most 8/));
  const pad = (n) => { const out = clone(base); for (let i = 0; i < n; i++) out.properties.definition.actions[`Pad_${i}`] = { type: 'Compose', inputs: 'x', runAfter: { Check_errors: ['Succeeded'] } }; return out; };
  const need = LIMITS.maxActions - statsOf(base).actions;
  assert.equal(statsOf(pad(need)).actions, 500); assert.ok(!failedWith(pad(need), /at most 500 actions/));
  assert.equal(statsOf(pad(need + 1)).actions, 501); assert.ok(failedWith(pad(need + 1), /at most 500 actions/));
});

// ---------------------------------------------------------------------------------------------------------------- the key expression against alert-key.mjs
test('the evaluated key expression equals alert-key.mjs: lower-case GUID, capitals, yyyyMMdd (end of month, leap day, year end), each of the four TYPE values', () => {
  const r = compareWithAlertKey();
  assert.deepEqual(r.bad, []); assert.equal(r.ok, 3 * 5 * 4);
  for (const type of ALERT_TYPES) assert.equal(evaluateKey('3F2504E0-4F89-41D3-9A0C-0305E82C3301', '2028-02-29T10:00:00Z', type), `3f2504e0-4f89-41d3-9a0c-0305e82c3301-${type}-20280229`);
  assert.equal(evaluateKey('3f2504e0-4f89-41d3-9a0c-0305e82c3301', '2027-03-31T23:59:59Z', TYPES_USED[0]), buildAlertKey({ sourceId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', type: TYPES_USED[0], date: '2027-03-31' }));
});

test('the cases that must be rejected are rejected by BOTH the guard (or a failed evaluation) and alert-key.mjs: empty, too short, too long, empty type, empty date', () => {
  const r = compareWithAlertKey(); assert.deepEqual(r.badRejects, []); assert.equal(r.rejected, KEY_SAMPLES.rejects.length);
  for (const c of KEY_SAMPLES.rejects) {
    let key = null; try { key = evaluateKey(c.id, c.date, c.type); } catch { /* a failed evaluation fails the action: also a rejection */ }
    if (key !== null) assert.equal(evaluateGuard(key, c.type), false, c.label);
    assert.throws(() => validateAlertKey(key ?? ''), undefined, c.label);
  }
  assert.equal(evaluateGuard('', TYPES_USED[0]), false);
  assert.equal(evaluateGuard('x'.repeat(200), TYPES_USED[0]), false);
});

test('the guard lets exactly the keys of this flow through: the two OBLIGATION types give a valid 64-character key; the two RENEWAL types (never emitted here) do not; a recipient is required', () => {
  assert.deepEqual([...KEY_LENGTHS], [64]);
  const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  for (const t of TYPES_USED) assert.equal(evaluateGuard(evaluateKey(id, '2027-03-31T00:00:00Z', t), t), true, t);
  for (const t of ALERT_TYPES.filter((x) => !TYPES_USED.includes(x))) assert.equal(evaluateGuard(evaluateKey(id, '2027-03-31T00:00:00Z', t), t), false, t);
  const k = evaluateKey(id, '2027-03-31T00:00:00Z', TYPES_USED[0]);
  assert.equal(evaluateGuard(k, TYPES_USED[0], ''), false);
  assert.equal(evaluateGuard(k, TYPES_USED[1]), false);   // the key does not hold the other type segment
  assert.equal(evaluateGuard(k.slice(0, -1), TYPES_USED[0]), false); assert.equal(evaluateGuard(`${k}0`, TYPES_USED[0]), false);
});

test('the guard checks emptiness and length only: its stated limit (a 64-character key with a non-digit date part passes the guard, and alert-key.mjs rejects it)', () => {
  const bad = `3f2504e0-4f89-41d3-9a0c-0305e82c3301-${TYPES_USED[0]}-2027AB31`;
  assert.equal(bad.length, 64); assert.equal(evaluateGuard(bad, TYPES_USED[0]), true);
  assert.throws(() => validateAlertKey(bad));
  assert.match(SPEC, /does not check that the other 8 characters are digits/);
});

test('the alert type: due before the run start is OVERDUE, at or after it is DUE SOON (an offset time is compared as the same instant)', () => {
  const at = (due) => evalTemplate(TYPE_EXPRESSION, { variables: { runStartedAt: '2027-06-15T12:00:00Z' }, items: { Apply_to_each_obligation: { mwf_duedate: due } } });
  assert.equal(at('2027-06-15T11:59:59Z'), 'OBLIGATION-OVERDUE'); assert.equal(at('2027-06-15T12:00:00Z'), 'OBLIGATION-DUESOON'); assert.equal(at('2027-06-15T12:04:00Z'), 'OBLIGATION-DUESOON');
  assert.equal(at('2027-06-15T13:30:00+02:00'), 'OBLIGATION-OVERDUE');   // 11:30 UTC
});

test('the query window: evaluated with a fixed clock for both variants, the bounds are runStart - lookback and runStart + lead, Open only, oldest due date first', () => {
  const at = (variant) => evalTemplate(queryFilter(variant), { variables: { runStartedAt: '2027-06-15T12:00:00Z' } });
  assert.equal(at(testVariant()), 'mwf_status eq 867640000 and mwf_duedate ge 2027-06-15T11:30:00Z and mwf_duedate le 2027-06-15T12:05:00Z');
  assert.equal(at(productionVariant({ intervalMinutes: 15, leadMinutes: 60, lookbackMinutes: 120 })), 'mwf_status eq 867640000 and mwf_duedate ge 2027-06-15T10:00:00Z and mwf_duedate le 2027-06-15T13:00:00Z');
  const q = find(buildClientdata(testVariant()), 'Get_open_obligations').action.inputs.parameters;
  assert.equal(q.$orderby, 'mwf_duedate asc'); assert.equal(q.$top, 50); assert.equal(q.entityName, 'mwf_obligations');
  assert.doesNotMatch(q.$filter, /867640001|867640002/);   // Done and Disputed are never named: the Open filter excludes them
});

test('the cap check: yes below 5 successful claims, no at 5 or above', () => {
  const at = (n) => evalTemplate(find(buildClientdata(testVariant()), 'Set_proceed').action.inputs.value, { variables: { noticesSent: n } });
  assert.deepEqual([0, 4, 5, 6].map(at), ['yes', 'yes', 'no', 'no']);
});

// ---------------------------------------------------------------------------------------------------------------- every rule can fail on its own (the check is not vacuous)
test('MUTATIONS: each broken definition makes exactly the right check fail', () => {
  const base = buildClientdata(testVariant());
  const cases = [
    ['the email reachable after a failed claim', (c) => { find(c, 'Send_alert_email').action.runAfter = { Increment_noticesSent: ['Succeeded', 'Failed'] }; }, /fail closed/],
    ['the email directly after the claim with Failed', (c) => { find(c, 'Send_alert_email').action.runAfter = { Insert_claim: ['Failed'] }; }, /fail closed/],
    ['the counter after a failed claim', (c) => { find(c, 'Increment_noticesSent').action.runAfter = { Insert_claim: ['Succeeded', 'Failed'] }; }, /cap counter/],
    ['a second counter of the cap', (c) => { find(c, 'Increment_claimFailures').action.inputs.name = 'noticesSent'; }, /cap counter/],
    ['the failure branch also sends', (c) => { find(c, 'Increment_claimFailures').action.runAfter = { Compose_claim_failure: ['Succeeded'] }; find(c, 'Compose_claim_failure').action.runAfter = { Insert_claim: ['Failed', 'Succeeded'] }; }, /failed insert/],
    ['the guard without the length test', (c) => { const g = find(c, 'Gate_guard').action; g.expression = { and: g.expression.and.filter((x) => !JSON.stringify(x).includes('length')) }; }, /guard sits before the insert|guard and alert-key/],
    ['the guard without the empty-key test', (c) => { const g = find(c, 'Gate_guard').action; g.expression = { and: g.expression.and.filter((x) => !JSON.stringify(x).includes('empty(variables(\'alertKey\'))')) }; }, /guard sits before the insert/],
    ['the guard allowing a wrong length', (c) => { find(c, 'Gate_guard').action.expression.and[2] = { equals: ["@length(variables('alertKey'))", 63] }; }, /guard sits before the insert|guard and alert-key/],
    ['a changed key expression (no toLower)', (c) => { find(c, 'Set_alertKey').action.inputs.value = KEY_EXPRESSION.replace("toLower(string(items('Apply_to_each_obligation')?['mwf_obligationid']))", "string(items('Apply_to_each_obligation')?['mwf_obligationid'])"); }, /Set_alertKey is exactly|equals scripts\/lib\/alert-key\.mjs/],
    ['a changed key expression (another date format)', (c) => { find(c, 'Set_alertKey').action.inputs.value = KEY_EXPRESSION.replace("'yyyyMMdd'", "'yyyy-MM-dd'"); }, /equals scripts\/lib\/alert-key\.mjs/],
    ['a Set variable with an empty literal', (c) => { find(c, 'Reset_alertKey').action.inputs.value = ''; }, /empty-string literal/],
    ['a Set variable with an empty interpolation', (c) => { find(c, 'Reset_alertKey').action.inputs.value = '@{}'; }, /empty-string literal/],
    ['a Terminate inside the loop', (c) => { find(c, 'Gate_guard').action.else.actions.Terminate_in_loop = { type: 'Terminate', inputs: { runStatus: 'Failed' }, runAfter: { Increment_errors: ['Succeeded'] } }; }, /no Terminate inside a loop/],
    ['the Terminate moved into the loop', (c) => { const t = find(c, 'Terminate_run_failed'); delete t.siblings.Terminate_run_failed; find(c, 'Gate_guard').action.else.actions.Terminate_run_failed = { type: 'Terminate', inputs: { runStatus: 'Failed' }, runAfter: { Increment_errors: ['Succeeded'] } }; }, /no Terminate inside a loop/],
    ['an empty parameter', (c) => { find(c, 'Get_contract').action.inputs.parameters.$select = ''; }, /non-empty/],
    ['an empty email parameter', (c) => { find(c, 'Send_alert_email').action.inputs.parameters['emailMessage/To'] = ''; }, /non-empty/],
    ['an empty Compose field', (c) => { find(c, 'Compose_claim_failure').action.inputs.key = ''; }, /non-empty/],
    ['an update of a table', (c) => { find(c, 'Insert_claim').action.inputs.host.operationId = 'UpdateOnlyRecord'; }, /operation ids|only write/],
    ['an insert into another table', (c) => { find(c, 'Insert_claim').action.inputs.parameters.entityName = 'mwf_obligations'; }, /only write/],
    ['an extra column written', (c) => { find(c, 'Insert_claim').action.inputs.parameters['item/mwf_extra'] = 'x'; }, /only write/],
    ['a second email', (c) => { find(c, 'Gate_guard').action.else.actions.Send_other = { ...clone(find(c, 'Send_alert_email').action), runAfter: { Increment_errors: ['Succeeded'] } }; }, /fail closed|recipient/],
    ['the query names Disputed', (c) => { find(c, 'Get_open_obligations').action.inputs.parameters.$filter += ' and mwf_status ne 867640002'; }, /neither Done nor Disputed|query is server side/],
    ['the query without the lookback bound', (c) => { const q = find(c, 'Get_open_obligations').action.inputs.parameters; q.$filter = q.$filter.replace(/ and mwf_duedate ge @\{[^}]*\}/, ''); }, /query is server side/],
    ['the cap check not first', (c) => { const loop = find(c, 'Apply_to_each_obligation').action; const { Set_proceed, ...rest } = loop.actions; loop.actions = { ...rest, Set_proceed }; }, /cap is 5/],
    ['the insert outside the guard', (c) => { const g = find(c, 'Gate_guard').action; const claim = g.actions.Check_obligation_still_due; delete g.actions.Check_obligation_still_due; find(c, 'Gate_prepare').action.actions.Check_obligation_still_due_moved = { ...claim, runAfter: { Gate_guard: ['Succeeded'] } }; }, /Insert_claim is inside/],
    ['an action that reads a later action', (c) => { find(c, 'Get_contract').action.inputs.parameters.$filter = "@{outputs('Get_owner_user_list')?['body/value']}"; }, /reference to another action/],
    ['an unbalanced expression', (c) => { find(c, 'Set_alertType').action.inputs.value = "@if(less(1, 2), 'a', 'b'"; }, /balanced/],
    ['a variable used before it is declared', (c) => { find(c, 'Init_runStartedAt').action.inputs.variables[0].name = 'runStartedAt2'; }, /variables exist|initialized before/],
    ['an unsupported function in an evaluated expression', (c) => { find(c, 'Set_alertType').action.inputs.value = "@if(less(1, 2), substring('abc', 0, 1), 'b')"; }, /only functions of the small evaluator/],
    ['a real e-mail address in the definition', (c) => { find(c, 'Send_alert_email').action.inputs.parameters['emailMessage/Subject'] += ` ${['someone', 'example.net'].join('@')}`; }, /no email address/],
    ['a real host in the definition', (c) => { find(c, 'Send_alert_email').action.inputs.parameters['emailMessage/Body'] += ['https://org1234', 'crm4', 'dynamics', 'com'].join('.'); }, /placeholder <ORG_HOST>/],
    ['a loop that is not sequential', (c) => { find(c, 'Apply_to_each_obligation').action.runtimeConfiguration.concurrency.repetitions = 5; }, /one at a time/],
    ['a second trigger interval', (c) => { c.properties.definition.triggers.Recurrence.recurrence.interval = 7; }, /exactly one trigger/],
  ];
  for (const [label, mutate, expected] of cases) {
    const c = clone(base);
    // mutations that rebuild siblings rely on the walk's `siblings` map: apply on the plain JSON
    try { mutate(Object.assign(c, {})); } catch (e) { assert.fail(`${label}: the mutation itself failed: ${e.message}`); }
    const failed = failedOf(c);
    assert.ok(failed.some((n) => expected.test(n)), `${label}: expected a failing check matching ${expected}, got ${JSON.stringify(failed.map((x) => x.slice(0, 70)))}`);
  }
  assert.deepEqual(failedOf(base), []);   // and the unmutated definition fails nothing
});

// ---------------------------------------------------------------------------------------------------------------- shape, spec and command line
test('the numbered action list of the spec (section 4) is the list of the generated definition: same names, nothing missing, nothing extra', () => {
  const section = SPEC.slice(SPEC.indexOf('## 4. Order of actions'), SPEC.indexOf('## 5. Recipient'));
  const named = new Set([...section.matchAll(/`([A-Z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)`/g)].map((m) => m[1]));
  const generated = new Set(actionOutline(buildClientdata(testVariant())).map((a) => a.name));
  assert.deepEqual([...generated].filter((n) => !named.has(n)), [], 'in the definition but not in the spec');
  assert.deepEqual([...named].filter((n) => !generated.has(n)), [], 'in the spec but not in the definition');
});

test('the plan prints the parameters, the window, the cost, the key, the guard, the REAL size, and the numbered list; it needs no environment', () => {
  const t = planLines(testVariant()).join('\n'); const s = statsOf(buildClientdata(testVariant()));
  for (const n of ['TEST CONSTANTS', 'runStart - 30 min', 'runStart + 5 min', 'never gets its alert', '@concat(toLower', 'key length 64', `${s.actions} actions, nesting depth ${s.depth}`, 'REAL numbers', 'Insert_claim', 'Terminate_run_failed', 'NOT IN THIS GENERATOR']) assert.ok(t.includes(n), n);
  assert.match(t, /39 of 39 structural checks pass|\d+ of \d+ structural checks pass/);
  assert.doesNotMatch(t, /FAILED/);
});

test('the script has exactly two modes, check and plan: create, verify and replace are refused (exit 2) and no code of the file reaches an environment', () => {
  for (const mode of ['create', 'verify', 'replace', 'build', '']) { const r = run(`--mode=${mode}`); assert.equal(r.status, 2, mode); assert.match(r.stderr, /only --mode=check and --mode=plan exist/); assert.match(r.stderr, /Nothing was run/); }
  assert.equal(run().status, 2);
  assert.doesNotMatch(CODE, /openSession|dv-session|fetch\(|execSync|spawn|writeFileSync|process\.env|--confirm-mutates-environment|--env=|'POST'|'PUT'|'PATCH'|'DELETE'/);
  assert.doesNotMatch(CODE, /mode === 'create'|mode === 'replace'|mode === 'verify'/);
});

test('command line: check and plan exit 0 for the test variant; production without all three parameters is refused (exit 2) and names the missing ones; with them it passes', () => {
  assert.equal(run('--mode=check').status, 0); assert.equal(run('--mode=plan').status, 0);
  const noParams = run('--mode=plan', '--variant=production'); assert.equal(noParams.status, 2); assert.match(noParams.stderr, /cannot emit a production definition/); assert.match(noParams.stderr, /interval-minutes is required/); assert.match(noParams.stderr, /Nothing was emitted/);
  const some = run('--mode=check', '--variant=production', '--lead-minutes=60'); assert.equal(some.status, 2); assert.match(some.stderr, /lookback-minutes is required/);
  assert.equal(run('--mode=check', '--variant=both').status, 2);   // both needs the parameters too
  const ok = run('--mode=check', '--variant=production', '--interval-minutes=15', '--lead-minutes=60', '--lookback-minutes=30'); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /variant production/);
  const both = run('--mode=plan', '--variant=both', '--interval-minutes=15', '--lead-minutes=60', '--lookback-minutes=30'); assert.equal(both.status, 0); assert.match(both.stdout, /Variant: test/); assert.match(both.stdout, /Variant: production/);
  assert.equal(run('--mode=plan', '--variant=production', '--interval-minutes=30', '--lead-minutes=60', '--lookback-minutes=29').status, 2);
  assert.equal(run('--mode=check', '--variant=nonsense').status, 2);
  assert.equal(run('--mode=check', '--outlook-ref=3f2504e0-4f89-41d3-9a0c-0305e82c3301').status, 2);   // a GUID is not a reference name
});

test('the flow name and the labels: a name of its own, the test constants are labelled as such in the plan, and production values are labelled as given by the caller', () => {
  assert.equal(FLOW_NAME, 'Muwafaqa - Obligation Alerts');
  assert.match(planLines(productionVariant(PROD)).join('\n'), /given by the caller; no default exists/);
  assert.doesNotMatch(planLines(productionVariant(PROD)).join('\n'), /TEST CONSTANTS/);
});

test('no GUID, address or host is stored in the generator file (the placeholder host only)', () => {
  assert.doesNotMatch(SOURCE.replace(/3f2504e0-4f89-41d3-9a0c-0305e82c3301|00000000-0000-4000-8000-000000000001/g, ''), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.doesNotMatch(SOURCE, /[A-Za-z0-9._%+-]+@(?!example\.test)[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  assert.doesNotMatch(SOURCE.replace(/<org>\.crm4\.dynamics\.com/g, ''), /\.crm\d*\.dynamics\.com/);
});
