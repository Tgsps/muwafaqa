#!/usr/bin/env node
/**
 * Builds, checks and (on purpose) creates the scheduled flow "Muwafaqa - Approval Reminders" (ADR-010, status Proposed; docs/flow-approval-reminders.md).
 * The flow scans the approval steps that are Waiting and sends ONE reminder to the approver and, later, ONE informational escalation notice to the owner
 * of the contract. Same style as scripts/build-flow-v2.mjs: the definition is code in this file, no id, address or host is stored (the record link keeps
 * the placeholder <ORG_HOST>, which `create` replaces with the host of --env in memory only).
 *
 * THE FLOW IS CREATED OFF AND THIS SCRIPT HAS NO CODE PATH THAT TURNS A FLOW ON (or off, or changes the state of any row): the only write is ONE POST of a new
 * workflows row whose body carries no state. It never starts a run and never changes another flow. The owner alone turns flows on and off.
 *
 * Modes:
 *   --mode=build   offline. Prints the action table and the numbers (actions, depth). With --out=<file outside the repository> writes the clientdata JSON.
 *   --mode=check   offline. Structural checks of the generated definition. Exit code 1 on any failure.
 *   --mode=create  needs --variant=test|production. WITHOUT --confirm-mutates-environment (or with --dry-run) it is a DRY RUN: it prints the summary of the
 *                  request (name, state, the connection references it would bind, sizes) and sends nothing; it does not sign in and needs no --env.
 *                  WITH --confirm-mutates-environment and --env it uses the owner's Azure CLI sign-in (--auth=az, the only accepted value), requires 3 consecutive
 *                  successful reads, checks that the solution is unmanaged, that no flow of this name exists, and that the two connection references exist in the
 *                  solution for the right connectors (read only), re-runs the structural check, then POSTs ONE row (never retried; if the network fails it reads
 *                  whether the row exists and prints that) and reads it back: category, OFF, solution membership, structure, and that no other flow changed.
 *   --mode=verify  read only. Needs --env. Re-reads the row: exists once, OFF, in the solution, the stored structure, the stored connection reference names.
 *   (There is no cleanup mode: a half-created row, if one ever appears, is reported and removed by the owner or by a separately approved step.)
 *
 *   --variant=test|production|both   for build and check, default both. test: recurrence every 1 minute, timers 3 and 6 minutes, subject prefix "[Muwafaqa test] ".
 *                                    production: recurrence every 15 minutes (a PLACEHOLDER, not decided), timers 2880 and 5760 minutes (48 h and 96 h,
 *                                    placeholders). Nothing else differs; a unit test enforces it. For create exactly one variant must be named.
 *   --outlook-ref=<logical name>     the logical name of the Office 365 Outlook connection reference. Default: mwf_sharedoffice365_reminders (created by the owner in the
 *                                    solution on 2026-10-26). Never a GUID.
 *   --dataverse-ref=<logical name>   the Dataverse connection reference. Default: the one v2 uses (new_sharedcommondataserviceforapps_43184).
 *
 * What lives where (the reason for the manual cases R1 to R6 of docs/flow-approval-reminders.md): the decision logic of the pure function
 * `pickCandidates` (scripts/lib/reminder-candidates.mjs) is unit tested, but THIS FLOW re-implements it in Power Automate expressions, which no unit test runs:
 *   - the server-side OData filter of the steps and its time cut, the derived waiting time, the elapsed minutes (ticks arithmetic), the reminder-or-escalate decision,
 *   - the re-read before the claim, the claim writes, the counter of the cap, the order in which contracts are visited (modifiedon ascending, an approximation of "oldest waiting first").
 * The structural check covers the STRUCTURE of those expressions only (names, order, references, the constants), not their result.
 *
 * Usage:
 *   node scripts/build-flow-reminders.mjs --mode=check
 *   node scripts/build-flow-reminders.mjs --mode=create --variant=test                       (dry run, offline)
 *   node scripts/build-flow-reminders.mjs --mode=create --variant=test --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { walk, balanced, expressionsOf } from './build-flow-v2.mjs';
import { TEST_TIMERS, PRODUCTION_TIMERS, MAX_NOTICES_PER_RUN, DECISION, ACTION_TYPE, STATUS_PENDING_APPROVAL, validateTimers } from './lib/reminder-candidates.mjs';

export const FLOW_NAME = 'Muwafaqa - Approval Reminders';
export const DEFAULT_OUTLOOK_REF = 'mwf_sharedoffice365_reminders';   // created by the owner in the solution Muwafaqa on 2026-10-26 (connector Office 365 Outlook)
export const DEFAULT_DATAVERSE_REF = 'new_sharedcommondataserviceforapps_43184';
/** How the designer writes the parameters of "Send an email (V2)". Learn lists flat keys (To, Subject, Body); designer exports usually use emailMessage/<Key>. NOT VERIFIED: look at the created flow in the designer. */
export const EMAIL_KEY_STYLE = 'nested';
const emailKey = (k) => (EMAIL_KEY_STYLE === 'nested' ? `emailMessage/${k}` : k);

/** The two variants. They differ ONLY in the two timers, the recurrence interval and the subject prefix. */
export const VARIANTS = Object.freeze({
  test: Object.freeze({ name: 'test', timers: TEST_TIMERS, intervalMinutes: 1, subjectPrefix: '[Muwafaqa test] ' }),
  production: Object.freeze({ name: 'production', timers: PRODUCTION_TIMERS, intervalMinutes: 15, subjectPrefix: '' }),
});

const LOOP_C = 'Apply_to_each_contract';
const LOOP_S = 'Apply_to_each_due_step';
const CON = `items('${LOOP_C}')`;
const STEP = `items('${LOOP_S}')`;
const NOW = "variables('runStartedAt')";
const SINCE = "variables('sinceUtc')";
const TICKS_PER_MINUTE = 600000000;
const ELAPSED = `div(sub(ticks(${NOW}), ticks(${SINCE})), ${TICKS_PER_MINUTE})`;
const ROLE_JSON = '{"867640000":"Department Head","867640001":"Finance Manager","867640002":"General Manager","867640003":"Regional Office","867640004":"Owner"}';
const ROLE_EXPR = `json('${ROLE_JSON}')?[string(${STEP}?['mwf_approverrole'])]`;
const LINK = `https://<ORG_HOST>/main.aspx?etn=mwf_contract&pagetype=entityrecord&id=@{${CON}?['mwf_contractid']}`;

const CDS = (operationId) => ({ apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps', operationId, connectionName: 'shared_commondataserviceforapps' });
const OUT = (operationId) => ({ apiId: '/providers/Microsoft.PowerApps/apis/shared_office365', operationId, connectionName: 'shared_office365' });
const cds = (operationId, parameters) => ({ type: 'OpenApiConnection', inputs: { parameters, host: CDS(operationId) } });
const setVar = (name, value) => ({ type: 'SetVariable', inputs: { name, value } });
const initVar = (name, type, value) => ({ type: 'InitializeVariable', inputs: { variables: [{ name, type, value }] } });
const ifThen = (expression, actions, elseActions = {}) => ({ type: 'If', expression, actions, else: { actions: elseActions } });
const eq = (a, b) => ({ equals: [a, b] });
const v = (n) => `@variables('${n}')`;
/** Gives every action of the ordered list a runAfter on the previous one (Succeeded). */
function chain(list) {
  const out = {}; let prev = null;
  for (const [name, action] of list) { out[name] = { ...action, runAfter: prev ? { [prev]: ['Succeeded'] } : {} }; prev = name; }
  return out;
}
const updateStep = (extra) => cds('UpdateOnlyRecord', { entityName: 'mwf_approvalsteps', recordId: `@${STEP}?['mwf_approvalstepid']`, ...extra });
const cut = (minutes) => `@{formatDateTime(addMinutes(${NOW}, -${minutes}), 'yyyy-MM-ddTHH:mm:ssZ')}`;

function mail(prefix, subject, bodyHtml) {
  return {
    type: 'OpenApiConnection',
    inputs: { parameters: { [emailKey('To')]: v('recipientEmail'), [emailKey('Subject')]: `${prefix}${subject}`, [emailKey('Body')]: bodyHtml }, host: OUT('SendEmailV2') },
  };
}

export function buildDefinition(variant = VARIANTS.test) {
  const { timers: T, intervalMinutes, subjectPrefix } = variant;
  validateTimers(T);
  const R = T.remindAfterMinutes; const E = T.escalateAfterMinutes;
  const where = `step @{${STEP}?['mwf_steporder']} (@{${ROLE_EXPR}}) of contract @{${CON}?['mwf_name']} (number @{${CON}?['mwf_contractnumber']})`;
  const waited = `@{${ELAPSED}} minutes`;

  // 1. the waiting time of the step, DERIVED (ADR-010). Anything unclear leaves sinceUtc empty, and an empty sinceUtc ends the story for this step: nothing is sent.
  const sinceGroup = ifThen(eq(v('proceed'), 'yes'), {
    Branch_waiting_since: ifThen(eq(`@${STEP}?['mwf_steporder']`, 1),
      { Set_sinceUtc_from_createdon: setVar('sinceUtc', `@{${STEP}?['createdon']}`) },
      chain([
        ['Get_previous_step', cds('ListRecords', {
          entityName: 'mwf_approvalsteps', $select: 'mwf_decision,mwf_decidedon',
          $filter: `_mwf_contract_value eq @{${CON}?['mwf_contractid']} and mwf_approvalround eq @{${CON}?['mwf_approvalround']} and mwf_steporder eq @{sub(${STEP}?['mwf_steporder'], 1)}`,
          $top: 1,
        })],
        ['Check_previous_step_exists', ifThen({ greater: ["@length(outputs('Get_previous_step')?['body/value'])", 0] }, {
          Check_previous_step_decided: ifThen({
            and: [
              { or: [eq("@first(outputs('Get_previous_step')?['body/value'])?['mwf_decision']", DECISION.Approved), eq("@first(outputs('Get_previous_step')?['body/value'])?['mwf_decision']", DECISION.Informed)] },
              { not: { equals: ["@empty(first(outputs('Get_previous_step')?['body/value'])?['mwf_decidedon'])", true] } },
            ],
          }, { Set_sinceUtc_from_previous: setVar('sinceUtc', "@{first(outputs('Get_previous_step')?['body/value'])?['mwf_decidedon']}") }),
        })],
      ])),
  });

  // 2. reminder, escalation or nothing (the same rule as pickCandidates)
  const decideGroup = ifThen({ and: [eq(v('proceed'), 'yes'), { not: eq(v('sinceUtc'), '') }] }, {
    Set_action: setVar('action',
      `@{if(and(empty(${STEP}?['mwf_remindedon']), greaterOrEquals(${ELAPSED}, ${R})), 'remind', if(and(not(empty(${STEP}?['mwf_remindedon'])), empty(${STEP}?['mwf_escalatedon']), greaterOrEquals(${ELAPSED}, ${E})), 'escalate', ''))}`),
  });

  // 3. the recipient is resolved BEFORE the claim: a notice with no address is skipped, not claimed (nothing is lost)
  const recipientGroup = ifThen({ not: eq(v('action'), '') }, {
    Branch_recipient: ifThen(eq(v('action'), 'remind'),
      chain([
        ['Get_assignment_of_role', cds('ListRecords', { entityName: 'mwf_approverassignments', $select: 'mwf_approverassignmentid,_mwf_user_value', $filter: `mwf_approverrole eq @{${STEP}?['mwf_approverrole']} and statecode eq 0`, $top: 1 })],
        ['Check_assignment_exists', ifThen({ greater: ["@length(outputs('Get_assignment_of_role')?['body/value'])", 0] }, chain([
          ['Get_approver_user_list', cds('ListRecords', { entityName: 'systemusers', $select: 'internalemailaddress', $filter: "systemuserid eq @{first(outputs('Get_assignment_of_role')?['body/value'])?['_mwf_user_value']}", $top: 1 })],
          ['Set_recipient_approver', setVar('recipientEmail', "@{coalesce(first(outputs('Get_approver_user_list')?['body/value'])?['internalemailaddress'], '')}")],
        ]))],
      ]),
      chain([
        ['Get_owner_user_list', cds('ListRecords', { entityName: 'systemusers', $select: 'internalemailaddress', $filter: `systemuserid eq @{${CON}?['_ownerid_value']}`, $top: 1 })],
        ['Check_owner_found', ifThen({ greater: ["@length(outputs('Get_owner_user_list')?['body/value'])", 0] }, {
          Set_recipient_owner: setVar('recipientEmail', "@{coalesce(first(outputs('Get_owner_user_list')?['body/value'])?['internalemailaddress'], '')}"),
        })],
      ])),
  });

  // 4. re-read, CLAIM (write the column), count, THEN send. A claim is never undone: if the send fails the notice is lost, never repeated (ADR-010).
  const stillDue = {
    and: [
      eq("@outputs('Get_step_before_claim')?['body/mwf_decision']", DECISION.Waiting),
      {
        or: [
          { and: [eq(v('action'), 'remind'), eq("@empty(outputs('Get_step_before_claim')?['body/mwf_remindedon'])", true)] },
          { and: [eq(v('action'), 'escalate'), eq("@empty(outputs('Get_step_before_claim')?['body/mwf_remindedon'])", false), eq("@empty(outputs('Get_step_before_claim')?['body/mwf_escalatedon'])", true)] },
        ],
      },
    ],
  };
  const reminderBody = [
    `<p>This is a reminder from the Muwafaqa approval system (sample text).</p>`,
    `<p>The approval of ${where} has been waiting for your answer for ${waited}.</p>`,
    `<p>Please answer the approval request that was sent to you earlier. This message does not need an answer.</p>`,
    `<p><a href="${LINK}">Open the contract</a></p>`,
  ].join('');
  const escalationBody = [
    `<p>This is an informational notice from the Muwafaqa approval system (sample text).</p>`,
    `<p>The approval of ${where} is still waiting for the approver after ${waited}. A reminder was sent earlier.</p>`,
    `<p>Nothing was changed: this notice does not approve, reject, skip or reassign anything. The step stays with its approver.</p>`,
    `<p><a href="${LINK}">Open the contract</a></p>`,
  ].join('');
  const sendGroup = ifThen({ and: [{ not: eq(v('action'), '') }, { not: eq(v('recipientEmail'), '') }] }, chain([
    ['Get_step_before_claim', cds('GetItem', { entityName: 'mwf_approvalsteps', recordId: `@${STEP}?['mwf_approvalstepid']`, $select: 'mwf_decision,mwf_remindedon,mwf_escalatedon' })],
    ['Check_step_still_due', ifThen(stillDue, chain([
      ['Branch_claim', ifThen(eq(v('action'), 'remind'),
        { Claim_reminder: updateStep({ 'item/mwf_remindedon': '@utcNow()' }) },
        { Claim_escalation: updateStep({ 'item/mwf_escalatedon': '@utcNow()' }) })],
      ['Increment_noticesSent', { type: 'IncrementVariable', inputs: { name: 'noticesSent', value: 1 } }],
      ['Branch_send', ifThen(eq(v('action'), 'remind'),
        { Send_reminder_email: mail(subjectPrefix, `Reminder: approval waiting for contract @{${CON}?['mwf_name']}`, reminderBody) },
        { Send_escalation_email: mail(subjectPrefix, `Escalation notice: approval still waiting for contract @{${CON}?['mwf_name']}`, escalationBody) })],
    ]))],
  ]));

  const stepLoopActions = chain([
    ['Set_proceed', setVar('proceed', `@{if(less(variables('noticesSent'), ${MAX_NOTICES_PER_RUN}), 'yes', '')}`)],   // the hard cap of one run (owner decision 2026-10-26)
    ['Reset_sinceUtc', setVar('sinceUtc', '')],
    ['Reset_action', setVar('action', '')],
    ['Reset_recipientEmail', setVar('recipientEmail', '')],
    ['Gate_waiting_since', sinceGroup],
    ['Gate_decide', decideGroup],
    ['Gate_recipient', recipientGroup],
    ['Gate_claim_and_send', sendGroup],
  ]);

  const contractLoopActions = chain([
    ['Get_due_steps', cds('ListRecords', {
      entityName: 'mwf_approvalsteps',
      $select: 'mwf_approvalstepid,mwf_steporder,mwf_approverrole,createdon,mwf_remindedon,mwf_escalatedon',
      // server side: this contract and its CURRENT round (an old round is never reached), a Waiting Approve step, a notice still to send, and the time cut. The cut is a NECESSARY
      // condition only (waiting since >= createdon of the step row), so no due step is lost; the exact test is client side (Set_action).
      $filter: `_mwf_contract_value eq @{${CON}?['mwf_contractid']} and mwf_approvalround eq @{${CON}?['mwf_approvalround']} and mwf_decision eq ${DECISION.Waiting} and mwf_actiontype eq ${ACTION_TYPE.Approve} and ((mwf_remindedon eq null and createdon lt ${cut(R)}) or (mwf_remindedon ne null and mwf_escalatedon eq null and createdon lt ${cut(E)}))`,
      $orderby: 'mwf_steporder asc',
      $top: 5,
    })],
    [LOOP_S, { type: 'Foreach', foreach: "@outputs('Get_due_steps')?['body/value']", actions: stepLoopActions, runtimeConfiguration: { concurrency: { repetitions: 1 } } }],
  ]);

  const actions = chain([
    ['Init_runStartedAt', initVar('runStartedAt', 'string', '@{utcNow()}')],
    ['Init_noticesSent', initVar('noticesSent', 'integer', 0)],
    ['Init_proceed', initVar('proceed', 'string', '')],
    ['Init_sinceUtc', initVar('sinceUtc', 'string', '')],
    ['Init_action', initVar('action', 'string', '')],
    ['Init_recipientEmail', initVar('recipientEmail', 'string', '')],
    ['Get_pending_contracts', cds('ListRecords', {
      entityName: 'mwf_contracts',
      $select: 'mwf_contractid,mwf_name,mwf_contractnumber,mwf_approvalround,_ownerid_value',
      $filter: `statuscode eq ${STATUS_PENDING_APPROVAL}`,
      $orderby: 'modifiedon asc',
      $top: 50,
    })],
    [LOOP_C, { type: 'Foreach', foreach: "@outputs('Get_pending_contracts')?['body/value']", actions: contractLoopActions, runtimeConfiguration: { concurrency: { repetitions: 1 } } }],
  ]);
  return {
    $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
    contentVersion: '1.0.0.0',
    parameters: { $authentication: { defaultValue: {}, type: 'SecureObject' }, $connections: { defaultValue: {}, type: 'Object' } },
    triggers: { Recurrence: { type: 'Recurrence', recurrence: { frequency: 'Minute', interval: intervalMinutes } } },
    actions,
  };
}

export function buildClientdata(variant = VARIANTS.test, { outlookRef = DEFAULT_OUTLOOK_REF, dataverseRef = DEFAULT_DATAVERSE_REF } = {}) {
  assertLogicalName(outlookRef); assertLogicalName(dataverseRef);
  return {
    properties: {
      connectionReferences: {
        shared_commondataserviceforapps: { api: { name: 'shared_commondataserviceforapps' }, connection: { connectionReferenceLogicalName: dataverseRef }, runtimeSource: 'embedded' },
        shared_office365: { api: { name: 'shared_office365' }, connection: { connectionReferenceLogicalName: outlookRef }, runtimeSource: 'embedded' },
      },
      definition: buildDefinition(variant),
    },
    schemaVersion: '1.0.0.0',
  };
}

/** A logical name: lower case letters, digits and underscore, starting with a letter. Never a GUID. */
export function assertLogicalName(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{2,}$/.test(name) || /^[0-9a-f]{8}_?[0-9a-f]{4}/.test(name)) throw new Error(`"${name}" is not a valid connection reference logical name (lower case letters, digits and underscore; never a GUID)`);
  return name;
}

export function statsOf(cd) {
  const list = walk(cd.properties.definition.actions);
  return { actions: list.length, depth: Math.max(...list.map((x) => x.scope.length)) + 1 };
}

// ------------------------------------------------------------------------------------------------ checks
const WRITE_KEYS = ['entityName', 'recordId', 'item/mwf_remindedon', 'item/mwf_escalatedon'];
const OPERATIONS = ['ListRecords', 'GetItem', 'UpdateOnlyRecord', 'SendEmailV2'];
const READ_TABLES = ['mwf_contracts', 'mwf_approvalsteps', 'mwf_approverassignments', 'systemusers'];

export function checkClientdata(cd, variant = VARIANTS.test, { outlookRef = DEFAULT_OUTLOOK_REF, dataverseRef = DEFAULT_DATAVERSE_REF } = {}) {
  const results = [];
  const ok = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });
  const def = cd.properties.definition; const refs = cd.properties.connectionReferences;
  const list = walk(def.actions);
  const byName = Object.fromEntries(list.map((x) => [x.name, x]));
  const idx = (n) => byName[n]?.index ?? -1;
  const trig = Object.entries(def.triggers);
  const all = [...list.map((x) => x.name), ...trig.map(([n]) => n)];
  const R = variant.timers.remindAfterMinutes; const E = variant.timers.escalateAfterMinutes;
  const text = JSON.stringify(cd);

  ok('action names are unique across the whole flow (including the trigger)', new Set(all).size === all.length, `${all.length} names`);
  ok('action names use letters, digits and underscore only, at most 80 characters', all.every((n) => /^[A-Za-z0-9_]{1,80}$/.test(n)));
  ok('no action has the name of an action of flow v2', !list.some((x) => ['Apply_to_each_step', 'Get_steps_of_this_round', 'Request_approval_for_step', 'Mark_step_Waiting'].includes(x.name)));
  ok(`exactly one trigger: a Recurrence of ${variant.intervalMinutes} minute(s) (Learn: the minimum interval is 60 seconds)`,
    trig.length === 1 && trig[0][1].type === 'Recurrence' && trig[0][1].recurrence?.frequency === 'Minute' && trig[0][1].recurrence?.interval === variant.intervalMinutes && variant.intervalMinutes >= 1);

  const badRun = []; const missingRun = [];
  for (const x of list) {
    const ra = x.action.runAfter || {};
    for (const [t, st] of Object.entries(ra)) {
      if (!(t in x.siblings) || t === x.name) badRun.push(`${x.name}->${t}`);
      if (!Array.isArray(st) || !st.length || !st.every((s) => ['Succeeded', 'Failed', 'Skipped', 'TimedOut'].includes(s))) badRun.push(`${x.name} status`);
    }
    if (Object.keys(x.siblings)[0] !== x.name && Object.keys(ra).length === 0) missingRun.push(x.name);
  }
  ok('every runAfter points to a sibling action in the same scope, with valid statuses', badRun.length === 0, badRun.join(', '));
  ok('every action except the first of a scope has a runAfter', missingRun.length === 0, missingRun.join(', '));
  ok('no runAfter cycle (targets come earlier in the scope)', !list.some((x) => Object.keys(x.action.runAfter || {}).some((t) => Object.keys(x.siblings).indexOf(t) >= Object.keys(x.siblings).indexOf(x.name))));

  const strs = (val, out = []) => { if (typeof val === 'string') out.push(val); else if (Array.isArray(val)) val.forEach((y) => strs(y, out)); else if (val && typeof val === 'object') Object.values(val).forEach((y) => strs(y, out)); return out; };
  const refErrors = []; const exprErrors = []; const variableUse = [];
  for (const x of list) {
    const parts = [];
    strs({ i: x.action.inputs, e: x.action.expression, f: x.action.foreach }).forEach((s) => expressionsOf(s).forEach((e) => parts.push(e)));
    for (const e of parts) {
      if (e === '\u0000UNCLOSED' || !balanced(e)) { exprErrors.push(`${x.name}: ${e.slice(0, 60)}`); continue; }
      for (const m of e.matchAll(/\b(outputs|body|actions)\('([^']+)'\)/g)) {
        const t = byName[m[2]];
        if (!t) { refErrors.push(`${x.name} -> ${m[2]} (missing)`); continue; }
        const visible = t.scope.length <= x.scope.length && t.scope.every((s, i) => x.scope[i] === s);
        if (t.index >= x.index || !visible) refErrors.push(`${x.name} -> ${m[2]} (not an earlier action of the same or an enclosing scope)`);
      }
      for (const m of e.matchAll(/\bitems\('([^']+)'\)/g)) {
        const t = byName[m[1]];
        if (!t || t.action.type !== 'Foreach' || !x.scope.includes(m[1])) refErrors.push(`${x.name} -> items('${m[1]}') (not an enclosing Foreach)`);
      }
      for (const m of e.matchAll(/\bvariables\('([^']+)'\)/g)) variableUse.push({ at: x.name, index: x.index, name: m[1] });
    }
  }
  ok('every outputs()/body()/items() reference points to an earlier action of the same or an enclosing scope, or to an enclosing loop', refErrors.length === 0, refErrors.join('; '));
  ok('every expression has balanced parentheses, quotes and braces', exprErrors.length === 0, exprErrors.join('; '));
  // the condition expressions that are written as strings inside objects are covered by strs() through x.action.expression

  const inits = list.filter((x) => x.action.type === 'InitializeVariable');
  const declared = new Map(); for (const x of inits) for (const d of x.action.inputs.variables) declared.set(d.name, { index: x.index, type: d.type });
  ok('Initialize variable appears only at the top level of the flow', inits.every((x) => x.scope.length === 0));
  ok('the variables exist with the expected types (noticesSent integer 0; runStartedAt, proceed, sinceUtc, action, recipientEmail string)',
    declared.get('noticesSent')?.type === 'integer' && inits.find((x) => x.name === 'Init_noticesSent')?.action.inputs.variables[0].value === 0
    && ['runStartedAt', 'proceed', 'sinceUtc', 'action', 'recipientEmail'].every((n) => declared.get(n)?.type === 'string'));
  const setNames = list.filter((x) => ['SetVariable', 'IncrementVariable'].includes(x.action.type)).map((x) => ({ at: x.name, index: x.index, name: x.action.inputs.name }));
  const undefinedUse = [...variableUse, ...setNames].filter((u) => !declared.has(u.name) || declared.get(u.name).index > u.index);
  ok('every variable that is read or set was initialized earlier at the top level', undefinedUse.length === 0, undefinedUse.map((u) => `${u.at}:${u.name}`).join(', '));

  const lc = byName[LOOP_C]; const ls = byName[LOOP_S];
  ok('both loops are sequential (concurrency 1), the step loop is inside the contract loop',
    lc?.action.runtimeConfiguration?.concurrency?.repetitions === 1 && ls?.action.runtimeConfiguration?.concurrency?.repetitions === 1 && ls?.scope.includes(LOOP_C));
  ok('the loops iterate the outputs of the contract query and of the step query respectively',
    lc?.action.foreach === "@outputs('Get_pending_contracts')?['body/value']" && ls?.action.foreach === "@outputs('Get_due_steps')?['body/value']");
  ok('the flow has no Terminate action and no Until (nothing ends or loops forever; a failed action fails the run visibly)', !list.some((x) => ['Terminate', 'Until'].includes(x.action.type)));

  const pc = byName.Get_pending_contracts?.action.inputs.parameters;
  ok('the contract query is server side: Pending Approval only, oldest first, at most 50', pc?.$filter === `statuscode eq ${STATUS_PENDING_APPROVAL}` && pc?.$orderby === 'modifiedon asc' && pc?.$top === 50);
  const sq = byName.Get_due_steps?.action.inputs.parameters;
  const f = sq?.$filter || '';
  const frags = ['_mwf_contract_value eq', 'mwf_approvalround eq', `mwf_decision eq ${DECISION.Waiting}`, `mwf_actiontype eq ${ACTION_TYPE.Approve}`, 'mwf_remindedon eq null', 'mwf_remindedon ne null', 'mwf_escalatedon eq null', 'createdon lt'];
  ok('the step query is server side: this contract and its current round, Waiting, Approve, a notice still to send, and a time cut for each notice', frags.every((x) => f.includes(x)) && (f.match(/createdon lt/g) || []).length === 2, frags.filter((x) => !f.includes(x)).join(', '));
  ok(`the time cuts use this variant's timers (${R} and ${E} minutes) and the decision uses the same numbers`, f.includes(`-${R})`) && f.includes(`-${E})`) && byName.Set_action?.action.inputs.value.includes(`, ${R})`) && byName.Set_action?.action.inputs.value.includes(`, ${E})`));
  const other = variant.name === 'test' ? [2880, 5760] : [3, 6];
  ok('the timers of the other variant do not appear', other.every((n) => !f.includes(`-${n})`) && !byName.Set_action.action.inputs.value.includes(`, ${n})`)));
  ok('the step query is ordered by step order and limited', sq?.$orderby === 'mwf_steporder asc' && sq?.$top === 5);

  ok(`the hard cap of one run is ${MAX_NOTICES_PER_RUN} (owner decision 2026-10-26): the gate variable is set from the counter, first in the step loop`,
    MAX_NOTICES_PER_RUN === 5 && byName.Set_proceed?.action.inputs.value === `@{if(less(variables('noticesSent'), ${MAX_NOTICES_PER_RUN}), 'yes', '')}` && Object.keys(ls?.action.actions || {})[0] === 'Set_proceed');
  const groups = ['Gate_waiting_since', 'Gate_decide', 'Gate_recipient', 'Gate_claim_and_send'];
  ok('every group of the step loop is a gate, and the first two are gated on the cap (proceed)', groups.every((g) => byName[g]?.action.type === 'If') && ['Gate_waiting_since', 'Gate_decide'].every((g) => JSON.stringify(byName[g].action.expression).includes("variables('proceed')")));
  ok('the counter is incremented exactly once, by 1', list.filter((x) => x.action.type === 'IncrementVariable').length === 1 && byName.Increment_noticesSent?.action.inputs.name === 'noticesSent' && byName.Increment_noticesSent?.action.inputs.value === 1);

  const sends = list.filter((x) => x.action.inputs?.host?.operationId === 'SendEmailV2');
  const claims = list.filter((x) => x.action.inputs?.host?.operationId === 'UpdateOnlyRecord');
  ok('claim first: both claims come before the counter, and the counter before both sends, all in the same gate', ['Claim_reminder', 'Claim_escalation'].every((c) => idx(c) > -1 && idx(c) < idx('Increment_noticesSent')) && sends.every((s) => s.index > idx('Increment_noticesSent')) && sends.length === 2);
  ok('the recipient is resolved BEFORE the re-read and the claim (a notice with no address is skipped, not claimed)', ['Set_recipient_approver', 'Set_recipient_owner'].every((n) => idx(n) > -1 && idx(n) < idx('Get_step_before_claim')) && idx('Get_step_before_claim') < idx('Claim_reminder'));
  ok('the step is read again before the claim, and the claim runs only if it is still Waiting and the notice is still unsent', JSON.stringify(byName.Check_step_still_due?.action.expression || '').includes('Get_step_before_claim') && JSON.stringify(byName.Check_step_still_due.action.expression).includes(String(DECISION.Waiting)) && byName.Check_step_still_due.scope.includes('Gate_claim_and_send'));
  ok('claims write only mwf_remindedon (reminder) or mwf_escalatedon (escalation) of ONE step row', claims.length === 2 && claims.every((x) => x.action.inputs.parameters.entityName === 'mwf_approvalsteps' && /mwf_approvalstepid/.test(x.action.inputs.parameters.recordId) && Object.keys(x.action.inputs.parameters).every((k) => WRITE_KEYS.includes(k)))
    && byName.Claim_reminder?.action.inputs.parameters['item/mwf_remindedon'] === '@utcNow()' && byName.Claim_escalation?.action.inputs.parameters['item/mwf_escalatedon'] === '@utcNow()');
  ok('the flow reads only the contract, step, assignment and user tables and writes only the step table', list.every((x) => !x.action.inputs?.parameters?.entityName || (READ_TABLES.includes(x.action.inputs.parameters.entityName) && (x.action.inputs.host.operationId !== 'UpdateOnlyRecord' || x.action.inputs.parameters.entityName === 'mwf_approvalsteps'))));

  // derived waiting time, fail-safe
  const sinceSets = list.filter((x) => x.action.type === 'SetVariable' && x.action.inputs.name === 'sinceUtc' && !x.name.startsWith('Reset_'));
  const fromCreated = sinceSets.find((x) => x.name === 'Set_sinceUtc_from_createdon'); const fromPrev = sinceSets.find((x) => x.name === 'Set_sinceUtc_from_previous');
  ok('the waiting time is derived: step 1 from createdon; a later step from the decidedon of the previous step, only if that step exists and is Approved or Informed and has a decidedon',
    sinceSets.length === 2 && /createdon/.test(fromCreated?.action.inputs.value) && fromCreated.scope.includes('Branch_waiting_since')
    && /mwf_decidedon/.test(fromPrev?.action.inputs.value) && fromPrev.scope.includes('Check_previous_step_decided') && fromPrev.scope.includes('Check_previous_step_exists')
    && JSON.stringify(byName.Check_previous_step_decided.action.expression).includes(String(DECISION.Approved)) && JSON.stringify(byName.Check_previous_step_decided.action.expression).includes(String(DECISION.Informed))
    && JSON.stringify(byName.Check_previous_step_decided.action.expression).includes('mwf_decidedon'));
  ok('the previous step is found in the SAME contract and round, by step order minus 1', /_mwf_contract_value eq/.test(byName.Get_previous_step?.action.inputs.parameters.$filter) && /mwf_approvalround eq/.test(byName.Get_previous_step.action.inputs.parameters.$filter) && /sub\(.*mwf_steporder.*, 1\)/.test(byName.Get_previous_step.action.inputs.parameters.$filter));
  ok('the decision (Set_action) is reachable only through a gate on a non-empty waiting time, so an unclear time sends nothing', JSON.stringify(byName.Gate_decide?.action.expression).includes("variables('sinceUtc')") && byName.Set_action?.scope.includes('Gate_decide'));
  ok('the owner (escalation) and the assigned approver (reminder) are the only recipients', ['Get_owner_user_list', 'Get_assignment_of_role'].every((n) => byName[n]) && /_ownerid_value/.test(byName.Get_owner_user_list.action.inputs.parameters.$filter));

  // the two emails
  const emailKeys = ['To', 'Subject', 'Body'].map(emailKey);
  ok('exactly two Send an email (V2) actions, to the recipient variable, with the keys of the chosen style (NOT verified in the designer)', sends.length === 2 && sends.every((s) => JSON.stringify(Object.keys(s.action.inputs.parameters)) === JSON.stringify(emailKeys) && s.action.inputs.parameters[emailKey('To')] === "@variables('recipientEmail')" && s.action.inputs.host.connectionName === 'shared_office365'));
  const subjects = sends.map((s) => s.action.inputs.parameters[emailKey('Subject')]);
  ok(variant.name === 'test' ? 'the subjects of the test variant start with "[Muwafaqa test] "' : 'the subjects of the production variant have no test prefix', subjects.length === 2 && subjects.every((s) => (variant.name === 'test' ? s.startsWith('[Muwafaqa test] ') : !s.includes('[Muwafaqa test]') && !s.startsWith(' '))));
  const bodies = sends.map((s) => s.action.inputs.parameters[emailKey('Body')]);
  ok('the escalation text says that nothing was approved, rejected, skipped or reassigned; the reminder text asks to answer the request', /does not approve, reject, skip or reassign/.test(bodies[1] || '') && /answer the approval request/.test(bodies[0] || ''));

  // connections
  const conn = new Set([...text.matchAll(/"connectionName":"([^"]+)"/g)].map((m) => m[1]));
  ok('every connectionName exists in connectionReferences', [...conn].every((c) => Object.keys(refs).includes(c)), [...conn].join(', '));
  ok('the connection reference logical names are the ones given (the Outlook one is a parameter, not a GUID)', refs.shared_office365?.connection?.connectionReferenceLogicalName === outlookRef && refs.shared_commondataserviceforapps?.connection?.connectionReferenceLogicalName === dataverseRef && !/[0-9a-f]{8}-[0-9a-f]{4}/.test(outlookRef));
  ok('operation ids are the expected ones', list.every((x) => !x.action.inputs?.host || OPERATIONS.includes(x.action.inputs.host.operationId)));

  // structure and text
  const stats = statsOf(cd);
  ok('nesting depth is at most 8 (Power Automate limit, Learn limits-and-config)', stats.depth <= 8, `depth ${stats.depth}`);
  ok('fewer than 500 actions', stats.actions < 500, `${stats.actions} actions`);
  ok('no email address and no id (GUID) in the definition', !/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text.replace(/@\{|@[A-Za-z]+\(/g, '')) && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text));
  ok('the placeholder <ORG_HOST> is the only host in the definition', !/dynamics\.com/.test(text) && text.includes('<ORG_HOST>'));
  ok('the timers of the variant are valid (whole minutes, 0 < remind < escalate)', (() => { try { validateTimers(variant.timers); return true; } catch { return false; } })());
  return { results, list, stats };
}

// ------------------------------------------------------------------------------------------------ the creation request (pure)
export const SOLUTION_DEFAULT = 'Muwafaqa';
export const FLOW_DESCRIPTION = (variant) => `Scheduled flow of ADR-010: one reminder and one informational escalation notice for approval steps that wait too long (variant ${variant.name}). Created OFF by scripts/build-flow-reminders.mjs. Only the owner turns it on.`;

/** The body of the ONE POST. It carries NO state: a new cloud flow row is created in the Draft state (OFF). Exactly these keys, a unit test holds them. */
export function createBody(variant, clientdataJson) {
  return { name: FLOW_NAME, category: 5, type: 1, primaryentity: 'none', description: FLOW_DESCRIPTION(variant), clientdata: clientdataJson };
}

/** The summary printed by the dry run: what the request would be. No definition dump. */
export function requestSummary(variant, { outlookRef = DEFAULT_OUTLOOK_REF, dataverseRef = DEFAULT_DATAVERSE_REF, solution = SOLUTION_DEFAULT } = {}) {
  const cd = buildClientdata(variant, { outlookRef, dataverseRef });
  const { actions, depth } = statsOf(cd);
  const size = Buffer.byteLength(JSON.stringify(cd), 'utf8');
  const checks = checkClientdata(cd, variant, { outlookRef, dataverseRef }).results;
  const failedChecks = checks.filter((r) => !r.pass).length;
  const T = variant.timers;
  return [
    'DRY RUN: nothing is sent, no sign-in, no environment is read.',
    'REQUEST   POST workflows (ONE row, never retried), header MSCRM.SolutionUniqueName: ' + solution,
    'NAME      ' + FLOW_NAME,
    'CATEGORY  5 (modern cloud flow), type 1, primaryentity none',
    'STATE     OFF: the body carries no state, so the new row is a Draft. This script never turns a flow on, off or changes any state.',
    'VARIANT   ' + variant.name + ': recurrence every ' + variant.intervalMinutes + ' minute(s); reminder after ' + T.remindAfterMinutes + ' min, escalation after ' + T.escalateAfterMinutes + ' min; cap ' + MAX_NOTICES_PER_RUN + ' notices per run; subject prefix ' + (variant.subjectPrefix ? JSON.stringify(variant.subjectPrefix) : 'none'),
    'BINDS     shared_commondataserviceforapps -> connection reference ' + dataverseRef,
    'BINDS     shared_office365 (Office 365 Outlook) -> connection reference ' + outlookRef,
    'SIZE      ' + actions + ' actions, nesting depth ' + depth + ', clientdata ' + size + ' bytes (before the host replaces <ORG_HOST>)',
    'CHECKS    ' + (checks.length - failedChecks) + ' of ' + checks.length + ' structural checks pass' + (failedChecks ? ' (THE REAL RUN WOULD REFUSE: ' + failedChecks + ' failed)' : ''),
    'BEFORE THE POST (real run only): 3 consecutive successful reads; the solution is unmanaged; no flow named "' + FLOW_NAME + '" exists; each of the two references exists in the solution for its connector (read only)',
    'AFTER THE POST (real run only): read back once: category 5, OFF, in the solution, stored structure, stored reference names; every other flow row unchanged',
    'NEVER     turn on, turn off, update, delete or run any flow; no other write.',
  ];
}

// ------------------------------------------------------------------------------------------------ modes
function printResults(variant, results) {
  console.log(`--- variant ${variant.name}`);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`SUMMARY (${variant.name}): ${results.length - bad} passed, ${bad} failed.\n`);
  return bad;
}
function printTable(list) {
  console.log('action'.padEnd(48) + 'type'.padEnd(20) + 'operation'.padEnd(20) + 'parent');
  for (const x of list) console.log(`${'  '.repeat(x.scope.length)}${x.name}`.padEnd(48) + String(x.action.type).padEnd(20) + String(x.action.inputs?.host?.operationId || '').padEnd(20) + (x.scope[x.scope.length - 1] || '-'));
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;   // false when a unit test imports this file
if (isMain) {
  const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
  const has = (f) => process.argv.includes(f);
  const MODE = argOf('mode');
  if (!['build', 'check', 'create', 'verify'].includes(MODE)) { console.error('Missing or invalid --mode=build|check|create|verify. Nothing was run.'); process.exit(2); }
  const which = argOf('variant') || (MODE === 'create' ? '' : 'both');
  if (!['test', 'production', 'both'].includes(which) || (MODE === 'create' && which === 'both') || (MODE === 'create' && !which)) { console.error(MODE === 'create' ? 'create needs --variant=test or --variant=production. Nothing was run.' : 'Invalid --variant=test|production|both. Nothing was run.'); process.exit(2); }
  const refs = { outlookRef: argOf('outlook-ref') || DEFAULT_OUTLOOK_REF, dataverseRef: argOf('dataverse-ref') || DEFAULT_DATAVERSE_REF };
  try { assertLogicalName(refs.outlookRef); assertLogicalName(refs.dataverseRef); } catch (e) { console.error(`${e.message}. Nothing was run.`); process.exit(2); }
  const SOLUTION = argOf('solution') || SOLUTION_DEFAULT;

  if (MODE === 'build' || MODE === 'check') {
    const variants = which === 'both' ? [VARIANTS.test, VARIANTS.production] : [VARIANTS[which]];
    let bad = 0;
    for (const variant of variants) {
      const cd = buildClientdata(variant, refs);
      const { results, list, stats } = checkClientdata(cd, variant, refs);
      if (MODE === 'build') {
        console.log(`--- variant ${variant.name}`); printTable(list); console.log(`\n${stats.actions} actions, depth ${stats.depth}\n`);
        const out = argOf('out');
        if (out && variants.length === 1) { writeFileSync(out, JSON.stringify(cd, null, 2), 'utf8'); console.log('clientdata written to the given path (still with the placeholder <ORG_HOST>)'); }
      } else {
        bad += printResults(variant, results);
        console.log(`${stats.actions} actions, nesting depth ${stats.depth}\n`);
      }
    }
    process.exit(bad ? 1 : 0);
  }

  // ---- create: dry run unless confirmed (and --dry-run always wins). The dry run is offline.
  if (MODE === 'create' && (!has('--confirm-mutates-environment') || has('--dry-run'))) {
    console.log(requestSummary(VARIANTS[which], { ...refs, solution: SOLUTION }).join('\n'));
    console.log('\nNothing was sent. To create the row (OFF) add --env=https://<org>.crm4.dynamics.com and --confirm-mutates-environment (the owner\'s Azure CLI sign-in is used).');
    process.exit(0);
  }

  // ---- online modes (create with confirmation, verify). The owner's Azure CLI sign-in only.
  if (argOf('auth') && argOf('auth') !== 'az') { console.error('Only --auth=az (the owner\'s Azure CLI sign-in) is accepted. Nothing was run.'); process.exit(2); }
  const argv = process.argv.some((a) => a.startsWith('--auth=')) ? process.argv : [...process.argv, '--auth=az'];
  const { parseArgs, openSession, noGuid, Stop } = await import('./lib/dv-session.mjs');
  const { requireStableConnection } = await import('./lib/counter-snapshot.mjs');
  const { env: ENV, auth: AUTH } = parseArgs(argv);
  const variant = MODE === 'verify' ? null : VARIANTS[which];
  let failedChecks = 0;
  const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  [${d}]` : ''}`); if (!ok) failedChecks++; };

  (async () => {
    try {
      const S = await openSession({ env: ENV, auth: AUTH });
      const { must, call } = S;
      await requireStableConnection(call);
      const q = encodeURIComponent;
      const host = new URL(ENV).host;
      const flowRows = async () => (await must('GET', `workflows?$select=name,statecode,statuscode,category,modifiedon&$filter=${q('category eq 5')}&$top=200`)).j.value;
      const rowOf = async () => (await must('GET', `workflows?$select=workflowid,name,statecode,statuscode,category,modifiedon,clientdata&$filter=${q(`name eq '${FLOW_NAME}' and category eq 5`)}`)).j.value;
      const sol = (await must('GET', `solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid,ismanaged`)).j.value;
      if (sol.length !== 1 || sol[0].ismanaged) throw new Stop(`solution ${SOLUTION}: expected 1 unmanaged solution, found ${sol.length}${sol[0]?.ismanaged ? ' (managed)' : ''}`);
      const solId = sol[0].solutionid;
      const inSolution = async (id) => (await must('GET', `solutioncomponents?$filter=_solutionid_value eq ${solId} and objectid eq ${id}&$select=componenttype`)).j.value.length >= 1;

      if (MODE === 'verify') {
        const rows = await rowOf();
        check('the flow exists once and is OFF (statecode 0)', rows.length === 1 && rows[0].statecode === 0, `${rows.length} row(s)`);
        if (rows.length === 1) {
          check('the flow is a component of the solution', await inSolution(rows[0].workflowid));
          const back = JSON.parse(rows[0].clientdata || '{}');
          const stored = JSON.parse(JSON.stringify(back).split(host).join('<ORG_HOST>'));
          const outlookStored = back.properties?.connectionReferences?.shared_office365?.connection?.connectionReferenceLogicalName;
          const dvStored = back.properties?.connectionReferences?.shared_commondataserviceforapps?.connection?.connectionReferenceLogicalName;
          const variantStored = stored.properties?.definition?.triggers?.Recurrence?.recurrence?.interval === VARIANTS.test.intervalMinutes ? VARIANTS.test : VARIANTS.production;
          const c = checkClientdata(stored, variantStored, { outlookRef: outlookStored, dataverseRef: dvStored });
          const badC = c.results.filter((r) => !r.pass);
          check(`structure as stored (${variantStored.name} variant): ${c.results.length} checks`, badC.length === 0, badC.map((r) => r.name).join('; ').slice(0, 300));
          check('the stored Outlook connection reference is the one given', outlookStored === refs.outlookRef, outlookStored);
          check('the record link of the stored definition no longer has the placeholder', !(rows[0].clientdata || '').includes('<ORG_HOST>'));
        }
        const all = await flowRows();
        console.log(`INFO  flow rows (category 5): ${all.length}; ON: ${all.filter((r) => r.statecode === 1).length}`);
        process.exit(failedChecks ? 1 : 0);
      }

      // create
      const before = await flowRows();
      console.log(`INFO  flow rows before: ${before.length}; ON: ${before.filter((r) => r.statecode === 1).length}`);
      if ((await rowOf()).length) throw new Stop(`"${FLOW_NAME}" already exists. Nothing was created (this script never modifies an existing flow).`);
      const allRefs = (await must('GET', 'connectionreferences?$select=connectionreferenceid,connectionreferencelogicalname,connectorid,connectionid&$top=5000')).j.value;
      const members = new Set((await must('GET', `solutioncomponents?$filter=_solutionid_value eq ${solId}&$select=objectid&$top=5000`)).j.value.map((x) => String(x.objectid).toLowerCase()));
      for (const [connector, logical] of [['shared_commondataserviceforapps', refs.dataverseRef], ['shared_office365', refs.outlookRef]]) {
        const hit = allRefs.filter((r) => r.connectionreferencelogicalname === logical);
        check(`the connection reference ${logical} exists once`, hit.length === 1, `${hit.length} found`);
        if (hit.length === 1) {
          check(`${logical} is for the connector ${connector}`, String(hit[0].connectorid).endsWith('/' + connector));
          check(`${logical} is a component of the solution ${SOLUTION}`, members.has(String(hit[0].connectionreferenceid).toLowerCase()));
          check(`${logical} has a connection set (the value is not printed)`, !!hit[0].connectionid);
        }
      }
      if (failedChecks) throw new Stop('The connection references are not as expected. Nothing was created.');
      const cd = buildClientdata(variant, refs);
      const chk = checkClientdata(cd, variant, refs);
      if (chk.results.some((r) => !r.pass)) throw new Stop('The structural check failed. Nothing was created. Run --mode=check.');
      const payload = JSON.stringify(cd).split('<ORG_HOST>').join(host);

      let created = null;
      try {
        created = await call('POST', 'workflows', createBody(variant, payload), { 'MSCRM.SolutionUniqueName': SOLUTION });
      } catch (e) {
        console.error(`POST outcome UNKNOWN: ${noGuid(e.message).slice(0, 200)}`);
        const after = await rowOf().catch(() => null);
        console.error(after ? `State read after the error: ${after.length} row(s) named "${FLOW_NAME}". Nothing was deleted or retried.` : 'State could not be read after the error either. Check by hand. Nothing was deleted or retried.');
        process.exit(5);
      }
      if (!created.ok) throw new Stop(`POST workflows failed HTTP ${created.status}\n${noGuid(created.j?.error?.message || created.text).slice(0, 700)}\nNothing else was done.`);
      check('POST accepted (one row)', true, `HTTP ${created.status}`);

      const rows = await rowOf();
      check('the flow exists once', rows.length === 1, `${rows.length}`);
      const row = rows[0];
      check('category is 5 (modern flow) and the flow is OFF (statecode 0, Draft)', row.category === 5 && row.statecode === 0, `category ${row.category}, statecode ${row.statecode}, statuscode ${row.statuscode}`);
      check('the flow is a component of the solution', await inSolution(row.workflowid));
      const back = JSON.parse(row.clientdata);
      const stored = JSON.parse(JSON.stringify(back).split(host).join('<ORG_HOST>'));
      const sc = checkClientdata(stored, variant, refs);
      const badS = sc.results.filter((r) => !r.pass);
      check('the structural check passes on the definition as stored by Dataverse', badS.length === 0, badS.map((r) => r.name).join('; ').slice(0, 300));
      check('the stored definition has the same action names as the one sent', JSON.stringify(walk(back.properties.definition.actions).map((x) => x.name)) === JSON.stringify(chk.list.map((x) => x.name)));
      check('the stored connection references are the two given', back.properties.connectionReferences.shared_office365.connection.connectionReferenceLogicalName === refs.outlookRef && back.properties.connectionReferences.shared_commondataserviceforapps.connection.connectionReferenceLogicalName === refs.dataverseRef);
      const afterAll = await flowRows();
      const was = new Map(before.map((r) => [r.name + '|' + r.modifiedon, r.statecode]));
      check('every other flow row is unchanged (same modifiedon and state) and none is ON that was not ON before', afterAll.filter((r) => r.name !== FLOW_NAME).every((r) => was.get(r.name + '|' + r.modifiedon) === r.statecode) && afterAll.filter((r) => r.statecode === 1).length === before.filter((r) => r.statecode === 1).length, `${afterAll.length - 1} other row(s)`);
      console.log(`\nSUMMARY: ${failedChecks} failed check(s). The flow was NOT turned on and no run was started. The owner turns it on, only for a test.`);
      process.exit(failedChecks ? 1 : 0);
    } catch (e) {
      console.error(`\nSTOPPED: ${noGuid(e.message)}`);
      process.exit(4);
    }
  })();
}
