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
 *   same-status-save  item 7 step 3: PATCH one existing row (subject "TEST-TMP-FLOW-01 edited") with its CURRENT Status Reason only
 *   quick-toggle item 7 step 4: create TEST-TMP-FLOW-03, then Pending -> Draft -> Pending with no wait. The row is kept for reading run history
 *   delete-by-subject  deletes only the contracts with the subjects "TEST-TMP-FLOW-01 edited", "TEST-TMP-FLOW-02", "TEST-TMP-FLOW-03"
 *   check-clean  read-only: no TEST-TMP rows remain
 *
 * Contract State Guard (ADR-004): t4 reaches Rejected by allowed transitions (Draft -> Pending -> Rejected) and therefore needs the
 * approval flow OFF (it reads the flow state and stops if it is ON; add --flow-off-confirmed if it cannot be read). Every delete
 * goes through scripts/lib/contract-cleanup.mjs: Pending rows are withdrawn to Draft first, In Force rows (none are created
 * here) would need the bypass of the guard Delete step alone.
 *
 * Rules: the access token comes from `az` and is kept in memory only, never printed. Only TEST-TMP-* rows are written or
 * deleted. TEST-CT-* rows are only read. Temporary rows are deleted after each test and the deletion is verified by reading.
 * An unexpected error in setup or cleanup stops the script. Errors that ARE the observation are recorded as results.
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { deleteContract, deleteContracts, findGuardDeleteStepId, requireFlowOff } from './lib/contract-cleanup.mjs';

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
// adapter for the shared helper (scripts/lib/contract-cleanup.mjs)
const io = {
  get: async (p) => { const r = await call('GET', p); return { ok: r.ok, status: r.status, json: r.json, message: r.ok ? '' : msg(r) }; },
  patch: async (p, b) => { const r = await call('PATCH', p, b, { 'If-Match': '*' }); return { ok: r.ok, status: r.status, message: r.ok ? '' : msg(r) }; },
  del: async (p, h) => { const r = await call('DELETE', p, undefined, h || {}); return { ok: r.ok, status: r.status, message: r.ok ? '' : msg(r) }; },
};
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
  const res = await deleteContracts(io, contractIds);
  if (res.failed.length) throw new Error(`cleanup FAILED, ${res.failed.length} contract row(s) were not deleted: ${JSON.stringify(res.failed)}`);
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
    // The guard (ADR-004) rejects Draft -> Rejected, so the row reaches Rejected by allowed transitions: Draft -> Pending -> Rejected.
    // Moving to Pending starts a flow run when the flow is ON, so the flow must be OFF.
    await requireFlowOff(io, { confirmedByUser: process.argv.includes('--flow-off-confirmed') });
    const cp = await tmpCounterparty(); const ids = [];
    try {
      const id = await tmpContract(cp, { number: 'TEST-TMP-REJ', name: 'TEST-TMP rejected', value: 1000, iso: 'USD' }); ids.push(id);
      await must('PATCH', `mwf_contracts(${id})`, { statuscode: 867640000 }, { 'If-Match': '*' });
      R.steps.step0_afterPending = await readContract(id);
      await must('PATCH', `mwf_contracts(${id})`, { statecode: 1, statuscode: 2 }, { 'If-Match': '*' });
      R.steps.step1_afterReject = await readContract(id);
      R.steps.extra_updateOtherColumnOnInactiveRow = await observe('PATCH', `mwf_contracts(${id})`, { mwf_name: 'TEST-TMP rejected renamed' });
      R.steps.step5a_statuscodeOnly_to_Draft = await observe('PATCH', `mwf_contracts(${id})`, { statuscode: 1 });
      R.steps.step5a_after = await readContract(id);
      R.steps.step5b_stateAndStatus_to_Draft = await observe('PATCH', `mwf_contracts(${id})`, { statecode: 0, statuscode: 1 });
      R.steps.step5b_after = await readContract(id);
    } finally { R.cleanup = await cleanup(ids, cp); }
  }

  else if (test === 'same-status-save') {
    // item 7 step 3: save a Pending Approval row again with the SAME Status Reason. Touches exactly one row, found by its Subject.
    const SUBJECT = 'TEST-TMP-FLOW-01 edited';
    const PENDING = 867640000;
    const find = await must('GET', `mwf_contracts?$select=mwf_name,statuscode,statecode,modifiedon&$filter=${q(`mwf_name eq '${SUBJECT}'`)}`);
    if (find.json.value.length !== 1) throw new Error(`expected exactly 1 contract with the subject "${SUBJECT}", found ${find.json.value.length}. Nothing was sent.`);
    const row = find.json.value[0];
    R.before = { statuscode: row.statuscode, statecode: row.statecode, modifiedon: row.modifiedon };
    if (row.statuscode !== PENDING) throw new Error(`the row is not Pending Approval (statuscode ${row.statuscode}). Nothing was sent.`);
    const riyadh = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Riyadh', dateStyle: 'short', timeStyle: 'medium' }).format(d);
    const sentAt = new Date();
    R.patchSentAt = { riyadh: riyadh(sentAt), utc: sentAt.toISOString() };
    console.log(`Sending PATCH (statuscode only, same value) at ${R.patchSentAt.riyadh} Riyadh time (${R.patchSentAt.utc} UTC)`);
    R.patch = await observe('PATCH', `mwf_contracts(${row.mwf_contractid})`, { statuscode: PENDING });
    const again = await must('GET', `mwf_contracts(${row.mwf_contractid})?$select=statuscode,statecode,modifiedon`);
    R.after = { statuscode: again.json.statuscode, statecode: again.json.statecode, modifiedon: again.json.modifiedon };
    R.modifiedonChanged = R.before.modifiedon !== R.after.modifiedon;
    R.note = 'Only this row was written. Whether a flow run started must be read from the flow run history.';
  }

  else if (test === 'quick-toggle') {
    // item 7 step 4: Pending -> Draft -> Pending with no wait between the three requests, on ONE new row.
    // The row is NOT deleted here: the flow run history has to be read first. Delete it afterwards on purpose.
    const SUBJECT = 'TEST-TMP-FLOW-03';
    const dup = await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`mwf_name eq '${SUBJECT}'`)}`);
    if (dup.json.value.length) throw new Error(`a contract with the subject "${SUBJECT}" already exists (${dup.json.value.length}). Nothing was created.`);
    const cps = await must('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=${q("mwf_name eq 'Demo Partner Holdings Test Inc'")}`);
    if (cps.json.value.length !== 1) throw new Error(`expected 1 counterparty 'Demo Partner Holdings Test Inc', found ${cps.json.value.length}`);
    const usd = await currency('USD');
    const stamp = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }).format(d);
    R.timesAre = 'Riyadh time (UTC+3), with milliseconds';

    const created = await call('POST', 'mwf_contracts', {
      mwf_name: SUBJECT, mwf_contracttype: 867640000, mwf_direction: 867640001, mwf_value: 1,
      'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${cps.json.value[0].mwf_counterpartyid})`,
      'transactioncurrencyid@odata.bind': `/transactioncurrencies(${usd.transactioncurrencyid})`,
    });
    R.create = { http: created.status, ok: created.ok, error: created.ok ? null : msg(created) };
    console.log('1. create:', R.create.http);
    if (!created.ok) throw new Error(`create failed: HTTP ${created.status} ${msg(created)}`);
    const id = idOf(created.entityId);

    const steps = [['a', { statuscode: 867640000 }], ['b', { statuscode: 1, statecode: 0 }], ['c', { statuscode: 867640000 }]];
    R.requests = [];
    for (const [k, body] of steps) {
      const sent = new Date();
      const r = await call('PATCH', `mwf_contracts(${id})`, body);
      const received = new Date();
      const row = { step: k, body, http: r.status, sentAt: stamp(sent), receivedAt: stamp(received), error: r.ok ? null : msg(r) };
      R.requests.push(row);
      console.log(`2${k}. PATCH ${JSON.stringify(body)} -> HTTP ${row.http}, sent ${row.sentAt}, received ${row.receivedAt}`);
    }
    const fin = await must('GET', `mwf_contracts(${id})?$select=statuscode,statecode,modifiedon`);
    R.final = { statuscode: fin.json.statuscode, statecode: fin.json.statecode, modifiedon: fin.json.modifiedon };
    R.note = 'The row TEST-TMP-FLOW-03 was left in place for reading the flow run history. Only this row was written.';
  }

  else if (test === 'delete-by-subject') {
    // Deletes ONLY the three flow-test contracts below, found by their exact Subject. Anything else is untouched.
    const SUBJECTS = ['TEST-TMP-FLOW-01 edited', 'TEST-TMP-FLOW-02', 'TEST-TMP-FLOW-03'];
    const noGuid = (t) => (t == null ? t : t.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>'));
    R.results = [];
    // the shared helper: Pending rows are withdrawn to Draft first; In Force rows need the bypass of the guard Delete step alone
    let guardStepId;
    const deleteRow = async (id) => {
      let r = await deleteContract(io, id, { bypassStepId: guardStepId ?? null });
      if (!r.deleted && r.statuscode === 867640001 && guardStepId === undefined) {
        guardStepId = await findGuardDeleteStepId(io);
        if (guardStepId) r = await deleteContract(io, id, { bypassStepId: guardStepId });
      }
      return { ok: r.deleted, status: r.status ?? (r.deleted ? 204 : 0), error: r.deleted ? null : (r.message || r.how) };
    };
    // Optional --prefix=TEST-TMP-...: delete every contract whose Subject starts with that prefix (must start with TEST-TMP-, at most 20 rows).
    const prefix = argOf('prefix');
    if (prefix) {
      if (!prefix.startsWith('TEST-TMP-')) throw new Error('--prefix must start with TEST-TMP-. Nothing was deleted.');
      const f = await must('GET', `mwf_contracts?$select=mwf_name,statecode,statuscode&$filter=${q(`startswith(mwf_name,'${prefix}')`)}&$orderby=mwf_name`);
      if (f.json.value.length > 20) throw new Error(`more than 20 contracts match the prefix (${f.json.value.length}). Nothing was deleted.`);
      for (const row of f.json.value) {
        const d = await deleteRow(row.mwf_contractid);
        R.results.push({ subject: row.mwf_name, found: 1, statuscode: row.statuscode, statecode: row.statecode, deleteHttp: d.status, deleted: d.ok, error: noGuid(d.error) });
        if (!d.ok) { R.stoppedAt = row.mwf_name; break; }
      }
      if (!f.json.value.length) R.results.push({ prefix, found: 0, action: 'nothing to delete' });
    }
    for (const s of (prefix ? [] : SUBJECTS)) {
      const f = await must('GET', `mwf_contracts?$select=mwf_name,statecode,statuscode&$filter=${q(`mwf_name eq '${s}'`)}`);
      if (f.json.value.length > 1) throw new Error(`more than one contract has the subject "${s}" (${f.json.value.length}). Nothing was deleted for it.`);
      if (f.json.value.length === 0) { R.results.push({ subject: s, found: 0, action: 'nothing to delete' }); continue; }
      const row = f.json.value[0];
      const d = await deleteRow(row.mwf_contractid);
      R.results.push({ subject: s, found: 1, statuscode: row.statuscode, statecode: row.statecode, deleteHttp: d.status, deleted: d.ok, error: noGuid(d.error) });
      if (!d.ok) { R.stoppedAt = s; break; }
    }
    R.tmp = await tmpCount();
  }

  else if (test === 'key-tests') {
    // Alternate key "Contract Number Key" on mwf_contractnumber. Writes only TEST-TMP-KEY-* rows. Clean up afterwards with
    //   delete-by-subject --prefix=TEST-TMP-KEY-
    // PATCH by key is an upsert, so every PATCH here sends If-Match: * (update only, never create).
    const noGuid = (t) => (t == null ? t : t.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>'));
    const seen = async (method, path, body, headers) => {
      const r = await call(method, path, body, headers);
      return { http: r.status, ok: r.ok, message: r.ok ? null : noGuid(msg(r)), json: r.json };
    };
    const NOUPSERT = { 'If-Match': '*' };
    const cps = await must('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=${q("mwf_name eq 'Demo Partner Holdings Test Inc'")}`);
    if (cps.json.value.length !== 1) throw new Error(`expected 1 counterparty 'Demo Partner Holdings Test Inc', found ${cps.json.value.length}`);
    const usd = await currency('USD');
    const base = (subject, number) => {
      const b = {
        mwf_name: subject, mwf_contracttype: 867640000, mwf_direction: 867640001, mwf_value: 1,
        'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${cps.json.value[0].mwf_counterpartyid})`,
        'transactioncurrencyid@odata.bind': `/transactioncurrencies(${usd.transactioncurrencyid})`,
      };
      if (number !== undefined) b.mwf_contractnumber = number;
      return b;
    };
    const pre = await must('GET', `mwf_contracts?$select=mwf_name&$filter=${q("startswith(mwf_name,'TEST-TMP-KEY-')")}`);
    if (pre.json.value.length) throw new Error(`TEST-TMP-KEY-* rows already exist (${pre.json.value.length}). Clean them first. Nothing was created.`);
    R.steps = {};

    // 1. GET by key on an existing seeded contract (read only)
    const g1 = await seen('GET', "mwf_contracts(mwf_contractnumber='TEST-CT-0001')?$select=mwf_name,mwf_contractnumber,statuscode");
    R.steps['1_get_seeded_TEST-CT-0001'] = { http: g1.http, message: g1.message, returnedNumber: g1.json?.mwf_contractnumber, returnedStatus: g1.json?.statuscode };

    // 2. valid characters: create, PATCH by key, GET by key
    const c2 = await seen('POST', 'mwf_contracts', base('TEST-TMP-KEY-01', 'TMPKEY-01'));
    R.steps['2a_create_TMPKEY-01'] = { http: c2.http, message: c2.message };
    if (!c2.ok) throw new Error(`create TMPKEY-01 failed: HTTP ${c2.http} ${c2.message}`);
    const p2 = await seen('PATCH', "mwf_contracts(mwf_contractnumber='TMPKEY-01')", { mwf_name: 'TEST-TMP-KEY-01 edited' }, NOUPSERT);
    R.steps['2b_patch_by_key'] = { http: p2.http, message: p2.message };
    const g2 = await seen('GET', "mwf_contracts(mwf_contractnumber='TMPKEY-01')?$select=mwf_name");
    R.steps['2c_get_by_key_after_patch'] = { http: g2.http, message: g2.message, subject: g2.json?.mwf_name, changeConfirmed: g2.json?.mwf_name === 'TEST-TMP-KEY-01 edited' };

    // 3. restricted character "/" in the number
    const c3 = await seen('POST', 'mwf_contracts', base('TEST-TMP-KEY-02', 'TMP/KEY/02'));
    R.steps['3a_create_TMP/KEY/02'] = { http: c3.http, message: c3.message };
    if (c3.ok) {
      R.steps['3b_get_encoded'] = (({ http, message, json }) => ({ http, message, subject: json?.mwf_name }))(await seen('GET', "mwf_contracts(mwf_contractnumber='TMP%2FKEY%2F02')?$select=mwf_name"));
      R.steps['3c_get_plain'] = (({ http, message, json }) => ({ http, message, subject: json?.mwf_name }))(await seen('GET', "mwf_contracts(mwf_contractnumber='TMP/KEY/02')?$select=mwf_name"));
      R.steps['3d_patch_encoded'] = (({ http, message }) => ({ http, message }))(await seen('PATCH', "mwf_contracts(mwf_contractnumber='TMP%2FKEY%2F02')", { mwf_name: 'TEST-TMP-KEY-02 edited' }, NOUPSERT));
      R.steps['3e_patch_plain'] = (({ http, message }) => ({ http, message }))(await seen('PATCH', "mwf_contracts(mwf_contractnumber='TMP/KEY/02')", { mwf_name: 'TEST-TMP-KEY-02 edited plain' }, NOUPSERT));
      const after = await must('GET', `mwf_contracts?$select=mwf_name&$filter=${q("startswith(mwf_name,'TEST-TMP-KEY-02')")}`);
      R.steps['3f_subjects_of_row_02_now'] = after.json.value.map((x) => x.mwf_name);
    }

    // 4. duplicate number
    const c4 = await seen('POST', 'mwf_contracts', base('TEST-TMP-KEY-03', 'TMPKEY-01'));
    R.steps['4_create_duplicate_TMPKEY-01'] = { http: c4.http, message: c4.message };

    // 5. two rows without a number
    const c5a = await seen('POST', 'mwf_contracts', base('TEST-TMP-KEY-04'));
    const c5b = await seen('POST', 'mwf_contracts', base('TEST-TMP-KEY-05'));
    R.steps['5_two_rows_without_number'] = { first: { http: c5a.http, message: c5a.message }, second: { http: c5b.http, message: c5b.message } };

    const left = await must('GET', `mwf_contracts?$select=mwf_name&$filter=${q("startswith(mwf_name,'TEST-TMP-KEY-')")}&$orderby=mwf_name`);
    R.rowsToDeleteNow = left.json.value.map((x) => x.mwf_name);
    R.note = 'TEST-TMP-KEY-* rows were left in place. Delete them with: delete-by-subject --prefix=TEST-TMP-KEY-';
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
