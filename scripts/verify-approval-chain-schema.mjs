#!/usr/bin/env node
/**
 * Read-back of the approval-chain schema (ADR-007): mwf_approvalstep, mwf_approverassignment, and the ApprovalMatrix descriptions.
 * Prints PASS / FAIL / OBS. Read only by default. No id, address or token is printed; the approver rows are checked by counts.
 *
 *   S1  columns: logical name, type, required level of every expected column of both tables
 *   S2  Choice columns: option values (local option sets, values as the ApprovalMatrix)
 *   S3  lookups: target table and DELETE behaviour in the relationship metadata (contract: Cascade, systemuser: RemoveLink)
 *   S4  alternate keys: columns and index status Active
 *   S5  Approver Assignment rows: 5, one per role, Active, each with a user, distinct users counted (no identity printed)
 *   S6  ApprovalMatrix: the two corrected descriptions
 *   S7  solution membership of both tables
 *   S8  what the project roles (roles that are NOT managed) hold on the two tables, against the design of ADR-008 (lib/security-roles.mjs), by privilege name:
 *       steps: Read only, for Approver, Finance and Admin; assignments: Read for Finance, all six for Admin; Requester nothing; no Assign / Share; no other project role.
 *       Depth is checked by create-security-roles --mode=verify. Managed platform roles are listed by name only (OBS)
 *   S9  (only with --cascade-test) live test of the relationship and the key, on FICTIONAL rows named TEST-TMP-STEP*:
 *       a Draft contract + 2 steps; a duplicate (contract, round, order) is rejected; deleting the contract deletes its steps;
 *       counters are snapshotted first and restored by the rule of scripts/lib/counter-snapshot.mjs; everything created is deleted.
 *
 * Usage:
 *   node scripts/verify-approval-chain-schema.mjs --env=https://<org>.crm4.dynamics.com [--auth=device|az] [--solution=Muwafaqa]
 *   node scripts/verify-approval-chain-schema.mjs --env=... --cascade-test --confirm-mutates-environment
 *   node scripts/verify-approval-chain-schema.mjs --env=... --mode=cleanup --confirm-mutates-environment   (after a crashed S9)
 */
import { parseArgs, openSession, noGuid, Stop } from './lib/dv-session.mjs';
import { snapshotCounters, restoreCounters, requireStableConnection } from './lib/counter-snapshot.mjs';
import { approvalFlowState, describeFlowState, deleteContracts } from './lib/contract-cleanup.mjs';
import { enterCleanupPhase } from './lib/resilient-fetch.mjs';
import { expectContractsOrExit, describeExpectContracts } from './lib/expect-contracts.mjs';
import { compareProjectRolesOnTables } from './lib/security-roles.mjs';

const { argOf, env: ENV, auth: AUTH, has } = parseArgs();
const SOLUTION = argOf('solution') || 'Muwafaqa';
const MODE = argOf('mode') || 'verify';
const EXPECT_CONTRACTS = expectContractsOrExit();   // contracts expected in the starting and the final state (argument, variable or default 11)
console.log(describeExpectContracts(EXPECT_CONTRACTS));
const CASCADE = has('--cascade-test');
const PREFIX = 'TEST-TMP-STEP';
const q = encodeURIComponent;
if (!['verify', 'cleanup'].includes(MODE)) { console.error('Invalid --mode=verify|cleanup. Nothing was run.'); process.exit(2); }
if ((CASCADE || MODE === 'cleanup') && !has('--confirm-mutates-environment')) {
  console.error(`WARNING: --cascade-test and --mode=cleanup create or delete ${PREFIX}* rows and temporarily write the contract number counters. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
  process.exit(2);
}

const ROLES = { 'Department Head': 867640000, 'Finance Manager': 867640001, 'General Manager': 867640002, 'Regional Office': 867640003, Owner: 867640004 };
const EXPECT = {
  mwf_approvalstep: {
    columns: { mwf_name: ['String', 'ApplicationRequired'], mwf_contract: ['Lookup', 'ApplicationRequired'], mwf_approvalround: ['Integer', 'ApplicationRequired'], mwf_steporder: ['Integer', 'ApplicationRequired'],
      mwf_approverrole: ['Picklist', 'ApplicationRequired'], mwf_actiontype: ['Picklist', 'ApplicationRequired'], mwf_decision: ['Picklist', 'ApplicationRequired'],
      mwf_originalapprover: ['Lookup', 'None'], mwf_actualapprover: ['Lookup', 'None'], mwf_decidedon: ['DateTime', 'None'], mwf_comments: ['Memo', 'None'], mwf_delegated: ['Boolean', 'None'],
      mwf_remindedon: ['DateTime', 'None'], mwf_escalatedon: ['DateTime', 'None'] },   // the last two: ADR-010, created 2026-10-26
    options: { mwf_approverrole: ROLES, mwf_actiontype: { Approve: 867640000, Inform: 867640001 },
      mwf_decision: { Pending: 867640000, Waiting: 867640001, Approved: 867640002, Rejected: 867640003, Informed: 867640004, Cancelled: 867640005 } },
    lookups: { mwf_contract: ['mwf_contract', 'Cascade'], mwf_originalapprover: ['systemuser', 'RemoveLink'], mwf_actualapprover: ['systemuser', 'RemoveLink'] },
    key: ['mwf_ApprovalStepKey', ['mwf_contract', 'mwf_approvalround', 'mwf_steporder']],
  },
  mwf_approverassignment: {
    columns: { mwf_name: ['String', 'ApplicationRequired'], mwf_approverrole: ['Picklist', 'ApplicationRequired'], mwf_user: ['Lookup', 'ApplicationRequired'] },
    options: { mwf_approverrole: ROLES },
    lookups: { mwf_user: ['systemuser', 'RemoveLink'] },
    key: ['mwf_ApproverAssignmentKey', ['mwf_approverrole']],
  },
};

const results = [];
const out = (id, status, name, detail = '') => { results.push({ id, status }); console.log(`${status.padEnd(4)}  ${id.padEnd(4)} ${name}${detail ? `  [${detail}]` : ''}`); };
const check = (id, name, ok, detail) => out(id, ok ? 'PASS' : 'FAIL', name, detail);

(async () => {
  let S;
  try {
    S = await openSession({ env: ENV, auth: AUTH });
    const { call, must, io, msgOf } = S;
    await requireStableConnection(call);

    if (MODE === 'cleanup') { await cleanup(S); return; }

    // ---- S1-S4 per table
    for (const [table, ex] of Object.entries(EXPECT)) {
      const md = (await must('GET', `EntityDefinitions(LogicalName='${table}')?$select=OwnershipType,EntitySetName,HasNotes,HasActivities`)).j;
      check('S0', `${table}: Organization-owned, no notes, no activities`, md.OwnershipType === 'OrganizationOwned' && !md.HasNotes && !md.HasActivities, md.OwnershipType);
      const attrs = (await must('GET', `EntityDefinitions(LogicalName='${table}')/Attributes?$select=LogicalName,AttributeType,RequiredLevel`)).j.value;
      const by = Object.fromEntries(attrs.map((a) => [a.LogicalName, a]));
      for (const [c, [type, level]] of Object.entries(ex.columns)) {
        const a = by[c];
        check('S1', `${table}.${c}`, !!a && a.AttributeType === type && a.RequiredLevel.Value === level, a ? `${a.AttributeType}, ${a.RequiredLevel.Value}` : 'missing');
      }
      for (const [c, want] of Object.entries(ex.options)) {
        const p = (await must('GET', `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${c}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options,IsGlobal)`)).j.OptionSet;
        const got = Object.fromEntries(p.Options.map((o) => [o.Label?.UserLocalizedLabel?.Label, o.Value]));
        check('S2', `${table}.${c} options (local, ${Object.keys(want).length} values)`, !p.IsGlobal && JSON.stringify(got) === JSON.stringify(want), p.IsGlobal ? 'GLOBAL' : `${Object.keys(got).length} values`);
      }
      const dflt = table === 'mwf_approvalstep'
        ? (await must('GET', `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='mwf_delegated')/Microsoft.Dynamics.CRM.BooleanAttributeMetadata?$select=DefaultValue`)).j.DefaultValue : null;
      if (dflt !== null) check('S1', `${table}.mwf_delegated default is No`, dflt === false, String(dflt));
      const rels = (await must('GET', `EntityDefinitions(LogicalName='${table}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,CascadeConfiguration`)).j.value;
      for (const [c, [target, del]] of Object.entries(ex.lookups)) {
        const r = rels.find((x) => x.ReferencingAttribute === c);
        const cc = r?.CascadeConfiguration;
        check('S3', `${table}.${c} -> ${target}, delete ${del}`, !!r && r.ReferencedEntity === target && cc.Delete === del && cc.Assign === 'NoCascade' && cc.Share === 'NoCascade' && cc.Reparent === 'NoCascade',
          r ? `${r.ReferencedEntity}, delete ${cc.Delete}, assign ${cc.Assign}, share ${cc.Share}, reparent ${cc.Reparent}` : 'missing');
      }
      const key = (await must('GET', `EntityDefinitions(LogicalName='${table}')/Keys?$select=SchemaName,KeyAttributes,EntityKeyIndexStatus`)).j.value.find((k) => k.SchemaName === ex.key[0]);
      check('S4', `${table} key ${ex.key[0]} on (${ex.key[1].join(', ')}), index Active`, !!key && JSON.stringify([...key.KeyAttributes].sort()) === JSON.stringify([...ex.key[1]].sort()) && key.EntityKeyIndexStatus === 'Active', key ? `${key.KeyAttributes.length} column(s), ${key.EntityKeyIndexStatus}` : 'missing');
    }

    // ---- S5 approver rows (counts only)
    const set = (await must('GET', "EntityDefinitions(LogicalName='mwf_approverassignment')?$select=EntitySetName")).j.EntitySetName;
    const rows = (await must('GET', `${set}?$select=mwf_approverrole,statecode,_mwf_user_value`)).j.value;
    check('S5', 'Approver Assignment: 5 rows, one per role, all Active, each with a user', rows.length === 5 && Object.values(ROLES).every((v) => rows.filter((r) => r.mwf_approverrole === v).length === 1) && rows.every((r) => r.statecode === 0 && r._mwf_user_value), `${rows.length} rows`);
    out('S5', 'OBS', 'distinct users behind the 5 roles (development: all roles to one test account)', String(new Set(rows.map((r) => r._mwf_user_value)).size));
    const usersOk = (await must('GET', `systemusers?$select=isdisabled&$filter=${q([...new Set(rows.map((r) => r._mwf_user_value))].map((u) => `systemuserid eq ${u}`).join(' or '))}`)).j.value;
    check('S5', 'the referenced user(s) exist and are enabled', usersOk.length === new Set(rows.map((r) => r._mwf_user_value)).size && usersOk.every((u) => u.isdisabled === false), `${usersOk.length} user(s)`);

    // ---- S6 matrix descriptions
    for (const [c, want] of [['mwf_minvalueusd', 'lower bound of the value band, exclusive'], ['mwf_maxvalueusd', 'upper bound, inclusive; empty means no upper limit']]) {
      const d = (await must('GET', `EntityDefinitions(LogicalName='mwf_approvalmatrix')/Attributes(LogicalName='${c}')?$select=LogicalName,Description`)).j.Description?.UserLocalizedLabel?.Label;
      check('S6', `ApprovalMatrix.${c} description`, d === want, d === want ? 'as decided' : 'differs');
    }

    // ---- S7 solution membership
    const sol = (await must('GET', `solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid`)).j.value;
    for (const table of Object.keys(EXPECT)) {
      const id = (await must('GET', `EntityDefinitions(LogicalName='${table}')?$select=MetadataId`)).j.MetadataId;
      const own = (await must('GET', `solutioncomponents?$filter=_solutionid_value eq ${sol[0].solutionid} and objectid eq ${id}&$select=componenttype`)).j.value;
      check('S7', `${table} is a component of the solution`, own.length >= 1, `${own.length} row(s)`);
    }

    // ---- S8 roles with a privilege on the tables
    const privs = await call('GET', `privileges?$select=name&$filter=${q("contains(name,'approvalstep') or contains(name,'approverassignment')")}`);
    if (!privs.ok) out('S8', 'OBS', 'privileges not read', `HTTP ${privs.status} ${msgOf(privs)}`);
    else {
      const roles = new Map(); let unread = 0;
      for (const p of privs.j.value) {
        const r = await call('GET', `privileges(${p.privilegeid})?$select=name&$expand=roleprivileges_association($select=name,ismanaged)`);
        if (!r.ok) { unread++; continue; }
        for (const role of r.j.roleprivileges_association || []) { const cur = roles.get(role.name) || { managed: role.ismanaged, n: 0, names: new Set() }; cur.n++; cur.names.add(p.name); roles.set(role.name, cur); }
      }
      const project = [...roles.entries()].filter(([, v]) => !v.managed);
      const verdict = compareProjectRolesOnTables(Object.fromEntries(project.map(([n, v]) => [n, [...v.names]])), Object.keys(EXPECT));
      const found = [...verdict.unknownRoles.map((r) => `unknown project role ${r}`), ...verdict.extra.map((x) => `extra ${x.role}: ${x.name}`), ...verdict.missing.map((x) => `missing ${x.role}: ${x.name}`)];
      check('S8', 'the project roles hold exactly the designed privileges on the two tables (ADR-008: steps Read only; Admin maintains the assignments; no Assign or Share)', unread === 0 && verdict.ok, `${privs.j.value.length} privileges read, ${unread} unread, ${project.length} project role(s) holding some${found.length ? '; ' + found.slice(0, 6).join('; ') : ''}`);
      out('S8', 'OBS', 'managed platform roles that hold privileges on the two tables (names only, as for the counter table, owner decision of ADR-006)', [...roles.keys()].join('; ') || 'none');
    }

    // ---- S9 live cascade test
    if (CASCADE) await cascadeTest(S);
    else out('S9', 'OBS', 'live cascade and duplicate-key test NOT run (needs --cascade-test)');

    const fail = results.filter((r) => r.status === 'FAIL').length;
    console.log(`\nSUMMARY: ${results.filter((r) => r.status === 'PASS').length} PASS, ${fail} FAIL, ${results.filter((r) => r.status === 'OBS').length} OBS.`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    if (CASCADE) console.error(`If rows were created, run: node scripts/verify-approval-chain-schema.mjs --env=<url> --auth=az --mode=cleanup --confirm-mutates-environment`);
    process.exit(4);
  }
})();

async function cascadeTest({ call, must, io, msgOf }) {
  const flow = await approvalFlowState(io);
  if (!flow.known || flow.on) throw new Stop(`The approval flow is not confirmed OFF (${describeFlowState(flow)}). Nothing was created.`);
  const pre = (await must('GET', `mwf_contracts?$select=mwf_contractid&$count=true&$top=1`)).j['@odata.count'];
  if (pre !== EXPECT_CONTRACTS.value) throw new Stop(`Expected ${EXPECT_CONTRACTS.value} contracts before the test (${EXPECT_CONTRACTS.source}), found ${pre}. Nothing was created.`);
  const snap = await snapshotCounters(io);
  const consumed = {}; let cp = null; let contract = null; let ok = false;
  try {
    const usd = (await must('GET', "transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0")).j.value;
    if (usd.length < 1) throw new Stop('No active USD currency found.');
    const opt = (await must('GET', "EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)")).j.OptionSet.Options[0].Value;
    cp = (await must('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} Fictional Counterparty (delete me)`, mwf_counterpartytype: opt })).id;
    const c = await call('POST', 'mwf_contracts?$select=mwf_contractnumber', {
      mwf_name: `${PREFIX}-1`, mwf_contracttype: 867640000, mwf_direction: 867640001, mwf_value: 1000,
      'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${cp})`, 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${usd[0].transactioncurrencyid})`,
    }, { Prefer: 'return=representation' });
    if (!c.ok) throw new Stop(`contract create failed HTTP ${c.status} ${msgOf(c)}`);
    contract = c.j.mwf_contractid; consumed[867640000] = 1;
    const step = (order, extra = {}) => call('POST', 'mwf_approvalsteps', {
      mwf_name: `${PREFIX} step ${order}`, 'mwf_Contract@odata.bind': `/mwf_contracts(${contract})`, mwf_approvalround: 1, mwf_steporder: order,
      mwf_approverrole: 867640000, mwf_actiontype: 867640000, mwf_decision: 867640000, ...extra });
    const s1 = await step(1); const s2 = await step(2, { mwf_actiontype: 867640001, mwf_approverrole: 867640004 });
    check('S9a', 'two steps created for one contract and round (orders 1 and 2)', s1.ok && s2.ok, `HTTP ${s1.status}/${s2.status}`);
    const dup = await step(2);
    check('S9b', 'duplicate (contract, round, order) rejected by the alternate key', !dup.ok, `HTTP ${dup.status} ${msgOf(dup).slice(0, 120)}`);
    const round2 = await step(2, { mwf_approvalround: 2 });
    check('S9c', 'same order in another round is accepted (the key includes the round)', round2.ok, `HTTP ${round2.status}`);
    const n1 = (await must('GET', `mwf_approvalsteps?$select=mwf_name&$filter=_mwf_contract_value eq ${contract}`)).j.value.length;
    check('S9d', '3 steps exist for the contract before the delete', n1 === 3, String(n1));
    enterCleanupPhase();
    const del = await deleteContracts(io, [contract]);
    check('S9e', 'the Draft contract is deleted', del.deleted === 1 && del.failed.length === 0, `${del.deleted} deleted, ${del.failed.length} failed`);
    const n2 = (await must('GET', `mwf_approvalsteps?$select=mwf_name&$filter=startswith(mwf_name,'${PREFIX}')`)).j.value.length;
    check('S9f', 'CASCADE: deleting the contract deleted all its steps', n2 === 0, `${n2} step(s) left`);
    contract = null; ok = true;
  } finally {
    enterCleanupPhase();
    if (contract) { const d = await deleteContracts(io, [contract]); console.log(`INFO  cleanup: contract delete ${d.deleted} ok, ${d.failed.length} failed`); }
    const left = (await call('GET', `mwf_approvalsteps?$select=mwf_name&$filter=startswith(mwf_name,'${PREFIX}')`)).j?.value || [];
    for (const s of left) await call('DELETE', `mwf_approvalsteps(${s.mwf_approvalstepid})`);
    if (cp) { const d = await call('DELETE', `mwf_counterparties(${cp})`); console.log(`INFO  cleanup: counterparty delete HTTP ${d.status}`); }
    const rs = await restoreCounters(io, snap, consumed);
    for (const l of rs.lines) console.log(`counter: ${l}`);
    const a = (await must('GET', `mwf_contracts?$select=mwf_contractid&$count=true&$top=1`)).j['@odata.count'];
    const b = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=startswith(mwf_name,'${PREFIX}')`)).j.value.length;
    const c2 = (await must('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=startswith(mwf_name,'${PREFIX}')`)).j.value.length;
    const s2 = (await must('GET', `mwf_approvalsteps?$select=mwf_name&$filter=startswith(mwf_name,'${PREFIX}')`)).j.value.length;
    check('S9g', 'clean after the test: ' + EXPECT_CONTRACTS.value + ' contracts, 0 TEST-TMP contracts, 0 temporary counterparties, 0 temporary steps, counters restored', ok && a === EXPECT_CONTRACTS.value && b === 0 && c2 === 0 && s2 === 0 && rs.refused === 0, `${a}/${b}/${c2}/${s2}, refused ${rs.refused}`);
  }
}

async function cleanup({ call, must, io }) {
  enterCleanupPhase();
  const contracts = (await must('GET', `mwf_contracts?$select=mwf_name&$filter=startswith(mwf_name,'${PREFIX}')`)).j.value;
  const del = await deleteContracts(io, contracts.map((r) => r.mwf_contractid));
  console.log(`INFO  cleanup: ${contracts.length} contract(s) found, ${del.deleted} deleted, ${del.failed.length} failed`);
  const steps = (await must('GET', `mwf_approvalsteps?$select=mwf_name&$filter=startswith(mwf_name,'${PREFIX}')`)).j.value;
  for (const s of steps) await call('DELETE', `mwf_approvalsteps(${s.mwf_approvalstepid})`);
  const cps = (await must('GET', `mwf_counterparties?$select=mwf_name&$filter=startswith(mwf_name,'${PREFIX}')`)).j.value;
  for (const c of cps) await call('DELETE', `mwf_counterparties(${c.mwf_counterpartyid})`);
  console.log(`INFO  cleanup: ${steps.length} step(s), ${cps.length} counterparty(ies) removed. Counters are NOT touched here: check them and restore with scripts/cleanup-test-rows.mjs rules if needed.`);
}
