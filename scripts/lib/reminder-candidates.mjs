/**
 * Which waiting approval steps need a reminder or an escalation notice now (ADR-010, status Proposed). Pure: no network, no clock
 * (the caller passes `nowMs`). The reminder flow reads the rows; this function decides. Everything it cannot be sure about is
 * SKIPPED with a reason and never sent (fail-safe): a wrong silence costs one late reminder, a wrong notice costs a spurious mail.
 *
 * "Waiting since" is DERIVED (nothing is written when a step becomes Waiting, ADR-007):
 *   step 1            -> createdon of the step row (the chain is built at submission, seconds before the flow starts)
 *   step k > 1        -> mwf_decidedon of step k-1 of the SAME contract and round (found through the alternate key), when that step is
 *                        Approved or Informed. A missing previous step, or one that is not decided, or one without a usable
 *                        decidedon, means the chain is not in the shape the flow produces: skip.
 *
 * A step is a candidate only when: its decision is Waiting; it is an Approve step; its contract exists, is Pending Approval and
 * is in the SAME approval round as the step (a step of an old round is an orphan: never reminded). Escalation is separate from the
 * reminder: the reminder is never skipped. If both thresholds have passed and no reminder was sent (the scan was down), this scan
 * returns the reminder only and the escalation follows in the next scan.
 *
 * Timers are constants shared with the (future) flow builder: TEST_TIMERS for the short test, PRODUCTION_TIMERS for the placeholders
 * of the project (48 h and 96 h, business values not decided).
 */

export const DECISION = Object.freeze({ Pending: 867640000, Waiting: 867640001, Approved: 867640002, Rejected: 867640003, Informed: 867640004, Cancelled: 867640005 });
export const ACTION_TYPE = Object.freeze({ Approve: 867640000, Inform: 867640001 });
export const STATUS_PENDING_APPROVAL = 867640000;   // Status Reason "Pending Approval" of mwf_contract

export const PRODUCTION_TIMERS = Object.freeze({ remindAfterMinutes: 2880, escalateAfterMinutes: 5760 });
export const TEST_TIMERS = Object.freeze({ remindAfterMinutes: 3, escalateAfterMinutes: 6 });

/** @param {'test'|'production'} variant */
export function timersFor(variant) {
  if (variant === 'test') return TEST_TIMERS;
  if (variant === 'production') return PRODUCTION_TIMERS;
  throw new Error(`unknown timer variant "${variant}" (use test or production)`);
}

export function validateTimers(t) {
  const ok = Number.isInteger(t?.remindAfterMinutes) && Number.isInteger(t?.escalateAfterMinutes)
    && t.remindAfterMinutes > 0 && t.escalateAfterMinutes > t.remindAfterMinutes;
  if (!ok) throw new Error('timers: remindAfterMinutes and escalateAfterMinutes must be whole numbers, 0 < remind < escalate');
  return t;
}

const ms = (v) => { if (v == null || v === '') return null; const n = Date.parse(v); return Number.isFinite(n) ? n : null; };
const norm = (id) => String(id ?? '').toLowerCase();
const isEmpty = (v) => v == null || v === '';

/**
 * @param {object}   input
 * @param {object[]} input.steps      step rows (all steps of the contracts concerned, including the previous ones):
 *                                    { mwf_approvalstepid, _mwf_contract_value, mwf_approvalround, mwf_steporder, mwf_decision, mwf_actiontype,
 *                                      createdon, mwf_decidedon, mwf_remindedon, mwf_escalatedon }
 * @param {object[]} input.contracts  { mwf_contractid, statuscode, mwf_approvalround }
 * @param {number}   input.nowMs
 * @param {{remindAfterMinutes:number, escalateAfterMinutes:number}} input.timers
 * @returns {{actions:{stepId:string, action:'remind'|'escalate', waitingSinceMs:number, waitingMinutes:number}[], skipped:{stepId:string, reason:string}[], notDue:number}}
 */
export function pickCandidates({ steps, contracts, nowMs, timers }) {
  validateTimers(timers);
  if (!Number.isFinite(nowMs)) throw new Error('nowMs must be a number');
  const contractById = new Map((contracts || []).map((c) => [norm(c.mwf_contractid), c]));
  const stepKey = (contractId, round, order) => `${norm(contractId)}|${round}|${order}`;
  const byKey = new Map();
  for (const s of steps || []) byKey.set(stepKey(s._mwf_contract_value, s.mwf_approvalround, s.mwf_steporder), s);

  const actions = []; const skipped = []; let notDue = 0;
  const skip = (s, reason) => skipped.push({ stepId: s.mwf_approvalstepid, reason });

  for (const s of steps || []) {
    if (s.mwf_decision !== DECISION.Waiting) continue;               // not waiting: not a candidate, not an anomaly
    if (s.mwf_actiontype !== ACTION_TYPE.Approve) { skip(s, 'not-an-approve-step'); continue; }
    const contract = contractById.get(norm(s._mwf_contract_value));
    if (!contract) { skip(s, 'contract-missing'); continue; }
    if (contract.statuscode !== STATUS_PENDING_APPROVAL) { skip(s, 'contract-not-pending-approval'); continue; }
    if (contract.mwf_approvalround !== s.mwf_approvalround) { skip(s, 'stale-round'); continue; }
    if (!Number.isInteger(s.mwf_steporder) || s.mwf_steporder < 1) { skip(s, 'bad-step-order'); continue; }

    let since;
    if (s.mwf_steporder === 1) {
      since = ms(s.createdon);
      if (since === null) { skip(s, 'createdon-missing'); continue; }
    } else {
      const prev = byKey.get(stepKey(s._mwf_contract_value, s.mwf_approvalround, s.mwf_steporder - 1));
      if (!prev) { skip(s, 'previous-step-missing'); continue; }
      if (prev.mwf_decision !== DECISION.Approved && prev.mwf_decision !== DECISION.Informed) { skip(s, 'previous-step-not-decided'); continue; }
      since = ms(prev.mwf_decidedon);
      if (since === null) { skip(s, 'previous-decidedon-missing'); continue; }
    }
    if (since > nowMs) { skip(s, 'waiting-since-in-the-future'); continue; }

    const minutes = (nowMs - since) / 60000;
    const reminded = !isEmpty(s.mwf_remindedon);
    const escalated = !isEmpty(s.mwf_escalatedon);
    const remindDue = minutes >= timers.remindAfterMinutes;
    const escalateDue = minutes >= timers.escalateAfterMinutes;
    const hit = (action) => actions.push({ stepId: s.mwf_approvalstepid, action, waitingSinceMs: since, waitingMinutes: Math.floor(minutes) });

    if (remindDue && !reminded) hit('remind');                        // the reminder is never skipped, also when the escalation is due too
    else if (escalateDue && reminded && !escalated) hit('escalate');
    else notDue++;
  }
  return { actions, skipped, notDue };
}

/**
 * DECIDED by the owner on 2026-10-26 (ADR-010, "Hard cap per run"): at most this many notices (reminders and escalations together) in one scan.
 * Hard-coded. `capActions` itself has no default: the caller passes the number.
 */
export const MAX_NOTICES_PER_RUN = 5;

/**
 * The hard cap of one run. Takes the actions of `pickCandidates`, returns at most `maxPerRun` of them, the ones that have waited the longest first
 * (ties: the step id, so the result is deterministic), and the number left over. A step that is left over is NOT claimed by the flow in this run, so it
 * is picked up by the next scan; nothing is dropped. maxPerRun must be an explicit whole number >= 1 (no default: an unset cap must not mean "no cap").
 * @returns {{send:object[], deferred:number}}
 */
export function capActions(actions, maxPerRun) {
  if (!Number.isInteger(maxPerRun) || maxPerRun < 1) throw new Error('maxPerRun must be an explicit whole number >= 1');
  const ordered = [...(actions || [])].sort((a, b) => (a.waitingSinceMs - b.waitingSinceMs) || String(a.stepId).localeCompare(String(b.stepId)));
  return { send: ordered.slice(0, maxPerRun), deferred: Math.max(0, ordered.length - maxPerRun) };
}
