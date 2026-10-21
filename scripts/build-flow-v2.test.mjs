// node --test scripts/build-flow-v2.test.mjs   (offline: the structural checker of the flow v2 definition must catch real defects)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClientdata, checkClientdata, balanced, expressionsOf, walk } from './build-flow-v2.mjs';

const fresh = () => JSON.parse(JSON.stringify(buildClientdata()));
const failing = (cd) => checkClientdata(cd, { v1Trigger: Object.values(buildClientdata().properties.definition.triggers)[0] }).results.filter((r) => !r.pass).map((r) => r.name);

test('the definition as built passes every check', () => {
  assert.deepEqual(failing(fresh()), []);
});

test('a runAfter that points to a missing action is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Check_steps_exist.runAfter = { No_such_action: ['Succeeded'] };
  assert.ok(failing(cd).some((n) => /runAfter points to a sibling/.test(n)));
});

test('a reference to an action that does not exist is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Set_contract_In_Force.inputs.parameters.recordId = "@outputs('Ghost')?['body/x']";
  assert.ok(failing(cd).some((n) => /reference points to an earlier action/.test(n)));
});

test('a reference to an action later in the flow is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Get_steps_of_this_round.inputs.parameters.entityName = "@outputs('Set_contract_In_Force')?['body/x']";
  assert.ok(failing(cd).some((n) => /reference points to an earlier action/.test(n)));
});

test('a reference from outside the loop to an action inside the loop is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Set_contract_In_Force.inputs.parameters.recordId = "@outputs('Role_name')";
  assert.ok(failing(cd).some((n) => /reference points to an earlier action/.test(n)));
});

test('items() outside the loop is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Set_contract_In_Force.inputs.parameters.recordId = "@items('Apply_to_each_step')?['x']";
  assert.ok(failing(cd).some((n) => /reference points to an earlier action/.test(n)));
});

test('a variable is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Set_contract_In_Force.inputs.parameters.recordId = "@variables('total')";
  assert.ok(failing(cd).some((n) => /no variables/.test(n)));
});

test('an unknown connection name is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Get_steps_of_this_round.inputs.host.connectionName = 'shared_other';
  assert.ok(failing(cd).some((n) => /connectionName/.test(n)));
});

test('a name of a v1 action is reported', () => {
  const cd = fresh(); const a = cd.properties.definition.actions; a.Check_Stage1 = a.Set_contract_In_Force; delete a.Set_contract_In_Force;
  assert.ok(failing(cd).some((n) => /name of a v1 action/.test(n)));
});

test('a duplicate action name is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Apply_to_each_step.actions.Check_steps_exist = { type: 'Compose', inputs: 'x', runAfter: { Role_name: ['Succeeded'] } };
  assert.ok(failing(cd).some((n) => /unique/.test(n)));
});

test('an action without a runAfter is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Set_contract_In_Force.runAfter = {};
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
  const cd = fresh(); cd.properties.definition.actions.Set_contract_In_Force.inputs.parameters.recordId = "@triggerOutputs()?['body/mwf_contractid'";
  assert.ok(failing(cd).some((n) => /balanced/.test(n)));
});

test('an email address in the definition is reported', () => {
  const cd = fresh(); cd.properties.definition.actions.Set_contract_In_Force.inputs.parameters.recordId = ['someone', 'example.com'].join('@');   // built at run time so that no address is written in the file
  assert.ok(failing(cd).some((n) => /no email address/.test(n)));
});

test('a changed trigger filter is reported', () => {
  const cd = fresh(); Object.values(cd.properties.definition.triggers)[0].inputs.parameters['subscriptionRequest/filterexpression'] = 'statuscode eq 1';
  assert.ok(failing(cd).some((n) => /equal the trigger of v1/.test(n)));
});

test('balanced() and expressionsOf()', () => {
  assert.ok(balanced("outputs('A')?['b']"));
  assert.ok(!balanced("outputs('A'"));
  assert.ok(balanced("concat('(', 'x')"));       // a parenthesis inside a quoted string does not count
  assert.deepEqual(expressionsOf("text @{a('x')} and @{b()}"), ["a('x')", 'b()']);
  assert.deepEqual(expressionsOf('@first(x)'), ['first(x)']);
  assert.deepEqual(expressionsOf('no expression'), []);
});

test('walk() lists 31 actions with scopes', () => {
  assert.equal(walk(buildClientdata().properties.definition.actions).length, 31);
});
