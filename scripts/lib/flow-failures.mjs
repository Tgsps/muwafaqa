/**
 * Pure helpers of scripts/test-flow-failures.mjs (the Failed endings of flow v2, cases F1 and F2). No network, no ids, no addresses.
 *
 * F1  no step rows for the round        -> run Failed, code NoApprovalSteps, the contract stays Pending Approval
 * F2  a step whose role has no active assignment -> run Failed, code ApprovalStepFailed, message of the "no assignment" branch
 * The texts come from scripts/build-flow-v2.mjs (the Terminate of Check_steps_exist and the endMessage of the assignment gate).
 */

export const BUILDER_STEP_NAME = 'Muwafaqa.Plugins.Contract.ApprovalChainBuilder: Update of mwf_contract';
export const BYPASS_HEADER = 'MSCRM.BypassBusinessLogicExecutionStepIds';
export const ROLE_DEPARTMENT_HEAD = 867640000;
export const ACTION_APPROVE = 867640000;
export const DECISION_PENDING = 867640000;

export const CASES = {
  f1: {
    prefix: 'TEST-TMP-FF1', subject: 'TEST-TMP-FF1 no approval steps', value: 5000, manualStep: false,
    expect: { code: 'NoApprovalSteps', message: 'No Approval Step rows exist for this contract and approval round.', steps: 0 },
  },
  f2: {
    prefix: 'TEST-TMP-FF2', subject: 'TEST-TMP-FF2 role without assignment', value: 5000, manualStep: true,
    expect: { code: 'ApprovalStepFailed', message: 'The approver role of this step has no active Approver Assignment row.', steps: 1 },
  },
};

/** No prefix of a case is a prefix of another one (a cleanup by prefix must never touch another case). */
export function prefixesAreIndependent(prefixes) {
  return prefixes.every((a, i) => prefixes.every((b, j) => i === j || !b.startsWith(a)));
}

/** The header that skips ONE plug-in step (the administrative bypass, same mechanism as the cleanup of In Force rows). */
export const bypassHeaders = (stepId) => ({ [BYPASS_HEADER]: stepId, 'If-Match': '*' });

/** Body of the step row F2 creates by hand (the same shape the builder writes). Ids are passed in, never stored. */
export function manualStepBody({ contractId, userId, number, round = 1, order = 1 }) {
  const body = {
    mwf_name: `${number} R${round} S${order} Department Head`,
    'mwf_Contract@odata.bind': `/mwf_contracts(${contractId})`,
    mwf_approvalround: round, mwf_steporder: order, mwf_approverrole: ROLE_DEPARTMENT_HEAD, mwf_actiontype: ACTION_APPROVE, mwf_decision: DECISION_PENDING,
  };
  if (userId) body['mwf_OriginalApprover@odata.bind'] = `/systemusers(${userId})`;
  return body;
}

/** Runs of the given workflow ids that started at or after sinceMs and before untilMs (the start of the next case, if any). rows: [{ starttime, _workflow_value }] */
export function runsSince(rows, workflowIds, sinceMs, untilMs = Infinity) {
  const ids = workflowIds.filter(Boolean).map((x) => String(x).toLowerCase());
  return (rows || []).filter((r) => ids.includes(String(r._workflow_value ?? '').toLowerCase()) && Date.parse(r.starttime) >= sinceMs && Date.parse(r.starttime) < untilMs);
}

/** Whether a run row has finished (the flowruns table lists finished runs a minute or two late). */
export const finished = (r) => !!r && !!r.endtime && !!r.status;

/**
 * Judges one run against the case. The literal values are always reported by the script; here only the match.
 * The code or the message may be in `errorcode` or in `errormessage` (the platform wraps Terminate errors), so both are searched.
 * @returns {{statusFailed:boolean, codeSeen:boolean, messageSeen:boolean}}
 */
export function judgeRun(run, expect) {
  const text = `${run?.errorcode ?? ''} ${run?.errormessage ?? ''}`;
  return { statusFailed: run?.status === 'Failed', codeSeen: text.includes(expect.code), messageSeen: text.includes(expect.message) };
}

/** Whether an assignment row read back is Active (statecode 0). */
export const assignmentActive = (row) => !!row && row.statecode === 0;

/**
 * Counts only: whether the state is the one the session needs: v2 ON, and v1 OFF **if it exists** (v1 is being retired; a missing v1 is accepted, never two flows ON).
 * v1 / v2: the workflow row or undefined.
 */
export function sessionFlowState(v1, v2) {
  return { ok: !!v2 && v2.statecode === 1 && (!v1 || v1.statecode === 0), v1On: v1?.statecode === 1, v2On: v2?.statecode === 1, v1Present: !!v1 };
}
