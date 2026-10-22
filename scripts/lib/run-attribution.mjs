/**
 * Attribution of flow runs to contracts, by END time (used by scripts/test-flow-checkpoints.mjs --mode=read). Titles of v1 and v2 are both understood (v2: ADR-007).
 *
 * The flowruns table does not say which contract a run belongs to, and runs can start in the same second (two runs of the
 * 2026-10-19 session started at 17:34:14), so the START order says nothing. A run ends when its LAST approval is answered
 * (or a few seconds after), so a run is attributed to the contract whose last approval was completed within `tolS` seconds
 * before the run's end. The attribution must be UNIQUE in both directions (one run for the contract, and that run fits only that
 * contract); otherwise the contract gets no run (`unique: false`) and no verdict may be given for it.
 *
 * Pure functions, no network: node --test scripts/lib/run-attribution.test.mjs
 */

const STEP_SUFFIX = /\s*\(step (\d+) of (\d+), ([^)]*)\)\s*$/;

/**
 * The step part of a v2 approval title, or null. v2 titles end with " (step <i> of <n>, <role>)" (docs/flow-approval-v2.md).
 * @returns {{index:number, total:number, role:string}|null}
 */
export function stepOfTitle(title) {
  const m = STEP_SUFFIX.exec(String(title || ''));
  return m ? { index: Number(m[1]), total: Number(m[2]), role: m[3] } : null;
}

/** True for the approval that v2 creates for an Inform step ("For information: contract <Subject> (step i of n, <role>)"). */
export function isInformTitle(title) {
  return /^For information: contract /.test(String(title || ''));
}

/**
 * The contract Subject inside an approval title. Understands, in this order:
 *   v2 approve   "Approve contract: <Subject> (step i of n, <role>)"
 *   v2 inform    "For information: contract <Subject> (step i of n, <role>)"
 *   v1           "Approve contract : <Subject>" (stage 1, with a space) and "Approve contract: <Subject>" (stage 2)
 * Anything else falls back to the text after the last colon (the old rule). A colon inside a Subject is safe for the three known forms.
 */
export function subjectOfTitle(title) {
  let t = String(title || '').replace(STEP_SUFFIX, '').trim();
  let m = /^Approve contract\s*:\s*([\s\S]*)$/.exec(t);
  if (m) return m[1].trim();
  m = /^For information: contract ([\s\S]*)$/.exec(t);
  if (m) return m[1].trim();
  return t.split(':').pop().trim();
}

/** Last completion time (ms) of the approvals of each contract. `approvals`: [{ title, completedon }]; the Subject is taken from the title by subjectOfTitle(). Open approvals (no completedon, for example an Inform request) are ignored. */
export function lastApprovalByContract(approvals) {
  const last = {};
  for (const a of approvals || []) {
    if (!a.completedon) continue;
    const subject = subjectOfTitle(a.title);
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
