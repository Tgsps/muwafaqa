#!/usr/bin/env node
/**
 * Approver Assignment (table mwf_approverassignment, ADR-007): check, load, validate. DEVELOPMENT assignment only.
 *
 * In development all five roles point to ONE test account. The account is NOT in the repository: it is read at run time from the
 * environment variable MWF_APPROVER_TEST_USER (the sign-in name or the user id of the test account). Its value, the resolved
 * user id and the address are never printed or written anywhere; only counts are.
 *
 * Modes:
 *   --mode=check     read only. The table, its columns and key exist; the variable is set; it resolves to exactly one enabled user; how many rows exist.
 *   --mode=load      creates one row per role that does not exist yet (looked up by role). Existing rows are never changed
 *                    (a row that points to a different user is only reported). MUTATES the environment: needs --confirm-mutates-environment. Idempotent.
 *   --mode=validate  read only. 5 rows, one per role, all Active, each with a user, and how many distinct users they point to (a count).
 *
 * Usage (PowerShell: $env:MWF_APPROVER_TEST_USER = '<test account>' first; bash: MWF_APPROVER_TEST_USER=... node ...):
 *   node scripts/load-approver-assignment.mjs --mode=check|load|validate --env=https://<org>.crm4.dynamics.com [--auth=device|az] [--confirm-mutates-environment]
 *
 * The rows are data: they do NOT travel with the solution. Run this script once per environment.
 */
import { parseArgs, openSession, noGuid, Stop } from './lib/dv-session.mjs';
import { USER_BIND_KEY } from './lib/assignment-columns.mjs';

const { argOf, env: ENV, auth: AUTH, has } = parseArgs();
const MODE = argOf('mode');
const VAR = 'MWF_APPROVER_TEST_USER';
const TABLE = 'mwf_approverassignment';
const ROLES = { 'Department Head': 867640000, 'Finance Manager': 867640001, 'General Manager': 867640002, 'Regional Office': 867640003, Owner: 867640004 };
if (!['check', 'load', 'validate'].includes(MODE)) { console.error('Missing or invalid --mode=check|load|validate. Nothing was run.'); process.exit(2); }
if (MODE === 'load' && !has('--confirm-mutates-environment')) {
  console.error('WARNING: --mode=load creates rows in the environment. Add --confirm-mutates-environment to run it on purpose. Nothing was run.');
  process.exit(2);
}

let bad = 0;
const check = (n, ok, v = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${v ? `: ${v}` : ''}`); if (!ok) bad++; };
const isGuid = (s) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);

(async () => {
  try {
    const { must } = await openSession({ env: ENV, auth: AUTH });

    const ent = (await must('GET', `EntityDefinitions(LogicalName='${TABLE}')?$select=EntitySetName,OwnershipType`)).j;
    check('table exists, Organization-owned', ent.OwnershipType === 'OrganizationOwned', ent.OwnershipType);
    const SET = ent.EntitySetName;
    const cols = (await must('GET', `EntityDefinitions(LogicalName='${TABLE}')/Attributes?$select=LogicalName,AttributeType`)).j.value.map((a) => a.LogicalName);
    check('columns mwf_name, mwf_approverrole, mwf_user', ['mwf_name', 'mwf_approverrole', 'mwf_user'].every((c) => cols.includes(c)), `${cols.length} columns in total`);
    const key = (await must('GET', `EntityDefinitions(LogicalName='${TABLE}')/Keys?$select=SchemaName,EntityKeyIndexStatus`)).j.value.find((k) => k.SchemaName === 'mwf_ApproverAssignmentKey');
    check('alternate key on the role is Active', key?.EntityKeyIndexStatus === 'Active', key?.EntityKeyIndexStatus ?? 'missing');

    const rows = (await must('GET', `${SET}?$select=mwf_name,mwf_approverrole,statecode,_mwf_user_value`)).j.value;
    console.log(`INFO  rows now: ${rows.length}`);

    if (MODE === 'validate') {
      check('5 rows', rows.length === 5, String(rows.length));
      check('one row per role', Object.values(ROLES).every((v) => rows.filter((r) => r.mwf_approverrole === v).length === 1));
      check('all Active', rows.every((r) => r.statecode === 0), `${rows.filter((r) => r.statecode !== 0).length} inactive`);
      check('every row has a user', rows.every((r) => !!r._mwf_user_value), `${rows.filter((r) => !r._mwf_user_value).length} without`);
      const distinct = new Set(rows.map((r) => r._mwf_user_value)).size;
      console.log(`INFO  distinct users: ${distinct} (development expects 1)`);
      console.log(`\nSUMMARY: ${bad} failed check(s).`);
      process.exit(bad ? 1 : 0);
    }

    // check and load need the user
    const raw = (process.env[VAR] || '').trim();
    check(`environment variable ${VAR} is set`, raw.length > 0, raw ? 'yes (value not printed)' : 'no');
    if (!raw) throw new Stop(`Set ${VAR} to the sign-in name or the user id of the test account. Nothing was changed.`);
    const esc = (s) => s.replace(/'/g, "''");
    const filter = isGuid(raw) ? `systemuserid eq ${raw}` : `domainname eq '${esc(raw)}' or internalemailaddress eq '${esc(raw)}'`;
    const users = (await must('GET', `systemusers?$select=isdisabled&$filter=${encodeURIComponent(filter)}`)).j.value;
    check('the variable resolves to exactly one user', users.length === 1, `${users.length} match(es)`);
    if (users.length !== 1) throw new Stop('The test account was not resolved to exactly one user. Nothing was changed.');
    check('the user is enabled', users[0].isdisabled === false);
    if (users[0].isdisabled) throw new Stop('The test account is disabled. Nothing was changed.');
    const userId = users[0].systemuserid;

    if (MODE === 'check') {
      console.log(`\nSUMMARY: ${bad} failed check(s). Read only; nothing was changed.`);
      process.exit(bad ? 1 : 0);
    }

    // load
    for (const [roleName, value] of Object.entries(ROLES)) {
      const have = rows.find((r) => r.mwf_approverrole === value);
      if (have) {
        console.log(`SKIP     ${roleName} (exists${have._mwf_user_value === userId ? '' : ', points to a DIFFERENT user; not changed'})`);
        continue;
      }
      await must('POST', SET, { mwf_name: roleName, mwf_approverrole: value, [USER_BIND_KEY]: `/systemusers(${userId})` });
      console.log(`CREATED  ${roleName}`);
    }
    console.log('\nLoaded. Run --mode=validate for the read-back.');
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
