// node --test scripts/build-flow-v2.test.mjs   (offline: the structural checker of the flow v2 definition must catch real defects)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClientdata, checkClientdata, balanced, expressionsOf, walk } from './build-flow-v2.mjs';

const fresh = () => JSON.parse(JSON.stringify(buildClientdata()));
const node = (cd, name) => walk(cd.properties.definition.actions).find((x) => x.name === name).action;   // any action by name, at any depth
const failing = (cd) => checkClientdata(cd, { v1Trigger: Object.values(buildClientdata().properties.definition.triggers)[0] }).results.filter((r) => !r.pass).map((r) => r.name);

test('the definition as built passes every check', () => {
  assert.deepEqual(failing(fresh()), []);
});

test('a runAfter that points to a missing action is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Check_steps_exist.runAfter = { No_such_action: ['Succeeded'] };
  assert.ok(failing(cd).some((n) => /runAfter points to a sibling/.test(n)));
});

test('a reference to an action that does not exist is reported', () => {
  const cd = fresh(); node(cd, 'Set_contract_In_Force').inputs.parameters.recordId = "@outputs('Ghost')?['body/x']";
  assert.ok(failing(cd).some((n) => /reference points to an earlier action/.test(n)));
});

test('a reference to an action later in the flow is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Get_steps_of_this_round.inputs.parameters.entityName = "@outputs('Set_contract_In_Force')?['body/x']";
  assert.ok(failing(cd).some((n) => /reference points to an earlier action/.test(n)));
});

test('a reference from outside the loop to an action inside the loop is reported', () => {
  const cd = fresh(); node(cd, 'Set_contract_In_Force').inputs.parameters.recordId = "@outputs('Get_assignment_of_role')";
  assert.ok(failing(cd).some((n) => /reference points to an earlier action/.test(n)));
});

test('items() outside the loop is reported', () => {
  const cd = fresh(); node(cd, 'Set_contract_In_Force').inputs.parameters.recordId = "@items('Apply_to_each_step')?['x']";
  assert.ok(failing(cd).some((n) => /reference points to an earlier action/.test(n)));
});

test('a variable that was never initialized is reported', () => {
  const cd = fresh(); node(cd, 'Set_contract_In_Force').inputs.parameters.recordId = "@variables('total')";
  assert.ok(failing(cd).some((n) => /initialized earlier/.test(n)));
});

test('an unknown connection name is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Get_steps_of_this_round.inputs.host.connectionName = 'shared_other';
  assert.ok(failing(cd).some((n) => /connectionName/.test(n)));
});

test('a name of a v1 action is reported', () => {
  const cd = fresh(); const a = cd.properties.definition.actions; a.Check_Stage1 = { type: 'Compose', inputs: 'x', runAfter: { Switch_on_end_kind: ['Succeeded'] } };
  assert.ok(failing(cd).some((n) => /name of a v1 action/.test(n)));
});

test('a duplicate action name is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Apply_to_each_step.actions.Gate_find_user.actions.Check_steps_exist = { type: 'Compose', inputs: 'x', runAfter: { Get_approver_user: ['Succeeded'] } };
  assert.ok(failing(cd).some((n) => /unique/.test(n)));
});

test('an action without a runAfter is reported', () => {
  const cd = fresh(); node(cd, 'Set_contract_In_Force').runAfter = {};
  assert.ok(failing(cd).some((n) => /has a runAfter/.test(n)));
});

test('a Terminate Failed without runError is reported', () => {
  const cd = fresh(); delete cd.properties.definition.actions.Check_steps_exist.else.actions.Fail_no_approval_steps.inputs.runError;
  assert.ok(failing(cd).some((n) => /runError/.test(n)));
});

test('a concurrent loop is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Apply_to_each_step.runtimeConfiguration.concurrency.repetitions = 20;
  assert.ok(failing(cd).some((n) => /concurrency 1/.test(n)));
});

test('an unbalanced expression is reported', () => {
  const cd = fresh(); node(cd, 'Set_contract_In_Force').inputs.parameters.recordId = "@triggerOutputs()?['body/mwf_contractid'";
  assert.ok(failing(cd).some((n) => /balanced/.test(n)));
});

test('an email address in the definition is reported', () => {
  const cd = fresh(); node(cd, 'Set_contract_In_Force').inputs.parameters.recordId = ['someone', 'example.com'].join('@');   // built at run time so that no address is written in the file
  assert.ok(failing(cd).some((n) => /no email address/.test(n)));
});

test('a changed trigger filter is reported', () => {
  const cd = fresh(); Object.values(cd.properties.definition.triggers)[0].inputs.parameters['subscriptionRequest/filterexpression'] = 'statuscode eq 1';
  assert.ok(failing(cd).some((n) => /equal the trigger of v1/.test(n)));
});

test('reassignment can not come back as true in the Approve request', () => {
  const cd = fresh(); node(cd, 'Request_approval_for_step').inputs.parameters['WebhookApprovalCreationInput/enableReassignment'] = true;
  assert.ok(failing(cd).some((n) => /reassignment is disabled/.test(n)));
});

test('reassignment can not come back as true in the Inform request', () => {
  const cd = fresh(); node(cd, 'Send_information_approval').inputs.parameters['ApprovalCreationInput/enableReassignment'] = true;
  assert.ok(failing(cd).some((n) => /reassignment is disabled/.test(n)));
});

test('the built definition has reassignment false in both approval actions', () => {
  const cd = buildClientdata();
  assert.equal(node(cd, 'Request_approval_for_step').inputs.parameters['WebhookApprovalCreationInput/enableReassignment'], false);
  assert.equal(node(cd, 'Send_information_approval').inputs.parameters['ApprovalCreationInput/enableReassignment'], false);
});

test('balanced() and expressionsOf()', () => {
  assert.ok(balanced("outputs('A')?['b']"));
  assert.ok(!balanced("outputs('A'"));
  assert.ok(balanced("concat('(', 'x')"));       // a parenthesis inside a quoted string does not count
  assert.deepEqual(expressionsOf("text @{a('x')} and @{b()}"), ["a('x')", 'b()']);
  assert.deepEqual(expressionsOf('@first(x)'), ['first(x)']);
  assert.deepEqual(expressionsOf('no expression'), []);
});

test('walk() lists 50 actions with scopes (Switch cases and default included)', () => {
  assert.equal(walk(buildClientdata().properties.definition.actions).length, 50);
});

// ---- the Terminate restriction (found when the owner turned v2 on: InvalidWorkflowRunAction, "'Terminate' ... could not be nested under an action of type 'foreach'")
test('a Terminate directly in the loop is reported (the first build of v2 had them)', () => {
  const cd = fresh(); node(cd, 'Apply_to_each_step').actions.Stop_in_loop = { type: 'Terminate', inputs: { runStatus: 'Cancelled' }, runAfter: { Gate_send_request: ['Succeeded'] } };
  assert.ok(failing(cd).some((n) => /no Terminate action is nested under a Foreach/.test(n)));
});

test('a Terminate deep inside the loop (under conditions) is reported', () => {
  const cd = fresh(); node(cd, 'Check_contract_before_step').else.actions.Stop_deep = { type: 'Terminate', inputs: { runStatus: 'Cancelled' }, runAfter: { Before_step_end_message: ['Succeeded'] } };
  assert.ok(failing(cd).some((n) => /no Terminate action is nested under a Foreach/.test(n)));
});

test('the first build of v2 (Terminate inside the loop, no variables) fails the checks', () => {
  const cd = fresh(); const loop = node(cd, 'Apply_to_each_step');
  loop.actions = { Get_contract_before_step: { type: 'OpenApiConnection', inputs: { parameters: {}, host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps', operationId: 'GetItem', connectionName: 'shared_commondataserviceforapps' } }, runAfter: {} },
    Check_contract_before_step: { type: 'If', expression: { equals: [1, 1] }, actions: {}, else: { actions: { Stop_contract_not_pending_before_step: { type: 'Terminate', inputs: { runStatus: 'Cancelled' } } } }, runAfter: { Get_contract_before_step: ['Succeeded'] } } };
  const bad = failing(cd);
  assert.ok(bad.some((n) => /no Terminate action is nested under a Foreach/.test(n)));
  assert.ok(bad.some((n) => /direct child of the loop is a gate/.test(n)));
});

test('Initialize variable inside a condition or a loop is reported', () => {
  const cd = fresh(); node(cd, 'Gate_find_user').actions.Init_inside = { type: 'InitializeVariable', inputs: { variables: [{ name: 'late', type: 'string', value: '' }] }, runAfter: { Check_approver_email: ['Succeeded'] } };
  assert.ok(failing(cd).some((n) => /Initialize variable appears only at the top level/.test(n)));
});

test('endKind and endMessage must exist as empty strings', () => {
  const cd = fresh(); cd.properties.definition.actions.Init_endKind.inputs.variables[0].value = 'x';
  assert.ok(failing(cd).some((n) => /endKind and endMessage exist/.test(n)));
});

test('a group of the loop that is not gated on endKind is reported', () => {
  const cd = fresh(); node(cd, 'Apply_to_each_step').actions.Gate_find_user.expression = { equals: [1, 1] };
  assert.ok(failing(cd).some((n) => /direct child of the loop is a gate/.test(n)));
});

test('a Switch that is not right after the loop, or whose Failed case has no endMessage, is reported', () => {
  const a = fresh(); a.properties.definition.actions.Switch_on_end_kind.runAfter = { Check_steps_exist: ['Succeeded'] };
  assert.ok(failing(a).some((n) => /Switch on endKind runs right after the loop/.test(n)));
  const b = fresh(); node(b, 'Stop_run_failed').inputs.runError.message = 'fixed text';
  assert.ok(failing(b).some((n) => /Switch cases/.test(n)));
  const c = fresh(); node(c, 'Stop_run_after_rejection').inputs.runStatus = 'Failed';
  assert.ok(failing(c).some((n) => /Switch cases/.test(n)));
});

test('the Switch default keeps the old ending: last checkpoint, then In Force', () => {
  const cd = fresh(); delete node(cd, 'Switch_on_end_kind').default.actions.Set_contract_In_Force;
  assert.ok(failing(cd).some((n) => /default of the Switch carries on/.test(n)));
});

test('endKind can be set only inside the loop and only to the three end kinds', () => {
  const cd = fresh(); node(cd, 'Reject_end_kind').inputs.value = 'Unknown';
  assert.ok(failing(cd).some((n) => /endKind is set only inside the loop/.test(n)));
});

test('the loop must stay sequential because it sets variables', () => {
  const cd = fresh(); node(cd, 'Apply_to_each_step').runtimeConfiguration.concurrency.repetitions = 5;
  assert.ok(failing(cd).some((n) => /Set variable inside a loop only in a sequential loop/.test(n)));
});
