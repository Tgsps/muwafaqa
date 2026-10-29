import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOWS, CASES, MARKER, MARKER_MS, SIMULATION_SENTENCE, STATUS, SEED, TIMED, CAP, FAMILY,
  subjectsOf, caseOfSubject, planLines, claimAttribution, capVerdict, dueAtRunStart, verdict, summarize, recipientsVerdict,
} from './reminder-session.mjs';
import { DECISION, ACTION_TYPE } from './reminder-candidates.mjs';

const T0 = Date.parse('2026-11-01T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const m = (n, s = 0) => n * 60000 + s * 1000;

// ---- an ideal observation of each window, built from the rules (every test below breaks one thing in it)
function mk(windowId) {
  const contracts = []; const steps = []; let n = 0;
  const contract = (name, extra = {}) => { const c = { mwf_contractid: `c${++n}`, mwf_name: name, statuscode: STATUS.Pending, mwf_approvalround: 1, modifiedon: iso(T0), ...extra }; contracts.push(c); return c; };
  const step = (c, order, round, extra = {}) => { const s = { mwf_approvalstepid: `${c.mwf_contractid}-s${order}r${round}`, _mwf_contract_value: c.mwf_contractid, mwf_approvalround: round, mwf_steporder: order, mwf_decision: DECISION.Pending, mwf_actiontype: ACTION_TYPE.Approve, createdon: iso(T0), mwf_decidedon: null, mwf_remindedon: null, mwf_escalatedon: null, ...extra }; steps.push(s); return s; };
  let onAtMs; let runs;
  if (windowId === 1) {
    subjectsOf('r5').forEach((name, i) => { const c = contract(name); step(c, 1, 1, { mwf_decision: DECISION.Waiting, mwf_escalatedon: MARKER, mwf_remindedon: iso(T0 + m(3, i < 5 ? 10 : 70)) }); });
    const c3 = contract(subjectsOf('r3')[0]); step(c3, 1, 1, { mwf_decision: DECISION.Waiting, mwf_remindedon: MARKER, mwf_escalatedon: iso(T0 + m(6, 20)) });
    const c4a = contract(subjectsOf('r4a')[0], { mwf_approvalround: 2 });
    step(c4a, 1, 1, { mwf_decision: DECISION.Approved, mwf_decidedon: iso(T0 + 1000) }); step(c4a, 2, 1, { mwf_decision: DECISION.Waiting });
    step(c4a, 1, 2); step(c4a, 2, 2);
    const c4b = contract(subjectsOf('r4b')[0], { statuscode: STATUS.Rejected }); step(c4b, 1, 1, { mwf_decision: DECISION.Waiting });
    onAtMs = T0 + m(1, 50);
    runs = Array.from({ length: 8 }, (_, i) => ({ startMs: T0 + m(2 + i, 5), endMs: T0 + m(2 + i, 25), status: 'Succeeded' }));
  } else {
    const c1 = contract(subjectsOf('r1')[0]); step(c1, 1, 1, { mwf_decision: DECISION.Waiting, mwf_remindedon: iso(T0 + m(3, 20)), mwf_escalatedon: iso(T0 + m(6, 20)) });
    const c2 = contract(subjectsOf('r2')[0]); step(c2, 1, 1, { mwf_decision: DECISION.Approved, mwf_decidedon: iso(T0 + m(1)) });
    const D = T0 + m(2, 30);
    const c6 = contract(subjectsOf('r6')[0]); step(c6, 1, 1, { mwf_decision: DECISION.Approved, mwf_decidedon: iso(D) });
    step(c6, 2, 1, { mwf_decision: DECISION.Waiting, mwf_remindedon: iso(D + m(3, 40)), mwf_escalatedon: iso(D + m(6, 40)) });
    onAtMs = T0 + m(1, 40);
    runs = Array.from({ length: 11 }, (_, i) => ({ startMs: T0 + m(2 + i, 5), endMs: T0 + m(2 + i, 25), status: 'Succeeded' }));
  }
  return { windowId, contracts, steps, runs, flow: { on: false, onAtMs }, legacy: { found: true, round: null, status: STATUS.Pending, modifiedon: 'x', modifiedonBefore: 'x' } };
}
const by = (res, id) => res.find((r) => r.id === id);
const failing = (res) => res.filter((r) => r.status === 'FAIL').map((r) => r.id);
const clone = (o) => structuredClone(o);
const stepOf = (o, name, order, round = 1) => { const c = o.contracts.find((x) => x.mwf_name === name); return o.steps.find((s) => s._mwf_contract_value === c.mwf_contractid && s.mwf_steporder === order && s.mwf_approvalround === round); };

test('an ideal window 1 passes every check, and says that v2 is simulated', () => {
  const r = verdict(mk(1));
  assert.deepEqual(failing(r), []);
  assert.equal(by(r, 'control').status, 'PASS');
  assert.equal(by(r, 'R4a.quiet').status, 'PASS'); assert.equal(by(r, 'R4b.quiet').status, 'PASS');
  assert.equal(by(r, 'cap.max').status, 'PASS'); assert.match(by(r, 'cap.max').detail, /\[0,5,2,0,1,0,0,0\]/);
  const sim = by(r, 'simulation'); assert.equal(sim.status, 'OBS'); assert.equal(sim.name, SIMULATION_SENTENCE);
  assert.match(SIMULATION_SENTENCE, /^v2 simulated by seeded rows/);
});

test('an ideal window 2 passes every check', () => {
  const r = verdict(mk(2));
  assert.deepEqual(failing(r), []);
  assert.equal(by(r, 'R2.quiet').status, 'PASS'); assert.equal(by(r, 'R6.not-from-createdon').status, 'PASS');
});

test('B: if the positive control did not fire, "no notice" in R4a, R4b and R2 is INCONCLUSIVE (OBS), never PASS, and the control itself FAILS', () => {
  const o1 = clone(mk(1)); for (const s of o1.steps.filter((x) => String(x._mwf_contract_value) && o1.contracts.find((c) => c.mwf_contractid === x._mwf_contract_value).mwf_name.includes('-R5-'))) s.mwf_remindedon = null;
  const r1 = verdict(o1);
  assert.equal(by(r1, 'control').status, 'FAIL');
  for (const id of ['R4a.quiet', 'R4b.quiet']) { assert.equal(by(r1, id).status, 'OBS', id); assert.match(by(r1, id).name, /^INCONCLUSIVE/); }
  assert.ok(!r1.some((x) => x.id.endsWith('.quiet') && x.status === 'PASS'));
  const o2 = clone(mk(2)); const s1 = stepOf(o2, subjectsOf('r1')[0], 1); s1.mwf_remindedon = null; s1.mwf_escalatedon = null;
  const r2 = verdict(o2);
  assert.equal(by(r2, 'control').status, 'FAIL'); assert.equal(by(r2, 'R2.quiet').status, 'OBS'); assert.match(by(r2, 'R2.quiet').name, /^INCONCLUSIVE/);
});

test('a notice written for the orphan steps (R4a, R4b) or for the answered step (R2) FAILS when the control fired', () => {
  const a = clone(mk(1)); stepOf(a, subjectsOf('r4a')[0], 2).mwf_remindedon = iso(T0 + m(4));
  assert.ok(failing(verdict(a)).includes('R4a.quiet'));
  const b = clone(mk(1)); stepOf(b, subjectsOf('r4b')[0], 1).mwf_escalatedon = iso(T0 + m(7));
  assert.ok(failing(verdict(b)).includes('R4b.quiet'));
  const c = clone(mk(2)); stepOf(c, subjectsOf('r2')[0], 1).mwf_remindedon = iso(T0 + m(4));
  assert.ok(failing(verdict(c)).includes('R2.quiet'));
});

test('A: the seed must still be in place at verdict time; a step that changed makes the shape check FAIL (silence must not come from a step that is no longer Waiting)', () => {
  const a = clone(mk(1)); stepOf(a, subjectsOf('r4a')[0], 2).mwf_decision = DECISION.Approved;
  assert.ok(failing(verdict(a)).includes('R4a.shape'));
  const a2 = clone(mk(1)); a2.contracts.find((c) => c.mwf_name === subjectsOf('r4a')[0]).mwf_approvalround = 1;   // the contract is back in round 1: the step would be current
  assert.ok(failing(verdict(a2)).includes('R4a.shape'));
  const b = clone(mk(1)); b.contracts.find((c) => c.mwf_name === subjectsOf('r4b')[0]).statuscode = STATUS.Pending;
  assert.ok(failing(verdict(b)).includes('R4b.shape'));
  const c = clone(mk(2)); stepOf(c, subjectsOf('r2')[0], 1).mwf_decision = DECISION.Waiting;
  assert.ok(failing(verdict(c)).includes('R2.shape'));
});

test('the cap: more than 5 claims in one run FAILS; a run with 5 or more steps due that claimed fewer than 5 FAILS', () => {
  const over = clone(mk(1));
  for (const n of subjectsOf('r5')) stepOf(over, n, 1).mwf_remindedon = iso(T0 + m(3, 10));   // all 7 in the first run
  assert.ok(failing(verdict(over)).includes('cap.max'));
  const under = clone(mk(1));
  subjectsOf('r5').forEach((n, i) => { stepOf(under, n, 1).mwf_remindedon = iso(T0 + m(3, i < 4 ? 10 : 70)); });   // 4 then 3, although 7 were due at the first run
  const r = verdict(under);
  assert.ok(failing(r).includes('cap.exact')); assert.equal(by(r, 'cap.max').status, 'PASS');
});

test('R5: a missing reminder, a reminder that came too early, and an escalation written for an R5 step FAIL', () => {
  const miss = clone(mk(1)); stepOf(miss, subjectsOf('r5')[3], 1).mwf_remindedon = null;
  assert.ok(failing(verdict(miss)).includes('R5.reminded'));
  const early = clone(mk(1)); stepOf(early, subjectsOf('r5')[0], 1).mwf_remindedon = iso(T0 + m(2));
  assert.ok(failing(verdict(early)).includes('R5.timing'));
  const esc = clone(mk(1)); stepOf(esc, subjectsOf('r5')[0], 1).mwf_escalatedon = iso(T0 + m(7));
  assert.ok(failing(verdict(esc)).includes('R5.only-reminders'));
});

test('R3: reminded again (the marker was overwritten), escalated too early, or not escalated at all FAILS', () => {
  const again = clone(mk(1)); stepOf(again, subjectsOf('r3')[0], 1).mwf_remindedon = iso(T0 + m(4));
  assert.ok(failing(verdict(again)).includes('R3'));
  const early = clone(mk(1)); stepOf(early, subjectsOf('r3')[0], 1).mwf_escalatedon = iso(T0 + m(4));
  assert.ok(failing(verdict(early)).includes('R3'));
  const none = clone(mk(1)); stepOf(none, subjectsOf('r3')[0], 1).mwf_escalatedon = null;
  assert.ok(failing(verdict(none)).includes('R3'));
});

test('R1: a reminder before 3 minutes, or one more than 3 minutes late, an escalation before the reminder FAIL', () => {
  const early = clone(mk(2)); stepOf(early, subjectsOf('r1')[0], 1).mwf_remindedon = iso(T0 + m(2, 30));
  assert.ok(failing(verdict(early)).includes('R1.timing'));
  const late = clone(mk(2)); stepOf(late, subjectsOf('r1')[0], 1).mwf_remindedon = iso(T0 + m(7));
  assert.ok(failing(verdict(late)).includes('R1.timing'));
  const order = clone(mk(2)); const s = stepOf(order, subjectsOf('r1')[0], 1); s.mwf_escalatedon = iso(T0 + m(3, 5));
  assert.ok(failing(verdict(order)).includes('R1.escalation'));
  const none = clone(mk(2)); stepOf(none, subjectsOf('r1')[0], 1).mwf_escalatedon = null;
  assert.ok(failing(verdict(none)).includes('R1.escalation'));
});

test('R6, the key check: a reminder counted from the SUBMISSION (3 minutes after it, before D + 3 minutes) FAILS', () => {
  const o = clone(mk(2)); stepOf(o, subjectsOf('r6')[0], 2).mwf_remindedon = iso(T0 + m(3, 20));
  const r = verdict(o);
  assert.ok(failing(r).includes('R6.not-from-createdon'));
  assert.match(by(r, 'R6.not-from-createdon').detail, /-?\d+ s after D/);
  const noD = clone(mk(2)); stepOf(noD, subjectsOf('r6')[0], 1).mwf_decidedon = null;
  assert.ok(failing(verdict(noD)).includes('R6.shape'));
});

test('C: the flow still ON at verdict time FAILS and says STILL ON; a Failed or Cancelled run FAILS; the legacy contract changed FAILS', () => {
  const on = clone(mk(1)); on.flow.on = true;
  const r = verdict(on); assert.ok(failing(r).includes('flow')); assert.match(by(r, 'flow').detail, /STILL ON/);
  const failedRun = clone(mk(1)); failedRun.runs[2].status = 'Failed';
  assert.ok(failing(verdict(failedRun)).includes('runs'));
  const cancelled = clone(mk(1)); cancelled.runs[2].status = 'Cancelled';
  assert.ok(failing(verdict(cancelled)).includes('runs'));
  const noRuns = clone(mk(1)); noRuns.runs = [];
  assert.ok(failing(verdict(noRuns)).includes('runs'));
  const leg = clone(mk(1)); leg.legacy.modifiedon = 'y';
  assert.ok(failing(verdict(leg)).includes('legacy'));
  const leg2 = clone(mk(1)); leg2.legacy.round = 1;
  assert.ok(failing(verdict(leg2)).includes('legacy'));
});


test('dueAtRunStart uses the columns as they were at the start of the run (a later claim is invisible)', () => {
  const o = mk(1);
  const start = T0 + m(3, 5);
  assert.equal(dueAtRunStart({ steps: o.steps, contracts: o.contracts, startMs: start }), 7);
  assert.equal(dueAtRunStart({ steps: o.steps, contracts: o.contracts, startMs: T0 + m(1) }), 0);
  assert.equal(dueAtRunStart({ steps: o.steps, contracts: o.contracts, startMs: T0 + m(4, 5) }), 2);   // the first 5 are reminded by then
});

test('the cases: subjects are unique, belong to their window prefix, no window prefix is a prefix of another, and every subject maps back to its case', () => {
  assert.equal(CAP, 5);
  const all = Object.keys(CASES).flatMap((k) => subjectsOf(k));
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.length, 7 + 1 + 1 + 1 + 1 + 1 + 1);
  assert.ok(all.every((s) => s.startsWith(FAMILY)));
  assert.ok(!WINDOWS[1].prefix.startsWith(WINDOWS[2].prefix) && !WINDOWS[2].prefix.startsWith(WINDOWS[1].prefix));
  for (const [k, c] of Object.entries(CASES)) for (const s of subjectsOf(k)) { assert.equal(caseOfSubject(s), k, s); assert.ok(s.startsWith(WINDOWS[c.window].prefix + '-'), s); }
  for (const bad of ['TEST-TMP-REM3-R1', 'TEST-TMP-REM1-R1', 'TEST-TMP-REM2-R5-1', 'something', '', null, 'TEST-TMP-REM1-R5-x']) assert.equal(caseOfSubject(bad), null, String(bad));
  assert.deepEqual(WINDOWS[1].cases.concat(WINDOWS[2].cases).sort(), Object.keys(CASES).sort());
  assert.ok(WINDOWS[1].cases.includes(WINDOWS[1].control) && WINDOWS[2].cases.includes(WINDOWS[2].control));
});

test('the seeds: a marker is obviously old, a Waiting seed carries the decision of v2, an answer carries the decision and the time', () => {
  assert.equal(MARKER, '2001-01-01T00:00:00Z'); assert.equal(MARKER_MS, Date.parse(MARKER));
  assert.deepEqual(SEED.waiting(), { mwf_decision: DECISION.Waiting });
  assert.deepEqual(SEED.waitingEscalatedMarker(), { mwf_decision: DECISION.Waiting, mwf_escalatedon: MARKER });
  assert.deepEqual(SEED.waitingRemindedMarker(), { mwf_decision: DECISION.Waiting, mwf_remindedon: MARKER });
  assert.deepEqual(SEED.approvedAt('2026-11-01T10:00:00Z'), { mwf_decision: DECISION.Approved, mwf_decidedon: '2026-11-01T10:00:00Z' });
  assert.deepEqual(TIMED, { r2AnswerAfterS: 60, r6AnswerAfterS: 150 });
  assert.ok(TIMED.r2AnswerAfterS < 180 && TIMED.r6AnswerAfterS < 180);   // both answers are written before the first reminder could be due
});

test('A and D in the plan text: the late seeds, what the flow sees, real waiting, and the simulation sentence', () => {
  const p1 = planLines(1).join('\n');
  assert.match(p1, /LAST \(after the contract transition\) the step 2 of ROUND 1 is made Waiting/);
  assert.match(p1, /LAST \(after that transition\) step 1 is made Waiting/);
  assert.match(p1, /the setup FAILS unless it is Waiting, round 1, step order 2/);
  assert.match(p1, /what the flow sees when it scans it: the contract is Pending Approval with approval round 2/);
  assert.match(p1, /the contract is Rejected \(inactive\)/);
  assert.match(p1, /REAL time/); assert.match(p1, /PASS only if the control of the window fired/);
  assert.match(p1, /marker 2001-01-01T00:00:00Z/);
  assert.match(p1, /7 reminders \+ 1 escalation = 8 emails/);
  assert.match(p1, new RegExp(SIMULATION_SENTENCE.slice(0, 40)));
  const p2 = planLines(2).join('\n');
  assert.match(p2, /NO reminder before D\+3 min/); assert.match(p2, /4 emails at most/);
  assert.match(p2, /control of the window \(R1\) fired/);
  assert.throws(() => planLines(3), /window must be 1 or 2/);
});

test('E: the recipients: five assignments that all resolve to the logged-in user pass; any other user, a wrong count or no address FAILS', () => {
  const me = 'aaaaaaaa-0000-4000-8000-000000000001';
  const five = Array.from({ length: 5 }, (_, i) => ({ mwf_approverrole: 867640000 + i, _mwf_user_value: me.toUpperCase() }));
  assert.deepEqual(recipientsVerdict({ assignments: five, meId: me, meHasEmail: true }), { ok: true, reasons: [] });
  const other = five.map((a, i) => (i === 3 ? { ...a, _mwf_user_value: 'bbbbbbbb-0000-4000-8000-000000000002' } : a));
  const r = recipientsVerdict({ assignments: other, meId: me, meHasEmail: true });
  assert.equal(r.ok, false); assert.match(r.reasons[0], /different user than the logged-in one/);
  assert.equal(recipientsVerdict({ assignments: five.slice(0, 4), meId: me, meHasEmail: true }).ok, false);
  assert.equal(recipientsVerdict({ assignments: five, meId: me, meHasEmail: false }).ok, false);
  assert.equal(recipientsVerdict({ assignments: undefined, meId: me, meHasEmail: true }).ok, false);
  assert.equal(recipientsVerdict({ assignments: [...five.slice(0, 4), { mwf_approverrole: 9, _mwf_user_value: null }], meId: me, meHasEmail: true }).ok, false);
});

test('summarize counts PASS, FAIL and OBS', () => {
  assert.deepEqual(summarize([{ status: 'PASS' }, { status: 'PASS' }, { status: 'FAIL' }, { status: 'OBS' }]), { pass: 2, fail: 1, obs: 1 });
  assert.throws(() => verdict({ windowId: 3, contracts: [], steps: [], runs: [], flow: {} }), /window must be 1 or 2/);
});

// ---- the attribution of claims to runs: CONTAINMENT, with the REAL timings of window 1 (2026-10-29) as fixtures
const Dt = (hms) => Date.parse(`2026-10-29T${hms}Z`);
// the 9 runs of the reminders flow (start, end): 17 to 85 seconds on a 60-second interval; they overlap
const REAL_RUNS = [['08:32:09', '08:32:54'], ['08:33:09', '08:34:25'], ['08:34:10', '08:34:27'], ['08:35:10', '08:35:28'], ['08:36:11', '08:37:35'],
  ['08:37:11', '08:37:32'], ['08:38:12', '08:38:30'], ['08:39:12', '08:40:20'], ['08:41:13', '08:41:30']].map(([s, e]) => ({ startMs: Dt(s), endMs: Dt(e), status: 'Succeeded' }));
// the 8 claims (the reminders of R5-4, -2, -5, -3, -1, -6, -7 and the escalation of R3 at 08:37:09)
const REAL_CLAIMS = [['08:32:12', 'r5-4:remind'], ['08:32:19', 'r5-2:remind'], ['08:32:23', 'r5-5:remind'], ['08:32:29', 'r5-3:remind'], ['08:32:34', 'r5-1:remind'],
  ['08:33:50', 'r5-6:remind'], ['08:33:59', 'r5-7:remind'], ['08:37:09', 'r3:escalate']].map(([tm, key]) => ({ atMs: Dt(tm), key }));
const REAL_DUES = [7, 2, 0, 0, 1, 0, 0, 0, 0];   // as the verdict computed them
const idsOf = (res) => Object.fromEntries(res.map((r) => [r.id, r]));

test('REAL timings: each claim lies inside exactly one run; the escalation of R3 (08:37:09Z) belongs to run 4 (08:36:11 to 08:37:35), not to run 5 that started two seconds later', () => {
  const a = claimAttribution(REAL_RUNS, REAL_CLAIMS);
  assert.deepEqual(a.inside, [5, 2, 0, 0, 1, 0, 0, 0, 0]);
  assert.equal(a.attributed.length, 8); assert.deepEqual(a.ambiguous, []); assert.deepEqual(a.unattributed, []);
  assert.equal(a.attributed.find((c) => c.key === 'r3:escalate').run, 4);
  assert.deepEqual(a.attributed.filter((c) => c.run === 0).map((c) => c.key).sort(), ['r5-1:remind', 'r5-2:remind', 'r5-3:remind', 'r5-4:remind', 'r5-5:remind']);
  assert.deepEqual(a.attributed.filter((c) => c.run === 1).map((c) => c.key).sort(), ['r5-6:remind', 'r5-7:remind']);
  // the previous rule (the run that started last before the claim, with 2 seconds of slack) gave run 5 for the escalation: it was wrong
  const old = REAL_RUNS.map((r, i) => (r.startMs - 2000 <= Dt('08:37:09') ? i : -1)).filter((i) => i >= 0).pop();
  assert.equal(old, 5);
});

test('REAL timings: the overlapping runs are found (1 and 2, 4 and 5) and no other', () => {
  const a = claimAttribution(REAL_RUNS, REAL_CLAIMS);
  assert.deepEqual(a.overlaps, [[], [2], [1], [], [5], [4], [], [], []]);
  assert.equal(a.overlapping, true);
  const durations = REAL_RUNS.map((r) => Math.round((r.endMs - r.startMs) / 1000));
  assert.equal(Math.min(...durations), 17); assert.equal(Math.max(...durations), 84);   // from whole-second stamps; the measured durations were 16.6 to 84.8 seconds
});

test('REAL timings: the cap verdict passes, says that the runs overlap and that the check is weaker, and does not evaluate the exact cap for overlapping runs', () => {
  const r = idsOf(capVerdict({ runs: REAL_RUNS, claims: REAL_CLAIMS, dues: REAL_DUES }));
  assert.equal(r['cap.max'].status, 'PASS'); assert.match(r['cap.max'].detail, /\[5,2,0,0,1,0,0,0,0\]/);
  assert.equal(r['cap.exact'].status, 'PASS');   // run 0 had 7 due and claimed 5; it overlaps nothing
  assert.equal(r['claims.attribution'].status, 'PASS');
  assert.equal(r['cap.overlap'].status, 'OBS'); assert.match(r['cap.overlap'].name, /WEAKER/); assert.match(r['cap.overlap'].detail, /1&2, 4&5/);
});

test('AMBIGUOUS: a claim inside two overlapping runs is reported as ambiguous with both runs, given to neither, and counted in both windows', () => {
  const claims = [...REAL_CLAIMS, { atMs: Dt('08:37:20'), key: 'x:escalate' }];   // inside run 4 (to 08:37:35) and run 5 (from 08:37:11)
  const a = claimAttribution(REAL_RUNS, claims);
  assert.deepEqual(a.ambiguous.map((c) => c.runs), [[4, 5]]);
  assert.equal(a.attributed.some((c) => c.key === 'x:escalate'), false);
  assert.deepEqual(a.inside, [5, 2, 0, 0, 2, 1, 0, 0, 0]);
  const r = idsOf(capVerdict({ runs: REAL_RUNS, claims, dues: REAL_DUES }));
  assert.equal(r['claims.attribution'].status, 'OBS'); assert.match(r['claims.attribution'].detail, /ambiguous: runs 4, 5 \(escalate at 08:37:20Z/);
  assert.equal(r['cap.max'].status, 'PASS');
});

test('UNATTRIBUTED: a claim inside no run (between 08:40:20 and 08:41:13) is an OBS, not a failure, and not given to a run', () => {
  const claims = [...REAL_CLAIMS, { atMs: Dt('08:40:40'), key: 'y:remind' }];
  const a = claimAttribution(REAL_RUNS, claims);
  assert.equal(a.unattributed.length, 1); assert.equal(a.attributed.length, 8);
  const r = idsOf(capVerdict({ runs: REAL_RUNS, claims, dues: REAL_DUES }));
  assert.equal(r['claims.attribution'].status, 'OBS'); assert.match(r['claims.attribution'].detail, /unattributed: remind at 08:40:40Z lies inside no run/);
  assert.equal(r['cap.max'].status, 'PASS');
});

test('containment has no slack: one millisecond before the start is outside, the start and the end are inside; a run without an end time is open ended', () => {
  const runs = [{ startMs: 1000, endMs: 2000 }, { startMs: 5000, endMs: null }];
  const a = claimAttribution(runs, [{ atMs: 999 }, { atMs: 1000 }, { atMs: 2000 }, { atMs: 2001 }, { atMs: 4999 }, { atMs: 5000 }, { atMs: 900000 }]);
  assert.deepEqual(a.inside, [2, 2]); assert.equal(a.unattributed.length, 3);
  assert.deepEqual(claimAttribution([], [{ atMs: 1 }]).unattributed.length, 1);
  assert.deepEqual(claimAttribution([{ startMs: null, endMs: 5 }], [{ atMs: 1 }]).runs, []);   // a run without a start is ignored
});

test('the cap check is conservative with overlap: a window that holds the claims of two concurrent runs FAILS and says it may be a false alarm; a single run over the cap FAILS plainly', () => {
  const runs = [{ startMs: 0, endMs: 100000 }, { startMs: 50000, endMs: 150000 }];
  const four = (base) => Array.from({ length: 4 }, (_, i) => ({ atMs: base + i, key: `k${base}${i}:remind` }));
  const both = capVerdict({ runs, claims: [...four(60000), ...four(70000)], dues: [0, 0] }).find((x) => x.id === 'cap.max');   // 8 claims inside both windows
  assert.equal(both.status, 'FAIL'); assert.match(both.detail, /possible false alarm/);
  const solo = capVerdict({ runs: [{ startMs: 0, endMs: 1000 }], claims: Array.from({ length: 6 }, (_, i) => ({ atMs: 100 + i, key: `z${i}:remind` })), dues: [6] }).find((x) => x.id === 'cap.max');
  assert.equal(solo.status, 'FAIL'); assert.doesNotMatch(solo.detail, /false alarm/); assert.match(solo.detail, /over the cap: run 0/);
});

test('cap.exact: FAILS for a run that overlaps nothing, had 5 or more due and claimed fewer; NOT evaluated (said in the detail) for an overlapping run', () => {
  const alone = capVerdict({ runs: [{ startMs: 0, endMs: 1000 }], claims: Array.from({ length: 4 }, (_, i) => ({ atMs: 10 + i, key: `a${i}:remind` })), dues: [7] }).find((x) => x.id === 'cap.exact');
  assert.equal(alone.status, 'FAIL'); assert.match(alone.detail, /wrong: run 0/);
  const runs = [{ startMs: 0, endMs: 1000 }, { startMs: 500, endMs: 1500 }];
  const over = capVerdict({ runs, claims: Array.from({ length: 4 }, (_, i) => ({ atMs: 10 + i, key: `b${i}:remind` })), dues: [7, 0] }).find((x) => x.id === 'cap.exact');
  assert.equal(over.status, 'PASS'); assert.match(over.detail, /NOT evaluated for the overlapping run\(s\) run 0/);
});

test('the verdict uses the new attribution: runs that overlap give an OBS and may give a false alarm on the cap, never a silent pass', () => {
  const o = mk(1);
  o.runs = o.runs.map((r) => ({ ...r, endMs: r.startMs + 80000 }));   // 80-second runs on a 60-second interval: every run overlaps its neighbours
  const r = verdict(o);
  assert.equal(by(r, 'cap.overlap').status, 'OBS');
  assert.equal(by(r, 'cap.max').status, 'FAIL'); assert.match(by(r, 'cap.max').detail, /possible false alarm/);
  assert.equal(by(r, 'claims.attribution').status, 'OBS');
  const ideal = verdict(mk(1));
  assert.equal(by(ideal, 'claims.attribution').status, 'PASS'); assert.equal(by(ideal, 'cap.overlap'), undefined);
  assert.ok(!ideal.some((x) => /[0-9a-f]{8}-[0-9a-f]{4}/i.test(x.detail + x.name)), 'no id in the output');
});

// ---- window 2: the flow turned ON late, and the audit values
import { LATE_ON_MS } from './reminder-session.mjs';

test('the late-ON limit is S0 + 2:30', () => { assert.equal(LATE_ON_MS, 150000); });

test('the flow turned ON LATER than S0+2:30: the timing of R1 and R6 is INCONCLUSIVE (OBS), not FAIL, and says why; the notices must still exist', () => {
  const o = clone(mk(2)); o.flow = { on: false, onAtMs: T0 + m(3, 10), onAtSource: 'reported' };
  // the first scan after the ON finds everything due: the reminders and escalations come at once (they are late for R1; for R6 the reminder is no longer distinguishable)
  stepOf(o, subjectsOf('r1')[0], 1).mwf_remindedon = iso(T0 + m(4, 10)); stepOf(o, subjectsOf('r1')[0], 1).mwf_escalatedon = iso(T0 + m(8, 20));
  stepOf(o, subjectsOf('r6')[0], 2).mwf_remindedon = iso(T0 + m(5, 40)); stepOf(o, subjectsOf('r6')[0], 2).mwf_escalatedon = iso(T0 + m(8, 50));
  const r = verdict(o);
  assert.deepEqual(failing(r), []);
  for (const id of ['R1.timing', 'R6.timing', 'R6.not-from-createdon']) { assert.equal(by(r, id).status, 'OBS', id); assert.match(by(r, id).name, /^INCONCLUSIVE/, id); assert.match(by(r, id).name, /turned ON at 2026-11-01T10:03:10Z \(reported\), after S0\+2:30 \(2026-11-01T10:02:30Z\)/, id); }
  assert.equal(by(r, 'R1.reminder').status, 'PASS'); assert.equal(by(r, 'R6.reminder').status, 'PASS');
  // the notices must still exist: a missing reminder FAILS even when the ON was late
  const miss = clone(o); stepOf(miss, subjectsOf('r1')[0], 1).mwf_remindedon = null; stepOf(miss, subjectsOf('r1')[0], 1).mwf_escalatedon = null;
  assert.ok(failing(verdict(miss)).includes('R1.reminder'));
  const miss6 = clone(o); stepOf(miss6, subjectsOf('r6')[0], 2).mwf_remindedon = null;
  assert.ok(failing(verdict(miss6)).includes('R6.reminder'));
});

test('the flow turned ON in time (at or before S0+2:30): the timing checks are real (PASS or FAIL), also when the ON time is only estimated', () => {
  const okAt = (onAtMs, source) => { const o = clone(mk(2)); o.flow = { on: false, onAtMs, onAtSource: source }; return verdict(o); };
  for (const [at, source] of [[T0 + m(1, 40), 'reported'], [T0 + m(2, 30), 'reported'], [T0 + m(2, 0), 'estimated']]) {
    const r = okAt(at, source);
    assert.deepEqual(failing(r), []);
    for (const id of ['R1.timing', 'R6.timing', 'R6.not-from-createdon']) assert.equal(by(r, id).status, 'PASS', `${id} at ${at}`);
  }
  const late1 = clone(mk(2)); late1.flow = { on: false, onAtMs: T0 + m(2, 0), onAtSource: 'estimated' }; stepOf(late1, subjectsOf('r6')[0], 2).mwf_remindedon = iso(T0 + m(3, 20));
  assert.ok(failing(verdict(late1)).includes('R6.not-from-createdon'));   // the ON was in time, so a reminder counted from the submission FAILS
  const x = clone(mk(2)); x.flow = { on: false, onAtMs: T0 + m(2, 31), onAtSource: 'reported' };
  assert.equal(by(verdict(x), 'R1.timing').status, 'OBS');   // one second after the limit
});

test('the audit values for R2 and R6 carry the UTC timestamps of the seeded and written values (no id)', () => {
  const r = verdict(mk(2));
  const r2 = by(r, 'R2.values'); const r6 = by(r, 'R6.values');
  assert.equal(r2.status, 'OBS'); assert.equal(r6.status, 'OBS');
  assert.match(r2.detail, /decision Approved \(867640002\), decidedon 2026-11-01T10:01:00Z, createdon 2026-11-01T10:00:00Z, remindedon empty, escalatedon empty/);
  assert.match(r6.detail, /step 1 Approved decidedon D = 2026-11-01T10:02:30Z; step 2 Waiting, createdon 2026-11-01T10:00:00Z, remindedon 2026-11-01T10:06:10Z, escalatedon 2026-11-01T10:09:10Z; due by the rule: 2026-11-01T10:05:30Z \/ 2026-11-01T10:08:30Z/);
  assert.match(by(r, 'R6.not-from-createdon').detail, /reminder 2026-11-01T10:06:10Z = 220 s after D/);
  assert.ok(!r.some((x) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(x.detail + x.name)));
  assert.equal(verdict(mk(1)).some((x) => x.id === 'R2.values'), false);
});
