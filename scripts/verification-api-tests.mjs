#!/usr/bin/env node
/**
 * WARNING: THIS SCRIPT MODIFIES THE ENVIRONMENT TEMPORARILY AND THEN RESTORES IT.
 *   - It creates and deletes TEST-TMP-* rows (contracts and one counterparty).
 *   - t3 changes the exchange rate of the AED currency record and puts the original value back.
 *   - t1 inserts and deletes a spare Status Reason option (867640099) on Contract.
 * It only runs with the flag --confirm-mutates-environment. Without it, it prints this warning and exits (code 2).
 * It refuses to guess the environment: pass it explicitly with --env=<url>. No URL, token or address is stored in this file.
 *
 * Web API tests for the (A)-class items of docs/verification-checklist.md.
 * Usage:
 *   node scripts/verification-api-tests.mjs <snapshot|t1|t2|t3|t4|check-clean> --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment [--out=<file>]
 *
 *   snapshot     read-only snapshot of TEST-CT-* rows, currency rates, status options, keys, Value precision metadata
 *   t1           item 1 step 6: insert and delete a SPARE Status Reason option (default options are never touched)
 *   t2           item 2: KWD / USD precision, read back through the Web API (form and grid display need the UI)
 *   t3           item 3: exchange rate change and its effect on existing records (AED rate is changed and restored)
 *   t4           item 4 step 5: update a Rejected row back to Draft through the API
 *   check-clean  read-only: no TEST-TMP rows remain
 *
 * Rules: the access token comes from `az` and is kept in memory only, never printed. Only TEST-TMP-* rows are written or
 * deleted. TEST-CT-* rows are only read. Temporary rows are deleted after each test and the deletion is verified by reading.
 * An unexpected error in setup or cleanup stops the script. Errors that ARE the observation are recorded as results.
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const argOf = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
if (!process.argv.includes('--confirm-mutates-environment')) {
  console.error([
    'WARNING: verification-api-tests.mjs modifies the environment temporarily and then restores it:',
    '  - creates and deletes TEST-TMP-* rows',
    '  - t3 changes the AED exchange rate and restores it',
    '  - t1 inserts and deletes a spare Status Reason option on Contract',
    'Nothing was run. To run it on purpose, add --confirm-mutates-environment (and --env=<url>).',
  ].join('\n'));
  process.exit(2);
}
const ENV = argOf('env').replace(/\/+$/, '');
if (!/^https:\/\/[^/]+$/.test(ENV)) {
  console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.');
  process.exit(2);
}
const API = `${ENV}/api/data/v9.2`;
const SOLUTION = 'Muwafaqa';
const test = process.argv[2];
const out = argOf('out');
const TOKEN = execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim();

const label = (t) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: t, LanguageCode: 1033 }] });
const q = (s) => encodeURIComponent(s).replace(/%24/g, '$');
const idOf = (e) => /\(([0-9a-f-]{36})\)/i.exec(e || '')?.[1];
const msg = (r) => { try { return JSON.parse(r.text).error.message; } catch { return (r.text || '').slice(0, 400); } };

async function call(method, path, body, headers = {}) {
  const r = await fetch(`${API}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: r.status, ok: r.ok, text, json, entityId: r.headers.get('OData-EntityId') };
}
// For setup and cleanup: any non-2xx stops the script with the full error.
async function must(method, path, body, headers) {
  const r = await call(method, path, body, headers);
  if (!r.ok) throw new Error(`${method} ${path} -> HTTP ${r.status}\n${r.text}`);
  return r;
}
// For observations: the outcome (success or error text) IS the result.
async function observe(method, path, body, headers) {
  const r = await call(method, path, body, headers);
  return { ok: r.ok, status: r.status, error: r.ok ? null : msg(r) };
}

async function currency(iso) {
  const r = await must('GET', `transactioncurrencies?$select=transactioncurrencyid,exchangerate,currencyprecision&$filter=${q(`isocurrencycode eq '${iso}'`)}`);
  return r.json.value[0];
}
async function tmpCounterparty() {
  const r = await must('POST', 'mwf_counterparties', { mwf_name: 'TEST-TMP Fictional Counterparty (delete me)', mwf_counterpartytype: 867640000 });
  return idOf(r.entityId);
}
async function tmpContract(cp, { number, name, value, iso }) {
  const c = await currency(iso);
  const r = await must('POST', 'mwf_contracts', {
    mwf_name: name, mwf_contractnumber: number, mwf_contracttype: 867640000, mwf_direction: 867640001, mwf_value: value,
    'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${cp})`, 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${c.transactioncurrencyid})`,
  });
  return idOf(r.entityId);
}
async function readContract(id) {
  const r = await must('GET', `mwf_contracts(${id})?$select=mwf_name,mwf_value,mwf_value_base,exchangerate,statecode,statuscode`);
  const j = r.json; return { value: j.mwf_value, base: j.mwf_value_base, rate: j.exchangerate, state: j.statecode, status: j.statuscode, name: j.mwf_name };
}
async function tmpCount() {
  const a = await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q("startswith(mwf_contractnumber,'TEST-TMP')")}`);
  const b = await must('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=${q("startswith(mwf_name,'TEST-TMP')")}`);
  return { contracts: a.json.value.length, counterparties: b.json.value.length };
}
async function cleanup(contractIds, cp) {
  for (const id of contractIds) await must('DELETE', `mwf_contracts(${id})`);
  if (cp) await must('DELETE', `mwf_counterparties(${cp})`);
  const left = await tmpCount();
  if (left.contracts || left.counterparties) throw new Error(`cleanup verification FAILED, TEST-TMP rows remain: ${JSON.stringify(left)}`);
  return { deleted: contractIds.length + (cp ? 1 : 0), remainingTestTmp: left };
}
async function statusOptions() {
  const r = await must('GET', "EntityDefinitions(LogicalName='mwf_contract')/Attributes(LogicalName='statuscode')/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)");
  return r.json.OptionSet.Options.map((o) => ({ value: o.Value, label: o.Label?.UserLocalizedLabel?.Label, state: o.State }));
}
async function snapshot() {
  const c = await must('GET', 'mwf_contracts?$select=mwf_contractnumber,statuscode,statecode,mwf_value,mwf_value_base,exchangerate,modifiedon&$orderby=mwf_contractnumber');
  const cur = await must('GET', 'transactioncurrencies?$select=isocurrencycode,exchangerate,currencyprecision,statecode&$orderby=isocurrencycode');
  const keys = await must('GET', "EntityDefinitions(LogicalName='mwf_contract')/Keys?$select=SchemaName,EntityKeyIndexStatus");
  const meta = await must('GET', "EntityDefinitions(LogicalName='mwf_contract')/Attributes(LogicalName='mwf_value')/Microsoft.Dynamics.CRM.MoneyAttributeMetadata?$select=PrecisionSource,Precision");
  return {
    contracts: c.json.value.filter((x) => /^TEST-CT-/.test(x.mwf_contractnumber || '')).map((x) => ({ n: x.mwf_contractnumber, status: x.statuscode, state: x.statecode, value: x.mwf_value, base: x.mwf_value_base, rate: x.exchangerate, modifiedon: x.modifiedon })),
    currencies: cur.json.value.map((x) => ({ iso: x.isocurrencycode, rate: x.exchangerate, precision: x.currencyprecision, state: x.statecode })),
    keys: keys.json.value, valuePrecision: { source: meta.json.PrecisionSource, precision: meta.json.Precision },
    statusOptions: await statusOptions(), tmp: await tmpCount(),
  };
}

const R = { test, steps: {} };
try {
  if (test === 'snapshot') Object.assign(R, await snapshot());

  else if (test === 't1') {
    R.before = await statusOptions();
    const ins = await observe('POST', 'InsertStatusValue', { AttributeLogicalName: 'statuscode', EntityLogicalName: 'mwf_contract', Label: label('TMP spare (delete me)'), StateCode: 0, Value: 867640099, SolutionUniqueName: SOLUTION });
    R.steps.insertSpare = ins;
    if (!ins.ok) throw new Error(`could not insert the spare option: ${ins.error}`);
    R.afterInsert = await statusOptions();
    const del = await observe('POST', 'DeleteOptionValue', { EntityLogicalName: 'mwf_contract', AttributeLogicalName: 'statuscode', Value: 867640099 });
    R.steps.deleteSpare = del;
    R.after = await statusOptions();
    R.spareStillThere = R.after.some((o) => o.value === 867640099);
    R.note = 'Only the spare option was targeted. The default options (1 Draft, 2 Rejected) were NOT deleted.';
    if (R.spareStillThere) throw new Error(`the spare option 867640099 is still present after the delete attempt (delete result: ${JSON.stringify(del)}). It must be removed in the UI.`);
  }

  else if (test === 't2') {
    const cp = await tmpCounterparty(); const ids = [];
    try {
      const meta = await must('GET', "EntityDefinitions(LogicalName='mwf_contract')/Attributes(LogicalName='mwf_value')/Microsoft.Dynamics.CRM.MoneyAttributeMetadata?$select=PrecisionSource,Precision");
      R.valueColumn = { precisionSource: meta.json.PrecisionSource, precision: meta.json.Precision };
      R.currencyPrecision = { KWD: (await currency('KWD')).currencyprecision, USD: (await currency('USD')).currencyprecision };
      const cases = [['K1', 'KWD', 6500.25, 'item step 3 (6500.250)'], ['K2', 'KWD', 6500.255, 'EXTRA: makes the 3rd decimal observable'], ['U1', 'USD', 100.255, 'item step 5']];
      R.cases = [];
      for (const [k, iso, v, why] of cases) {
        const id = await tmpContract(cp, { number: `TEST-TMP-PREC-${k}`, name: `TEST-TMP precision ${k}`, value: v, iso }); ids.push(id);
        const g = await readContract(id);
        R.cases.push({ case: k, why, currency: iso, sent: v, storedValue: g.value, storedBase: g.base, rate: g.rate });
      }
    } finally { R.cleanup = await cleanup(ids, cp); }
  }

  else if (test === 't3') {
    const aed = await currency('AED'); const R0 = aed.exchangerate; const R1 = 0.08;
    R.aed = { id: aed.transactioncurrencyid, rateBefore: R0, tempRate: R1 };
    R.existingAedRowsBefore = (await must('GET', `mwf_contracts?$select=mwf_contractnumber,mwf_value_base,exchangerate,modifiedon&$filter=${q("startswith(mwf_contractnumber,'TEST-CT') and _transactioncurrencyid_value eq " + aed.transactioncurrencyid)}&$orderby=mwf_contractnumber`)).json.value.map((x) => ({ n: x.mwf_contractnumber, base: x.mwf_value_base, rate: x.exchangerate, modifiedon: x.modifiedon }));
    const cp = await tmpCounterparty(); const ids = []; let changed = false;
    try {
      const A = await tmpContract(cp, { number: 'TEST-TMP-FX-A', name: 'TEST-TMP FX A', value: 367250, iso: 'AED' }); ids.push(A);
      const s2 = await readContract(A);
      R.steps.step2_createA = { ...s2, expectedBase_value_div_R0: 367250 / R0, matches: Math.abs(s2.base - 367250 / R0) < 1 };
      await must('PATCH', `transactioncurrencies(${aed.transactioncurrencyid})`, { exchangerate: R1 }); changed = true;
      R.steps.step4_currencyRateNow = (await currency('AED')).exchangerate;
      R.steps.step5_A_after_rate_change = await readContract(A);
      await must('PATCH', `mwf_contracts(${A})`, { mwf_name: 'TEST-TMP FX A renamed' });
      R.steps.step6_A_after_subject_edit = await readContract(A);
      await must('PATCH', `mwf_contracts(${A})`, { mwf_value: 367251 });
      R.steps.step7_A_after_value_edit = await readContract(A);
      R.steps.step7_expectedBase = { withOldRate: 367251 / R0, withNewRate: 367251 / R1 };
      const B = await tmpContract(cp, { number: 'TEST-TMP-FX-B', name: 'TEST-TMP FX B', value: 367250, iso: 'AED' }); ids.push(B);
      R.steps.step8_B = { ...(await readContract(B)), expectedBase_value_div_R1: 367250 / R1 };
      R.steps.step9_patchExchangeRateViaApi = await observe('PATCH', `mwf_contracts(${A})`, { exchangerate: 0.5 });
      R.steps.step9_A_after = await readContract(A);
    } finally {
      if (changed) {
        await must('PATCH', `transactioncurrencies(${aed.transactioncurrencyid})`, { exchangerate: R0 });
        const back = (await currency('AED')).exchangerate;
        R.aed.rateAfterRestore = back; R.aed.restored = back === R0;
        if (back !== R0) throw new Error(`AED rate NOT restored: before ${R0}, now ${back}`);
      }
      R.cleanup = await cleanup(ids, cp);
    }
    R.existingAedRowsAfter = (await must('GET', `mwf_contracts?$select=mwf_contractnumber,mwf_value_base,exchangerate,modifiedon&$filter=${q("startswith(mwf_contractnumber,'TEST-CT') and _transactioncurrencyid_value eq " + aed.transactioncurrencyid)}&$orderby=mwf_contractnumber`)).json.value.map((x) => ({ n: x.mwf_contractnumber, base: x.mwf_value_base, rate: x.exchangerate, modifiedon: x.modifiedon }));
    R.existingAedRowsUnchanged = JSON.stringify(R.existingAedRowsBefore) === JSON.stringify(R.existingAedRowsAfter);
  }

  else if (test === 't4') {
    const cp = await tmpCounterparty(); const ids = [];
    try {
      const id = await tmpContract(cp, { number: 'TEST-TMP-REJ', name: 'TEST-TMP rejected', value: 1000, iso: 'USD' }); ids.push(id);
      await must('PATCH', `mwf_contracts(${id})`, { statecode: 1, statuscode: 2 });
      R.steps.step1_afterReject = await readContract(id);
      R.steps.extra_updateOtherColumnOnInactiveRow = await observe('PATCH', `mwf_contracts(${id})`, { mwf_name: 'TEST-TMP rejected renamed' });
      R.steps.step5a_statuscodeOnly_to_Draft = await observe('PATCH', `mwf_contracts(${id})`, { statuscode: 1 });
      R.steps.step5a_after = await readContract(id);
      R.steps.step5b_stateAndStatus_to_Draft = await observe('PATCH', `mwf_contracts(${id})`, { statecode: 0, statuscode: 1 });
      R.steps.step5b_after = await readContract(id);
    } finally { R.cleanup = await cleanup(ids, cp); }
  }

  else if (test === 'check-clean') R.tmp = await tmpCount();

  else throw new Error('unknown test: ' + test);

  R.result = 'completed';
} catch (e) {
  R.result = 'STOPPED'; R.error = e.message; process.exitCode = 1;
}
const text = JSON.stringify(R, null, 2);
if (out) writeFileSync(out, text);
console.log(text);
