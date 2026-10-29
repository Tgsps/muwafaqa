/**
 * The pure parts of the test session of the reminders flow (docs/flow-approval-reminders.md, scripts/test-flow-reminders.mjs): the cases of the
 * two windows, the seeds, the plan text, the reading of claims per run, and the VERDICT. No network, no clock (the caller passes the times).
 *
 * v2 IS SIMULATED BY SEEDED ROWS. The steps are made Waiting (and sometimes Approved with a decidedon) by a direct write, as v2 would write them; nothing
 * here proves the integration with v2 (no real approval request, no real answer). SIMULATION_SENTENCE says so in the verdict.
 *
 * What the flow sees: the server-side filter keeps a step only if its createdon is older than the reminder time (3 minutes, test variant) or, for the
 * escalation, older than the escalation time (6 minutes). The createdon of a step cannot be written, and a decidedon older than the createdon does not make
 * a step due earlier (the premise "waiting since is never earlier than createdon" does not hold for such a seed). So EVERY case waits 3 minutes (reminder) and
 * 6 minutes (escalation) of REAL time from the submission of its contract; only the later steps of a chain (case R6) start counting from the decidedon of the
 * step before them.
 */
import { pickCandidates, TEST_TIMERS, MAX_NOTICES_PER_RUN, DECISION, ACTION_TYPE, STATUS_PENDING_APPROVAL } from './reminder-candidates.mjs';

export const FLOW_NAME = 'Muwafaqa - Approval Reminders';
export const FAMILY = 'TEST-TMP-REM';
/** A recognisable, obviously seeded timestamp. A column that holds it was set by the seed and must come out of the session unchanged. */
export const MARKER = '2001-01-01T00:00:00Z';
export const MARKER_MS = Date.parse(MARKER);
export const EARLY_MS = 5000;            // clock skew: a notice may not come earlier than its due time by more than this
/** If the owner turns the flow ON later than S0 + 2:30, the timing of R1 and R6 cannot be judged (INCONCLUSIVE, not FAIL). */
export const LATE_ON_MS = 150000;
export const LATE_MS = 3 * 60000;        // one scan every minute plus the start of the run: a notice is late after this
export const SIMULATION_SENTENCE = 'v2 simulated by seeded rows: this session does NOT prove the integration with v2 (no real approval request, no real answer, no real Mark_step_Waiting).';
export const STATUS = Object.freeze({ Draft: 1, Rejected: 2, Pending: STATUS_PENDING_APPROVAL, InForce: 867640001 });
export const CAP = MAX_NOTICES_PER_RUN;

export const WINDOWS = Object.freeze({
  1: Object.freeze({ id: 1, prefix: 'TEST-TMP-REM1', cases: ['r5', 'r3', 'r4a', 'r4b'], control: 'r5', onMinutes: 9 }),
  2: Object.freeze({ id: 2, prefix: 'TEST-TMP-REM2', cases: ['r1', 'r2', 'r6'], control: 'r1', onMinutes: 11 }),
});

/** count: contracts of the case; value: USD (5,000 = one step, 25,000 = two steps of the Maintenance / Expense matrix); chain: steps built by the plug-in. */
export const CASES = Object.freeze({
  r5: { window: 1, label: 'R5 the cap (positive control of window 1)', count: 7, value: 5000, chain: 1 },
  r3: { window: 1, label: 'R3 escalation only, idempotency', count: 1, value: 5000, chain: 1 },
  r4a: { window: 1, label: 'R4a a Waiting step of an OLD round', count: 1, value: 25000, chain: 2 },
  r4b: { window: 1, label: 'R4b a Waiting step of a contract that is no longer Pending Approval', count: 1, value: 5000, chain: 1 },
  r1: { window: 2, label: 'R1 reminder, then escalation, once each (positive control of window 2)', count: 1, value: 5000, chain: 1 },
  r2: { window: 2, label: 'R2 answered before the time', count: 1, value: 5000, chain: 1 },
  r6: { window: 2, label: 'R6 a later step counts from the answer to the step before it', count: 1, value: 25000, chain: 2 },
});

export function subjectsOf(caseKey) {
  const c = CASES[caseKey]; const p = WINDOWS[c.window].prefix; const tag = caseKey.toUpperCase();
  return c.count === 1 ? [`${p}-${tag}`] : Array.from({ length: c.count }, (_, i) => `${p}-${tag}-${i + 1}`);
}
export function caseOfSubject(name) {
  const m = /^TEST-TMP-REM([12])-(R\d[AB]?)(?:-\d+)?$/.exec(String(name ?? ''));
  if (!m) return null;
  const key = m[2].toLowerCase();
  return CASES[key] && CASES[key].window === Number(m[1]) ? key : null;
}

/** The seeds that are written to a step row (a Waiting step, a marker, an answer). One place, so the plan, the script and the tests agree. */
export const SEED = Object.freeze({
  waiting: () => ({ mwf_decision: DECISION.Waiting }),
  waitingEscalatedMarker: () => ({ mwf_decision: DECISION.Waiting, mwf_escalatedon: MARKER }),
  waitingRemindedMarker: () => ({ mwf_decision: DECISION.Waiting, mwf_remindedon: MARKER }),
  approvedAt: (iso) => ({ mwf_decision: DECISION.Approved, mwf_decidedon: iso }),
});

/** Seconds after the submission at which the timed seeds of window 2 are written (by the await step). */
export const TIMED = Object.freeze({ r2AnswerAfterS: 60, r6AnswerAfterS: 150 });

const mins = (n) => n * 60000;
const ms = (v) => { if (v == null || v === '') return null; const n = Date.parse(v); return Number.isFinite(n) ? n : null; };

// ---------------------------------------------------------------------------------------------------------------- the plan text
export function planLines(windowId) {
  const w = WINDOWS[windowId]; if (!w) throw new Error('window must be 1 or 2');
  const T = TEST_TIMERS;
  const L = [];
  L.push(`WINDOW ${windowId}: ${w.cases.map((k) => k.toUpperCase()).join(', ')}; the positive control is ${w.control.toUpperCase()}; the flow is ON for about ${w.onMinutes} minutes. Test variant: reminder after ${T.remindAfterMinutes} min, escalation after ${T.escalateAfterMinutes} min, cap ${CAP} notices per run, a scan every minute.`);
  L.push(`${SIMULATION_SENTENCE}`);
  L.push('Every case waits in REAL time from the submission of its contract (createdon of its steps): the reminder is due 3 minutes after it, the escalation 6 minutes after it. A decidedon in the past does not make a step due earlier.');
  const add = (k, lines) => { L.push(''); L.push(`${CASES[k].label}: ${CASES[k].count} contract(s), ${subjectsOf(k)[0]}${CASES[k].count > 1 ? ' ...' : ''}, USD ${CASES[k].value}, ${CASES[k].chain} step(s)`); for (const x of lines) L.push('  ' + x); };
  if (windowId === 1) {
    add('r5', ['setup: the 7 contracts are created and submitted in parallel (their createdon differ by seconds); step 1 of each is made Waiting and its mwf_escalatedon is set to the marker ' + MARKER + ' so that only REMINDERS can happen.',
      'expected: each step gets exactly ONE reminder, mwf_remindedon written once, at about submission + 3 min (first scan after it); no run claims more than ' + CAP + ' notices; if 5 or more steps are due at the start of a run, that run claims exactly ' + CAP + '. mwf_escalatedon stays at the marker.',
      'emails: 7 reminders to the owner\'s mailbox. By script: the columns, the claims per run, the run statuses. By your eye: the mailbox, and the number of Increment_noticesSent iterations in each run.']);
    add('r3', ['setup: step 1 made Waiting and its mwf_remindedon set to the marker (already reminded).',
      'expected: ONE escalation at about submission + 6 min; mwf_remindedon stays at the marker; mwf_escalatedon written once; no further change in the next scans. emails: 1 escalation to the contract owner (the signed-in user).']);
    add('r4a', ['setup order: create, submit (round 1), step 1 Approved, withdraw to Draft, submit again (round 2), and LAST (after the contract transition) the step 2 of ROUND 1 is made Waiting; it is read back and the setup FAILS unless it is Waiting, round 1, step order 2.',
      'what the flow sees when it scans it: the contract is Pending Approval with approval round 2; the step is Approve, decision Waiting, round 1, both notice columns empty, createdon older than 3 minutes (so it WOULD be due if the round were current); the step query filters on the CONTRACT\'S current round (2), so the step is never read.',
      'expected: no mail, both columns stay empty. Counted as PASS only if the control of the window fired.']);
    add('r4b', ['setup order: create, submit, the contract is set to Rejected, and LAST (after that transition) step 1 is made Waiting; read back, the setup FAILS unless it is Waiting and the contract is Rejected.',
      'what the flow sees when it scans it: the contract is Rejected (inactive), so the contract query (Pending Approval only) never lists it; the step is Approve, Waiting, round 1, older than 3 minutes, both columns empty.',
      'expected: no mail, both columns stay empty. Counted as PASS only if the control of the window fired.']);
    L.push(''); L.push('R4c the legacy Pending contract (nothing is created): its approval round is empty. Expected: no run of the flow ends Failed (it must not break a run), no mail, and the contract is unchanged.');
    L.push('Notices of the window: 7 reminders + 1 escalation = 8 emails at most.');
  } else {
    add('r1', ['setup: step 1 made Waiting right after the submission (S0).',
      'expected: ONE reminder in [S0+3, S0+3+3] min and ONE escalation in [S0+6, S0+6+3] min (never earlier than the due time minus 5 s; later than the flow was turned on); then nothing more. emails: 1 reminder + 1 escalation.']);
    add('r2', ['setup: step 1 made Waiting; at S0+' + TIMED.r2AnswerAfterS + ' s the await step writes the answer (decision Approved, decidedon now).',
      'expected: no mail at any time, both columns stay empty. Counted as PASS only if the control of the window (R1) fired.']);
    add('r6', ['setup: nothing is seeded at first (both steps Pending). At S0+' + TIMED.r6AnswerAfterS + ' s the await step writes step 1 Approved with decidedon = now (D) and step 2 Waiting.',
      'expected: NO reminder before D+3 min (the key check: the time counts from the answer to step 1, not from the submission); the reminder in [D+3, D+3+3] min and the escalation in [D+6, D+6+3] min. emails: 1 reminder + 1 escalation.',
      'If the owner turns the flow ON later than S0+2:30 the timing of R1 and R6 cannot be judged: those timing checks are INCONCLUSIVE (OBS), not FAIL; the existence of the notices is still checked.']);
    L.push(''); L.push('Notices of the window: 4 emails at most (R1: 2, R6: 2).');
  }
  return L;
}

// ---------------------------------------------------------------------------------------------------------------- claims and runs
const clock = (ms) => new Date(ms).toISOString().slice(11, 19) + 'Z';
const kindOf = (claim) => String(claim.key ?? '').split(':')[1] ?? 'claim';

/**
 * Attributes each claim to the run whose [startMs, endMs] interval CONTAINS the claim time. The runs of the flow overlap (a run can last longer than the
 * interval of the trigger), so the nearest start is not a safe rule. A claim inside SEVERAL runs is AMBIGUOUS (it is not given to one of them); a claim inside none
 * is UNATTRIBUTED. A run without an end time (still running) is open ended. No slack is applied.
 * claims: [{atMs, key}]; runs: [{startMs, endMs}].
 * @returns {{runs:object[], inside:number[], attributed:object[], ambiguous:object[], unattributed:object[], overlaps:number[][], overlapping:boolean}}
 *   inside[i]: how many claims lie inside the interval of run i, AMBIGUOUS ones included (the conservative count of that run window)
 */
export function claimAttribution(runs, claims) {
  const sorted = [...runs].filter((r) => r.startMs != null).sort((x, y) => x.startMs - y.startMs);
  const endOf = (r) => (r.endMs == null ? Infinity : r.endMs);
  const overlaps = sorted.map((r, i) => sorted.map((o, j) => (j !== i && r.startMs <= endOf(o) && o.startMs <= endOf(r) ? j : -1)).filter((j) => j >= 0));
  const inside = sorted.map(() => 0); const attributed = []; const ambiguous = []; const unattributed = [];
  for (const c of claims) {
    const hit = []; sorted.forEach((r, i) => { if (r.startMs <= c.atMs && c.atMs <= endOf(r)) hit.push(i); });
    for (const i of hit) inside[i]++;
    if (hit.length === 1) attributed.push({ ...c, run: hit[0] });
    else if (hit.length > 1) ambiguous.push({ ...c, runs: hit });
    else unattributed.push(c);
  }
  return { runs: sorted, inside, attributed, ambiguous, unattributed, overlaps, overlapping: overlaps.some((x) => x.length > 0) };
}

/**
 * The cap checks, pure. dues: for each run in the order of claimAttribution().runs, how many steps were due at its start.
 *  cap.max     FAIL if any run window contains more than CAP claims. With overlapping runs a window can contain the claims of a concurrent run, so this is
 *              CONSERVATIVE (it can raise a false alarm, it cannot hide a run that claimed more than CAP, because a claim is made inside its run).
 *  cap.exact   only for runs that overlap no other run: a run that had CAP or more steps due must have claimed exactly CAP. Overlapping runs are NOT evaluated (said in the detail).
 *  claims.attribution  OBS when a claim is ambiguous ("ambiguous: runs X, Y") or unattributed.
 *  cap.overlap OBS when runs overlap: says that the cap check is weaker.
 */
export function capVerdict({ runs, claims, dues }) {
  const a = claimAttribution(runs, claims); const out = [];
  const add = (id, status, name, detail = '') => out.push({ id, status, name, detail });
  const label = (i) => `run ${i} (${clock(a.runs[i].startMs)})`;
  const over = a.inside.map((n, i) => (n > CAP ? i : -1)).filter((i) => i >= 0);
  const weak = over.filter((i) => a.overlaps[i].length > 0);
  add('cap.max', over.length === 0 ? 'PASS' : 'FAIL', `no run window contains more than ${CAP} claims (every claim inside the interval of a run counts for that run, ambiguous ones for each run that contains them)`,
    `claims inside each run window ${JSON.stringify(a.inside)}${over.length ? `; over the cap: ${over.map(label).join(', ')}` : ''}${weak.length ? '; an offending window overlaps another run, so it may hold claims of the concurrent run (possible false alarm, not proof of a violation)' : ''}`);
  const exactBad = []; const notEvaluated = [];
  a.runs.forEach((r, i) => { const due = dues?.[i] ?? 0; if (due < CAP) return; if (a.overlaps[i].length) { notEvaluated.push(i); return; } if (a.inside[i] !== CAP) exactBad.push(i); });
  add('cap.exact', exactBad.length === 0 ? 'PASS' : 'FAIL', `a run that overlaps no other run and had ${CAP} or more steps due claimed exactly ${CAP}`,
    `due at the start ${JSON.stringify(dues)}${notEvaluated.length ? `; NOT evaluated for the overlapping run(s) ${notEvaluated.map(label).join(', ')}` : ''}${exactBad.length ? `; wrong: ${exactBad.map(label).join(', ')}` : ''}`);
  const notes = [
    ...a.ambiguous.map((c) => `ambiguous: runs ${c.runs.join(', ')} (${kindOf(c)} at ${clock(c.atMs)}; run starts ${c.runs.map((i) => clock(a.runs[i].startMs)).join(', ')})`),
    ...a.unattributed.map((c) => `unattributed: ${kindOf(c)} at ${clock(c.atMs)} lies inside no run`),
  ];
  add('claims.attribution', notes.length ? 'OBS' : 'PASS', 'every claim lies inside exactly one run interval', notes.length ? notes.join(' | ') : `${a.attributed.length} claim(s), each inside one run`);
  if (a.overlapping) {
    const pairs = []; a.overlaps.forEach((l, i) => l.forEach((j) => { if (j > i) pairs.push(`${i}&${j}`); }));
    add('cap.overlap', 'OBS', 'OVERLAP: runs overlap, so the cap check is WEAKER: it bounds the claims inside each run window but cannot show which run made an ambiguous claim, can raise a false alarm, and the exact-cap check is not evaluated for overlapping runs',
      `overlapping run pairs ${pairs.join(', ')}`);
  }
  return out;
}

/** How many steps are due at the start of a run, by the same rules as pickCandidates, with the columns as they were at that time (a claim written later is not visible). */
export function dueAtRunStart({ steps, contracts, startMs }) {
  const visible = steps.map((s) => ({ ...s, mwf_remindedon: (ms(s.mwf_remindedon) ?? Infinity) <= startMs ? s.mwf_remindedon : null, mwf_escalatedon: (ms(s.mwf_escalatedon) ?? Infinity) <= startMs ? s.mwf_escalatedon : null }));
  return pickCandidates({ steps: visible, contracts, nowMs: startMs, timers: TEST_TIMERS }).actions.length;
}

// ---------------------------------------------------------------------------------------------------------------- the verdict
/**
 * @param {object} o
 * @param {1|2} o.windowId
 * @param {object[]} o.contracts  rows {mwf_contractid, mwf_name, statuscode, mwf_approvalround, modifiedon}
 * @param {object[]} o.steps      rows {mwf_approvalstepid, _mwf_contract_value, mwf_approvalround, mwf_steporder, mwf_decision, mwf_actiontype, createdon, mwf_decidedon, mwf_remindedon, mwf_escalatedon}
 * @param {{startMs:number,endMs:number|null,status:string}[]} o.runs  the runs of the reminders flow since it was turned on
 * @param {{on:boolean, onAtMs:number|null}} o.flow
 * @param {{found:boolean, round:any, status:any, modifiedon:string|null, modifiedonBefore?:string|null}} [o.legacy]
 * @returns {{id:string,status:'PASS'|'FAIL'|'OBS',name:string,detail:string}[]}
 */
export function verdict({ windowId, contracts, steps, runs, flow, legacy }) {
  const out = []; const add = (id, status, name, detail = '') => out.push({ id, status, name, detail });
  const w = WINDOWS[windowId]; if (!w) throw new Error('window must be 1 or 2');
  const onAt = flow?.onAtMs ?? 0;
  const idOf = new Map(contracts.map((c) => [String(c.mwf_contractid).toLowerCase(), c]));
  const stepsOfContract = (c) => steps.filter((s) => String(s._mwf_contract_value).toLowerCase() === String(c.mwf_contractid).toLowerCase());
  const entries = (k) => contracts.filter((c) => caseOfSubject(c.mwf_name) === k).sort((a, b) => String(a.mwf_name).localeCompare(String(b.mwf_name))).map((c) => ({ contract: c, steps: stepsOfContract(c) }));
  const step = (e, order, round = 1) => e.steps.find((s) => s.mwf_steporder === order && s.mwf_approvalround === round);
  const inWindow = (t, dueMs) => t != null && t >= dueMs - EARLY_MS && t <= Math.max(dueMs, onAt) + LATE_MS;
  const none = (s) => s && ms(s.mwf_remindedon) == null && ms(s.mwf_escalatedon) == null;
  const hasMarker = (v) => ms(v) === MARKER_MS;
  const real = (v) => ms(v) != null && ms(v) !== MARKER_MS;

  add('flow', flow?.on ? 'FAIL' : 'PASS', 'the reminders flow is OFF when the verdict is made', flow?.on ? 'STILL ON: the owner must turn it off' : 'OFF');
  const failedRuns = runs.filter((r) => r.status !== 'Succeeded' && r.status !== 'Running');
  add('runs', failedRuns.length === 0 && runs.some((r) => r.status === 'Succeeded') ? 'PASS' : 'FAIL', 'every finished run of the flow succeeded (none Failed, none Cancelled) and at least one ran',
    `${runs.length} run(s): ${JSON.stringify(runs.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}))}`);
  if (legacy) add('legacy', legacy.found && legacy.round == null && legacy.status === STATUS.Pending && (legacy.modifiedonBefore == null || legacy.modifiedon === legacy.modifiedonBefore) ? 'PASS' : 'FAIL',
    'R4c: the legacy Pending contract (empty approval round) is untouched and did not break a run', `round ${legacy.round}, modifiedon ${legacy.modifiedon}`);

  // claims of the window, with their identity
  const claims = [];
  for (const s of steps) {
    if (real(s.mwf_remindedon)) claims.push({ atMs: ms(s.mwf_remindedon), key: `${s.mwf_approvalstepid}:remind` });
    if (real(s.mwf_escalatedon)) claims.push({ atMs: ms(s.mwf_escalatedon), key: `${s.mwf_approvalstepid}:escalate` });
  }
  const sortedRuns = [...runs].filter((r) => r.startMs != null).sort((x, y) => x.startMs - y.startMs);
  const dues = sortedRuns.map((r) => dueAtRunStart({ steps, contracts, startMs: r.startMs }));
  out.push(...capVerdict({ runs: sortedRuns, claims, dues }));

  let control = false;
  if (windowId === 1) {
    const r5 = entries('r5').map((e) => step(e, 1));
    const okCount = r5.length === 7 && r5.every(Boolean);
    const reminded = r5.filter((s) => s && real(s.mwf_remindedon));
    control = okCount && reminded.length === 7;
    add('R5.reminded', control ? 'PASS' : 'FAIL', 'positive control: each of the 7 steps was reminded, once', `${reminded.length} of ${r5.length} steps have mwf_remindedon`);
    add('R5.timing', okCount && r5.every((s) => s && inWindow(ms(s.mwf_remindedon), ms(s.createdon) + mins(TEST_TIMERS.remindAfterMinutes))) ? 'PASS' : 'FAIL',
      'each reminder is no earlier than 3 minutes after the submission (minus 5 s) and not later than 3 minutes after it was due', '');
    add('R5.only-reminders', okCount && r5.every((s) => s && hasMarker(s.mwf_escalatedon)) ? 'PASS' : 'FAIL', 'the escalation column of each R5 step still holds the marker (only reminders happened)', '');
    const r3 = step(entries('r3')[0] ?? { steps: [] }, 1);
    const due6 = r3 ? ms(r3.createdon) + mins(TEST_TIMERS.escalateAfterMinutes) : 0;
    add('R3', r3 && hasMarker(r3.mwf_remindedon) && real(r3.mwf_escalatedon) && inWindow(ms(r3.mwf_escalatedon), due6) ? 'PASS' : 'FAIL',
      'R3: the already reminded step was ESCALATED once (not reminded again): mwf_remindedon is unchanged, mwf_escalatedon was written at submission + 6 min', r3 ? `reminded ${hasMarker(r3.mwf_remindedon) ? 'marker' : r3.mwf_remindedon}, escalated ${r3.mwf_escalatedon ?? 'empty'}` : 'step missing');

    const a = entries('r4a')[0]; const sa = a ? step(a, 2, 1) : null;
    const shapeA = !!a && !!sa && a.contract.statuscode === STATUS.Pending && a.contract.mwf_approvalround === 2 && sa.mwf_decision === DECISION.Waiting && sa.mwf_actiontype === ACTION_TYPE.Approve;
    add('R4a.shape', shapeA ? 'PASS' : 'FAIL', 'R4a: at verdict time the old-round step is still Waiting (round 1, step 2) and its contract is Pending in round 2 (the test was real, not passing because the step changed)', a ? `contract round ${a.contract.mwf_approvalround}, step ${sa ? DECISION_NAME(sa.mwf_decision) : 'missing'}` : 'contract missing');
    gate(add, 'R4a', control, none(sa), 'R4a: no notice for the step of the old round (both columns empty)');
    const b = entries('r4b')[0]; const sb = b ? step(b, 1, 1) : null;
    const shapeB = !!b && !!sb && b.contract.statuscode === STATUS.Rejected && sb.mwf_decision === DECISION.Waiting && sb.mwf_actiontype === ACTION_TYPE.Approve;
    add('R4b.shape', shapeB ? 'PASS' : 'FAIL', 'R4b: at verdict time the step is still Waiting (round 1) and its contract is Rejected', b ? `contract status ${b.contract.statuscode}, step ${sb ? DECISION_NAME(sb.mwf_decision) : 'missing'}` : 'contract missing');
    gate(add, 'R4b', control, none(sb), 'R4b: no notice for the step of the contract that is no longer Pending Approval (both columns empty)');
  } else {
    const stamp = (v) => { const n = typeof v === 'number' ? v : ms(v); return n == null || !Number.isFinite(n) ? 'empty' : new Date(n).toISOString().slice(0, 19) + 'Z'; };
    const lateOn = (s0) => s0 != null && flow?.onAtMs != null && flow.onAtMs > s0 + LATE_ON_MS;
    const onNote = (s0) => `the flow was turned ON at ${stamp(flow.onAtMs)} (${flow?.onAtSource ?? 'estimated'}), after S0+2:30 (${stamp(s0 + LATE_ON_MS)}), so the time of the notices cannot be judged`;
    const e1 = entries('r1')[0]; const s1 = e1 ? step(e1, 1) : null;
    const S01 = s1 ? ms(s1.createdon) : null;
    const due3 = s1 ? S01 + mins(TEST_TIMERS.remindAfterMinutes) : 0; const due6 = s1 ? S01 + mins(TEST_TIMERS.escalateAfterMinutes) : 0;
    control = !!s1 && real(s1.mwf_remindedon);
    add('R1.reminder', control ? 'PASS' : 'FAIL', 'R1 (positive control): ONE reminder was claimed', s1 ? `remindedon ${stamp(s1.mwf_remindedon)}` : 'step missing');
    add('R1.escalation', !!s1 && real(s1.mwf_escalatedon) && ms(s1.mwf_remindedon) < ms(s1.mwf_escalatedon) ? 'PASS' : 'FAIL', 'R1: ONE escalation was claimed, after the reminder', s1 ? `escalatedon ${stamp(s1.mwf_escalatedon)}` : 'step missing');
    const r1Timing = !!s1 && inWindow(ms(s1.mwf_remindedon), due3) && inWindow(ms(s1.mwf_escalatedon), due6);
    if (s1 && lateOn(S01)) add('R1.timing', 'OBS', `INCONCLUSIVE: R1 timing: ${onNote(S01)}`, `S0 ${stamp(S01)}, due ${stamp(due3)} and ${stamp(due6)}`);
    else add('R1.timing', r1Timing ? 'PASS' : 'FAIL', 'R1: the reminder came between 3 minutes after the submission (minus 5 s) and 3 minutes after it was due, the escalation likewise at 6 minutes', s1 ? `S0 ${stamp(S01)}, due ${stamp(due3)} / ${stamp(due6)}, claimed ${stamp(s1.mwf_remindedon)} / ${stamp(s1.mwf_escalatedon)}` : 'step missing');
    const e2 = entries('r2')[0]; const s2 = e2 ? step(e2, 1) : null;
    add('R2.shape', !!s2 && s2.mwf_decision === DECISION.Approved && ms(s2.mwf_decidedon) != null ? 'PASS' : 'FAIL', 'R2: the seeded answer was written (the step is Approved with a decidedon)', s2 ? DECISION_NAME(s2.mwf_decision) : 'step missing');
    gate(add, 'R2', control, none(s2), 'R2: no notice for the step answered before the time (both columns empty)');
    if (s2) add('R2.values', 'OBS', 'R2 audit: the values on the step at verdict time', `decision ${DECISION_NAME(s2.mwf_decision)} (${s2.mwf_decision}), decidedon ${stamp(s2.mwf_decidedon)}, createdon ${stamp(s2.createdon)}, remindedon ${stamp(s2.mwf_remindedon)}, escalatedon ${stamp(s2.mwf_escalatedon)}`);
    const e6 = entries('r6')[0]; const t1 = e6 ? step(e6, 1) : null; const t2 = e6 ? step(e6, 2) : null;
    const D = t1 ? ms(t1.mwf_decidedon) : null; const S06 = t1 ? ms(t1.createdon) : null;
    const shape6 = !!t1 && !!t2 && t1.mwf_decision === DECISION.Approved && D != null && t2.mwf_decision === DECISION.Waiting;
    add('R6.shape', shape6 ? 'PASS' : 'FAIL', 'R6: step 1 is Approved with a decidedon D and step 2 is Waiting', t1 && t2 ? `${DECISION_NAME(t1.mwf_decision)} / ${DECISION_NAME(t2.mwf_decision)}` : 'steps missing');
    const rem6 = t2 ? ms(t2.mwf_remindedon) : null; const esc6 = t2 ? ms(t2.mwf_escalatedon) : null;
    add('R6.reminder', shape6 && rem6 != null && real(t2.mwf_remindedon) ? 'PASS' : 'FAIL', 'R6: ONE reminder was claimed on step 2', t2 ? `remindedon ${stamp(t2.mwf_remindedon)}` : 'step missing');
    add('R6.escalation', shape6 && esc6 != null && rem6 != null && rem6 < esc6 && real(t2.mwf_escalatedon) ? 'PASS' : 'FAIL', 'R6: ONE escalation was claimed on step 2, after the reminder', t2 ? `escalatedon ${stamp(t2.mwf_escalatedon)}` : 'step missing');
    const keyDetail = rem6 != null && D != null ? `D ${stamp(t1.mwf_decidedon)}, reminder ${stamp(t2.mwf_remindedon)} = ${Math.round((rem6 - D) / 1000)} s after D (the threshold is 180 s minus 5 s)` : 'no reminder';
    if (shape6 && lateOn(S06)) {
      add('R6.not-from-createdon', 'OBS', `INCONCLUSIVE: R6 key check: ${onNote(S06)}`, keyDetail);
      add('R6.timing', 'OBS', `INCONCLUSIVE: R6 timing windows: ${onNote(S06)}`, keyDetail);
    } else {
      add('R6.not-from-createdon', shape6 && rem6 != null && rem6 >= D + mins(TEST_TIMERS.remindAfterMinutes) - EARLY_MS ? 'PASS' : 'FAIL',
        'R6 (the key check): the reminder came at least 3 minutes after D, the answer to step 1, NOT 3 minutes after the submission', keyDetail);
      add('R6.timing', shape6 && rem6 != null && esc6 != null && inWindow(rem6, D + mins(TEST_TIMERS.remindAfterMinutes)) && inWindow(esc6, D + mins(TEST_TIMERS.escalateAfterMinutes)) ? 'PASS' : 'FAIL',
        'R6: the reminder not later than 3 minutes after D + 3 minutes, the escalation between D + 6 minutes (minus 5 s) and 3 minutes after it was due', `escalation ${esc6 != null && D != null ? Math.round((esc6 - D) / 1000) + ' s after D' : 'none'}`);
    }
    if (t1 && t2) add('R6.values', 'OBS', 'R6 audit: the values on the two steps at verdict time', `step 1 ${DECISION_NAME(t1.mwf_decision)} decidedon D = ${stamp(t1.mwf_decidedon)}; step 2 ${DECISION_NAME(t2.mwf_decision)}, createdon ${stamp(t2.createdon)}, remindedon ${stamp(t2.mwf_remindedon)}, escalatedon ${stamp(t2.mwf_escalatedon)}; due by the rule: ${D != null ? stamp(D + mins(3)) + ' / ' + stamp(D + mins(6)) : 'n/a'}`);
  }
  add('control', control ? 'PASS' : 'FAIL', `the positive control of window ${windowId} (${w.control.toUpperCase()}) fired in this window`, control ? 'a notice was claimed' : 'NO notice was claimed: the "no notice" results of this window are INCONCLUSIVE');
  add('simulation', 'OBS', SIMULATION_SENTENCE, '');
  return out;
}

const DECISION_NAME = (v) => Object.entries(DECISION).find(([, x]) => x === v)?.[0] ?? String(v);
/** A "no notice" result counts only if the positive control fired in the same window. */
function gate(add, id, control, quiet, name) {
  if (!control) add(`${id}.quiet`, 'OBS', `INCONCLUSIVE: ${name}`, 'the control of this window did not fire, so silence proves nothing');
  else add(`${id}.quiet`, quiet ? 'PASS' : 'FAIL', name, quiet ? 'both columns empty' : 'a column was written');
}

export const summarize = (results) => ({ pass: results.filter((r) => r.status === 'PASS').length, fail: results.filter((r) => r.status === 'FAIL').length, obs: results.filter((r) => r.status === 'OBS').length });

// ---------------------------------------------------------------------------------------------------------------- baseline: the recipients
/** The five assignments must all resolve to the logged-in user, and that user must have an address. Pure: the script reads the rows. */
export function recipientsVerdict({ assignments, meId, meHasEmail }) {
  const reasons = [];
  if (!Array.isArray(assignments) || assignments.length !== 5) reasons.push(`${assignments?.length ?? 0} active assignment rows, expected 5`);
  for (const a of assignments || []) if (String(a._mwf_user_value ?? '').toLowerCase() !== String(meId ?? '').toLowerCase()) reasons.push(`an assignment (role ${a.mwf_approverrole}) resolves to a different user than the logged-in one`);
  if (!meHasEmail) reasons.push('the logged-in user has no email address');
  return { ok: reasons.length === 0, reasons };
}
