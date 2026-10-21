#!/usr/bin/env node
/**
 * Creates the two tables of the approval chain (ADR-007) in the solution, and corrects two ApprovalMatrix column descriptions.
 * Idempotent: existing objects are only read back, never modified (except the two descriptions, which are updated only when they differ).
 * Any error stops the script with the full message. Nothing is retried automatically.
 *
 *   mwf_approvalstep ("Approval Step"), Organization-owned, no notes, no activities. One row per step of the chain of one approval round.
 *     mwf_name (primary), mwf_contract (lookup to mwf_contract, DELETE CASCADE: deleting a contract deletes its steps),
 *     mwf_approvalround (Whole Number), mwf_steporder (Whole Number), mwf_approverrole (Choice, values as in ApprovalMatrix),
 *     mwf_actiontype (Choice: Approve, Inform), mwf_decision (Choice: Pending, Waiting, Approved, Rejected, Informed, Cancelled),
 *     mwf_originalapprover and mwf_actualapprover (lookups to systemuser, remove-link on delete), mwf_decidedon (Date and Time),
 *     mwf_comments (multiple lines), mwf_delegated (Yes/No, default No).
 *     Alternate key mwf_ApprovalStepKey on (mwf_contract, mwf_approvalround, mwf_steporder): no duplicate step in a round.
 *     (A Lookup is a valid alternate key column type: Microsoft Learn, "Work with alternate keys". So no text key column is needed.)
 *
 *   mwf_approverassignment ("Approver Assignment"), Organization-owned. Role -> user, read by the flow when a step starts.
 *     mwf_name (primary), mwf_approverrole (Choice), mwf_user (lookup to systemuser, remove-link on delete).
 *     Alternate key mwf_ApproverAssignmentKey on mwf_approverrole: one row per role (active or not; to change the approver, update the row).
 *
 *   ApprovalMatrix: mwf_minvalueusd -> "lower bound of the value band, exclusive"; mwf_maxvalueusd -> "upper bound, inclusive; empty means no upper limit".
 *
 * Usage:
 *   node scripts/create-approval-chain-tables.mjs --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment [--auth=device|az] [--solution=Muwafaqa]
 *
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
import { parseArgs, openSession, noGuid, sleep, label, req, Stop } from './lib/dv-session.mjs';

const { argOf, env: ENV, auth: AUTH, has } = parseArgs();
const SOLUTION = argOf('solution') || 'Muwafaqa';
if (!has('--confirm-mutates-environment')) {
  console.error(`WARNING: create-approval-chain-tables.mjs creates two tables, their columns, relationships and keys in the environment and the solution ${SOLUTION}, and updates two ApprovalMatrix column descriptions. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
  process.exit(2);
}

const SOL = { 'MSCRM.SolutionUniqueName': SOLUTION };
const ROLES = { 'Department Head': 867640000, 'Finance Manager': 867640001, 'General Manager': 867640002, 'Regional Office': 867640003, Owner: 867640004 };
const ACTIONS = { Approve: 867640000, Inform: 867640001 };
const DECISIONS = { Pending: 867640000, Waiting: 867640001, Approved: 867640002, Rejected: 867640003, Informed: 867640004, Cancelled: 867640005 };
const NO_CASCADE = { Assign: 'NoCascade', Merge: 'NoCascade', Reparent: 'NoCascade', Share: 'NoCascade', Unshare: 'NoCascade', RollupView: 'NoCascade' };

const MIN_DESC = 'lower bound of the value band, exclusive';
const MAX_DESC = 'upper bound, inclusive; empty means no upper limit';

const picklist = (schema, name, desc, options, required) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata', SchemaName: schema, LogicalName: schema.toLowerCase(),
  DisplayName: label(name), Description: label(desc), RequiredLevel: req(required),
  OptionSet: { '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata', IsGlobal: false, OptionSetType: 'Picklist',
    Options: Object.entries(options).map(([l, v]) => ({ Value: v, Label: label(l) })) },
});
const integer = (schema, name, desc, min, required) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata', SchemaName: schema, LogicalName: schema.toLowerCase(),
  DisplayName: label(name), Description: label(desc), RequiredLevel: req(required), Format: 'None', MinValue: min, MaxValue: 2147483647,
});

(async () => {
  try {
    const { call, must, msgOf } = await openSession({ env: ENV, auth: AUTH });
    const sol = (await must('GET', `solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid,ismanaged`)).j.value;
    if (sol.length !== 1 || sol[0].ismanaged) throw new Stop(`solution ${SOLUTION}: expected 1 unmanaged solution, found ${sol.length}${sol[0]?.ismanaged ? ' (managed)' : ''}`);

    async function waitFor(fn, what, tries = 15) {
      for (let i = 0; i < tries; i++) { if (await fn()) return; await sleep(2000); }
      throw new Stop(`${what} was created but is not readable after ${tries * 2} s.`);
    }

    async function ensureTable(logical, schema, name, plural, desc, primaryDesc) {
      const t = await call('GET', `EntityDefinitions(LogicalName='${logical}')?$select=LogicalName,OwnershipType`);
      if (t.ok) { console.log(`SKIP     table ${logical} (exists, ${t.j.OwnershipType})`); return; }
      if (t.status !== 404) throw new Stop(`could not check table ${logical}: HTTP ${t.status} ${msgOf(t)}`);
      await must('POST', 'EntityDefinitions', {
        '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata', SchemaName: schema,
        DisplayName: label(name), DisplayCollectionName: label(plural), Description: label(desc),
        OwnershipType: 'OrganizationOwned', IsActivity: false, HasActivities: false, HasNotes: false,
        Attributes: [{
          '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' },
          SchemaName: `${schema.split('_')[0]}_Name`, DisplayName: label('Name'), Description: label(primaryDesc),
          RequiredLevel: req('ApplicationRequired'), FormatName: { Value: 'Text' }, MaxLength: 200, IsPrimaryName: true,
        }],
      }, SOL);
      console.log(`CREATED  table ${logical}`);
      await waitFor(async () => (await call('GET', `EntityDefinitions(LogicalName='${logical}')?$select=LogicalName`)).ok, `table ${logical}`);
    }

    async function ensureColumn(table, logical, body) {
      const ex = await call('GET', `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${logical}')?$select=LogicalName,AttributeType`);
      if (ex.ok) { console.log(`SKIP     column ${table}.${logical} (exists, ${ex.j.AttributeType})`); return; }
      if (ex.status !== 404) throw new Stop(`could not check column ${logical}: HTTP ${ex.status} ${msgOf(ex)}`);
      await must('POST', `EntityDefinitions(LogicalName='${table}')/Attributes`, body, SOL);
      console.log(`CREATED  column ${table}.${logical}`);
    }

    async function ensureLookup(table, logical, referenced, relSchema, lookupSchema, name, desc, required, deleteBehavior) {
      const ex = await call('GET', `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${logical}')?$select=LogicalName,AttributeType`);
      if (ex.ok) { console.log(`SKIP     lookup ${table}.${logical} (exists, ${ex.j.AttributeType})`); return; }
      if (ex.status !== 404) throw new Stop(`could not check lookup ${logical}: HTTP ${ex.status} ${msgOf(ex)}`);
      await must('POST', 'RelationshipDefinitions', {
        '@odata.type': 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata', SchemaName: relSchema,
        ReferencedEntity: referenced, ReferencingEntity: table,
        CascadeConfiguration: { ...NO_CASCADE, Delete: deleteBehavior },
        Lookup: { '@odata.type': 'Microsoft.Dynamics.CRM.LookupAttributeMetadata', SchemaName: lookupSchema, DisplayName: label(name), Description: label(desc), RequiredLevel: req(required) },
      }, SOL);
      console.log(`CREATED  lookup ${table}.${logical} -> ${referenced} (delete: ${deleteBehavior})`);
    }

    async function ensureKey(table, keySchema, name, attrs) {
      const keys = (await must('GET', `EntityDefinitions(LogicalName='${table}')/Keys?$select=SchemaName,KeyAttributes`)).j.value;
      if (keys.some((k) => k.SchemaName === keySchema)) console.log(`SKIP     key ${keySchema} (exists)`);
      else {
        await must('POST', `EntityDefinitions(LogicalName='${table}')/Keys`, { SchemaName: keySchema, DisplayName: label(name), KeyAttributes: attrs }, SOL);
        console.log(`CREATED  key ${keySchema} on (${attrs.join(', ')})`);
      }
      let status = null;
      for (let i = 0; i < 40; i++) {
        const k = (await must('GET', `EntityDefinitions(LogicalName='${table}')/Keys?$select=SchemaName,EntityKeyIndexStatus`)).j.value.find((x) => x.SchemaName === keySchema);
        status = k?.EntityKeyIndexStatus;
        if (status === 'Active') break;
        if (status === 'Failed') throw new Stop(`The alternate key index ${keySchema} failed.`);
        await sleep(3000);
      }
      if (status !== 'Active') throw new Stop(`The alternate key ${keySchema} is not Active yet (status ${status}). Rerun the script later; it is idempotent.`);
      console.log(`PASS     key ${keySchema} index status Active`);
    }

    // ---- A. mwf_approvalstep
    await ensureTable('mwf_approvalstep', 'mwf_ApprovalStep', 'Approval Step', 'Approval Steps',
      'One row per step of the approval chain of one contract and one approval round. Built by the plug-in when the contract is submitted; updated by the approval flow. No user privileges.',
      'Short text for people, for example the contract subject and the step order.');
    await ensureLookup('mwf_approvalstep', 'mwf_contract', 'mwf_contract', 'mwf_contract_approvalstep', 'mwf_Contract', 'Contract', 'The contract this step belongs to. Deleting the contract deletes its steps.', 'ApplicationRequired', 'Cascade');
    await ensureColumn('mwf_approvalstep', 'mwf_approvalround', integer('mwf_ApprovalRound', 'Approval Round', 'The approval round of the contract this step belongs to (the value of the contract approval round when the chain was built).', 1, 'ApplicationRequired'));
    await ensureColumn('mwf_approvalstep', 'mwf_steporder', integer('mwf_StepOrder', 'Step Order', 'Position of this step within the chain of the round (1 = first).', 1, 'ApplicationRequired'));
    await ensureColumn('mwf_approvalstep', 'mwf_approverrole', picklist('mwf_ApproverRole', 'Approver Role', 'The role that approves or is informed at this step. Same values as the role in the ApprovalMatrix.', ROLES, 'ApplicationRequired'));
    await ensureColumn('mwf_approvalstep', 'mwf_actiontype', picklist('mwf_ActionType', 'Action Type', 'Approve waits for the decision; Inform creates an approval request without waiting.', ACTIONS, 'ApplicationRequired'));
    await ensureColumn('mwf_approvalstep', 'mwf_decision', picklist('mwf_Decision', 'Decision', 'State of the step: Pending (not started), Waiting (request sent), Approved, Rejected, Informed (Inform step sent), Cancelled.', DECISIONS, 'ApplicationRequired'));
    await ensureLookup('mwf_approvalstep', 'mwf_originalapprover', 'systemuser', 'mwf_approvalstep_originalapprover', 'mwf_OriginalApprover', 'Original Approver', 'The user the step was assigned to (from the Approver Assignment of the role).', 'None', 'RemoveLink');
    await ensureLookup('mwf_approvalstep', 'mwf_actualapprover', 'systemuser', 'mwf_approvalstep_actualapprover', 'mwf_ActualApprover', 'Actual Approver', 'The user who answered the step. Differs from the original approver after a delegation.', 'None', 'RemoveLink');
    await ensureColumn('mwf_approvalstep', 'mwf_decidedon', {
      '@odata.type': 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata', SchemaName: 'mwf_DecidedOn', LogicalName: 'mwf_decidedon',
      DisplayName: label('Decided On'), Description: label('When the step was answered (the completion time of the approval).'),
      RequiredLevel: req('None'), Format: 'DateAndTime', DateTimeBehavior: { Value: 'UserLocal' },
    });
    await ensureColumn('mwf_approvalstep', 'mwf_comments', {
      '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata', AttributeType: 'Memo', AttributeTypeName: { Value: 'MemoType' },
      SchemaName: 'mwf_Comments', LogicalName: 'mwf_comments', DisplayName: label('Comments'), Description: label('The approver comments, copied from the approval response.'),
      RequiredLevel: req('None'), Format: 'TextArea', MaxLength: 4000,
    });
    await ensureColumn('mwf_approvalstep', 'mwf_delegated', {
      '@odata.type': 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata', SchemaName: 'mwf_Delegated', LogicalName: 'mwf_delegated',
      DisplayName: label('Delegated'), Description: label('Yes if the step was answered by someone other than the original approver (Phase 3).'),
      RequiredLevel: req('None'), DefaultValue: false,
      OptionSet: { '@odata.type': 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata', TrueOption: { Value: 1, Label: label('Yes') }, FalseOption: { Value: 0, Label: label('No') } },
    });
    await ensureKey('mwf_approvalstep', 'mwf_ApprovalStepKey', 'Approval Step Key', ['mwf_contract', 'mwf_approvalround', 'mwf_steporder']);

    // ---- B. mwf_approverassignment
    await ensureTable('mwf_approverassignment', 'mwf_ApproverAssignment', 'Approver Assignment', 'Approver Assignments',
      'Maps an approver role to a user. Read by the approval flow when a step starts. One row per role. No user privileges to write.',
      'Short text for people, for example the role name.');
    await ensureColumn('mwf_approverassignment', 'mwf_approverrole', picklist('mwf_ApproverRole', 'Approver Role', 'The role this row assigns. Same values as the role in the ApprovalMatrix. One row per role (alternate key).', ROLES, 'ApplicationRequired'));
    await ensureLookup('mwf_approverassignment', 'mwf_user', 'systemuser', 'mwf_approverassignment_user', 'mwf_User', 'User', 'The user who approves for this role.', 'ApplicationRequired', 'RemoveLink');
    await ensureKey('mwf_approverassignment', 'mwf_ApproverAssignmentKey', 'Approver Assignment Key', ['mwf_approverrole']);

    // ---- C. ApprovalMatrix descriptions
    let published = false;
    for (const [logical, text] of [['mwf_minvalueusd', MIN_DESC], ['mwf_maxvalueusd', MAX_DESC]]) {
      const url = `EntityDefinitions(LogicalName='mwf_approvalmatrix')/Attributes(LogicalName='${logical}')/Microsoft.Dynamics.CRM.DecimalAttributeMetadata`;
      const cur = (await must('GET', url)).j;
      const now = cur.Description?.UserLocalizedLabel?.Label ?? '';
      if (now === text) { console.log(`SKIP     description of ${logical} (already correct)`); continue; }
      const body = { ...cur }; delete body['@odata.context']; body.Description = label(text);
      await must('PUT', `EntityDefinitions(LogicalName='mwf_approvalmatrix')/Attributes(LogicalName='${logical}')/Microsoft.Dynamics.CRM.DecimalAttributeMetadata`, body, { ...SOL, 'MSCRM.MergeLabels': 'true' });
      console.log(`UPDATED  description of ${logical}`);
      published = true;
    }
    if (published) {
      await must('POST', 'PublishXml', { ParameterXml: '<importexportxml><entities><entity>mwf_approvalmatrix</entity></entities></importexportxml>' });
      console.log('PUBLISHED mwf_approvalmatrix');
    }
    console.log('\nDONE. Run scripts/verify-approval-chain-schema.mjs for the read-back.');
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
