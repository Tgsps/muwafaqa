#!/usr/bin/env node
/**
 * Builds, checks and (on purpose) creates the flow "Muwafaqa - Contract Approval v2" (ADR-007, batch 3, docs/flow-approval-v2.md).
 * The flow is created OFF (a new cloud flow row is in the Draft state). This script NEVER turns a flow on or off, never changes v1, and
 * never starts a run. The flow definition is code in this file, so no id, address or host is stored anywhere in the repository: the
 * record link keeps the placeholder <ORG_HOST>, which `create` replaces with the host of --env in memory only.
 *
 * Modes:
 *   --mode=build   offline. Prints the action table (name, type, parent). With --out=<file outside the repository> writes the clientdata JSON
 *                  (still with the placeholder). No network.
 *   --mode=check   offline. Structural checks of the definition (what can be checked without the designer): unique action names, runAfter
 *                  targets, references to earlier actions in the same or an enclosing scope, items() inside the loop, variables (top level, defined before use), no Terminate under a loop, the closing Switch, balanced
 *                  expressions, connection names, nesting depth, concurrency 1, Terminate Failed has runError, the trigger equals the trigger of
 *                  v1 in src/Workflows, no name of v1, no address or id. Exit code 1 on any failure.
 *   --mode=create  needs --env and --confirm-mutates-environment. 3 GET requests first. Reads v1 (read only) for its connection references,
 *                  stops if v2 already exists, POSTs ONE workflows row (never retried; if the network fails it reads whether the row exists and
 *                  prints that), then reads it back: category, OFF, solution membership, structure, and that v1 is unchanged.
 *   --mode=verify  read only. Re-reads v2 and v1: both OFF, v2 in the solution, the size of the stored clientdata, its structure (the same checks as --mode=check)
 *                  and that v1 is unchanged since the first read of this run is not possible here, so v1's modifiedon is printed for comparison.
 *   --mode=cleanup deletes ONLY the row named "Muwafaqa - Contract Approval v2" (category 5) and only if it is OFF; never v1. Needs --confirm-mutates-environment.
 *                  For a half-created row after a POST whose outcome is unknown.
 *
 * Usage:
 *   node scripts/build-flow-v2.mjs --mode=check
 *   node scripts/build-flow-v2.mjs --mode=create --env=https://<org>.crm4.dynamics.com --auth=az --confirm-mutates-environment
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const MODE = argOf('mode');
const FLOW_NAME = 'Muwafaqa - Contract Approval v2';
const V1_NAME = 'Muwafaqa - Contract Approval v1';
const SOLUTION = argOf('solution') || 'Muwafaqa';
const PENDING = 867640000;
const LOOP = 'Apply_to_each_step';
const STEPS = 'Get_steps_of_this_round';

// ------------------------------------------------------------------------------------------------ definition
const CDS = (operationId) => ({ apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps', operationId, connectionName: 'shared_commondataserviceforapps' });
const APR = (operationId) => ({ apiId: '/providers/Microsoft.PowerApps/apis/shared_approvals', operationId, connectionName: 'shared_approvals' });
const cds = (operationId, parameters) => ({ type: 'OpenApiConnection', inputs: { parameters, host: CDS(operationId) } });
const contractPending = (getName) => ({
  and: [
    { equals: [`@outputs('${getName}')?['body/statuscode']`, PENDING] },
    { equals: [`@outputs('${getName}')?['body/mwf_approvalround']`, "@triggerOutputs()?['body/mwf_approvalround']"] },
  ],
});
const getContract = () => cds('GetItem', { entityName: 'mwf_contracts', recordId: "@triggerOutputs()?['body/mwf_contractid']" });
const terminate = (runStatus, runError) => ({ type: 'Terminate', inputs: runError ? { runStatus, runError } : { runStatus } });
/** An If whose true branch is empty and whose false branch stops the run (the checkpoint pattern of v1). */
const guardIf = (expression, elseName, elseAction) => ({ type: 'If', expression, actions: {}, else: { actions: { [elseName]: elseAction } } });
/** Gives every action of the ordered list a runAfter on the previous one (Succeeded). The first one gets `first`. */
function chain(list, first = {}) {
  const out = {}; let prev = null;
  for (const [name, action] of list) {
    out[name] = { ...action, runAfter: prev ? { [prev]: ['Succeeded'] } : first };
    prev = name;
  }
  return out;
}

const ROLE_JSON = '{"867640000":"Department Head","867640001":"Finance Manager","867640002":"General Manager","867640003":"Regional Office","867640004":"Owner"}';
const STEP = `items('${LOOP}')`;
const N = `length(outputs('${STEPS}')?['body/value'])`;
// the role label is computed from the role value of the step, inline (no action, so no cross-scope reference)
const ROLE_EXPR = `json('${ROLE_JSON}')?[string(${STEP}?['mwf_approverrole'])]`;
const where = `(step @{${STEP}?['mwf_steporder']} of @{${N}}, @{${ROLE_EXPR}})`;
const link = 'https://<ORG_HOST>/main.aspx?etn=mwf_contract&pagetype=entityrecord&id=@{triggerOutputs()?[\'body/mwf_contractid\']}';
const detailsText = [
  "**Contract:** @{triggerOutputs()?['body/mwf_name']}",
  "**Number:** @{triggerOutputs()?['body/mwf_contractnumber']}",
  "**Value (USD, frozen):** @{triggerOutputs()?['body/mwf_valueusdfrozen']}",
  `**Step:** @{${STEP}?['mwf_steporder']} of @{${N}} (@{${ROLE_EXPR}})`,
  "**Approval round:** @{triggerOutputs()?['body/mwf_approvalround']}",
].join('\n');
const assignedTo = "@{variables('approverEmail')};";
const updateStep = (extra) => cds('UpdateOnlyRecord', { entityName: 'mwf_approvalsteps', recordId: `@${STEP}?['mwf_approvalstepid']`, ...extra });

// ---- the end of a run is NOT a Terminate inside the loop (a Terminate can not be inside Foreach or Until, Learn: Logic Apps workflow actions, "Terminate action").
// Inside the loop a problem sets two variables; every later group of the loop is gated on endKind being empty; after the loop one Switch ends the run.
const setVar = (name, value) => ({ type: 'SetVariable', inputs: { name, value } });
const initVar = (name) => ({ type: 'InitializeVariable', inputs: { variables: [{ name, type: 'string', value: '' }] } });
const ended = (kind, message, prefix) => chain([[`${prefix}_end_kind`, setVar('endKind', kind)], [`${prefix}_end_message`, setVar('endMessage', message)]]);
const notEnded = { equals: ["@variables('endKind')", ''] };
/** A group of the loop that runs only while no earlier group has ended the run. */
const gate = (name, actions) => [name, { type: 'If', expression: notEnded, actions, else: { actions: {} } }];

function stepActions() {
  const approveBranch = chain([
    ['Mark_step_Waiting', updateStep({ 'item/mwf_decision': 867640001 })],
    ['Request_approval_for_step', {
      type: 'OpenApiConnectionWebhook',
      inputs: {
        parameters: {
          approvalType: 'Basic',
          'WebhookApprovalCreationInput/title': `Approve contract: @{triggerOutputs()?['body/mwf_name']} ${where}`,
          'WebhookApprovalCreationInput/assignedTo': assignedTo,
          'WebhookApprovalCreationInput/details': detailsText,
          'WebhookApprovalCreationInput/itemLink': link,
          'WebhookApprovalCreationInput/itemLinkDescription': 'Open contract',
          'WebhookApprovalCreationInput/enableNotifications': true,
          'WebhookApprovalCreationInput/enableReassignment': false,   // owner decision 2026-10-22 (ADR-007): the approver is fixed by the role and its assignment; Yes would let the approver pass the request on and bypass the chain
        },
        host: APR('StartAndWaitForAnApproval'),
      },
    }],
    ['Get_contract_after_step', getContract()],
    ['Check_contract_after_step', {
      type: 'If', expression: contractPending('Get_contract_after_step'), actions: {},
      else: { actions: ended('Cancelled', 'The contract is no longer Pending Approval, or it was submitted again (another approval round), after a step was answered.', 'After_step') },
    }],
    gate('Gate_after_step', {
      Check_step_outcome: {
        type: 'If',
        expression: { equals: ["@outputs('Request_approval_for_step')?['body/outcome']", 'Approve'] },
        actions: {
          Mark_step_Approved: updateStep({
            'item/mwf_decision': 867640002,
            'item/mwf_decidedon': "@outputs('Request_approval_for_step')?['body/completionDate']",
            'item/mwf_comments': "@{coalesce(first(outputs('Request_approval_for_step')?['body/responses'])?['comments'], '')}",
          }),
        },
        else: {
          actions: chain([
            ['Mark_step_Rejected', updateStep({
              'item/mwf_decision': 867640003,
              'item/mwf_decidedon': "@outputs('Request_approval_for_step')?['body/completionDate']",
              'item/mwf_comments': "@{coalesce(first(outputs('Request_approval_for_step')?['body/responses'])?['comments'], '')}",
            })],
            ['Set_contract_Rejected', cds('UpdateOnlyRecord', { entityName: 'mwf_contracts', recordId: "@triggerOutputs()?['body/mwf_contractid']", 'item/statecode': 1, 'item/statuscode': 2 })],
            ['Reject_end_kind', setVar('endKind', 'Rejected')],
            ['Reject_end_message', setVar('endMessage', 'A step was rejected. The contract was set to Rejected.')],
          ]),
        },
      },
    }),
  ]);
  const informBranch = chain([
    ['Send_information_approval', {
      type: 'OpenApiConnection',
      inputs: {
        parameters: {
          approvalType: 'Basic',
          'ApprovalCreationInput/title': `For information: contract @{triggerOutputs()?['body/mwf_name']} ${where}`,
          'ApprovalCreationInput/assignedTo': assignedTo,
          'ApprovalCreationInput/details': detailsText,
          'ApprovalCreationInput/itemLink': link,
          'ApprovalCreationInput/itemLinkDescription': 'Open contract',
          'ApprovalCreationInput/enableNotifications': true,
          'ApprovalCreationInput/enableReassignment': false,
        },
        host: APR('CreateAnApproval'),
      },
    }],
    ['Mark_step_Informed', updateStep({ 'item/mwf_decision': 867640004, 'item/mwf_decidedon': '@utcNow()' })],
  ]);
  return chain([
    gate('Gate_checkpoint_before_step', chain([
      ['Get_contract_before_step', getContract()],
      ['Check_contract_before_step', {
        type: 'If', expression: contractPending('Get_contract_before_step'), actions: {},
        else: { actions: ended('Cancelled', 'The contract is no longer Pending Approval, or it was submitted again (another approval round), before a step started.', 'Before_step') },
      }],
    ])),
    gate('Gate_find_assignment', chain([
      ['Get_assignment_of_role', cds('ListRecords', {
        entityName: 'mwf_approverassignments',
        $select: 'mwf_approverassignmentid,_mwf_user_value',
        $filter: `mwf_approverrole eq @{${STEP}?['mwf_approverrole']} and statecode eq 0`,
        $top: 1,
      })],
      ['Check_assignment_exists', {
        type: 'If', expression: { greater: ["@length(outputs('Get_assignment_of_role')?['body/value'])", 0] },
        actions: { Set_approver_user_id: setVar('approverUserId', "@{first(outputs('Get_assignment_of_role')?['body/value'])?['_mwf_user_value']}") },
        else: { actions: ended('Failed', 'The approver role of this step has no active Approver Assignment row. The contract stays Pending Approval.', 'No_assignment') },
      }],
    ])),
    gate('Gate_find_user', chain([
      ['Get_approver_user', cds('GetItem', { entityName: 'systemusers', recordId: "@variables('approverUserId')", $select: 'internalemailaddress,fullname' })],
      ['Set_approver_email', setVar('approverEmail', "@{coalesce(outputs('Get_approver_user')?['body/internalemailaddress'], '')}")],
      ['Check_approver_email', {
        type: 'If', expression: { greater: ["@length(variables('approverEmail'))", 0] }, actions: {},
        else: { actions: ended('Failed', 'The user assigned to the approver role has no email address. The contract stays Pending Approval.', 'No_email') },
      }],
    ])),
    gate('Gate_send_request', {
      Branch_on_action_type: {
        type: 'If',
        expression: { equals: [`@${STEP}?['mwf_actiontype']`, 867640000] },
        actions: approveBranch,
        else: { actions: informBranch },
      },
    }),
  ]);
}

export function buildDefinition() {
  const switchEnd = {
    type: 'Switch',
    expression: "@variables('endKind')",
    cases: {
      Case_Cancelled: { case: 'Cancelled', actions: { Stop_run_cancelled: terminate('Cancelled') } },
      Case_Rejected: { case: 'Rejected', actions: { Stop_run_after_rejection: terminate('Succeeded') } },
      Case_Failed: { case: 'Failed', actions: { Stop_run_failed: terminate('Failed', { code: 'ApprovalStepFailed', message: "@variables('endMessage')" }) } },
    },
    default: {
      actions: chain([
        ['Get_contract_before_final', getContract()],
        ['Check_contract_before_final', guardIf(contractPending('Get_contract_before_final'), 'Stop_contract_not_pending_before_final', terminate('Cancelled'))],
        ['Set_contract_In_Force', cds('UpdateOnlyRecord', { entityName: 'mwf_contracts', recordId: "@triggerOutputs()?['body/mwf_contractid']", 'item/statuscode': 867640001 })],
      ]),
    },
  };
  const actions = chain([
    ['Init_endKind', initVar('endKind')],
    ['Init_endMessage', initVar('endMessage')],
    ['Init_approverEmail', initVar('approverEmail')],
    ['Init_approverUserId', initVar('approverUserId')],
    [STEPS, cds('ListRecords', {
      entityName: 'mwf_approvalsteps',
      $select: 'mwf_approvalstepid,mwf_name,mwf_steporder,mwf_approverrole,mwf_actiontype,mwf_decision',
      $filter: "_mwf_contract_value eq @{triggerOutputs()?['body/mwf_contractid']} and mwf_approvalround eq @{triggerOutputs()?['body/mwf_approvalround']}",
      $orderby: 'mwf_steporder asc',
    })],
    ['Check_steps_exist', guardIf({ greater: [`@${N}`, 0] }, 'Fail_no_approval_steps',
      terminate('Failed', { code: 'NoApprovalSteps', message: 'No Approval Step rows exist for this contract and approval round. The contract stays Pending Approval.' }))],
    [LOOP, { type: 'Foreach', foreach: `@outputs('${STEPS}')?['body/value']`, actions: stepActions(), runtimeConfiguration: { concurrency: { repetitions: 1 } } }],
    ['Switch_on_end_kind', switchEnd],
  ]);
  return {
    $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
    contentVersion: '1.0.0.0',
    parameters: { $authentication: { defaultValue: {}, type: 'SecureObject' }, $connections: { defaultValue: {}, type: 'Object' } },
    triggers: {
      When_a_contract_enters_Pending_Approval: {
        type: 'OpenApiConnectionWebhook',
        inputs: {
          parameters: {
            'subscriptionRequest/message': 3,
            'subscriptionRequest/entityname': 'mwf_contract',
            'subscriptionRequest/scope': 4,
            'subscriptionRequest/filteringattributes': 'mwf_valueusdfrozen',
            'subscriptionRequest/filterexpression': `statuscode eq ${PENDING}`,
          },
          host: CDS('SubscribeWebhookTrigger'),
        },
      },
    },
    actions,
  };
}

const DEFAULT_REFS = {
  shared_commondataserviceforapps: { api: { name: 'shared_commondataserviceforapps' }, connection: { connectionReferenceLogicalName: 'new_sharedcommondataserviceforapps_43184' }, runtimeSource: 'embedded' },
  shared_approvals: { api: { name: 'shared_approvals' }, connection: { connectionReferenceLogicalName: 'mwf_sharedapprovals_27e14' }, runtimeSource: 'embedded' },
};
export function buildClientdata(connectionReferences = DEFAULT_REFS) {
  return { properties: { connectionReferences, definition: buildDefinition() }, schemaVersion: '1.0.0.0' };
}

// ------------------------------------------------------------------------------------------------ walk and checks
/** Preorder list of every action: { name, action, scope: [ancestor action names], index } */
export function walk(actions, scope = [], list = []) {
  for (const [name, action] of Object.entries(actions || {})) {
    list.push({ name, action, scope, index: list.length, siblings: actions });
    const inner = [];
    if (action.actions) inner.push(action.actions);
    if (action.else?.actions) inner.push(action.else.actions);
    for (const c of Object.values(action.cases || {})) if (c.actions) inner.push(c.actions);   // Switch
    if (action.default?.actions) inner.push(action.default.actions);
    for (const a of inner) walk(a, [...scope, name], list);
  }
  return list;
}
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}
/** Parentheses and brackets balanced outside single-quoted strings, quotes closed, braces of @{ } closed. */
export function balanced(text) {
  let inQ = false; const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === "'") { if (text[i + 1] === "'") i++; else inQ = false; } continue; }
    if (c === "'") { inQ = true; continue; }
    if ('([{'.includes(c)) stack.push(c);
    if (')]}'.includes(c)) { const o = stack.pop(); if (!o || '([{'.indexOf(o) !== ')]}'.indexOf(c)) return false; }
  }
  return !inQ && stack.length === 0;
}
/** The expression parts of a string: "@expr" or every "@{expr}" inside text. */
export function expressionsOf(s) {
  if (typeof s !== 'string' || !s.includes('@')) return [];
  const out = [];
  if (s.startsWith('@') && !s.startsWith('@{')) { out.push(s.slice(1)); return out; }
  let i = 0;
  while ((i = s.indexOf('@{', i)) >= 0) {
    let depth = 1; let j = i + 2; let inQ = false;
    for (; j < s.length && depth > 0; j++) {
      const c = s[j];
      if (inQ) { if (c === "'") { if (s[j + 1] === "'") j++; else inQ = false; } continue; }
      if (c === "'") inQ = true; else if (c === '{') depth++; else if (c === '}') depth--;
    }
    if (depth !== 0) { out.push('\u0000UNCLOSED'); break; }
    out.push(s.slice(i + 2, j - 1)); i = j;
  }
  return out;
}
const V1_NAMES = ['Approval_DeptHead', 'Check_Stage1', 'Get_contract_after_stage_1', 'Is_still_Pending_(stage_1)', 'Approval_FinanceMgr', 'Check_Stage2', 'Get_contract_after_stage_2',
  'Is_still_Pending_(stage_2)', 'Update_a_row', 'Update_a_row_2', 'Update_a_row_3', 'Terminate', 'Terminate_2', 'Stop_-_contract_no_longer_Pending_(stage_1)',
  'Stop_-_contract_no_longer_Pending_(stage_2)', 'When_a_row_is_added,_modified_or_deleted'];

export function checkClientdata(cd, { v1Trigger = null } = {}) {
  const results = [];
  const ok = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });
  const def = cd.properties.definition; const refs = cd.properties.connectionReferences;
  const list = walk(def.actions);
  const names = list.map((x) => x.name);
  const trig = Object.keys(def.triggers);
  const all = [...names, ...trig];

  ok('action names are unique across the whole flow (including the trigger)', new Set(all).size === all.length, `${all.length} names`);
  ok('action names use letters, digits and underscore only, at most 80 characters', all.every((n) => /^[A-Za-z0-9_]{1,80}$/.test(n)));
  ok('no action or trigger has the name of a v1 action', !all.some((n) => V1_NAMES.includes(n)));
  ok('exactly one trigger', trig.length === 1);

  // runAfter
  let badRun = []; let missingRun = [];
  for (const x of list) {
    const ra = x.action.runAfter || {};
    for (const [t, st] of Object.entries(ra)) {
      if (!(t in x.siblings) || t === x.name) badRun.push(`${x.name}->${t}`);
      if (!Array.isArray(st) || !st.length || !st.every((s) => ['Succeeded', 'Failed', 'Skipped', 'TimedOut'].includes(s))) badRun.push(`${x.name} status`);
    }
    const first = Object.keys(x.siblings)[0] === x.name;
    if (!first && Object.keys(ra).length === 0) missingRun.push(x.name);
  }
  ok('every runAfter points to a sibling action in the same scope, with valid statuses', badRun.length === 0, badRun.join(', '));
  ok('every action except the first of a scope has a runAfter (no unreachable branch)', missingRun.length === 0, missingRun.join(', '));
  // no cycles: each runAfter target comes earlier in its scope
  const cyc = list.filter((x) => Object.keys(x.action.runAfter || {}).some((t) => Object.keys(x.siblings).indexOf(t) >= Object.keys(x.siblings).indexOf(x.name)));
  ok('no runAfter cycle (targets come earlier in the scope)', cyc.length === 0, cyc.map((x) => x.name).join(', '));

  // references
  const byName = Object.fromEntries(list.map((x) => [x.name, x]));
  const refErrors = []; const variableUse = []; const exprErrors = [];
  for (const x of list) {
    const parts = [];
    strings({ i: x.action.inputs, e: x.action.expression, f: x.action.foreach }).forEach((s) => expressionsOf(s).forEach((e) => parts.push(e)));
    for (const e of parts) {
      if (e === '\u0000UNCLOSED' || !balanced(e)) { exprErrors.push(`${x.name}: ${e.slice(0, 60)}`); continue; }
      for (const m of e.matchAll(/\b(outputs|body|actions)\('([^']+)'\)/g)) {
        const t = byName[m[2]];
        if (!t) { refErrors.push(`${x.name} -> ${m[2]} (missing)`); continue; }
        const earlier = t.index < x.index; const visible = t.scope.length <= x.scope.length && t.scope.every((s, i) => x.scope[i] === s);
        if (!earlier || !visible) refErrors.push(`${x.name} -> ${m[2]} (not an earlier action of the same or an enclosing scope)`);
      }
      for (const m of e.matchAll(/\bitems\('([^']+)'\)/g)) {
        const t = byName[m[1]];
        if (!t || t.action.type !== 'Foreach' || !x.scope.includes(m[1])) refErrors.push(`${x.name} -> items('${m[1]}') (not an enclosing Foreach)`);
      }
      for (const m of e.matchAll(/\bvariables\('([^']+)'\)/g)) variableUse.push({ at: x.name, index: x.index, name: m[1] });
    }
  }
  ok('every outputs()/body()/items() reference points to an earlier action of the same or an enclosing scope, or to the enclosing loop', refErrors.length === 0, refErrors.join('; '));
  ok('every expression has balanced parentheses, quotes and braces', exprErrors.length === 0, exprErrors.join('; '));
  // variables (Learn, "Create variables": a variable is initialized only at the workflow top level, never in a scope, condition or loop)
  const inits = list.filter((x) => x.action.type === 'InitializeVariable');
  const declared = new Map(); for (const x of inits) for (const v of x.action.inputs.variables) declared.set(v.name, x.index);
  ok('Initialize variable appears only at the top level of the flow (not in a loop, condition, switch or scope)', inits.every((x) => x.scope.length === 0), inits.filter((x) => x.scope.length).map((x) => x.name).join(', '));
  ok('the variables endKind and endMessage exist (strings, empty at the start)', ['endKind', 'endMessage'].every((n) => inits.some((x) => x.action.inputs.variables.some((v) => v.name === n && v.type === 'string' && v.value === ''))));
  const setNames = list.filter((x) => x.action.type === 'SetVariable').map((x) => ({ at: x.name, index: x.index, name: x.action.inputs.name }));
  const undefinedUse = [...variableUse, ...setNames].filter((u) => !declared.has(u.name) || declared.get(u.name) > u.index);
  ok('every variable that is read or set was initialized earlier at the top level', undefinedUse.length === 0, undefinedUse.map((u) => `${u.at}:${u.name}`).join(', '));
  const loopNode = list.find((x) => x.name === LOOP);
  ok('Set variable inside a loop only in a sequential loop (concurrency 1)', setNames.every((u) => !list.find((x) => x.name === u.at).scope.includes(LOOP)) || loopNode?.action.runtimeConfiguration?.concurrency?.repetitions === 1);
  // Terminate: not under Foreach or Until at any depth (Learn: Logic Apps workflow actions, "Terminate action")
  const termUnderLoop = list.filter((x) => x.action.type === 'Terminate' && x.scope.some((n) => ['Foreach', 'Until'].includes(byName[n]?.action.type)));
  ok('no Terminate action is nested under a Foreach or Until at any depth', termUnderLoop.length === 0, termUnderLoop.map((x) => x.name).join(', '));
  // the end of the run: one Switch on endKind right after the loop (outside it), with the three end kinds and a default that carries on
  const sw = list.find((x) => x.action.type === 'Switch');
  const afterLoop = !!sw && sw.scope.length === 0 && Object.keys(sw.action.runAfter || {}).join() === LOOP;
  ok('a Switch on endKind runs right after the loop and outside it', afterLoop && sw.action.expression === "@variables('endKind')");
  const cs = sw ? sw.action.cases : {};
  const term = (c) => Object.values(cs[c]?.actions || {}).find((a) => a.type === 'Terminate')?.inputs;
  ok('Switch cases: Cancelled ends Cancelled, Rejected ends Succeeded, Failed ends Failed with the message of endMessage',
    cs.Case_Cancelled?.case === 'Cancelled' && term('Case_Cancelled')?.runStatus === 'Cancelled'
    && cs.Case_Rejected?.case === 'Rejected' && term('Case_Rejected')?.runStatus === 'Succeeded'
    && cs.Case_Failed?.case === 'Failed' && term('Case_Failed')?.runStatus === 'Failed' && term('Case_Failed')?.runError?.message === "@variables('endMessage')");
  const dflt = Object.keys(sw?.action.default?.actions || {});
  ok('the default of the Switch carries on: last checkpoint, then the contract is set In Force', dflt.join() === 'Get_contract_before_final,Check_contract_before_final,Set_contract_In_Force');
  // every group of the loop is gated on endKind being empty, so nothing runs in or after an iteration that ended the run
  const loopChildren = Object.entries(loopNode?.action.actions || {});
  ok('every direct child of the loop is a gate on endKind being empty', loopChildren.length > 0 && loopChildren.every(([, a]) => a.type === 'If' && JSON.stringify(a.expression) === JSON.stringify({ equals: ["@variables('endKind')", ''] })), `${loopChildren.length} groups`);
  const endSetters = list.filter((x) => x.action.type === 'SetVariable' && x.action.inputs.name === 'endKind');
  ok('endKind is set only inside the loop (the problem cases) and only to Cancelled, Rejected or Failed', endSetters.length > 0 && endSetters.every((x) => x.scope.includes(LOOP) && ['Cancelled', 'Rejected', 'Failed'].includes(x.action.inputs.value)), `${endSetters.length} setters`);

  // connections
  const conn = new Set([...JSON.stringify(def).matchAll(/"connectionName":"([^"]+)"/g)].map((m) => m[1]));
  const refNames = new Set(Object.keys(refs));
  ok('every connectionName used by an action or the trigger exists in connectionReferences', [...conn].every((c) => refNames.has(c)), [...conn].join(', '));
  ok('every connection reference has an api name and a connectionReferenceLogicalName', Object.values(refs).every((r) => r.api?.name && r.connection?.connectionReferenceLogicalName));
  ok('operation ids are the expected ones', list.concat([{ action: Object.values(def.triggers)[0] }]).every((x) => !x.action.inputs?.host || ['ListRecords', 'GetItem', 'UpdateOnlyRecord', 'StartAndWaitForAnApproval', 'CreateAnApproval', 'SubscribeWebhookTrigger'].includes(x.action.inputs.host.operationId)));

  // structure
  const depth = Math.max(...list.map((x) => x.scope.length)) + 1;
  ok('nesting depth is at most 8 (Power Automate limit)', depth <= 8, `depth ${depth}`);
  ok('fewer than 500 actions', list.length < 500, `${list.length} actions`);
  const loop = byName[LOOP];
  ok('the loop is sequential (concurrency 1)', loop?.action.runtimeConfiguration?.concurrency?.repetitions === 1);
  ok('the loop iterates the output of the steps query', loop?.action.foreach === `@outputs('${STEPS}')?['body/value']`);
  const failed = list.filter((x) => x.action.type === 'Terminate' && x.action.inputs.runStatus === 'Failed');
  ok('every Terminate with status Failed has a runError (code and message)', failed.length > 0 && failed.every((x) => x.action.inputs.runError?.code && x.action.inputs.runError?.message), `${failed.length} Failed terminations`);
  const cancelled = list.filter((x) => x.action.type === 'Terminate' && x.action.inputs.runStatus === 'Cancelled');
  ok('two Terminate Cancelled (the Switch case and the last checkpoint), both outside the loop', cancelled.length === 2 && cancelled.every((x) => !x.scope.includes(LOOP)), `${cancelled.length}`);
  ok('the list query is ordered by step order ascending', byName[STEPS].action.inputs.parameters.$orderby === 'mwf_steporder asc');
  ok('every update of a step names the step row (recordId) and the step table', list.filter((x) => x.action.inputs?.parameters?.entityName === 'mwf_approvalsteps' && x.action.inputs.host.operationId === 'UpdateOnlyRecord')
    .every((x) => /mwf_approvalstepid/.test(x.action.inputs.parameters.recordId)));
  // reassignment (owner decision 2026-10-22): no approval action may let the approver pass the request on
  const approvalActions = list.filter((x) => x.action.inputs?.host?.apiId?.endsWith('shared_approvals'));
  const reassign = approvalActions.flatMap((x) => Object.entries(x.action.inputs.parameters).filter(([k]) => /enableReassignment$/.test(k)).map(([, v]) => v));
  ok('reassignment is disabled (false) in every approval action, both Approve and Inform', approvalActions.length === 2 && reassign.length === 2 && reassign.every((v) => v === false), `${approvalActions.length} approval actions, values ${JSON.stringify(reassign)}`);
  // text hygiene
  const text = JSON.stringify(cd);
  ok('no email address, no id (GUID), no token in the definition', !/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text.replace(/@\{|@outputs|@triggerOutputs|@first|@length|@json|@utcNow|@coalesce/g, '')) && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text) && !/eyJ[A-Za-z0-9_-]{10,}/.test(text));
  ok('the placeholder <ORG_HOST> is the only host in the definition', !/dynamics\.com/.test(text) && text.includes('<ORG_HOST>'));
  ok('the approver placeholder of v1 is not used', !text.includes('<APPROVER_TEST_ACCOUNT>'));
  // trigger equals v1
  const t = Object.values(def.triggers)[0];
  if (v1Trigger) ok('the trigger parameters equal the trigger of v1 (message, table, scope, filtering column, filter expression)', JSON.stringify(t.inputs.parameters) === JSON.stringify(v1Trigger.inputs.parameters) && JSON.stringify(t.inputs.host) === JSON.stringify(v1Trigger.inputs.host));
  else ok('v1 trigger comparison', false, 'v1 source file not found in src/Workflows');
  return { results, list, depth };
}
function v1TriggerFromSrc() {
  try {
    const dir = join(HERE, '..', 'src', 'Workflows');
    const f = readdirSync(dir).find((x) => /ContractApprovalv1.*\.json$/.test(x) && !x.endsWith('.data.xml'));
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    return Object.values(d.properties.definition.triggers)[0];
  } catch { return null; }
}

// ------------------------------------------------------------------------------------------------ modes
function printResults(results) {
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\nSUMMARY: ${results.length - bad} passed, ${bad} failed.`);
  return bad;
}
function printTable(list) {
  console.log('action'.padEnd(46) + 'type'.padEnd(26) + 'operation'.padEnd(26) + 'parent');
  for (const x of list) console.log(`${'  '.repeat(x.scope.length)}${x.name}`.padEnd(46) + String(x.action.type).padEnd(26) + String(x.action.inputs?.host?.operationId || x.action.inputs?.runStatus || '').padEnd(26) + (x.scope[x.scope.length - 1] || '(top)'));
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;   // false when the unit test imports this file
if (isMain) {
if (!['build', 'check', 'create', 'verify', 'cleanup'].includes(MODE)) { console.error('Missing or invalid --mode=build|check|create|verify|cleanup. Nothing was run.'); process.exit(2); }

if (MODE === 'build' || MODE === 'check') {
  const cd = buildClientdata();
  const { results, list, depth } = checkClientdata(cd, { v1Trigger: v1TriggerFromSrc() });
  if (MODE === 'build') {
    printTable(list); console.log(`\n${list.length} actions, depth ${depth}`);
    const out = argOf('out');
    if (out) { writeFileSync(out, JSON.stringify(cd, null, 2), 'utf8'); console.log(`clientdata written to the given path (still with the placeholder <ORG_HOST>)`); }
    process.exit(0);
  }
  process.exit(printResults(results) ? 1 : 0);
}

// ---- online modes
const { parseArgs, openSession, noGuid, Stop } = await import('./lib/dv-session.mjs');
const { requireStableConnection } = await import('./lib/counter-snapshot.mjs');
const { env: ENV, auth: AUTH, has } = parseArgs();
if ((MODE === 'create' || MODE === 'cleanup') && !has('--confirm-mutates-environment')) {
  console.error(`WARNING: --mode=create creates ONE cloud flow row (OFF) named "${FLOW_NAME}" in the environment and the solution ${SOLUTION}. It never turns a flow on or off and never changes v1. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
  process.exit(2);
}
let bad = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  [${d}]` : ''}`); if (!ok) bad++; };

(async () => {
  try {
    const S = await openSession({ env: ENV, auth: AUTH });
    const { must, call } = S;
    await requireStableConnection(call);
    const q = encodeURIComponent;
    const rowOf = async (name) => (await must('GET', `workflows?$select=name,statecode,statuscode,category,modifiedon,clientdata&$filter=${q(`name eq '${name}' and category eq 5`)}`)).j.value;
    const v1a = await rowOf(V1_NAME);
    if (v1a.length !== 1) throw new Stop(`v1: expected 1 flow row, found ${v1a.length}`);

    if (MODE === 'verify') {
      const v2 = await rowOf(FLOW_NAME);
      check('v1 is OFF (statecode 0)', v1a[0].statecode === 0, `statecode ${v1a[0].statecode}, modifiedon ${v1a[0].modifiedon}`);
      check('v2 exists once and is OFF (statecode 0)', v2.length === 1 && v2[0].statecode === 0, `${v2.length} row(s)`);
      if (v2.length === 1) {
        const host = new URL(ENV).host;
        const sol = (await must('GET', `solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid`)).j.value;
        const sc = (await must('GET', `solutioncomponents?$filter=_solutionid_value eq ${sol[0].solutionid} and objectid eq ${v2[0].workflowid}&$select=componenttype`)).j.value;
        check('v2 is a component of the solution', sc.length >= 1, `${sc.length} row(s)`);
        const raw = v2[0].clientdata || '';
        console.log(`INFO  clientdata size: ${Buffer.byteLength(raw, 'utf8')} bytes (the definition as sent: ${Buffer.byteLength(JSON.stringify(buildClientdata()), 'utf8')} bytes before the host was filled in)`);
        const back = JSON.parse(raw);
        const c = checkClientdata(JSON.parse(JSON.stringify(back).split(host).join('<ORG_HOST>')), { v1Trigger: v1TriggerFromSrc() });
        const badC = c.results.filter((r) => !r.pass);
        check(`structure as stored: ${c.results.length} checks`, badC.length === 0, badC.map((r) => r.name).join('; ').slice(0, 300));
        check('stored action names equal the built ones', JSON.stringify(walk(back.properties.definition.actions).map((x) => x.name)) === JSON.stringify(walk(buildClientdata().properties.definition.actions).map((x) => x.name)), `${walk(back.properties.definition.actions).length} actions`);
        check('the record link of the stored definition no longer has the placeholder', !raw.includes('<ORG_HOST>'));
      }
      process.exit(bad ? 1 : 0);
    }

    if (MODE === 'cleanup') {
      const v2 = await rowOf(FLOW_NAME);
      if (v2.length === 0) { console.log('No row named v2. Nothing to delete.'); process.exit(0); }
      if (v2.length > 1) throw new Stop(`${v2.length} rows named v2: refusing to delete more than one. Nothing was deleted.`);
      if (v2[0].statecode !== 0) throw new Stop('v2 is not OFF. It is not deleted by this script.');
      const d = await call('DELETE', `workflows(${v2[0].workflowid})`);
      check('v2 row deleted', d.ok, `HTTP ${d.status}`);
      check('no row named v2 remains', (await rowOf(FLOW_NAME)).length === 0);
      const v1c = await rowOf(V1_NAME);
      check('v1 is untouched (same modifiedon, OFF)', v1c.length === 1 && v1c[0].modifiedon === v1a[0].modifiedon && v1c[0].statecode === 0);
      process.exit(bad ? 1 : 0);
    }

    // create
    if ((await rowOf(FLOW_NAME)).length) throw new Stop(`"${FLOW_NAME}" already exists. Nothing was created (this script never modifies an existing flow).`);
    const v1cd = JSON.parse(v1a[0].clientdata);
    const refs = v1cd.properties.connectionReferences;
    check('v1 has the two connection references the definition uses', ['shared_commondataserviceforapps', 'shared_approvals'].every((k) => refs[k]?.connection?.connectionReferenceLogicalName), Object.keys(refs).join(','));
    if (bad) throw new Stop('The connection references of v1 are not as expected. Nothing was created.');
    const cd = buildClientdata(refs);
    const chk = checkClientdata(cd, { v1Trigger: v1TriggerFromSrc() });
    if (chk.results.some((r) => !r.pass)) throw new Stop('The structural check failed. Nothing was created. Run --mode=check.');
    const host = new URL(ENV).host;
    const payload = JSON.stringify(cd).split('<ORG_HOST>').join(host);
    const sol = (await must('GET', `solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid,ismanaged`)).j.value;
    if (sol.length !== 1 || sol[0].ismanaged) throw new Stop(`solution ${SOLUTION}: expected 1 unmanaged solution`);

    let created = null;
    try {
      created = await call('POST', 'workflows', {
        name: FLOW_NAME, category: 5, type: 1, primaryentity: 'none',
        description: 'Approval chain flow driven by mwf_approvalstep (ADR-007). Created OFF by scripts/build-flow-v2.mjs. Turn on only after v1 is OFF.',
        clientdata: payload,
      }, { 'MSCRM.SolutionUniqueName': SOLUTION });
    } catch (e) {
      console.error(`POST outcome UNKNOWN: ${noGuid(e.message).slice(0, 200)}`);
      const after = await rowOf(FLOW_NAME).catch(() => null);
      console.error(after ? `State read after the error: ${after.length} row(s) named "${FLOW_NAME}". Nothing was deleted or retried.` : 'State could not be read after the error either. Check by hand. Nothing was deleted or retried.');
      process.exit(5);
    }
    if (!created.ok) throw new Stop(`POST workflows failed HTTP ${created.status}\n${noGuid(created.j?.error?.message || created.text).slice(0, 700)}\nNothing else was done.`);
    check('POST accepted (one row)', true, `HTTP ${created.status}`);

    // read back
    const v2 = await rowOf(FLOW_NAME);
    check('v2 exists once', v2.length === 1, `${v2.length}`);
    const row = v2[0];
    check('category is 5 (modern flow) and the flow is OFF (statecode 0, Draft)', row.category === 5 && row.statecode === 0, `category ${row.category}, statecode ${row.statecode}, statuscode ${row.statuscode}`);
    const sc = (await must('GET', `solutioncomponents?$filter=_solutionid_value eq ${sol[0].solutionid} and objectid eq ${row.workflowid}&$select=componenttype`)).j.value;
    check('v2 is a component of the solution', sc.length >= 1, `${sc.length} row(s)`);
    const back = JSON.parse(row.clientdata);
    const backCheck = checkClientdata(JSON.parse(JSON.stringify(back).split(host).join('<ORG_HOST>')), { v1Trigger: v1TriggerFromSrc() });
    const badBack = backCheck.results.filter((r) => !r.pass);
    check('the structural check passes on the definition as stored by Dataverse', badBack.length === 0, badBack.map((r) => r.name).join('; ').slice(0, 300));
    check('the stored definition has the same action names as the one sent', JSON.stringify(walk(back.properties.definition.actions).map((x) => x.name)) === JSON.stringify(chk.list.map((x) => x.name)));
    const v1b = await rowOf(V1_NAME);
    check('v1 is unchanged and still OFF (same modifiedon, statecode 0)', v1b.length === 1 && v1b[0].modifiedon === v1a[0].modifiedon && v1b[0].statecode === 0, `statecode ${v1b[0]?.statecode}`);
    console.log(`\nSUMMARY: ${bad} failed check(s). The flow was NOT turned on and no run was started.`);
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
}
