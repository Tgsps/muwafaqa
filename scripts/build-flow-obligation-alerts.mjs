#!/usr/bin/env node
/**
 * Generator of the scheduled flow "Muwafaqa - Obligation Alerts" (ADR-011, status Proposed; docs/flow-obligation-alerts.md). OFFLINE ONLY.
 * Modeled on scripts/build-flow-reminders.mjs. FOUR modes; there is NO replace mode and no code path that changes an existing flow:
 *
 *   --mode=check   OFFLINE. Structural checks of the generated definition; exit code 1 on any failure.
 *   --mode=plan    OFFLINE. Prints the summary (parameters, window, key expression, guard, the numbered action list, the REAL action count and nesting depth).
 *   --mode=create  TEST VARIANT ONLY (production is refused). Needs --solution=<unique name> (no default). Without --confirm-mutates-environment, or with --dry-run, it is an OFFLINE dry run
 *                  that prints the flow name, the solution header, the state requested (OFF: the body carries no state), the connection references, the real action count and depth and
 *                  the exact JSON path list of the request, and sends nothing. WITH --confirm-mutates-environment it needs --env and --auth=az (the owner's Azure CLI sign-in only) and
 *                  does ONE POST (never retried) after the guards of lib/obligation-flow-deploy.mjs; it creates the flow OFF, never turns it on, never publishes, never saves an existing flow, never
 *                  creates a connection reference, and refuses if a flow of this name exists. Verbs: GET and that one POST; never PUT, PATCH or DELETE.
 *   --mode=verify  READ ONLY. Needs --env, --auth=az, --solution. Reports the state (must be OFF), the solution membership, the references bound, whether the stored definition equals the generated
 *                  one (every difference listed, none fixed) and the real action count and depth read from the stored definition.
 *
 * create WAS RUN ONCE against the environment on 2026-11-03: it created the flow OFF (one POST, HTTP 204), and verify read it back identical to the generated definition (32 actions, depth 5). Both are
 * also covered by unit tests against a mocked, stateful environment (lib/obligation-flow-deploy.mjs). With the flow in place a second create refuses: a flow of this name exists.
 *
 * Variants (one generator, they differ ONLY in interval, lead time, lookback window and the subject prefix):
 *   test        TEST CONSTANTS, not business values: interval 1 minute, lead time 5 minutes, lookback window 30 minutes, subject prefix "[Muwafaqa test] ".
 *   production  REQUIRED parameters with NO default: --interval-minutes, --lead-minutes, --lookback-minutes (whole minutes). The generator refuses to emit a production
 *               definition without all three, and requires lookback >= interval (a due date that passes between two runs must still be inside the next window).
 *
 *   --variant=test|production|both   default test. production and both need the three parameters.
 *   --outlook-ref=<logical name>  --dataverse-ref=<logical name>   as in build-flow-reminders.mjs (defaults are its defaults); never a GUID.
 *
 * The rules built in (every one is checked by --mode=check and by unit tests):
 *   - The query only considers Open obligations whose due date lies in [runStart - lookback, runStart + lead]. No new column on Obligation.
 *   - The alert key is a GENERATED expression; offline checks compare its evaluated output with scripts/lib/alert-key.mjs (through the small evaluator of
 *     scripts/lib/flow-expression-eval.mjs, whose limits are stated there: it proves the expression TEXT, not the behavior of Power Automate).
 *   - A guard before the insert: the iteration stops (skips) if the recipient or the key is empty, or the key has not the exact length of a valid key.
 *   - Fail closed: the email action is reachable only through actions whose runAfter is Succeeded back to the claim insert. Any failed insert skips the send and is
 *     recorded in a Compose action (the real shape of a failed insert is unknown until test case 13 of the spec).
 *   - The cap of 5 counts SUCCESSFUL claims only; skipped duplicates do not count.
 *   - The rules the designer has bitten us with: no Set variable with an empty-string literal (string('') is used), no Terminate inside a loop, every expression parameter non-empty.
 *   - The real action count and nesting depth are computed from the definition; the check fails above depth 8 or above 500 actions.
 *
 * Usage:
 *   node scripts/build-flow-obligation-alerts.mjs --mode=check
 *   node scripts/build-flow-obligation-alerts.mjs --mode=plan
 *   node scripts/build-flow-obligation-alerts.mjs --mode=plan --variant=production --interval-minutes=<n> --lead-minutes=<n> --lookback-minutes=<n>
 *   node scripts/build-flow-obligation-alerts.mjs --mode=create --solution=<unique name>                     (dry run, offline)
 *   node scripts/build-flow-obligation-alerts.mjs --mode=create --solution=<name> --env=https://<org>.crm4.dynamics.com --auth=az --confirm-mutates-environment      (run once on 2026-11-03; it now refuses: the flow exists)
 *   node scripts/build-flow-obligation-alerts.mjs --mode=verify --solution=<name> --env=https://<org>.crm4.dynamics.com --auth=az                                 (read only; run on 2026-11-03)
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { walk, balanced, expressionsOf } from './build-flow-v2.mjs';
import { DEFAULT_OUTLOOK_REF, DEFAULT_DATAVERSE_REF, assertLogicalName } from './build-flow-reminders.mjs';
import { MAX_NOTICES_PER_RUN } from './lib/reminder-candidates.mjs';
import { ALERT_TYPES, buildAlertKey, validateAlertKey, AlertKeyError } from './lib/alert-key.mjs';
import { OBLIGATION_STATUS } from './lib/obligation-schema.mjs';
import { evalExpr, evalTemplate, evalCondition, parse, FlowEvalError, SUPPORTED_FUNCTIONS } from './lib/flow-expression-eval.mjs';

export const FLOW_NAME = 'Muwafaqa - Obligation Alerts';
export const SOLUTION_HEADER = 'MSCRM.SolutionUniqueName';
export const FLOW_DESCRIPTION = 'Scheduled flow of ADR-011: one informational alert for each open obligation that is due soon or overdue (test variant). Created OFF by scripts/build-flow-obligation-alerts.mjs. Only the owner turns it on.';
/** The body of the ONE POST. It carries NO state: a new cloud flow row is created in the Draft state (OFF), exactly as the reminders flow was. Exactly these keys; a unit test holds them. */
export const createBody = (clientdataJson) => ({ name: FLOW_NAME, category: 5, type: 1, primaryentity: 'none', description: FLOW_DESCRIPTION, clientdata: clientdataJson });
export const EMAIL_KEY_STYLE = 'nested';   // as build-flow-reminders.mjs: emailMessage/To, /Subject, /Body (12 messages arrived with it on 2026-10-29)
const emailKey = (k) => (EMAIL_KEY_STYLE === 'nested' ? `emailMessage/${k}` : k);

// ------------------------------------------------------------------------------------------------ variants
/** TEST CONSTANTS. Not business values: chosen so that seeded rows fall inside or outside the window within one test window (docs/flow-obligation-alerts.md, section 13). */
export const TEST_CONSTANTS = Object.freeze({ intervalMinutes: 1, leadMinutes: 5, lookbackMinutes: 30 });
export const MAX_MINUTES = 525600;   // a sanity limit against typos (one year), NOT a business rule
export class VariantError extends Error {}

/** Whole minutes from 1 to MAX_MINUTES. Strings of digits are accepted (command line). */
function minutes(name, value, problems) {
  const n = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (n === undefined || n === null || n === '') { problems.push(`${name} is required (no default)`); return null; }
  if (!Number.isInteger(n) || n < 1 || n > MAX_MINUTES) { problems.push(`${name} must be a whole number of minutes from 1 to ${MAX_MINUTES} (got ${JSON.stringify(value)})`); return null; }
  return n;
}
export function testVariant() { return Object.freeze({ name: 'test', ...TEST_CONSTANTS, subjectPrefix: '[Muwafaqa test] ' }); }
/** The production variant. There is NO default for any parameter: a missing one throws VariantError. */
export function productionVariant({ intervalMinutes, leadMinutes, lookbackMinutes } = {}) {
  const problems = [];
  const i = minutes('interval-minutes', intervalMinutes, problems); const l = minutes('lead-minutes', leadMinutes, problems); const b = minutes('lookback-minutes', lookbackMinutes, problems);
  if (i !== null && b !== null && b < i) problems.push(`lookback-minutes (${b}) must be at least interval-minutes (${i}): a due date that passes between two runs must still be inside the window of the next run`);
  if (problems.length) throw new VariantError(`cannot emit a production definition: ${problems.join('; ')}`);
  return Object.freeze({ name: 'production', intervalMinutes: i, leadMinutes: l, lookbackMinutes: b, subjectPrefix: '' });
}

// ------------------------------------------------------------------------------------------------ the pieces
export const TYPES_USED = Object.freeze([ALERT_TYPES[0], ALERT_TYPES[1]]);   // OBLIGATION-DUESOON, OBLIGATION-OVERDUE
export const [TYPE_DUE_SOON, TYPE_OVERDUE] = TYPES_USED;
/** The exact lengths of a valid key of THIS flow: 36 (GUID) + 1 + the type + 1 + 8 (yyyyMMdd), derived from the types it emits. */
export const KEY_LENGTHS = Object.freeze([...new Set(TYPES_USED.map((t) => 36 + 1 + t.length + 1 + 8))]);

const LOOP = 'Apply_to_each_obligation';
const OBL = `items('${LOOP}')`;
const NOW = "variables('runStartedAt')";
const CONTRACT = "first(outputs('Get_contract')?['body/value'])";
const ISO = "'yyyy-MM-ddTHH:mm:ssZ'";
const bound = (mins) => `@{formatDateTime(addMinutes(${NOW}, ${mins}), ${ISO})}`;

export const TYPE_EXPRESSION = `@if(less(ticks(${OBL}?['mwf_duedate']), ticks(${NOW})), '${TYPE_OVERDUE}', '${TYPE_DUE_SOON}')`;
/** The alert key: <lower-case obligation GUID>-<TYPE>-<yyyyMMdd of the due date in UTC>. GENERATED here; compared offline with scripts/lib/alert-key.mjs. */
export const KEY_EXPRESSION = `@concat(toLower(string(${OBL}?['mwf_obligationid'])), '-', variables('alertType'), '-', formatDateTime(${OBL}?['mwf_duedate'], 'yyyyMMdd'))`;
const lengthIs = (n) => ({ equals: ["@length(variables('alertKey'))", n] });
/** The guard: recipient and key not empty, the key has the exact length of a valid key of this flow, and holds -<alertType>-. */
export const GUARD_CONDITION = Object.freeze({
  and: [
    { not: { equals: ["@empty(variables('recipientEmail'))", true] } },
    { not: { equals: ["@empty(variables('alertKey'))", true] } },
    KEY_LENGTHS.length === 1 ? lengthIs(KEY_LENGTHS[0]) : { or: KEY_LENGTHS.map(lengthIs) },
    { equals: ["@contains(variables('alertKey'), concat('-', variables('alertType'), '-'))", true] },
  ],
});
export const queryFilter = (variant) => `mwf_status eq ${OBLIGATION_STATUS.Open} and mwf_duedate ge ${bound(-variant.lookbackMinutes)} and mwf_duedate le ${bound(variant.leadMinutes)}`;

const CDS = (operationId) => ({ apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps', operationId, connectionName: 'shared_commondataserviceforapps' });
const OUT = (operationId) => ({ apiId: '/providers/Microsoft.PowerApps/apis/shared_office365', operationId, connectionName: 'shared_office365' });
const cds = (operationId, parameters) => ({ type: 'OpenApiConnection', inputs: { parameters, host: CDS(operationId) } });
const setVar = (name, value) => ({ type: 'SetVariable', inputs: { name, value } });
const initVar = (name, type, value) => ({ type: 'InitializeVariable', inputs: { variables: [{ name, type, value }] } });
const incVar = (name) => ({ type: 'IncrementVariable', inputs: { name, value: 1 } });
const ifThen = (expression, actions, elseActions = {}) => ({ type: 'If', expression, actions, else: { actions: elseActions } });
const eq = (a, b) => ({ equals: [a, b] });
const v = (n) => `@variables('${n}')`;
/** The value of a Set variable that resets a string. The designer REJECTS an empty literal ("'Value' is required", found 2026-10-28) and stores this expression. */
const EMPTY = "@string('')";
/** Every action of the ordered list gets a runAfter on the previous one (Succeeded). The first action of a nested scope has none; the first of the whole flow keeps `runAfter: {}`. */
function chain(list, { top = false } = {}) {
  const out = {}; let prev = null;
  for (const [name, action] of list) {
    out[name] = prev ? { ...action, runAfter: { [prev]: ['Succeeded'] } } : (top ? { ...action, runAfter: {} } : { ...action });
    prev = name;
  }
  return out;
}
const LINK = `https://<ORG_HOST>/main.aspx?etn=mwf_obligation&pagetype=entityrecord&id=@{${OBL}?['mwf_obligationid']}`;
const WHAT = "@{if(equals(variables('alertType'), '" + TYPE_OVERDUE + "'), 'Obligation overdue: ', 'Obligation due soon: ')}";
const SUBJECT = `${WHAT}@{${OBL}?['mwf_name']} (contract @{${CONTRACT}?['mwf_name']})`;
const BODY = [
  '<p>This is an informational notice from the Muwafaqa contract system (sample text).</p>',
  `<p>The obligation "@{${OBL}?['mwf_name']}" of contract @{${CONTRACT}?['mwf_contractnumber']} (@{${CONTRACT}?['mwf_name']}) is @{if(equals(variables('alertType'), '${TYPE_OVERDUE}'), 'overdue: the due date has passed and it is still open', 'due soon')}.</p>`,
  `<p>Due date: @{${OBL}?['mwf_duedate']} (UTC).</p>`,
  '<p>Nothing was changed by this notice and nobody has to answer it.</p>',
  `<p><a href="${LINK}">Open the obligation</a></p>`,
].join('');

export function buildDefinition(variant = testVariant()) {
  if (!variant || !Number.isInteger(variant.intervalMinutes) || !Number.isInteger(variant.leadMinutes) || !Number.isInteger(variant.lookbackMinutes)) throw new VariantError('a variant with interval, lead time and lookback window (whole minutes) is required');
  const CLAIM_FAILURE_RECORD = {
    action: "@actions('Insert_claim')?['status']", error: "@actions('Insert_claim')?['error']", outputs: "@actions('Insert_claim')?['outputs']",
    obligationId: `@${OBL}?['mwf_obligationid']`, key: v('alertKey'),
  };
  // The scope of the claim. Insert_claim is first. Increment_noticesSent runs ONLY after Insert_claim Succeeded and Send_alert_email ONLY after that: fail closed.
  // Compose_claim_failure runs ONLY after Insert_claim Failed or TimedOut. Two branches from one action, so this scope is written by hand, not with chain().
  const claimScope = {
    Insert_claim: cds('CreateRecord', { entityName: 'mwf_alertlogs', 'item/mwf_alertkey': v('alertKey'), 'item/mwf_name': v('alertKey') }),
    Increment_noticesSent: { ...incVar('noticesSent'), runAfter: { Insert_claim: ['Succeeded'] } },
    Send_alert_email: {
      type: 'OpenApiConnection',
      inputs: { parameters: { [emailKey('To')]: v('recipientEmail'), [emailKey('Subject')]: `${variant.subjectPrefix}${SUBJECT}`, [emailKey('Body')]: BODY }, host: OUT('SendEmailV2') },
      runAfter: { Increment_noticesSent: ['Succeeded'] },
    },
    Compose_claim_failure: { type: 'Compose', inputs: CLAIM_FAILURE_RECORD, runAfter: { Insert_claim: ['Failed', 'TimedOut'] } },
    Increment_claimFailures: { ...incVar('claimFailures'), runAfter: { Compose_claim_failure: ['Succeeded'] } },
  };

  const guardTrue = chain([
    ['Get_obligation_before_claim', cds('GetItem', { entityName: 'mwf_obligations', recordId: `@${OBL}?['mwf_obligationid']`, $select: 'mwf_status,mwf_duedate' })],
    ['Check_obligation_still_due', ifThen({ and: [
      eq("@outputs('Get_obligation_before_claim')?['body/mwf_status']", OBLIGATION_STATUS.Open),
      eq("@outputs('Get_obligation_before_claim')?['body/mwf_duedate']", `@${OBL}?['mwf_duedate']`),
    ] }, claimScope)],
  ]);

  const prepare = chain([
    ['Set_alertType', setVar('alertType', TYPE_EXPRESSION)],
    ['Get_contract', cds('ListRecords', { entityName: 'mwf_contracts', $select: 'mwf_contractid,mwf_name,mwf_contractnumber,_ownerid_value', $filter: `mwf_contractid eq @{${OBL}?['_mwf_contract_value']}`, $top: 1 })],
    ['Check_contract_found', ifThen({ greater: ["@length(outputs('Get_contract')?['body/value'])", 0] }, chain([
      ['Get_owner_user_list', cds('ListRecords', { entityName: 'systemusers', $select: 'internalemailaddress', $filter: `systemuserid eq @{${CONTRACT}?['_ownerid_value']}`, $top: 1 })],
      ['Set_recipient_owner', setVar('recipientEmail', "@{coalesce(first(outputs('Get_owner_user_list')?['body/value'])?['internalemailaddress'], '')}")],
    ]))],
    ['Set_alertKey', setVar('alertKey', KEY_EXPRESSION)],
    ['Gate_guard', ifThen(GUARD_CONDITION, guardTrue, { Increment_errors: incVar('errors') })],
  ]);

  const loopActions = chain([
    ['Set_proceed', setVar('proceed', `@{if(less(variables('noticesSent'), ${MAX_NOTICES_PER_RUN}), 'yes', 'no')}`)],   // the cap of one run, checked BEFORE the claim
    ['Reset_alertType', setVar('alertType', EMPTY)],
    ['Reset_alertKey', setVar('alertKey', EMPTY)],
    ['Reset_recipientEmail', setVar('recipientEmail', EMPTY)],
    ['Gate_prepare', ifThen(eq(v('proceed'), 'yes'), prepare)],
  ]);

  const actions = chain([
    ['Init_runStartedAt', initVar('runStartedAt', 'string', '@{utcNow()}')],
    ['Init_noticesSent', initVar('noticesSent', 'integer', 0)],
    ['Init_claimFailures', initVar('claimFailures', 'integer', 0)],
    ['Init_errors', initVar('errors', 'integer', 0)],
    ['Init_proceed', initVar('proceed', 'string', '')],
    ['Init_alertType', initVar('alertType', 'string', '')],
    ['Init_alertKey', initVar('alertKey', 'string', '')],
    ['Init_recipientEmail', initVar('recipientEmail', 'string', '')],
    ['Get_open_obligations', cds('ListRecords', {
      entityName: 'mwf_obligations', $select: 'mwf_obligationid,mwf_name,mwf_duedate,_mwf_contract_value',
      $filter: queryFilter(variant), $orderby: 'mwf_duedate asc', $top: 50,
    })],
    [LOOP, { type: 'Foreach', foreach: "@outputs('Get_open_obligations')?['body/value']", actions: loopActions, runtimeConfiguration: { concurrency: { repetitions: 1 } } }],
    // After the loop and NOT inside any loop: a Terminate inside a loop ends the whole run at the first obligation.
    ['Check_errors', ifThen({ greater: ["@variables('errors')", 0] }, {
      Terminate_run_failed: { type: 'Terminate', inputs: { runStatus: 'Failed', runError: { code: 'ObligationAlertErrors', message: "@{concat('Obligation alerts finished with ', string(variables('errors')), ' error(s); see the run history')}" } } },
    })],
  ], { top: true });
  return {
    $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
    contentVersion: '1.0.0.0',
    parameters: { $authentication: { defaultValue: {}, type: 'SecureObject' }, $connections: { defaultValue: {}, type: 'Object' } },
    triggers: { Recurrence: { type: 'Recurrence', recurrence: { frequency: 'Minute', interval: variant.intervalMinutes } } },
    actions,
  };
}

export function buildClientdata(variant = testVariant(), { outlookRef = DEFAULT_OUTLOOK_REF, dataverseRef = DEFAULT_DATAVERSE_REF } = {}) {
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

/** REAL numbers from the generated definition: every action counted (also the ones inside conditions and loops), depth = the deepest scope + 1. */
export function statsOf(cd) {
  const list = walk(cd.properties.definition.actions);
  return { actions: list.length, depth: Math.max(...list.map((x) => x.scope.length)) + 1 };
}
export const LIMITS = Object.freeze({ maxActions: 500, maxDepth: 8 });   // Learn, limits-and-config (not re-read in this session; the reminders generator uses the same)

// ------------------------------------------------------------------------------------------------ the offline comparison of the key expression with alert-key.mjs
const GUID_LOWER = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';   // a made-up GUID
export const KEY_SAMPLES = Object.freeze({
  ids: Object.freeze([GUID_LOWER, GUID_LOWER.toUpperCase(), '00000000-0000-4000-8000-000000000001']),
  dates: Object.freeze(['2027-03-31T00:00:00Z', '2027-02-28T23:59:59Z', '2028-02-29T10:00:00Z', '2026-12-31T00:00:00Z', '2027-06-30T12:34:56Z']),
  types: ALERT_TYPES,
  /** Inputs that must be rejected: the guard must say no (or the evaluation must fail, which fails the action in the real engine), and alert-key.mjs must refuse the same key. */
  rejects: Object.freeze([
    { label: 'empty obligation id', id: '', date: '2027-03-31T00:00:00Z', type: TYPE_DUE_SOON },
    { label: 'too short (35 characters)', id: GUID_LOWER.slice(1), date: '2027-03-31T00:00:00Z', type: TYPE_DUE_SOON },
    { label: 'too long (id of 101 characters)', id: 'a'.repeat(101), date: '2027-03-31T00:00:00Z', type: TYPE_OVERDUE },
    { label: 'one character too long', id: `${GUID_LOWER}0`, date: '2027-03-31T00:00:00Z', type: TYPE_OVERDUE },
    { label: 'empty type', id: GUID_LOWER, date: '2027-03-31T00:00:00Z', type: '' },
    { label: 'empty date', id: GUID_LOWER, date: '', type: TYPE_DUE_SOON },
  ]),
});
/** A fictitious recipient for the offline evaluation, built at runtime (the repository holds no address literal, even a reserved one). */
const SAMPLE_RECIPIENT = ['owner', 'example.test'].join('@');
const ctxFor = (id, date, type, extra = {}) => ({ variables: { alertType: type, alertKey: '', recipientEmail: SAMPLE_RECIPIENT, runStartedAt: '2027-06-15T12:00:00Z', ...extra }, items: { [LOOP]: { mwf_obligationid: id, mwf_duedate: date } } });
/** The key the flow's expression gives for these inputs, or an Error when the evaluation fails (the real action would fail). */
export function evaluateKey(id, date, type, expression = KEY_EXPRESSION) { return evalTemplate(expression, ctxFor(id, date, type)); }
/** True when the guard lets this key go on. */
export function evaluateGuard(key, type, recipient = SAMPLE_RECIPIENT, condition = GUARD_CONDITION) { return !!evalCondition(condition, { variables: { alertKey: key, alertType: type, recipientEmail: recipient } }); }
/** Compares the evaluated expression with alert-key.mjs. @returns {{ok:number, bad:string[], rejected:number, badRejects:string[]}} */
/** keyExpression and guardCondition default to the generator's constants; the check passes the ones STORED in the definition, so a changed definition is caught. */
export function compareWithAlertKey({ keyExpression = KEY_EXPRESSION, guardCondition = GUARD_CONDITION } = {}) {
  const bad = []; let ok = 0;
  for (const id of KEY_SAMPLES.ids) for (const date of KEY_SAMPLES.dates) for (const type of KEY_SAMPLES.types) {
    let got; try { got = evaluateKey(id, date, type, keyExpression); } catch (e) { bad.push(`${id.slice(0, 8)} ${date} ${type}: evaluation failed ${e.message}`); continue; }
    const want = buildAlertKey({ sourceId: id, type, date });
    if (got === want) ok++; else bad.push(`${id.slice(0, 8)} ${date} ${type}: flow ${got} but alert-key ${want}`);
  }
  let rejected = 0; const badRejects = [];
  for (const r of KEY_SAMPLES.rejects) {
    let key = null; let flowRejects = false;
    try { key = evaluateKey(r.id, r.date, r.type, keyExpression); flowRejects = !evaluateGuard(key, r.type, SAMPLE_RECIPIENT, guardCondition); } catch (e) { if (e instanceof FlowEvalError) flowRejects = true; else throw e; }   // an evaluation failure fails the real action: also a rejection
    let libRejects = false; try { validateAlertKey(key ?? '', {}); } catch (e) { if (e instanceof AlertKeyError) libRejects = true; else throw e; }
    if (flowRejects && libRejects) rejected++; else badRejects.push(`${r.label}: flow rejects ${flowRejects}, alert-key rejects ${libRejects}`);
  }
  return { ok, bad, rejected, badRejects };
}

// ------------------------------------------------------------------------------------------------ checks
const OPERATIONS = ['ListRecords', 'GetItem', 'CreateRecord', 'SendEmailV2'];
const READ_TABLES = ['mwf_obligations', 'mwf_contracts', 'systemusers'];
const strs = (val, out = []) => { if (typeof val === 'string') out.push(val); else if (Array.isArray(val)) val.forEach((y) => strs(y, out)); else if (val && typeof val === 'object') Object.values(val).forEach((y) => strs(y, out)); return out; };
const functionNames = (text) => { const out = new Set(); const walkAst = (n) => { if (!n) return; if (n.k === 'call') { out.add(n.name); n.args.forEach(walkAst); } if (n.k === 'prop') { walkAst(n.obj); walkAst(n.key); } }; for (const e of expressionsOf(text)) { if (e === '\u0000UNCLOSED') continue; try { walkAst(parse(e)); } catch { /* not in the evaluated subset: reported by the caller */ } } return out; };

export function checkClientdata(cd, variant = testVariant(), { outlookRef = DEFAULT_OUTLOOK_REF, dataverseRef = DEFAULT_DATAVERSE_REF } = {}) {
  const results = [];
  const ok = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });
  const def = cd.properties.definition; const refs = cd.properties.connectionReferences;
  const list = walk(def.actions);
  const byName = Object.fromEntries(list.map((x) => [x.name, x]));
  const idx = (n) => byName[n]?.index ?? -1;
  const trig = Object.entries(def.triggers);
  const all = [...list.map((x) => x.name), ...trig.map(([n]) => n)];
  const text = JSON.stringify(cd);
  const stats = statsOf(cd);

  ok('action names are unique across the whole flow (including the trigger)', new Set(all).size === all.length, `${all.length} names`);
  ok('action names use letters, digits and underscore only, at most 80 characters', all.every((n) => /^[A-Za-z0-9_]{1,80}$/.test(n)));
  ok(`exactly one trigger: a Recurrence of ${variant.intervalMinutes} minute(s)`, trig.length === 1 && trig[0][1].type === 'Recurrence' && trig[0][1].recurrence?.frequency === 'Minute' && trig[0][1].recurrence?.interval === variant.intervalMinutes && variant.intervalMinutes >= 1);

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

  // expressions: balanced, references to earlier visible actions, loops, variables
  const refErrors = []; const exprErrors = []; const variableUse = []; const unsupported = new Set();
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
      for (const m of e.matchAll(/\bitems\('([^']+)'\)/g)) { const t = byName[m[1]]; if (!t || t.action.type !== 'Foreach' || !x.scope.includes(m[1])) refErrors.push(`${x.name} -> items('${m[1]}') (not an enclosing Foreach)`); }
      for (const m of e.matchAll(/\bvariables\('([^']+)'\)/g)) variableUse.push({ at: x.name, index: x.index, name: m[1] });
    }
  }
  ok('every expression is balanced (parentheses, brackets, quotes, @{ })', exprErrors.length === 0, exprErrors.slice(0, 3).join(' | '));
  ok('every reference to another action or loop points at an earlier action of the same or an enclosing scope', refErrors.length === 0, refErrors.slice(0, 3).join(' | '));
  const inits = list.filter((x) => x.action.type === 'InitializeVariable');
  const declared = new Map(inits.map((x) => [x.action.inputs.variables[0].name, { index: x.index, ...x.action.inputs.variables[0] }]));
  ok('the variables exist with the expected types (noticesSent, claimFailures, errors integer 0; runStartedAt, proceed, alertType, alertKey, recipientEmail string)',
    declared.size === 8 && ['noticesSent', 'claimFailures', 'errors'].every((n) => declared.get(n)?.type === 'integer' && declared.get(n)?.value === 0) && ['runStartedAt', 'proceed', 'alertType', 'alertKey', 'recipientEmail'].every((n) => declared.get(n)?.type === 'string'));
  ok('every variable is initialized before it is used', variableUse.every((u) => declared.has(u.name) && declared.get(u.name).index < u.index));
  const varWrites = list.filter((x) => ['SetVariable', 'IncrementVariable'].includes(x.action.type)).map((x) => ({ at: x.name, name: x.action.inputs.name }));
  ok('every Set and Increment names a declared variable, and every variable is initialized at the top level (never inside a scope)', varWrites.every((w) => declared.has(w.name)) && inits.every((x) => x.scope.length === 0));

  // the designer rules
  const setVars = list.filter((x) => x.action.type === 'SetVariable');
  ok("no Set variable has an empty-string literal as its value (the designer rejects it); string('') is used to reset", setVars.every((x) => typeof x.action.inputs.value === 'string' && x.action.inputs.value.trim() !== '' && x.action.inputs.value !== '@{}') && setVars.some((x) => x.action.inputs.value === EMPTY));
  const emptyParams = [];
  for (const x of list) {
    const p = x.action.inputs?.parameters;
    if (p) for (const [k, val] of Object.entries(p)) if (val === '' || val === null || val === undefined || (typeof val === 'string' && val.trim() === '')) emptyParams.push(`${x.name}.${k}`);
    if (x.action.type === 'Compose') for (const [k, val] of Object.entries(x.action.inputs || {})) if (val === '' || val === null || val === undefined) emptyParams.push(`${x.name}.${k}`);
    if (x.action.type === 'SetVariable' && !x.action.inputs.value) emptyParams.push(`${x.name}.value`);
    if (x.action.type === 'Foreach' && !x.action.foreach) emptyParams.push(`${x.name}.foreach`);
    if (x.action.type === 'If' && !x.action.expression) emptyParams.push(`${x.name}.expression`);
  }
  ok('every expression and parameter of an action is non-empty', emptyParams.length === 0, emptyParams.join(', '));
  const terminates = list.filter((x) => x.action.type === 'Terminate');
  const loops = list.filter((x) => ['Foreach', 'Until'].includes(x.action.type)).map((x) => x.name);
  ok('no Terminate inside a loop: the only Terminate is inside Check_errors, which follows the loop at the top level, with status Failed',
    terminates.length === 1 && terminates[0].name === 'Terminate_run_failed' && terminates[0].action.inputs.runStatus === 'Failed' && terminates[0].scope.join('/') === 'Check_errors' && !terminates[0].scope.some((s) => loops.includes(s))
    && byName.Check_errors?.scope.length === 0 && idx('Check_errors') > idx(LOOP) && Object.keys(byName.Check_errors?.action.runAfter || {}).join() === LOOP);
  ok('no Until loop; one Foreach, run one at a time (concurrency 1)', !list.some((x) => x.action.type === 'Until') && loops.length === 1 && byName[LOOP]?.action.runtimeConfiguration?.concurrency?.repetitions === 1);

  // operations and tables
  ok('operation ids are the expected ones (ListRecords, GetItem, CreateRecord, SendEmailV2)', list.every((x) => !x.action.inputs?.host || OPERATIONS.includes(x.action.inputs.host.operationId)));
  const creates = list.filter((x) => x.action.inputs?.host?.operationId === 'CreateRecord');
  const cp = creates[0]?.action.inputs.parameters;
  ok('the only write is ONE insert into mwf_alertlogs of mwf_alertkey and mwf_name (both the key variable); no update, no delete', creates.length === 1 && creates[0].name === 'Insert_claim'
    && cp?.entityName === 'mwf_alertlogs' && JSON.stringify(Object.keys(cp).sort()) === JSON.stringify(['entityName', 'item/mwf_alertkey', 'item/mwf_name'].sort()) && cp['item/mwf_alertkey'] === v('alertKey') && cp['item/mwf_name'] === v('alertKey')
    && !list.some((x) => ['UpdateOnlyRecord', 'DeleteRecord', 'UpdateRecord'].includes(x.action.inputs?.host?.operationId)));
  ok('the flow reads only mwf_obligations, mwf_contracts and systemusers', list.every((x) => !x.action.inputs?.parameters?.entityName || x.action.inputs.host.operationId === 'CreateRecord' || READ_TABLES.includes(x.action.inputs.parameters.entityName)));

  // the window
  const q = byName.Get_open_obligations?.action.inputs.parameters;
  const probe = '2027-06-15T12:00:00Z';
  let filterOut = '';
  try { filterOut = evalTemplate(q?.$filter, { variables: { runStartedAt: probe } }); } catch (e) { filterOut = `evaluation failed: ${e.message}`; }
  const iso = (mins) => new Date(Date.parse(probe) + mins * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  ok(`the query is server side and bounded: Open only, due date between now - ${variant.lookbackMinutes} and now + ${variant.leadMinutes} minutes (evaluated with a fixed clock)`,
    filterOut === `mwf_status eq ${OBLIGATION_STATUS.Open} and mwf_duedate ge ${iso(-variant.lookbackMinutes)} and mwf_duedate le ${iso(variant.leadMinutes)}` && q?.$orderby === 'mwf_duedate asc' && q?.$top === 50 && q?.entityName === 'mwf_obligations', filterOut);
  ok('the query names neither Done nor Disputed (the Open filter excludes them) and no other status', !/mwf_status eq (?!867640000\b)/.test(q?.$filter || '') && (q?.$filter.match(/mwf_status/g) || []).length === 1);
  ok('the loop reads the result of Get_open_obligations', byName[LOOP]?.action.foreach === "@outputs('Get_open_obligations')?['body/value']");

  // recipient, key, guard, claim, cap
  ok('the recipient is the owner of the contract: read before anything is written, no other recipient', byName.Get_owner_user_list?.action.inputs.parameters.$filter.includes("_ownerid_value") && idx('Get_owner_user_list') < idx('Insert_claim') && idx('Set_recipient_owner') < idx('Gate_guard')
    && list.filter((x) => x.action.inputs?.host?.operationId === 'SendEmailV2').every((x) => x.action.inputs.parameters[emailKey('To')] === v('recipientEmail')));
  ok('Set_alertKey is exactly the generated key expression', byName.Set_alertKey?.action.inputs.value === KEY_EXPRESSION);
  const cmp = compareWithAlertKey({ keyExpression: byName.Set_alertKey?.action.inputs.value, guardCondition: byName.Gate_guard?.action.expression });
  ok(`the key expression, evaluated, equals scripts/lib/alert-key.mjs on ${KEY_SAMPLES.ids.length * KEY_SAMPLES.dates.length * KEY_SAMPLES.types.length} samples (3 ids incl. capitals, 5 dates, the 4 types)`, cmp.bad.length === 0 && cmp.ok === KEY_SAMPLES.ids.length * KEY_SAMPLES.dates.length * KEY_SAMPLES.types.length, cmp.bad[0] || `${cmp.ok} equal`);
  ok(`the guard and alert-key.mjs both reject ${KEY_SAMPLES.rejects.length} bad inputs (empty, too short, too long, empty type, empty date)`, cmp.badRejects.length === 0 && cmp.rejected === KEY_SAMPLES.rejects.length, cmp.badRejects[0] || `${cmp.rejected} rejected`);
  const guard = byName.Gate_guard;
  ok(`the guard sits before the insert: Insert_claim is inside Gate_guard (true branch); the guard tests recipient, key empty, the exact key length ${KEY_LENGTHS.join(' or ')} and the type segment; its false branch only counts an error`,
    guard && byName.Insert_claim?.scope.includes('Gate_guard') && idx('Gate_guard') < idx('Insert_claim') && JSON.stringify(guard.action.expression) === JSON.stringify(GUARD_CONDITION)
    && Object.keys(guard.action.else.actions).join() === 'Increment_errors' && KEY_LENGTHS.every((n) => JSON.stringify(guard.action.expression).includes(`"@length(variables('alertKey'))",${n}`)));
  ok('Insert_claim is inside Check_obligation_still_due, which is inside Gate_guard, which is inside Gate_prepare (the cap gate)', JSON.stringify(byName.Insert_claim?.scope) === JSON.stringify([LOOP, 'Gate_prepare', 'Gate_guard', 'Check_obligation_still_due']));

  // fail closed: walk the runAfter chain from the send back to the insert
  const sends = list.filter((x) => x.action.inputs?.host?.operationId === 'SendEmailV2');
  const chainBack = (name, acc = []) => { const ra = byName[name]?.action.runAfter || {}; for (const [t, st] of Object.entries(ra)) { acc.push({ from: name, to: t, st }); chainBack(t, acc); } return acc; };
  const back = sends[0] ? chainBack(sends[0].name) : [];
  ok('fail closed: the email action is reachable only through runAfter Succeeded edges back to Insert_claim (exactly one send, in the same scope as the insert)',
    sends.length === 1 && sends[0].name === 'Send_alert_email' && JSON.stringify(sends[0].scope) === JSON.stringify(byName.Insert_claim?.scope) && back.length > 0 && back.every((e) => JSON.stringify(e.st) === '["Succeeded"]') && back.some((e) => e.to === 'Insert_claim'),
    back.map((e) => `${e.from}<-${e.to}:${e.st.join('/')}`).join(' '));
  ok('a failed insert (Failed or TimedOut) leads only to Compose_claim_failure and Increment_claimFailures: nothing sent, nothing counted as a notice',
    JSON.stringify(byName.Compose_claim_failure?.action.runAfter) === JSON.stringify({ Insert_claim: ['Failed', 'TimedOut'] }) && JSON.stringify(byName.Increment_claimFailures?.action.runAfter) === JSON.stringify({ Compose_claim_failure: ['Succeeded'] })
    && list.filter((x) => Object.keys(x.action.runAfter || {}).includes('Insert_claim')).map((x) => x.name).sort().join() === 'Compose_claim_failure,Increment_noticesSent'
    && ['status', 'error', 'outputs'].every((k) => JSON.stringify(byName.Compose_claim_failure.action.inputs).includes(`actions('Insert_claim')?['${k}']`)));
  const incs = list.filter((x) => x.action.type === 'IncrementVariable');
  ok('the cap counter noticesSent is incremented exactly once, by 1, and only right after Insert_claim Succeeded (skipped duplicates and failures never count)',
    incs.filter((x) => x.action.inputs.name === 'noticesSent').length === 1 && byName.Increment_noticesSent?.action.inputs.value === 1 && JSON.stringify(byName.Increment_noticesSent?.action.runAfter) === JSON.stringify({ Insert_claim: ['Succeeded'] })
    && idx('Insert_claim') < idx('Increment_noticesSent') && idx('Increment_noticesSent') < idx('Send_alert_email') && incs.every((x) => x.action.inputs.value === 1) && incs.map((x) => x.action.inputs.name).sort().join() === 'claimFailures,errors,noticesSent');
  ok(`the cap is ${MAX_NOTICES_PER_RUN} per run and is checked BEFORE the claim: Set_proceed is the first action of the loop, Gate_prepare runs only when it is yes`, MAX_NOTICES_PER_RUN === 5 && Object.keys(byName[LOOP]?.action.actions || {})[0] === 'Set_proceed'
    && byName.Set_proceed?.action.inputs.value === `@{if(less(variables('noticesSent'), ${MAX_NOTICES_PER_RUN}), 'yes', 'no')}` && JSON.stringify(byName.Gate_prepare?.action.expression) === JSON.stringify(eq(v('proceed'), 'yes')));
  const still = byName.Check_obligation_still_due?.action.expression;
  ok('the obligation is read again before the claim: it must still be Open and have the same due date', JSON.stringify(still ?? '').includes('Get_obligation_before_claim') && JSON.stringify(still ?? '').includes(String(OBLIGATION_STATUS.Open)) && idx('Get_obligation_before_claim') < idx('Insert_claim'));

  // the email
  const mail = byName.Send_alert_email?.action.inputs.parameters;
  ok('the email is informational: the subject starts with the prefix of the variant, the body says that nothing was changed and that nobody has to answer, and it links the obligation',
    !!mail && mail[emailKey('Subject')].startsWith(variant.subjectPrefix) && (variant.subjectPrefix === '' ? !mail[emailKey('Subject')].startsWith('[') : true) && /Nothing was changed/.test(mail[emailKey('Body')]) && /nobody has to answer/.test(mail[emailKey('Body')]) && mail[emailKey('Body')].includes('etn=mwf_obligation'));

  // the evaluated subset, connection references, size, text
  // every STRING of these actions is parsed on its own (a joined text would hide a plain @expression); the guard is the one STORED in the definition
  const evaluated = ['Set_alertType', 'Set_alertKey', 'Set_proceed', 'Get_open_obligations', 'Gate_guard'].flatMap((n) => strs({ i: byName[n]?.action.inputs, e: byName[n]?.action.expression }));
  const used = new Set(); evaluated.forEach((s) => functionNames(s).forEach((f) => used.add(f)));
  ok('the expressions that the offline tests evaluate use only functions of the small evaluator (and there are some: the check is not vacuous)', used.size >= 10 && [...used].every((f) => SUPPORTED_FUNCTIONS.includes(f)), [...used].filter((f) => !SUPPORTED_FUNCTIONS.includes(f)).join(', '));
  ok('both connection references are named by logical name and bound to their connectors', refs.shared_commondataserviceforapps?.connection?.connectionReferenceLogicalName === dataverseRef && refs.shared_office365?.connection?.connectionReferenceLogicalName === outlookRef);
  ok(`nesting depth is at most ${LIMITS.maxDepth} (Power Automate limit, Learn limits-and-config)`, stats.depth <= LIMITS.maxDepth, `depth ${stats.depth}`);
  ok(`at most ${LIMITS.maxActions} actions`, stats.actions <= LIMITS.maxActions, `${stats.actions} actions`);
  ok('no email address and no id (GUID) in the definition', !/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text.replace(/@\{|@[A-Za-z]+\(/g, '')) && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text));
  ok('the placeholder <ORG_HOST> is the only host in the definition', !/dynamics\.com/.test(text) && text.includes('<ORG_HOST>'));
  return { results, list, stats };
}

// ------------------------------------------------------------------------------------------------ the numbered action list and the plan
/** The action names in the order of the definition, with their depth: what the spec section 4 lists. */
export function actionOutline(cd) { return walk(cd.properties.definition.actions).map((x) => ({ name: x.name, type: x.action.type, operation: x.action.inputs?.host?.operationId || '', depth: x.scope.length })); }

export function planLines(variant, refs = {}) {
  const cd = buildClientdata(variant, refs); const s = statsOf(cd); const checks = checkClientdata(cd, variant, refs).results; const failed = checks.filter((r) => !r.pass).length;
  const L = [];
  L.push(`PLAN (offline, nothing is sent, no environment is read). Flow: ${FLOW_NAME}. Variant: ${variant.name}.`);
  L.push(`PARAMETERS  interval ${variant.intervalMinutes} min, lead time ${variant.leadMinutes} min, lookback window ${variant.lookbackMinutes} min${variant.name === 'test' ? '  (TEST CONSTANTS, not business values)' : '  (given by the caller; no default exists)'}; cap ${MAX_NOTICES_PER_RUN} successful claims per run; subject prefix ${variant.subjectPrefix ? JSON.stringify(variant.subjectPrefix) : 'none'}`);
  L.push(`WINDOW      Open obligations with  runStart - ${variant.lookbackMinutes} min <= due date <= runStart + ${variant.leadMinutes} min  (server side, oldest due date first, at most 50)`);
  L.push(`FILTER      ${queryFilter(variant)}`);
  L.push(`COST        an obligation overdue for longer than ${variant.lookbackMinutes} minutes because the flow was down never gets its alert; no column records that`);
  L.push(`KEY         ${KEY_EXPRESSION}`);
  L.push(`TYPE        ${TYPE_EXPRESSION}`);
  L.push(`GUARD       recipient not empty, key not empty, key length ${KEY_LENGTHS.join(' or ')}, key contains -<alertType>-  (else: Increment_errors, nothing inserted, nothing sent)`);
  L.push(`CLAIM       Insert_claim (CreateRecord, mwf_alertlogs); Increment_noticesSent and Send_alert_email only after it Succeeded; Compose_claim_failure + Increment_claimFailures after Failed/TimedOut`);
  L.push(`SIZE        ${s.actions} actions, nesting depth ${s.depth} (REAL numbers from the generated definition; limits ${LIMITS.maxActions} and ${LIMITS.maxDepth})`);
  L.push(`CHECKS      ${checks.length - failed} of ${checks.length} structural checks pass${failed ? ` (${failed} FAILED: run --mode=check)` : ''}`);
  L.push('NUMBERED ACTIONS (as the spec, section 4, lists them)');
  actionOutline(cd).forEach((a, i) => L.push(`  ${String(i + 1).padStart(2)}. ${'  '.repeat(a.depth)}${a.name}  [${a.operation || a.type}]`));
  L.push('NOT IN THIS GENERATOR  a replace mode: an existing flow is never changed by this script. check and plan make no network call; create and verify need --env, --auth=az and --solution. The flow exists (created OFF on 2026-11-03, verified identical to the generated definition).');
  return L;
}

// ------------------------------------------------------------------------------------------------ command line
function printResults(variant, results) {
  console.log(`--- variant ${variant.name}`);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`SUMMARY (${variant.name}): ${results.length - bad} passed, ${bad} failed.\n`);
  return bad;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;   // false when a unit test imports this file
// The command line is a function started AFTER this module has been evaluated: the online modes import lib/obligation-flow-deploy.mjs, which imports this module, and a
// top-level await here would wait for that import while the import waits for this module (a deadlock).
async function main() {
  const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
  const has = (f) => process.argv.includes(f);
  const MODE = argOf('mode');
  const MODES = ['check', 'plan', 'create', 'verify'];
  if (!MODES.includes(MODE)) { console.error(`${MODE ? `--mode=${MODE} does not exist in this generator: ` : ''}only --mode=${MODES.join('|')} exist. There is no replace mode. Nothing was run.`); process.exit(2); }
  const online = MODE === 'create' || MODE === 'verify';
  const which = argOf('variant') || 'test';
  if (!['test', 'production', 'both'].includes(which)) { console.error('Invalid --variant=test|production|both. Nothing was run.'); process.exit(2); }
  const refs = { outlookRef: argOf('outlook-ref') || DEFAULT_OUTLOOK_REF, dataverseRef: argOf('dataverse-ref') || DEFAULT_DATAVERSE_REF };
  try { assertLogicalName(refs.outlookRef); assertLogicalName(refs.dataverseRef); } catch (e) { console.error(`${e.message}. Nothing was run.`); process.exit(2); }

  if (online) {
    const { createPreflight, dryRunLines, runCreate, runVerify, SOLUTION_NAME } = await import('./lib/obligation-flow-deploy.mjs');
    const SOLUTION = argOf('solution');
    const why = MODE === 'create' ? createPreflight({ variant: which, solution: SOLUTION }) : [];
    if (MODE === 'verify') { if (which !== 'test') why.push('verify compares with the test variant; --variant must be test'); if (!SOLUTION) why.push('--solution=<unique name of the unmanaged solution> is required; there is no default'); else if (!SOLUTION_NAME.test(SOLUTION)) why.push('--solution is not a valid solution unique name'); }
    if (why.length) { console.error(`REFUSED (exit 2). ${why.join('; ')}. Nothing was run.`); process.exit(2); }
    if (MODE === 'create' && (!has('--confirm-mutates-environment') || has('--dry-run'))) {
      console.log(dryRunLines({ solution: SOLUTION, refs, variant: testVariant() }).join('\n'));
      console.log("\nNothing was sent. To create the row (OFF) add --env=https://<org>.crm4.dynamics.com --auth=az and --confirm-mutates-environment (the owner's Azure CLI sign-in is used). The flow already exists (created OFF on 2026-11-03): a real run would stop at the guard 'no flow of this name exists'.");
      process.exit(0);
    }
    if (argOf('auth') !== 'az') { console.error("REFUSED (exit 2). --auth=az is required (the owner's Azure CLI sign-in is the only accepted sign-in). Nothing was run."); process.exit(2); }
    const { parseArgs, openSession, noGuid } = await import('./lib/dv-session.mjs');
    const { requireStableConnection } = await import('./lib/counter-snapshot.mjs');
    const { expectContractsOrExit } = await import('./lib/expect-contracts.mjs');
    const { env: ENV } = parseArgs(process.argv);
    const EXPECT = expectContractsOrExit();
    try {
      const S = await openSession({ env: ENV, auth: 'az' });
      await requireStableConnection(S.call);
      const common = { call: S.call, solution: SOLUTION, host: new URL(ENV).host, refs, log: (l) => console.log(noGuid(l)) };
      if (MODE === 'verify') { const r = await runVerify(common); process.exit(r.ok ? 0 : r.stopped ? 4 : 1); }
      const r = await runCreate({ ...common, expectContracts: EXPECT.value, gate: () => requireStableConnection(S.call, { need: 3, maxAttempts: 6, pauseMs: 1500 }) });
      process.exit(r.ok ? 0 : r.unknown ? 5 : r.stopped ? 4 : 1);
    } catch (e) { console.error(`\nSTOPPED: ${noGuid(e.message)}`); process.exit(4); }
  }

  const variants = [];
  try {
    if (which !== 'production') variants.push(testVariant());
    if (which !== 'test') variants.push(productionVariant({ intervalMinutes: argOf('interval-minutes'), leadMinutes: argOf('lead-minutes'), lookbackMinutes: argOf('lookback-minutes') }));
  } catch (e) { console.error(`${e.message}. Nothing was emitted.`); process.exit(2); }
  let bad = 0;
  for (const variant of variants) {
    if (MODE === 'plan') { for (const l of planLines(variant, refs)) console.log(l); console.log(''); }
    else bad += printResults(variant, checkClientdata(buildClientdata(variant, refs), variant, refs).results);
  }
  process.exit(bad ? 1 : 0);
}
if (isMain) main();
