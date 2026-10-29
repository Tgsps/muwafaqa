// Unit tests of the generator of the flow "Muwafaqa - Approval Reminders" (scripts/build-flow-reminders.mjs). OFFLINE: they check the generated
// definition (its structure and its constants), NOT what the Power Automate expressions compute. That is covered by the manual cases R1 to R5
// of docs/flow-approval-reminders.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FLOW_NAME, VARIANTS, DEFAULT_OUTLOOK_REF, DEFAULT_DATAVERSE_REF, EMAIL_KEY_STYLE,
  buildDefinition, buildClientdata, checkClientdata, assertLogicalName, statsOf, createBody, requestSummary, FLOW_DESCRIPTION, replaceGuards, replaceSummary, REPLACE_BASELINE,
} from './build-flow-reminders.mjs';
import { walk } from './build-flow-v2.mjs';
import { MAX_NOTICES_PER_RUN } from './lib/reminder-candidates.mjs';

const SCRIPT = fileURLToPath(new URL('./build-flow-reminders.mjs', import.meta.url));
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');
const failed = (r) => r.results.filter((x) => !x.pass).map((x) => x.name);
const cdOf = (variant = VARIANTS.test, refs) => buildClientdata(variant, refs);
const clone = (o) => structuredClone(o);
const defOf = (cd) => cd.properties.definition;
const find = (cd, name) => walk(defOf(cd).actions).find((x) => x.name === name);
/** Rebuilds the `actions` object of a scope with the given key order. */
const reorder = (actions, names) => Object.fromEntries(names.map((n) => [n, actions[n]]));

test('the flow has the exact name asked for', () => {
  assert.equal(FLOW_NAME, 'Muwafaqa - Approval Reminders');
});

for (const variant of Object.values(VARIANTS)) {
  test(`the ${variant.name} variant passes every structural check`, () => {
    const r = checkClientdata(cdOf(variant), variant);
    assert.deepEqual(failed(r), []);
    assert.ok(r.results.length >= 40);
  });
}

test('the size of the generated definition, for the report: 42 actions, nesting depth 7, the same for both variants (the trigger is not counted)', () => {
  const a = statsOf(cdOf(VARIANTS.test)); const b = statsOf(cdOf(VARIANTS.production));
  assert.deepEqual(a, b);
  assert.deepEqual(a, { actions: 42, depth: 7 });
  assert.ok(a.depth <= 8 && a.actions < 500);
});

test('test and production differ ONLY in the two timers, the recurrence interval and the subject prefix (enforced over the generated definitions)', () => {
  const t = JSON.stringify(cdOf(VARIANTS.test));
  const p = JSON.stringify(cdOf(VARIANTS.production));
  assert.notEqual(t, p);
  // each literal that belongs to a variant constant, and how often it occurs: exactly where the constant is used and nowhere else
  const swaps = [['-3)', '-2880)', 1], ['-6)', '-5760)', 1], [', 3)', ', 2880)', 1], [', 6)', ', 5760)', 1], ['"interval":1}', '"interval":15}', 1], ['[Muwafaqa test] ', '', 2]];
  let normalized = t;
  for (const [from, to, times] of swaps) {
    assert.equal(t.split(from).length - 1, times, `${from} must occur ${times} time(s) in the test definition`);
    normalized = normalized.split(from).join(to);
  }
  assert.equal(normalized, p);
  // the other direction: the production definition holds no test constant
  for (const s of ['[Muwafaqa test]', '-3)', '-6)', ', 3)', ', 6)']) assert.equal(p.includes(s), false, s);
});

test('the variants carry the owner values: test 1 minute / 3 and 6 minutes, production 15 minutes (a placeholder) / 2880 and 5760 minutes (placeholders)', () => {
  assert.deepEqual([VARIANTS.test.intervalMinutes, VARIANTS.test.timers.remindAfterMinutes, VARIANTS.test.timers.escalateAfterMinutes], [1, 3, 6]);
  assert.deepEqual([VARIANTS.production.intervalMinutes, VARIANTS.production.timers.remindAfterMinutes, VARIANTS.production.timers.escalateAfterMinutes], [15, 2880, 5760]);
  assert.equal(VARIANTS.test.subjectPrefix, '[Muwafaqa test] ');
  assert.equal(VARIANTS.production.subjectPrefix, '');
  assert.ok(Object.isFrozen(VARIANTS) && Object.isFrozen(VARIANTS.test));
});

test('the cap of 5 notices per run is in the definition, and equals the constant the owner decided', () => {
  assert.equal(MAX_NOTICES_PER_RUN, 5);
  assert.equal(find(cdOf(), 'Set_proceed').action.inputs.value, "@{if(less(variables('noticesSent'), 5), 'yes', '')}");
});

test('the connection reference logical names are parameters: given names are used, the default is the proposed name, a GUID is refused', () => {
  const given = cdOf(VARIANTS.test, { outlookRef: 'mwf_outlook_custom', dataverseRef: 'new_dataverse_custom' });
  assert.equal(given.properties.connectionReferences.shared_office365.connection.connectionReferenceLogicalName, 'mwf_outlook_custom');
  assert.equal(given.properties.connectionReferences.shared_commondataserviceforapps.connection.connectionReferenceLogicalName, 'new_dataverse_custom');
  assert.deepEqual(failed(checkClientdata(given, VARIANTS.test, { outlookRef: 'mwf_outlook_custom', dataverseRef: 'new_dataverse_custom' })), []);
  const dflt = cdOf();
  assert.equal(dflt.properties.connectionReferences.shared_office365.connection.connectionReferenceLogicalName, DEFAULT_OUTLOOK_REF);
  assert.equal(DEFAULT_OUTLOOK_REF, 'mwf_sharedoffice365_reminders');
  assert.equal(dflt.properties.connectionReferences.shared_commondataserviceforapps.connection.connectionReferenceLogicalName, DEFAULT_DATAVERSE_REF);
  for (const bad of ['00000000-aaaa-4bbb-8ccc-000000000001', '00000000_aaaa_4bbb', 'Mwf_Upper', 'x', 'with space', '', undefined, '1abc_def']) assert.throws(() => assertLogicalName(bad), /not a valid connection reference/, String(bad));
  assert.throws(() => buildClientdata(VARIANTS.test, { outlookRef: '00000000-aaaa-4bbb-8ccc-000000000001' }));
  assert.equal(assertLogicalName('mwf_sharedoffice365_reminders'), 'mwf_sharedoffice365_reminders');
});

test('the check notices a wrong connection reference name (it must equal the one given)', () => {
  const cd = cdOf(); cd.properties.connectionReferences.shared_office365.connection.connectionReferenceLogicalName = 'something_else';
  assert.ok(failed(checkClientdata(cd, VARIANTS.test)).some((n) => n.startsWith('the connection reference logical names')));
});

test('the emails: English, fictional, no address, the test subjects start with the test prefix and the production ones do not', () => {
  for (const variant of Object.values(VARIANTS)) {
    const cd = cdOf(variant);
    const sends = walk(defOf(cd).actions).filter((x) => x.action.inputs?.host?.operationId === 'SendEmailV2');
    assert.equal(sends.length, 2);
    for (const s of sends) {
      const k = (n) => s.action.inputs.parameters[EMAIL_KEY_STYLE === 'nested' ? `emailMessage/${n}` : n];
      assert.equal(k('To'), "@variables('recipientEmail')");
      assert.equal(k('Subject').startsWith('[Muwafaqa test] '), variant.name === 'test');
      assert.match(k('Body'), /sample text/);
      assert.doesNotMatch(k('Body').replace(/@\{[^}]*\}/g, ''), /@/);
    }
  }
});

test('the clientdata has the shape of a flow row, a Recurrence trigger and no turn-on or state anywhere', () => {
  const cd = cdOf();
  assert.equal(cd.schemaVersion, '1.0.0.0');
  assert.deepEqual(Object.keys(cd.properties.connectionReferences).sort(), ['shared_commondataserviceforapps', 'shared_office365']);
  assert.deepEqual(Object.keys(defOf(cd).triggers), ['Recurrence']);
  assert.deepEqual(defOf(cd).triggers.Recurrence.recurrence, { frequency: 'Minute', interval: 1 });
  assert.equal(JSON.stringify(cd).includes('"statecode":1'), false);
});

// ---- defect injection: each structural check must fail when its defect is introduced
test('DEFECT: a send before the claim is detected (claim first)', () => {
  const cd = clone(cdOf());
  const gate = find(cd, 'Check_step_still_due').action.actions;
  find(cd, 'Check_step_still_due').action.actions = reorder(gate, ['Branch_send', 'Branch_claim', 'Increment_noticesSent']);
  assert.ok(failed(checkClientdata(cd, VARIANTS.test)).some((n) => n.startsWith('claim first')));
});

test('DEFECT: resolving the recipient after the claim is detected', () => {
  const cd = clone(cdOf());
  const loop = find(cd, 'Apply_to_each_due_step').action;
  loop.actions = reorder(loop.actions, ['Set_proceed', 'Reset_sinceUtc', 'Reset_action', 'Reset_recipientEmail', 'Gate_waiting_since', 'Gate_decide', 'Gate_claim_and_send', 'Gate_recipient']);
  assert.ok(failed(checkClientdata(cd, VARIANTS.test)).some((n) => n.startsWith('the recipient is resolved BEFORE')));
});

test('DEFECT: a cap of another number, or a gate variable that is always yes, is detected', () => {
  const a = clone(cdOf()); find(a, 'Set_proceed').action.inputs.value = "@{if(less(variables('noticesSent'), 6), 'yes', '')}";
  assert.ok(failed(checkClientdata(a, VARIANTS.test)).some((n) => n.startsWith('the hard cap of one run is 5')));
  const b = clone(cdOf()); find(b, 'Set_proceed').action.inputs.value = 'yes';
  assert.ok(failed(checkClientdata(b, VARIANTS.test)).some((n) => n.startsWith('the hard cap of one run is 5')));
});

test('DEFECT: a gate of the step loop that ignores the cap, or a second counter increment, is detected', () => {
  const a = clone(cdOf()); find(a, 'Gate_decide').action.expression = { not: { equals: ["@variables('sinceUtc')", ''] } };
  assert.ok(failed(checkClientdata(a, VARIANTS.test)).some((n) => n.startsWith('every group of the step loop is a gate')));
  const b = clone(cdOf()); find(b, 'Check_step_still_due').action.actions.Increment_again = { type: 'IncrementVariable', inputs: { name: 'noticesSent', value: 1 }, runAfter: { Branch_send: ['Succeeded'] } };
  assert.ok(failed(checkClientdata(b, VARIANTS.test)).some((n) => n.startsWith('the counter is incremented exactly once')));
});

test('DEFECT: parallel loops are detected', () => {
  for (const loop of ['Apply_to_each_contract', 'Apply_to_each_due_step']) {
    const cd = clone(cdOf()); find(cd, loop).action.runtimeConfiguration.concurrency.repetitions = 2;
    assert.ok(failed(checkClientdata(cd, VARIANTS.test)).some((n) => n.startsWith('both loops are sequential')), loop);
  }
});

test('DEFECT: a Terminate or an Until is detected', () => {
  const t = clone(cdOf()); find(t, 'Check_step_still_due').action.actions.Stop = { type: 'Terminate', inputs: { runStatus: 'Cancelled' }, runAfter: { Branch_send: ['Succeeded'] } };
  assert.ok(failed(checkClientdata(t, VARIANTS.test)).some((n) => n.startsWith('the flow has no Terminate')));
  const u = clone(cdOf()); find(u, 'Check_step_still_due').action.actions.Wait = { type: 'Until', expression: 'true', actions: {}, runAfter: { Branch_send: ['Succeeded'] } };
  assert.ok(failed(checkClientdata(u, VARIANTS.test)).some((n) => n.startsWith('the flow has no Terminate')));
});

test('DEFECT: a claim that writes another column or another table is detected', () => {
  const a = clone(cdOf()); find(a, 'Claim_reminder').action.inputs.parameters['item/mwf_decision'] = 867640002;
  assert.ok(failed(checkClientdata(a, VARIANTS.test)).some((n) => n.startsWith('claims write only')));
  const b = clone(cdOf()); find(b, 'Claim_escalation').action.inputs.parameters.entityName = 'mwf_contracts';
  assert.ok(failed(checkClientdata(b, VARIANTS.test)).some((n) => n.startsWith('claims write only') || n.startsWith('the flow reads only')));
});

test('DEFECT: a server-side filter that loses a condition is detected (each piece in turn)', () => {
  const pieces = ['mwf_remindedon eq null', 'mwf_escalatedon eq null', 'mwf_decision eq 867640001', 'mwf_actiontype eq 867640000', 'mwf_approvalround eq'];
  for (const piece of pieces) {
    const cd = clone(cdOf()); const p = find(cd, 'Get_due_steps').action.inputs.parameters;
    p.$filter = p.$filter.replace(piece, 'true eq true');
    assert.ok(failed(checkClientdata(cd, VARIANTS.test)).some((n) => n.startsWith('the step query is server side')), piece);
  }
  const noCut = clone(cdOf()); const q = find(noCut, 'Get_due_steps').action.inputs.parameters; q.$filter = q.$filter.replace(/ and createdon lt @\{[^}]*\}\)/, ')');
  assert.ok(failed(checkClientdata(noCut, VARIANTS.test)).length > 0);
  const c = clone(cdOf()); find(c, 'Get_pending_contracts').action.inputs.parameters.$filter = 'statuscode eq 1';
  assert.ok(failed(checkClientdata(c, VARIANTS.test)).some((n) => n.startsWith('the contract query')));
});

test('DEFECT: a timer that does not belong to the variant is detected (a production number in the test variant, and the reverse)', () => {
  const t = clone(cdOf(VARIANTS.test)); const q = find(t, 'Get_due_steps').action.inputs.parameters; q.$filter = q.$filter.replace('-3)', '-2880)');
  assert.ok(failed(checkClientdata(t, VARIANTS.test)).some((n) => n.startsWith('the time cuts use this variant') || n.startsWith('the timers of the other variant')));
  const p = clone(cdOf(VARIANTS.production)); const a = find(p, 'Set_action').action.inputs; a.value = a.value.replace(', 2880)', ', 3)');
  assert.ok(failed(checkClientdata(p, VARIANTS.production)).length > 0);
  assert.ok(failed(checkClientdata(cdOf(VARIANTS.test), VARIANTS.production)).length > 0);   // a test definition is not a production definition
});

test('DEFECT: a derived waiting time that does not check the previous step, or a decision outside the gate on the waiting time, is detected', () => {
  const a = clone(cdOf()); find(a, 'Check_previous_step_decided').action.expression = { equals: [1, 1] };
  assert.ok(failed(checkClientdata(a, VARIANTS.test)).some((n) => n.startsWith('the waiting time is derived')));
  const b = clone(cdOf()); find(b, 'Gate_decide').action.expression = { equals: ["@variables('proceed')", 'yes'] };
  assert.ok(failed(checkClientdata(b, VARIANTS.test)).some((n) => n.startsWith('the decision (Set_action) is reachable')));
  const c = clone(cdOf()); find(c, 'Get_previous_step').action.inputs.parameters.$filter = 'mwf_steporder eq 1';
  assert.ok(failed(checkClientdata(c, VARIANTS.test)).some((n) => n.startsWith('the previous step is found')));
});

test('DEFECT: a missing re-read before the claim is detected', () => {
  const cd = clone(cdOf()); find(cd, 'Check_step_still_due').action.expression = { equals: [1, 1] };
  assert.ok(failed(checkClientdata(cd, VARIANTS.test)).some((n) => n.startsWith('the step is read again before the claim')));
});

test('DEFECT: an email address, an id or a real host in the definition is detected', () => {
  const a = clone(cdOf()); find(a, 'Send_reminder_email').action.inputs.parameters[EMAIL_KEY_STYLE === 'nested' ? 'emailMessage/Body' : 'Body'] += '<p>write to someone' + String.fromCharCode(64) + 'example.com</p>';
  assert.ok(failed(checkClientdata(a, VARIANTS.test)).some((n) => n.startsWith('no email address')));
  const b = clone(cdOf()); find(b, 'Send_reminder_email').action.inputs.parameters[EMAIL_KEY_STYLE === 'nested' ? 'emailMessage/Body' : 'Body'] += '00000000-aaaa-4bbb-8ccc-000000000001';
  assert.ok(failed(checkClientdata(b, VARIANTS.test)).some((n) => n.startsWith('no email address')));
  const c = clone(cdOf()); find(c, 'Send_reminder_email').action.inputs.parameters[EMAIL_KEY_STYLE === 'nested' ? 'emailMessage/Body' : 'Body'] += 'https://org.crm4.dynamics.com/';
  assert.ok(failed(checkClientdata(c, VARIANTS.test)).some((n) => n.startsWith('the placeholder')));
});

test('DEFECT: a test prefix missing in the test variant, or present in production, is detected', () => {
  const key = EMAIL_KEY_STYLE === 'nested' ? 'emailMessage/Subject' : 'Subject';
  const a = clone(cdOf(VARIANTS.test)); const s = find(a, 'Send_escalation_email').action.inputs.parameters; s[key] = s[key].replace('[Muwafaqa test] ', '');
  assert.ok(failed(checkClientdata(a, VARIANTS.test)).some((n) => n.includes('subjects')));
  const b = clone(cdOf(VARIANTS.production)); const t = find(b, 'Send_reminder_email').action.inputs.parameters; t[key] = `[Muwafaqa test] ${t[key]}`;
  assert.ok(failed(checkClientdata(b, VARIANTS.production)).some((n) => n.includes('subjects')));
});

test('DEFECT: an unknown operation, an undeclared variable, a bad reference and an unbalanced expression are detected', () => {
  const op = clone(cdOf()); find(op, 'Get_pending_contracts').action.inputs.host.operationId = 'DeleteRecord';
  assert.ok(failed(checkClientdata(op, VARIANTS.test)).some((n) => n.startsWith('operation ids')));
  const v = clone(cdOf()); find(v, 'Reset_action').action.inputs.name = 'undeclared';
  assert.ok(failed(checkClientdata(v, VARIANTS.test)).some((n) => n.startsWith('every variable that is read or set')));
  const r = clone(cdOf()); find(r, 'Set_recipient_owner').action.inputs.value = "@{first(outputs('Get_nothing')?['body/value'])}";
  assert.ok(failed(checkClientdata(r, VARIANTS.test)).some((n) => n.startsWith('every outputs()')));
  const e = clone(cdOf()); find(e, 'Set_action').action.inputs.value = "@{if(equals(1, 1), 'remind', ''}";
  assert.ok(failed(checkClientdata(e, VARIANTS.test)).some((n) => n.startsWith('every expression has balanced')));
});

test('DEFECT: a wrong trigger is detected (a different interval, another trigger type)', () => {
  const a = clone(cdOf(VARIANTS.test)); defOf(a).triggers.Recurrence.recurrence.interval = 15;
  assert.ok(failed(checkClientdata(a, VARIANTS.test)).some((n) => n.startsWith('exactly one trigger')));
  const b = clone(cdOf(VARIANTS.test)); defOf(b).triggers.Recurrence.recurrence.frequency = 'Second';
  assert.ok(failed(checkClientdata(b, VARIANTS.test)).some((n) => n.startsWith('exactly one trigger')));
});

test('DEFECT: a variable that is not initialized at the top level is detected', () => {
  const cd = clone(cdOf());
  find(cd, 'Check_step_still_due').action.actions.Init_inside = { type: 'InitializeVariable', inputs: { variables: [{ name: 'oops', type: 'string', value: '' }] }, runAfter: { Branch_send: ['Succeeded'] } };
  assert.ok(failed(checkClientdata(cd, VARIANTS.test)).some((n) => n.startsWith('Initialize variable appears only')));
});

// ---- the creation request (pure)
test('the body of the ONE POST: exactly these keys, a modern cloud flow, and NO state of any kind', () => {
  for (const variant of Object.values(VARIANTS)) {
    const body = createBody(variant, '{"x":1}');
    assert.deepEqual(Object.keys(body), ['name', 'category', 'type', 'primaryentity', 'description', 'clientdata']);
    assert.equal(body.name, 'Muwafaqa - Approval Reminders');
    assert.equal(body.category, 5);
    assert.equal(body.type, 1);
    assert.equal(body.primaryentity, 'none');
    assert.equal(body.clientdata, '{"x":1}');
    for (const key of Object.keys(body)) assert.doesNotMatch(key, /state|status|activ/i, key);
    assert.match(body.description, /Created OFF/);
    assert.match(body.description, /Only the owner turns it on/);
    assert.equal(body.description, FLOW_DESCRIPTION(variant));
    assert.ok(body.description.includes(variant.name));
  }
});

test('the dry-run summary: name, OFF, both connection references, one POST, sizes; and no dump of the definition', () => {
  for (const variant of Object.values(VARIANTS)) {
    const text = requestSummary(variant).join('\n');
    assert.match(text, /DRY RUN: nothing is sent/);
    assert.match(text, /POST workflows \(ONE row, never retried\)/);
    assert.match(text, /MSCRM\.SolutionUniqueName: Muwafaqa/);
    assert.match(text, /NAME {6}Muwafaqa - Approval Reminders/);
    assert.match(text, /STATE {5}OFF: the body carries no state/);
    assert.match(text, /BINDS {5}shared_commondataserviceforapps -> connection reference new_sharedcommondataserviceforapps_43184/);
    assert.match(text, /BINDS {5}shared_office365 \(Office 365 Outlook\) -> connection reference mwf_sharedoffice365_reminders/);
    assert.match(text, /42 actions, nesting depth 7/);
    assert.match(text, /45 of 45 structural checks pass/);
    assert.match(text, /NEVER {5}turn on, turn off, update, delete or run any flow/);
    assert.match(text, new RegExp(`recurrence every ${variant.intervalMinutes} minute`));
    assert.match(text, new RegExp(`reminder after ${variant.timers.remindAfterMinutes} min, escalation after ${variant.timers.escalateAfterMinutes} min; cap 5`));
    assert.doesNotMatch(text, /"actions"|"triggers"|"properties"|runAfter|InitializeVariable/);
    assert.ok(text.length < 3000, 'a summary, not a dump');
  }
  assert.match(requestSummary(VARIANTS.test).join('\n'), /subject prefix "\[Muwafaqa test\] "/);
  assert.match(requestSummary(VARIANTS.production).join('\n'), /subject prefix none/);
});

test('the summary uses the references given, and says the real run would refuse when a check fails', () => {
  const text = requestSummary(VARIANTS.test, { outlookRef: 'mwf_other_outlook', dataverseRef: 'new_other_dv', solution: 'Other' }).join('\n');
  assert.match(text, /connection reference mwf_other_outlook/);
  assert.match(text, /connection reference new_other_dv/);
  assert.match(text, /SolutionUniqueName: Other/);
  assert.throws(() => requestSummary(VARIANTS.test, { outlookRef: '00000000-aaaa-4bbb-8ccc-000000000001' }), /not a valid connection reference/);
});

// ---- the script
test('NO CODE PATH TURNS A FLOW ON: no PATCH or PUT, no state or status being set, one POST of the new row, and exactly ONE delete (the replace of the flow of this exact name)', () => {
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /'PATCH'|'PUT'|"PATCH"|"PUT"/);
  assert.doesNotMatch(code, /statecode\s*[:=]\s*\d|statuscode\s*[:=]\s*\d|SetState|activate|Activat|turn_on|turnOn/i);
  assert.equal((code.match(/call\('POST'/g) || []).length, 1);
  assert.match(code, /call\('POST', 'workflows', createBody\(/);
  assert.equal((code.match(/'POST'/g) || []).length, 1);
  assert.equal((code.match(/'DELETE'/g) || []).length, 1);
  assert.match(code, /call\('DELETE', `workflows\(\$\{existing\[0\]\.workflowid\}\)`\)/);
  assert.match(SOURCE, /NO CODE PATH THAT TURNS A FLOW ON/);
});

test('the delete is reached only after the guards and the preflight: in the source the guards, then the preflight, then the delete, then the post', () => {
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const at = (s) => code.indexOf(s);
  const order = [at('replaceGuards({'), at("throw new Stop('A guard failed. Nothing was written.')"), at('const pf = await preflight();   '), at("call('DELETE'"), at('await postAndVerify(pf, before, \'THE OLD ROW WAS DELETED')];
  assert.ok(order.every((x) => x > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((x, y) => x - y), order);
});

test('the creation needs the owner\'s Azure CLI sign-in only and the confirmation flag', () => {
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /--confirm-mutates-environment/);
  assert.match(code, /argOf\('auth'\) !== 'az'/);
  assert.doesNotMatch(code, /deviceToken|device code/i);
});

test('the command line: check passes for both variants, build prints the numbers', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 });
  const check = run('--mode=check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /SUMMARY \(test\): \d+ passed, 0 failed/);
  assert.match(check.stdout, /SUMMARY \(production\): \d+ passed, 0 failed/);
  assert.match(check.stdout, /42 actions, nesting depth 7/);
  const build = run('--mode=build', '--variant=test');
  assert.equal(build.status, 0, build.stderr);
  assert.match(build.stdout, /42 actions, depth 7/);
  assert.match(build.stdout, /Send_reminder_email/);
  const named = run('--mode=check', '--variant=production', '--outlook-ref=mwf_my_outlook');
  assert.equal(named.status, 0, named.stderr);
  const explicit = run('--mode=check', '--outlook-ref=mwf_sharedoffice365_reminders');
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /SUMMARY \(test\): 45 passed, 0 failed/);
  assert.match(explicit.stdout, /SUMMARY \(production\): 45 passed, 0 failed/);
});

test('the command line: create is a DRY RUN without the confirmation flag (offline, no --env needed), and --dry-run always wins', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 });
  const dry = run('--mode=create', '--variant=test');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN: nothing is sent/);
  assert.match(dry.stdout, /Nothing was sent/);
  assert.match(dry.stdout, /mwf_sharedoffice365_reminders/);
  const prod = run('--mode=create', '--variant=production', '--outlook-ref=mwf_sharedoffice365_reminders');
  assert.equal(prod.status, 0, prod.stderr);
  assert.match(prod.stdout, /recurrence every 15 minute/);
  const both = run('--mode=create', '--variant=test', '--confirm-mutates-environment', '--dry-run', '--env=https://example.invalid');
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.stdout, /DRY RUN/);
});

test('the command line: refusals, all before any sign-in (exit 2)', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run('--mode=create').status, 2);                                   // no variant
  assert.equal(run('--mode=create', '--variant=both').status, 2);                 // exactly one variant
  assert.equal(run('--mode=create', '--variant=other').status, 2);
  const noEnv = run('--mode=create', '--variant=test', '--confirm-mutates-environment');
  assert.equal(noEnv.status, 2);
  assert.match(noEnv.stderr, /--env/);
  const device = run('--mode=create', '--variant=test', '--confirm-mutates-environment', '--env=https://example.invalid', '--auth=device');
  assert.equal(device.status, 2);
  assert.match(device.stderr, /Only --auth=az/);
  assert.equal(run('--mode=verify').status, 2);                                   // needs --env
  for (const mode of ['cleanup', 'delete', 'update', '']) { const r = run(`--mode=${mode}`); assert.equal(r.status, 2, mode); assert.match(r.stderr, /invalid --mode=build\|check\|create\|verify/i); }
  const guid = run('--mode=check', '--outlook-ref=00000000-aaaa-4bbb-8ccc-000000000001');
  assert.equal(guid.status, 2);
  assert.match(guid.stderr, /not a valid connection reference/);
  assert.equal(run('--mode=check', '--variant=other').status, 2);
});

// ---- the two findings of the designer review and of the first live runs (2026-10-28)
test('FINDING (designer): no Set variable action carries an empty literal; the three resets use string(\'\') as the designer stored them', () => {
  const cd = cdOf();
  const sets = walk(defOf(cd).actions).filter((x) => x.action.type === 'SetVariable');
  assert.ok(sets.length >= 8);
  for (const s of sets) { const val = s.action.inputs.value; assert.equal(typeof val, 'string', s.name); assert.notEqual(val.trim(), '', `${s.name} has an empty literal`); }
  for (const n of ['Reset_sinceUtc', 'Reset_action', 'Reset_recipientEmail']) assert.equal(find(cd, n).action.inputs.value, "@string('')", n);
});

test('FINDING (designer): the check FAILS on the old definition, where the three resets had an empty literal (this is what the designer rejected)', () => {
  const old = clone(cdOf());
  for (const n of ['Reset_sinceUtc', 'Reset_action', 'Reset_recipientEmail']) find(old, n).action.inputs.value = '';
  const names = failed(checkClientdata(old, VARIANTS.test));
  assert.equal(names.length, 1);
  assert.match(names[0], /^no Set variable action has an empty or missing literal/);
  assert.ok(failed(checkClientdata(cdOf(), VARIANTS.test)).length === 0);
  for (const v of [' ', undefined, null]) { const x = clone(cdOf()); find(x, 'Reset_action').action.inputs.value = v; assert.ok(failed(checkClientdata(x, VARIANTS.test)).some((m) => m.startsWith('no Set variable action has an empty')), String(v)); }
});

test('FINDING (live runs): the contract query leaves out contracts with an empty approval round, and the check fails without that condition', () => {
  assert.equal(find(cdOf(), 'Get_pending_contracts').action.inputs.parameters.$filter, 'statuscode eq 867640000 and mwf_approvalround ne null');
  const old = clone(cdOf()); find(old, 'Get_pending_contracts').action.inputs.parameters.$filter = 'statuscode eq 867640000';
  const names = failed(checkClientdata(old, VARIANTS.test));
  assert.equal(names.length, 1);
  assert.match(names[0], /^the contract query leaves out contracts whose approval round is empty/);
});

test('the first action of a nested scope has no runAfter key (as the designer stores it); only the first action of the flow keeps an empty one', () => {
  const list = walk(defOf(cdOf()).actions);
  const firstOf = (x) => Object.keys(x.siblings)[0] === x.name;
  const chainedFirsts = list.filter((x) => firstOf(x) && x.scope.length > 0 && Object.keys(x.siblings).length > 1);
  assert.ok(chainedFirsts.length >= 6);
  for (const x of chainedFirsts) assert.equal('runAfter' in x.action, false, x.name);
  assert.deepEqual(list[0].action.runAfter, {});
});

test('the generated test definition equals the one the DESIGNER stored (src/Workflows), except three known paths', (t) => {
  const dir = fileURLToPath(new URL('../src/Workflows/', import.meta.url));
  const file = fs.readdirSync(dir).find((f) => /^Muwafaqa-ApprovalReminders-.*\.json$/.test(f));
  if (!file) return t.skip('the flow is not in src/Workflows');
  const stored = JSON.parse(fs.readFileSync(dir + file, 'utf8').replace(/^\uFEFF/, ''));
  const flat = (o, p = '', out = {}) => {
    if (Array.isArray(o)) { if (!o.length) out[p] = '[]'; o.forEach((x, i) => flat(x, `${p}[${i}]`, out)); }
    else if (o && typeof o === 'object') { const k = Object.keys(o); if (!k.length) out[p] = '{}'; k.forEach((x) => flat(o[x], p ? `${p}.${x}` : x, out)); }
    else out[p] = o;
    return out;
  };
  const gen = flat(cdOf(VARIANTS.test)); const des = flat(stored);
  const diff = [...new Set([...Object.keys(gen), ...Object.keys(des)])].filter((k) => JSON.stringify(gen[k]) !== JSON.stringify(des[k])).sort();
  const known = [
    'properties.definition.actions.Get_pending_contracts.inputs.parameters.$filter',   // the generator is AHEAD: it leaves out contracts with an empty round (the stored flow does not yet)
    'properties.definition.description',                                               // the designer copies the flow description into the definition
    'properties.templateName',                                                         // the designer adds an empty template name
  ].sort();
  // after the stored flow is re-created from this generator the first path disappears from the list; until then it is the one difference
  const allowed = diff.every((k) => known.includes(k));
  assert.ok(allowed, `unexpected differences: ${diff.filter((k) => !known.includes(k)).join(', ')}`);
});

// ---- replace: the guards and the summary (pure)
const GOOD_ROW = { workflowid: 'w1', name: 'Muwafaqa - Approval Reminders', category: 5, statecode: 0, statuscode: 1 };
const OFF_FLOWS = [{ name: 'a', statecode: 0 }, { name: 'Muwafaqa - Approval Reminders', statecode: 0 }];
const GOOD = { rows: [GOOD_ROW], inSolution: true, flows: OFF_FLOWS, counts: { contracts: 11, matrix: 110, assignments: 5, steps: 0 } };

test('replace guards: everything as expected passes with no reason', () => {
  assert.deepEqual(replaceGuards(GOOD), { ok: true, reasons: [] });
  assert.deepEqual(REPLACE_BASELINE, { contracts: 11, matrix: 110, assignments: 5, steps: 0 });
});

test('replace guards: REFUSES when the flow is ON (and when its state is anything but OFF)', () => {
  for (const statecode of [1, 2, undefined, null]) {
    const r = replaceGuards({ ...GOOD, rows: [{ ...GOOD_ROW, statecode }], flows: OFF_FLOWS });
    assert.equal(r.ok, false, String(statecode));
    assert.ok(r.reasons.some((x) => /not OFF/.test(x)), String(statecode));
  }
});

test('replace guards: REFUSES with two rows, with none, and with no row list at all', () => {
  const two = replaceGuards({ ...GOOD, rows: [GOOD_ROW, { ...GOOD_ROW, workflowid: 'w2' }] });
  assert.equal(two.ok, false); assert.match(two.reasons[0], /2 row\(s\) with this name: exactly one/);
  const none = replaceGuards({ ...GOOD, rows: [] });
  assert.equal(none.ok, false); assert.match(none.reasons[0], /0 row\(s\)/);
  assert.equal(replaceGuards({ ...GOOD, rows: undefined }).ok, false);
});

test('replace guards: REFUSES when the name differs, also in case, in spaces or by a suffix', () => {
  for (const name of ['Muwafaqa - Approval Reminders v2', 'muwafaqa - approval reminders', 'Muwafaqa - Approval Reminders ', 'Muwafaqa - Contract Approval v2', '']) {
    const r = replaceGuards({ ...GOOD, rows: [{ ...GOOD_ROW, name }] });
    assert.equal(r.ok, false, JSON.stringify(name));
    assert.ok(r.reasons.some((x) => /not exactly/.test(x)), JSON.stringify(name));
  }
});

test('replace guards: REFUSES when the row is not a modern flow, not in the solution, or when ANY other flow is ON, or the baseline differs', () => {
  assert.ok(replaceGuards({ ...GOOD, rows: [{ ...GOOD_ROW, category: 0 }] }).reasons.some((x) => /category 5/.test(x)));
  assert.ok(replaceGuards({ ...GOOD, inSolution: false }).reasons.some((x) => /component of the solution/.test(x)));
  assert.ok(replaceGuards({ ...GOOD, inSolution: undefined }).reasons.some((x) => /component of the solution/.test(x)));
  const other = replaceGuards({ ...GOOD, flows: [...OFF_FLOWS, { name: 'Muwafaqa - Contract Approval v2', statecode: 1 }] });
  assert.equal(other.ok, false); assert.ok(other.reasons.some((x) => /1 flow row\(s\) of the environment are not OFF/.test(x)));
  for (const [key, value] of [['contracts', 12], ['matrix', 109], ['assignments', 4], ['steps', 1]]) {
    const r = replaceGuards({ ...GOOD, counts: { ...GOOD.counts, [key]: value } });
    assert.equal(r.ok, false, key); assert.ok(r.reasons.some((x) => x.includes(`baseline: ${key} is ${value}`)), key);
  }
  assert.equal(replaceGuards({ ...GOOD, counts: undefined }).ok, false);
});

test('replace guards: every failing guard is listed, not only the first', () => {
  const r = replaceGuards({ rows: [{ ...GOOD_ROW, statecode: 1, name: 'other' }], inSolution: false, flows: [{ statecode: 1 }], counts: { contracts: 0, matrix: 0, assignments: 0, steps: 9 } });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.length >= 8, JSON.stringify(r.reasons));
});

test('the replace summary: one DELETE and one POST, the exact name, the guards, OFF, and test only', () => {
  const text = replaceSummary(VARIANTS.test).join('\n');
  assert.match(text, /^DRY RUN: nothing is sent/);
  assert.match(text, /ONE DELETE of the existing flow row named "Muwafaqa - Approval Reminders", then ONE POST workflows/);
  assert.match(text, /Neither is retried/);
  assert.match(text, /exactly ONE row has this exact name/);
  assert.match(text, /it is OFF \(statecode 0\)/);
  assert.match(text, /EVERY flow row of the environment is OFF/);
  assert.match(text, /baseline contracts 11, matrix 110, assignments 5, steps 0/);
  assert.match(text, /IF THE POST FAILS {2}the old row is GONE/);
  assert.match(text, /STATE {5}OFF/);
  assert.match(text, /NEVER {5}turn on, turn off or run any flow/);
  assert.match(text, /mwf_sharedoffice365_reminders/);
  assert.match(text, /45 of 45 structural checks pass/);
  assert.doesNotMatch(text, /"actions"|"triggers"|runAfter/);
  assert.throws(() => replaceSummary(VARIANTS.production), /only for the test variant/);
});

test('the command line: replace is a dry run without the confirmation flag, test only, and refuses before any sign-in', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 });
  const dry = run('--mode=replace', '--variant=test');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /ONE DELETE of the existing flow row/);
  assert.match(dry.stdout, /Nothing was sent/);
  const both = run('--mode=replace', '--variant=test', '--confirm-mutates-environment', '--dry-run', '--env=https://example.invalid');
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.stdout, /DRY RUN/);
  assert.equal(run('--mode=replace').status, 2);                                    // no variant
  assert.equal(run('--mode=replace', '--variant=production').status, 2);           // test only
  assert.match(run('--mode=replace', '--variant=production').stderr, /only for the test variant/);
  assert.equal(run('--mode=replace', '--variant=both').status, 2);
  const noEnv = run('--mode=replace', '--variant=test', '--confirm-mutates-environment');
  assert.equal(noEnv.status, 2); assert.match(noEnv.stderr, /--env/);
  const device = run('--mode=replace', '--variant=test', '--confirm-mutates-environment', '--env=https://example.invalid', '--auth=device');
  assert.equal(device.status, 2); assert.match(device.stderr, /Only --auth=az/);
});
