/**
 * Shared helpers for the test scripts under the Contract State Guard (ADR-004).
 *
 * Rules the guard enforces for a delete (tested on the server):
 *   Draft, Rejected   -> can be deleted
 *   Pending Approval  -> cannot be deleted. Withdraw to Draft first (Pending to Draft is allowed), then delete
 *   In Force          -> cannot be deleted, and In Force is final. The only way is the bypass of the guard Delete STEP
 *                        alone (header MSCRM.BypassBusinessLogicExecutionStepIds). A step is never disabled for cleanup.
 *
 * The helpers do not know how a script talks to the Web API. Each script passes a small `io` object:
 *   io.get(path)          -> { ok, status, json, message }
 *   io.patch(path, body)  -> { ok, status, message }          (the script adds If-Match: * if it wants update-only)
 *   io.del(path, headers) -> { ok, status, message }
 * No id, address or token is written by these helpers. Results carry statuses and short messages only.
 */

export const STATUS = { Draft: 1, Rejected: 2, Pending: 867640000, InForce: 867640001 };
export const GUARD_DELETE_STEP_NAME = 'Muwafaqa.Plugins.Contract.ContractStateGuard: Delete of mwf_contract';
const FLOW_NAME_PART = 'Contract Approval';
const noGuid = (t) => String(t ?? '').replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>');

/** The id of the guard Delete step (needed only to delete In Force rows), or null if it is not registered. */
export async function findGuardDeleteStepId(io) {
  const r = await io.get(`sdkmessageprocessingsteps?$filter=${encodeURIComponent(`name eq '${GUARD_DELETE_STEP_NAME}'`)}&$select=name`);
  if (!r.ok || !r.json?.value?.length) return null;
  return r.json.value[0].sdkmessageprocessingstepid;
}

/**
 * Deletes ONE contract row the way the guard allows.
 * @returns {{deleted:boolean, how:string, status?:number, message?:string, statuscode?:number}}
 */
export async function deleteContract(io, id, { bypassStepId = null } = {}) {
  const row = await io.get(`mwf_contracts(${id})?$select=statuscode`);
  if (row.status === 404) return { deleted: true, how: 'already gone' };
  if (!row.ok) return { deleted: false, how: 'could not read the row', status: row.status, message: row.message };
  const s = row.json.statuscode;

  if (s === STATUS.Pending) {
    const w = await io.patch(`mwf_contracts(${id})`, { statuscode: STATUS.Draft });
    if (!w.ok) return { deleted: false, how: 'withdraw to Draft failed', status: w.status, message: w.message, statuscode: s };
    const d = await io.del(`mwf_contracts(${id})`, {});
    return { deleted: d.ok, how: 'withdrawn to Draft, then deleted', status: d.status, message: d.message, statuscode: s };
  }
  if (s === STATUS.InForce) {
    if (!bypassStepId) return { deleted: false, how: 'In Force row: needs the bypass of the guard Delete step, no step id was given', statuscode: s };
    const d = await io.del(`mwf_contracts(${id})`, { 'MSCRM.BypassBusinessLogicExecutionStepIds': bypassStepId });
    return { deleted: d.ok, how: 'In Force: deleted with the bypass of the guard Delete step only', status: d.status, message: d.message, statuscode: s };
  }
  if (s === STATUS.Draft || s === STATUS.Rejected) {
    const d = await io.del(`mwf_contracts(${id})`, {});
    return { deleted: d.ok, how: s === STATUS.Draft ? 'Draft: deleted' : 'Rejected: deleted', status: d.status, message: d.message, statuscode: s };
  }
  return { deleted: false, how: `unknown status ${s}`, statuscode: s };
}

/** Deletes many rows. The bypass step id is looked up once, and only if an In Force row is found. */
export async function deleteContracts(io, ids) {
  let stepId = null; let looked = false;
  const result = { deleted: 0, failed: [] };
  for (const id of ids) {
    let r = await deleteContract(io, id, { bypassStepId: stepId });
    if (!r.deleted && r.statuscode === STATUS.InForce && !looked) {
      looked = true; stepId = await findGuardDeleteStepId(io);
      if (stepId) r = await deleteContract(io, id, { bypassStepId: stepId });
    }
    if (r.deleted) result.deleted++;
    else result.failed.push({ how: r.how, status: r.status, message: noGuid(r.message).slice(0, 200) });
  }
  return result;
}

/**
 * State of the approval flow, read only. The flow row is found by a part of its name.
 * @returns {{known:boolean, on?:boolean, count:number, state?:number}}   workflow statecode: 0 Draft (off), 1 Activated (on), 2 Suspended
 */
export async function approvalFlowState(io) {
  const r = await io.get(`workflows?$filter=${encodeURIComponent(`category eq 5 and contains(name,'${FLOW_NAME_PART}')`)}&$select=name,statecode`);
  if (!r.ok) return { known: false, count: 0, message: r.message };
  const v = r.json.value;
  if (v.length !== 1) return { known: false, count: v.length };
  return { known: true, on: v[0].statecode === 1, count: 1, state: v[0].statecode };
}

/**
 * Stops (throws) unless the approval flow is OFF. A script that moves a contract to Pending Approval would start a run
 * and an approval request for each row. If the state cannot be read, pass --flow-off-confirmed after checking by hand.
 */
export async function requireFlowOff(io, { confirmedByUser = false } = {}) {
  const f = await approvalFlowState(io);
  if (f.known && f.on) throw new Error('The approval flow is ON. Turn it OFF first: this script moves contracts to Pending Approval and every move would start a run. Nothing was changed.');
  if (!f.known) {
    if (confirmedByUser) { console.log('INFO  the approval flow state could not be read; --flow-off-confirmed was given, continuing'); return; }
    throw new Error(`The state of the approval flow could not be read (${f.count} matching flow rows). Check by hand that it is OFF and pass --flow-off-confirmed. Nothing was changed.`);
  }
  console.log('INFO  approval flow is OFF (read only check)');
}
