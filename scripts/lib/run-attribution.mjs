/**
 * Attribution of flow runs to contracts, by END time (used by scripts/test-flow-checkpoints.mjs --mode=read).
 *
 * The flowruns table does not say which contract a run belongs to, and runs can start in the same second (two runs of the
 * 2026-10-19 session started at 17:34:14), so the START order says nothing. A run ends when its LAST approval is answered
 * (or a few seconds after), so a run is attributed to the contract whose last approval was completed within `tolS` seconds
 * before the run's end. The attribution must be UNIQUE in both directions (one run for the contract, and that run fits only that
 * contract); otherwise the contract gets no run (`unique: false`) and no verdict may be given for it.
 *
 * Pure functions, no network: node --test scripts/lib/run-attribution.test.mjs
 */

/** Last completion time (ms) of the approvals of each contract. `approvals`: [{ title, completedon }], the title ends with the Subject after a colon. */
export function lastApprovalByContract(approvals) {
  const last = {};
  for (const a of approvals || []) {
    if (!a.completedon) continue;
    const subject = String(a.title || '').split(':').pop().trim();
    const t = Date.parse(a.completedon);
    if (!(subject in last) || t > last[subject]) last[subject] = t;
  }
  return last;
}

/** @returns {Object<string,{candidates:Array, unique:boolean, run:object|null}>} keyed by subject */
export function attributeRuns(runs, lastDone, subjects, tolS = 5) {
  const fits = (run, subject) => {
    if (!(subject in lastDone) || !run.endtime) return false;
    const d = (Date.parse(run.endtime) - lastDone[subject]) / 1000;
    return d >= -1 && d <= tolS;
  };
  const out = {};
  for (const subject of subjects) {
    const candidates = runs.filter((r) => fits(r, subject));
    const unique = candidates.length === 1 && subjects.filter((o) => fits(candidates[0], o)).length === 1;
    out[subject] = { candidates, unique, run: unique ? candidates[0] : null };
  }
  return out;
}
