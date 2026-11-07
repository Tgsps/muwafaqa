/**
 * The test session of the flow "Muwafaqa - Obligation Alerts" (test variant): pure parts (the cases, the seeds with their due dates and margins, the plan, the
 * verdict) and the modes that read and write through an injected `call` (baseline, setup, await, verdict, cleanup). ONE WINDOW HAS BEEN RUN (the night of 2026-11-03/04: setup, await and verdict; its cleanup ran on 2026-11-07). State of the flow at the time of writing (2026-11-07): the first flow was deleted by the owner after the window of 2026-11-03/04; the Try/catch definition (generator commit cb9ac80) was created OFF on 2026-11-07 and read back identical to the generated one; it has never been turned on and has no run. The modes read the real state themselves: baseline, setup, await and verdict stop unless exactly one flow row of this name exists and every flow is OFF; cleanup accepts no such row (a missing flow cannot run) but still refuses while any flow is ON. The modes are also covered
 * by unit tests against a mocked environment. scripts/test-flow-obligation-alerts.mjs is the command line.
 *
 * What the script MEASURES itself: alert log rows (key, creation time), obligation and contract state, flow rows (ON / OFF and when it changed), flow run records
 * (start, end, status), the key index status, counters. What only the OWNER can read, by eye: the mailbox (number, recipient, text) and the run history in the designer (the
 * output of the failed insert of case 13, the Compose_claim_failure output, retries). This module never reads a mailbox in any way.
 *
 * Nothing here turns a flow on or off, saves or publishes one, or writes to the table of flows. Counters are touched ONLY with the explicit approval flag (setup consumes one
 * number by creating the Draft contract; cleanup restores it by the rule of lib/counter-snapshot.mjs).
 */
import { TEST_CONSTANTS, TYPE_DUE_SOON, TYPE_OVERDUE } from '../build-flow-obligation-alerts.mjs';
import { buildAlertKey, parseAlertKey, AlertKeyError } from './alert-key.mjs';
import { OBLIGATION_STATUS, PARTY } from './obligation-schema.mjs';
import { claimAttribution, capVerdict, summarize } from './reminder-session.mjs';
import { snapshotCounters, restoreCounters } from './counter-snapshot.mjs';
import { deleteContracts, STATUS } from './contract-cleanup.mjs';
import { keyGate } from './obligation-schema.mjs';

export { summarize };
export const FAMILY = 'TEST-TMP-OBL';
export const FLOW_NAME = 'Muwafaqa - Obligation Alerts';
export const CONTRACT_TYPE = 867640000;   // the counter row consumed by the one Draft contract (the prefix is read from the environment at setup and printed)
export const PARAMS = Object.freeze({ ...TEST_CONSTANTS });   // lead 5, lookback 30, interval 1 minute: the TEST CONSTANTS of the generator
const MIN = 60000;
/** The flow must be turned ON no later than this after the seeds were written (the due-soon obligation would otherwise change class: section "Margins"). */
export const ARM_LIMIT_MS = 5 * MIN;
/** How long after the ON a first scan can still be waited for (one interval plus the longest run of the reminders flow, 84.8 s, rounded up): ESTIMATE from the reminders flow. */
export const FIRST_SCAN_MS = 150000;
export const RUN_SLACK_MS = 90000;
/** The smallest distance, in seconds, that any seed may have to a classification boundary at the worst arming time. A unit test holds it. */
export const MIN_MARGIN_S = 90;
export const ON_MINUTES = 10;
export const MARKER_NOTE = 'No marker rows are used: every due date is relative to the real clock at the moment the seeds are written.';

const isoSec = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');   // yyyy-MM-ddTHH:mm:ssZ, seconds precision, as the Web API writes it
const clock = (ms) => `${new Date(ms).toISOString().slice(11, 19)}Z`;

/**
 * The cases. dueOffsetS: seconds relative to BASE (the moment the seeds are written); spreadS: each further obligation of the case is that much earlier (keeps the order of due dates stable).
 * expect: the alert types that must exist for each obligation of the case. control: the positive controls (a "no alert" case counts only if both fired).
 */
export const CASES = Object.freeze({
  duesoon: { label: 'due soon, inside the lead time', count: 1, status: 'Open', dueOffsetS: 10 * 60, spreadS: 0, expect: 'one DUESOON alert (a second, OVERDUE alert is specified once the due date has passed while the flow is still ON)', control: 'duesoon', observer: 'script: alert log; owner: mailbox' },
  overduein: { label: 'overdue, inside the lookback (7 of them: the cap case)', count: 7, status: 'Open', dueOffsetS: -8 * 60, spreadS: 5, expect: 'one OVERDUE alert each: 5 in the first run that sees them, the other 2 in a later run', control: 'overdue', observer: 'script: alert log, run attribution; owner: mailbox' },
  overdueout: { label: 'overdue, outside the lookback', count: 1, status: 'Open', dueOffsetS: -50 * 60, spreadS: 0, expect: 'no alert', observer: 'script: alert log' },
  beyondlead: { label: 'due beyond the lead time', count: 1, status: 'Open', dueOffsetS: 120 * 60, spreadS: 0, expect: 'no alert', observer: 'script: alert log' },
  disputed: { label: 'Disputed, overdue inside the lookback', count: 1, status: 'Disputed', dueOffsetS: -8 * 60, spreadS: 0, expect: 'no alert', observer: 'script: alert log' },
  done: { label: 'Done, overdue inside the lookback', count: 1, status: 'Done', dueOffsetS: -8 * 60, spreadS: 0, expect: 'no alert', observer: 'script: alert log' },
  preinserted: { label: 'case 13: Open, overdue, its alert log row inserted beforehand with the same key', count: 1, status: 'Open', dueOffsetS: -9 * 60, spreadS: 0, expect: 'no email, no new row; the flow\'s own insert fails with the duplicate error, which the Try/catch design recognises: it is not counted as a failure and the run must end Succeeded (see runs.status)', preInsert: true, observer: 'script: rows and the run statuses; owner: the Compose_claim_failure output in the run history' },
});
export const CASE_ORDER = Object.freeze(['duesoon', 'overduein', 'overdueout', 'beyondlead', 'disputed', 'done', 'preinserted']);

export const nameOf = (caseId, i) => `${FAMILY}-${caseId.toUpperCase()}-${i + 1}`;
export const caseOfName = (name) => { const m = new RegExp(`^${FAMILY}-([A-Z]+)-(\\d+)$`).exec(String(name || '')); const id = m && CASE_ORDER.find((c) => c.toUpperCase() === m[1]); return id ? { caseId: id, index: Number(m[2]) - 1 } : null; };

/** The seeds for a BASE time (ms). @returns {{name:string, caseId:string, status:string, statusValue:number, dueMs:number, dueIso:string}[]} */
export function seedPlan(baseMs) {
  const out = [];
  for (const caseId of CASE_ORDER) {
    const c = CASES[caseId];
    for (let i = 0; i < c.count; i++) {
      const dueMs = baseMs + (c.dueOffsetS - i * c.spreadS) * 1000;
      out.push({ name: nameOf(caseId, i), caseId, status: c.status, statusValue: OBLIGATION_STATUS[c.status], dueMs: Math.floor(dueMs / 1000) * 1000, dueIso: isoSec(dueMs) });
    }
  }
  return out;
}

/**
 * The distance of every seed class to the boundary that could change its classification, at the WORST time the flow may be turned on (ARM_LIMIT) and scan (FIRST_SCAN),
 * and for the window that follows. Seconds. A unit test requires every margin to be at least MIN_MARGIN_S.
 */
export function margins(params = PARAMS) {
  const L = params.leadMinutes * 60; const B = params.lookbackMinutes * 60;
  const firstScanLatest = (ARM_LIMIT_MS + FIRST_SCAN_MS) / 1000;
  const windowEnd = (ARM_LIMIT_MS + ON_MINUTES * MIN) / 1000;
  const due = (id, i = 0) => CASES[id].dueOffsetS - i * CASES[id].spreadS;
  const lastOver = CASES.overduein.count - 1;
  return [
    { what: `duesoon: the first scan (at the latest ${firstScanLatest}s after the seeds) still sees the due date in the future (type DUESOON, not OVERDUE)`, seconds: due('duesoon') - firstScanLatest },
    { what: 'overduein: the oldest one is still inside the lookback at the end of the ON window (leaves when now - due > lookback)', seconds: (due('overduein', 0) + B) - windowEnd },
    { what: 'overduein: the most recent one is already overdue at the seeds (type OVERDUE from the first scan)', seconds: -due('overduein', 0) },
    { what: 'overduein: the least overdue one (the 7th) is still overdue at the seeds', seconds: -due('overduein', lastOver) },
    { what: 'overdueout: it is outside the lookback at the seeds (and gets farther away)', seconds: -due('overdueout') - B },
    { what: 'beyondlead: it is outside the lead time at the end of the ON window (eligible from due - lead)', seconds: (due('beyondlead') - L) - windowEnd },
    { what: 'preinserted: it is overdue and inside the lookback at the end of the ON window', seconds: Math.min(-due('preinserted'), (due('preinserted') + B) - windowEnd) },
    { what: 'disputed / done: overdue and inside the lookback (they must be excluded by their STATUS, not by their date)', seconds: Math.min(-due('disputed'), (due('disputed') + B) - windowEnd) },
  ];
}

/** The seeds' alert key (the key the flow builds for it), by the same function the offline comparison uses. */
export const keyFor = (obligationId, type, dueIso) => buildAlertKey({ sourceId: obligationId, type, date: dueIso });

// ---------------------------------------------------------------------------------------------------------------- the plan (offline)
export function planLines() {
  const L = [];
  L.push(`PLAN (offline, no sign-in, no network). Flow: ${FLOW_NAME} (test variant: lead ${PARAMS.leadMinutes} min, lookback ${PARAMS.lookbackMinutes} min, interval ${PARAMS.intervalMinutes} min). STATE OF THE FLOW at the time of writing (2026-11-07): the first flow was deleted by the owner after the window of 2026-11-03/04; the Try/catch definition (generator commit cb9ac80) was created OFF on 2026-11-07 and read back identical to the generated one; it has never been turned on and has no run. The modes read the real state themselves. A window still needs the owner's explicit approval, and setup and cleanup also need --counters-approved.`);
  L.push(`WINDOW  one window, the flow ON for about ${ON_MINUTES} minutes. Every row has a name starting ${FAMILY}-. The script never turns a flow on or off. The owner turns it ON no later than ${ARM_LIMIT_MS / MIN} minutes after setup prints READY, and OFF when the await step says so.`);
  L.push('SEEDS  (BASE = the moment the seeds are written; every due date is relative to the real clock, seconds precision)');
  for (const id of CASE_ORDER) {
    const c = CASES[id];
    L.push(`  ${id.padEnd(11)} x${c.count}  ${c.status.padEnd(8)} due BASE ${c.dueOffsetS >= 0 ? '+' : '-'}${Math.abs(c.dueOffsetS / 60)} min${c.count > 1 ? ` (each further one ${c.spreadS}s earlier)` : ''}  ${c.label}`);
    L.push(`              expected: ${c.expect}   [observed by ${c.observer}]`);
  }
  L.push('CONTROLS  two positive controls: the DUE SOON obligation and the OVERDUE-inside-lookback obligations. "No alert" results (outside the lookback, beyond the lead time, Disputed, Done) count as PASS only if BOTH controls fired; otherwise they are reported as INCONCLUSIVE, never as success. If a control did not fire the verdict names a possible cause: the text comparison of the due dates in Check_obligation_still_due (docs/flow-obligation-alerts.md, section 3).');
  L.push('MARGINS  (seconds to the nearest classification boundary at the worst arming time; a unit test requires at least ' + MIN_MARGIN_S + ')');
  for (const m of margins()) L.push(`  ${String(m.seconds).padStart(6)} s  ${m.what}`);
  L.push(`LATE ON  if the flow is turned on later than ${ARM_LIMIT_MS / MIN} minutes after the seeds, the class of the due-soon obligation can change: the timing of that case is reported INCONCLUSIVE (the existence of alerts is still checked). Pass the exact ON time to the verdict with --on-at=<ISO UTC>.`);
  L.push('EXPECTED ALERTS  the cap case gives 7 OVERDUE alerts, the due-soon obligation 1 DUESOON (and 1 OVERDUE if the flow is still ON after its due date) = 8 or 9 new alert log rows = 8 or 9 emails. The alert log row of case 13 existed before the window and sends nothing.');
  L.push('COUNTERS  setup creates ONE Draft contract (no approval): it consumes ONE number of the contract-number counter row of contract type ' + CONTRACT_TYPE + ' (the prefix is read from the environment at setup and printed; the reminders sessions consumed type 867640000 and restored it). setup prints --counters-before=<prefix>:<n> --counters-consumed=<prefix>:1. cleanup restores the counter with the same guards as the 29 October restore: only if the counter now equals the snapshot plus the numbers this session consumed, and never below a number that still exists on a contract; otherwise it refuses and says so. NO mode touches the counters without --counters-approved (your explicit approval for the window); without it setup and cleanup refuse before writing anything.');
  L.push('THE SCRIPT MEASURES  alert log rows (keys, creation times, counts per key), obligation and contract state (status, owner, modifiedon), the flow row (ON / OFF, when it changed), flow run records (start, end, status; claims are attributed to runs by containment, ambiguous and unattributed claims are reported), the key index status, counters.');
  L.push('ONLY THE OWNER CAN READ  the mailbox (how many emails, to whom, subject and body: the script never reads it in any way) and the run history in the designer (the real output of the failed insert of case 13, the Compose_claim_failure output, whether the connector retried).');
  L.push('MODES  plan (offline, no network) | baseline (read only) | setup (WRITES) | await (read only) | verdict (read only) | cleanup (WRITES). plan, baseline, setup, await and verdict have been run (one window, 2026-11-03/04); the cleanup of that window ran on 2026-11-07; setup and cleanup need the owner\'s explicit approval.');
  return L;
}

// ---------------------------------------------------------------------------------------------------------------- the verdict (pure)
const out = (id, status, name, detail = '') => ({ id, status, name, detail });

/** The statuses of a flow run that end it badly, and the ones that mean it has not ended. */
export const RUN_BAD = Object.freeze(['Failed', 'TimedOut', 'Cancelled']);
export const RUN_OPEN = Object.freeze(['Running', 'Waiting']);
/**
 * The run-status check over the runs after BASE. FAIL beats everything (a bad run is real whatever the read says); then INCONCLUSIVE (a run still open, a status of another kind,
 * no run at all, or flowruns that did not settle); PASS only when there is at least one run, every run Succeeded and the read settled.
 * @param {{status:string}[]} runs   @param {{stable:boolean, reads:number, why?:string}} read
 * @returns {{status:'PASS'|'FAIL'|'INCONCLUSIVE', detail:string, why:string}}
 */
export function runStatus(runs, read = { stable: true, reads: 1, why: '' }) {
  const counts = runs.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  const detail = `total ${runs.length}: ${JSON.stringify(counts)} (${read.reads} read(s) of flowruns${read.stable ? ', settled' : ', NOT settled'})`;
  const bad = runs.filter((r) => RUN_BAD.includes(r.status)).length;
  if (bad) return { status: 'FAIL', detail, why: `${bad} run(s) ended ${RUN_BAD.filter((s) => counts[s]).join('/')}` };
  const open = runs.filter((r) => RUN_OPEN.includes(r.status)).length; const other = runs.filter((r) => ![...RUN_BAD, ...RUN_OPEN, 'Succeeded'].includes(r.status)).length;
  if (open) return { status: 'INCONCLUSIVE', detail, why: `${open} run(s) still Running or Waiting${read.stable ? '' : `; ${read.why}`}` };
  if (other) return { status: 'INCONCLUSIVE', detail, why: `${other} run(s) with a status that is neither Succeeded nor a failure (${Object.keys(counts).filter((s) => ![...RUN_BAD, ...RUN_OPEN, 'Succeeded'].includes(s)).join(', ')})` };
  if (!runs.length) return { status: 'INCONCLUSIVE', detail, why: 'no run was found after the oldest seed' };
  if (!read.stable) return { status: 'INCONCLUSIVE', detail, why: read.why };
  return { status: 'PASS', detail, why: '' };
}
/** The re-reads of flowruns: the records come late, so the count is only believed when two reads at least this far apart agree and no run is open. */
export const RUNS_READ_GAP_MS = 30000;
export const RUNS_READ_MAX = 10;   // at most 10 reads = 9 waits = 4.5 minutes

/** How many seeded, eligible obligations were still unclaimed and in the window at the start of a run. Used for the exact-cap check. */
export function claimableAtRunStart({ seeds, rows, startMs, params = PARAMS }) {
  const claimedBefore = new Set(rows.filter((r) => r.createdMs < startMs).map((r) => r.obligationId ?? String(r.key).slice(0, 36)));
  return seeds.filter((s) => s.status === 'Open' && s.caseId !== 'preinserted' && !claimedBefore.has(s.id)
    && s.dueMs >= startMs - params.lookbackMinutes * MIN && s.dueMs <= startMs + params.leadMinutes * MIN).length;
}

/**
 * @param {object} p
 * @param {object[]} p.seeds     [{ id, name, caseId, status, dueMs, createdMs, modifiedMs }]   (the obligations read back)
 * @param {object[]} p.rows      [{ id, key, createdMs }]   (alert log rows of the keys that start with a seeded obligation id)
 * @param {object[]} p.strayRows [{ key, createdMs }]       (alert log rows created since the ON that belong to no seeded obligation: an empty key, a wrong key)
 * @param {object[]} p.runs      [{ startMs, endMs, status }]
 * @param {object}   p.flow      { on, onAtMs, onAtSource, offAtMs, baseMs }
 * @param {object}   p.contract  { found, status, ownerIsMe, ownerHasEmail }
 * @param {boolean}  p.keyActive
 */
export function verdict({ seeds, rows, strayRows = [], runs, runsRead = { stable: true, reads: 1, why: '' }, flow, contract, keyActive, params = PARAMS }) {
  const R = []; const add = (...a) => R.push(out(...a));
  const byId = new Map(seeds.map((s) => [s.id, s]));
  const parsed = rows.map((r) => { let p = null; try { p = parseAlertKey(r.key); } catch (e) { if (!(e instanceof AlertKeyError)) throw e; } return { ...r, parsed: p, obligationId: p?.source ?? String(r.key).slice(0, 36) }; });
  const preSeed = seeds.find((s) => s.caseId === 'preinserted');
  const preKey = preSeed ? keyFor(preSeed.id, TYPE_OVERDUE, isoSec(preSeed.dueMs)) : null;
  const isPre = (r) => r.key === preKey && r.createdMs < (flow.onAtMs ?? Infinity);
  const flowRows = parsed.filter((r) => !isPre(r));
  const rowsOf = (s) => flowRows.filter((r) => r.obligationId === s.id);
  const typesOf = (s) => rowsOf(s).map((r) => r.parsed?.type);
  const of = (caseId) => seeds.filter((s) => s.caseId === caseId);
  const one = of('duesoon')[0];
  const lateOn = flow.baseMs != null && flow.onAtMs != null && flow.onAtMs - flow.baseMs > ARM_LIMIT_MS;

  // ---- the flow and the key
  add('flow.off', flow.on ? 'FAIL' : 'PASS', 'the alerts flow is OFF at the verdict (it must be turned off before the verdict and the cleanup)', flow.on ? 'STILL ON' : 'OFF');
  add('key.active', keyActive ? 'PASS' : 'FAIL', 'the alternate key index of mwf_alertlog is still Active', keyActive ? 'Active' : 'not Active');
  if (lateOn) add('late.on', 'OBS', `LATE ON: the flow was turned on ${Math.round((flow.onAtMs - flow.baseMs) / 1000)} s after the seeds (limit ${ARM_LIMIT_MS / 1000} s, ${flow.onAtSource || 'source not given'}): the class of the due-soon obligation may have changed, so its timing is INCONCLUSIVE; the existence of alerts is still checked`);
  if (flow.onAtMs == null) add('on.at', 'OBS', 'the time the flow was turned ON is not known (no run and no --on-at): timing checks are limited');

  // ---- the positive controls
  const duesoonFired = !!one && rowsOf(one).length > 0;
  const overdueFired = of('overduein').some((s) => rowsOf(s).length > 0);
  const hint = ' (nothing was claimed, no email, no row: a possible cause is a text mismatch of the due dates in Check_obligation_still_due, another is the flow not having run; read the run history)';
  add('ctl.duesoon', duesoonFired ? 'PASS' : 'FAIL', 'POSITIVE CONTROL: the due-soon obligation produced an alert', duesoonFired ? `${rowsOf(one).length} row(s)` : `no alert${hint}`);
  add('ctl.overdue', overdueFired ? 'PASS' : 'FAIL', 'POSITIVE CONTROL: the overdue-inside-lookback obligations produced alerts', overdueFired ? `${of('overduein').filter((s) => rowsOf(s).length).length} of ${of('overduein').length} obligations have a row` : `no alert${hint}`);
  const controls = duesoonFired && overdueFired;

  // ---- what must exist
  if (one) {
    const t = typesOf(one); const due = t.filter((x) => x === TYPE_DUE_SOON).length; const over = t.filter((x) => x === TYPE_OVERDUE).length;
    add('duesoon.one', due === 1 ? 'PASS' : (duesoonFired ? 'FAIL' : 'OBS'), 'the due-soon obligation has exactly ONE DUESOON row', `${due} DUESOON row(s)`);
    const afterDue = flow.offAtMs != null && flow.offAtMs > one.dueMs + FIRST_SCAN_MS;
    add('duesoon.overdue', over === 0 || over === 1 ? 'OBS' : 'FAIL', `after its due date the same obligation may get ONE OVERDUE alert (a different key): ${over} row(s); the flow was ${flow.offAtMs == null ? 'switched off at an unknown time' : `ON until ${clock(flow.offAtMs)} (due date ${clock(one.dueMs)})`}${afterDue ? ': an OVERDUE row is expected' : over ? ': an OVERDUE row appeared although the flow was off before the due date + one scan' : ''}`);
  }
  const over = of('overduein');
  const exactlyOne = over.map((s) => ({ s, n: typesOf(s).filter((x) => x === TYPE_OVERDUE).length }));
  const bad = exactlyOne.filter((x) => x.n !== 1);
  add('overdue.each', bad.length === 0 ? 'PASS' : (overdueFired ? 'FAIL' : 'OBS'), `each of the ${over.length} overdue-inside-lookback obligations has exactly ONE OVERDUE row`, bad.length ? `wrong: ${bad.map((x) => `${caseOfName(x.s.name)?.index + 1}:${x.n}`).join(', ')}` : `${over.length} of ${over.length}`);
  for (const id of ['overdueout', 'beyondlead', 'disputed', 'done']) {
    const s = of(id)[0]; if (!s) continue;
    const n = rowsOf(s).length;
    const status = n > 0 ? 'FAIL' : (controls ? 'PASS' : 'OBS');
    add(`no.${id}`, status, `${CASES[id].label}: NO alert`, n > 0 ? `${n} row(s): ${typesOf(s).join(', ')}` : (controls ? '0 rows (both controls fired)' : 'INCONCLUSIVE: 0 rows, but a positive control did not fire, so "no alert" proves nothing'));
  }
  // ---- case 13
  if (preSeed) {
    const all = parsed.filter((r) => r.obligationId === preSeed.id);
    const pre = all.filter(isPre); const later = all.filter((r) => !isPre(r));
    add('case13.row', pre.length === 1 && later.length === 0 ? (controls ? 'PASS' : 'OBS') : 'FAIL', 'case 13: exactly ONE alert log row for the pre-inserted key (the one setup wrote), no row created by the flow', `${pre.length} before the window, ${later.length} created later${pre.length === 1 && later.length === 0 && !controls ? '; INCONCLUSIVE because a positive control did not fire' : ''}`);
  }
  // ---- the runs after BASE (ALL runs since the oldest seed, not only the runs that met case 13)
  const rs = runStatus(runs, runsRead);
  add('runs.counts', 'OBS', 'ALL flow runs after the oldest seed (not only case 13): the total and the counts by status. With the Try/catch design every already claimed obligation, case 13 included, meets the duplicate error in every run, and that must NOT fail a run', rs.detail);
  add('runs.status', rs.status, 'RUN STATUS: every flow run after BASE ended Succeeded (Failed, TimedOut or Cancelled is a FAIL; Running, Waiting, any other status, no run, or a flowruns read that did not settle is INCONCLUSIVE)', rs.why ? `${rs.detail}; ${rs.why}` : rs.detail);
  // ---- keys and counts
  const keyBad = [];
  for (const r of flowRows) {
    const s = byId.get(r.obligationId);
    if (!s || !r.parsed) { keyBad.push(`${String(r.key).slice(0, 12)}: not a key of a seeded obligation`); continue; }
    const want = keyFor(s.id, r.parsed.type, isoSec(s.dueMs));
    if (r.key !== want) keyBad.push(`${s.name}: key differs from alert-key.mjs`);
    if (r.parsed.type === TYPE_OVERDUE && r.createdMs < s.dueMs) keyBad.push(`${s.name}: OVERDUE claimed before the due date`);
    if (r.parsed.type === TYPE_DUE_SOON && r.createdMs > s.dueMs + RUN_SLACK_MS) keyBad.push(`${s.name}: DUESOON claimed more than one run after the due date`);
  }
  add('keys.valid', keyBad.length === 0 ? 'PASS' : 'FAIL', 'every alert log row of the window has exactly the key that scripts/lib/alert-key.mjs builds for its obligation, type and due date, and its type fits its claim time', keyBad.slice(0, 4).join(' | ') || `${flowRows.length} row(s)`);
  const keys = parsed.map((r) => r.key);
  add('keys.unique', new Set(keys).size === keys.length ? 'PASS' : 'FAIL', 'one alert log row per key', `${keys.length} row(s), ${new Set(keys).size} distinct key(s)`);
  add('rows.stray', strayRows.length === 0 ? 'PASS' : 'FAIL', 'no alert log row appeared during the window that belongs to no seeded obligation (an empty or malformed key)', strayRows.length ? `${strayRows.length} row(s), keys ${strayRows.map((r) => JSON.stringify(String(r.key).slice(0, 14))).join(', ')}` : '0');
  const expected = 7 + 1; const maxExpected = expected + 1;
  add('rows.count', flowRows.length >= expected && flowRows.length <= maxExpected ? (controls ? 'PASS' : 'OBS') : 'FAIL', `the flow created ${expected} to ${maxExpected} alert log rows (7 overdue + 1 due soon, + 1 overdue for the due-soon obligation if it was still ON after its due date)`, `${flowRows.length} row(s)`);
  add('emails.expected', 'OBS', `EXPECTED EMAILS = the number of new alert log rows = ${flowRows.length}: the owner counts the mailbox by eye (this script never reads it); the number of rows equals the number of alerts the flow attempted to send, and a failed send after the claim would show as a row without an email`);

  // ---- the cap, by containment
  const claims = flowRows.map((r) => ({ atMs: r.createdMs, key: `${r.obligationId}:${r.parsed?.type ?? 'claim'}` }));
  const att = claimAttribution(runs, claims);
  const dues = att.runs.map((r) => claimableAtRunStart({ seeds, rows: flowRows, startMs: r.startMs, params }));
  for (const x of capVerdict({ runs, claims, dues })) add(`cap.${x.id.replace(/^cap\./, '')}`, x.status, x.name, x.detail);
  const overClaimsByRun = att.attributed.filter((c) => /OVERDUE/.test(c.key) && byId.get(c.key.split(':')[0])?.caseId === 'overduein').reduce((m, c) => { m[c.run] = (m[c.run] || 0) + 1; return m; }, {});
  const firstRun = Math.min(...Object.keys(overClaimsByRun).map(Number));
  const lone = att.attributed.length > 0 && !att.overlaps[firstRun]?.length;
  add('cap.five.then.two', Object.keys(overClaimsByRun).length && lone ? (overClaimsByRun[firstRun] === 5 && Object.values(overClaimsByRun).reduce((a, b) => a + b, 0) === 7 ? 'PASS' : 'FAIL') : 'OBS',
    'the 7 overdue obligations: 5 claims in the first run that has claims, the other 2 in a later run', `claims of the seven per run ${JSON.stringify(overClaimsByRun)}${lone ? '' : '; NOT evaluated (no attributed claim, or the first run overlaps another run)'}`);

  // ---- state that must not change
  const touched = seeds.filter((s) => s.modifiedMs != null && s.createdMs != null && s.modifiedMs !== s.createdMs);
  add('obl.untouched', touched.length === 0 ? 'PASS' : 'FAIL', 'no seeded obligation was written after its creation (the flow writes nothing but the alert log)', touched.length ? `changed: ${touched.map((s) => s.name).join(', ')}` : `${seeds.length} obligation(s) unchanged`);
  add('contract.owner', contract.found && contract.ownerIsMe && contract.ownerHasEmail ? 'PASS' : 'FAIL', 'the Draft contract still exists, is still Draft and its OWNER is the logged-in user, who has an address (this is the part of "the recipient is the contract owner" the script can measure)', JSON.stringify({ found: contract.found, status: contract.status, ownerIsMe: contract.ownerIsMe, ownerHasEmail: contract.ownerHasEmail }));
  add('recipient.byeye', 'OBS', 'WHO RECEIVED each email is NOT measured: every address in this environment resolves to the test account, so even the mailbox cannot tell the contract owner from any other recipient (not proven)');
  add('byeye', 'OBS', 'BY YOUR EYE (not read by this script): the mailbox (number, recipient, subject, body) and the run history in the designer: the output of the failed insert of case 13, Compose_claim_failure, whether the connector retried, the Send_alert_email results');
  return R;
}

// ---------------------------------------------------------------------------------------------------------------- the session (I/O through the injected environment)
export class Stop extends Error {}
const GUID_ANY = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
/** A text with every GUID, URL and Dataverse host masked. The host of the environment is never printed. */
export const maskText = (x) => String(x ?? '').replace(/https?:\/\/[^\s"')]+/g, '<url>').replace(/[A-Za-z0-9-]+\.crm\d*\.dynamics\.com/g, '<host>').replace(GUID_ANY, '<id>');
/** What a failed request says: the HTTP status, the error code and the message of the body (masked, cut at 400 characters). */
export function describeFailure(r) {
  const code = r?.j?.error?.code; const message = r?.j?.error?.message ?? (typeof r?.text === 'string' && r.text ? r.text : '');
  return `HTTP ${r?.status}, error code ${code ?? 'none'}, message ${maskText(message).slice(0, 400) || 'none'}`;
}
const WRITE_TABLES = /^(mwf_contracts|mwf_counterparties|mwf_obligations|mwf_alertlogs)(\(|\?|$)/;
const q = encodeURIComponent;

/**
 * @param {object} d  { call(method, path, body, headers) -> {ok,status,j,text,id}, now(), sleep(ms), log(line), gate(), flags }
 *   flags: { dry, countersApproved, expectContracts, onAt (ISO or ''), handoff: { before: {prefix:n}, consumed: {prefix:n} } }
 */
export function createSession(d) {
  const flags = { dry: false, countersApproved: false, expectContracts: 11, onAt: '', handoff: null, ...(d.flags || {}) };
  const log = (l) => d.log(l);
  const results = []; let failed = 0;
  const outLine = (id, status, name, detail = '') => { if (status === 'FAIL') failed++; results.push({ id, status }); log(`${status.padEnd(4)}  ${String(id).padEnd(14)} ${name}${detail ? `  [${detail}]` : ''}`); };
  const check = (id, name, ok, detail) => outLine(id, ok ? 'PASS' : 'FAIL', name, detail);
  const get = async (path) => { const r = await d.call('GET', path); if (!r.ok) throw new Stop(`GET ${maskText(path).slice(0, 80)} failed: ${describeFailure(r)}`); return r.j; };
  const nowIso = () => isoSec(d.now());
  async function write(method, path, body, headers) {
    if (!WRITE_TABLES.test(path)) throw new Stop(`refused: this session writes only contracts, counterparties, obligations and alert log rows (asked for ${method} ${path.slice(0, 40)}); never the table of flows`);
    if (flags.dry) { log(`DRY-RUN  would ${method} ${path.slice(0, 60)}`); return { ok: true, status: 0, j: {}, id: '00000000-0000-4000-8000-000000000000' }; }
    await d.gate();
    return d.call(method, path, body, headers);
  }
  const ioOf = () => ({
    get: async (p) => { const r = await d.call('GET', p); return { ok: r.ok, status: r.status, json: r.j, message: String(r.j?.error?.message || '').slice(0, 200) }; },
    patch: async (p, b) => { const r = await d.call('PATCH', p, b, { 'If-Match': '*' }); return { ok: r.ok, status: r.status, message: String(r.j?.error?.message || '').slice(0, 200) }; },
    del: async (p, h) => { const r = await d.call('DELETE', p, undefined, h || {}); return { ok: r.ok, status: r.status, message: String(r.j?.error?.message || '').slice(0, 200) }; },
  });

  const flowRows = async () => (await get(`workflows?$select=name,statecode,workflowid,modifiedon&$filter=${q('category eq 5')}&$top=200`)).value;
  async function alertsFlow() { const rows = (await flowRows()).filter((r) => r.name === FLOW_NAME); if (rows.length !== 1) throw new Stop(`Expected exactly one flow row named "${FLOW_NAME}", found ${rows.length} (0 means the flow was never created or was deleted).`); return rows[0]; }
  const count = async (set, id, filter) => (await get(`${set}?$select=${id}&$count=true&$top=1${filter ? `&$filter=${q(filter)}` : ''}`))['@odata.count'];
  const obligationsRead = async () => (await get(`mwf_obligations?$select=mwf_obligationid,mwf_name,mwf_status,mwf_duedate,createdon,modifiedon,_mwf_contract_value&$filter=${q(`startswith(mwf_name,'${FAMILY}-')`)}&$top=100`)).value;
  async function waitForOff(maxSeconds, every = 10) {
    const end = d.now() + maxSeconds * 1000; let first = true;
    for (;;) {
      const f = await alertsFlow();
      if (f.statecode === 0) { log(first ? 'INFO  the alerts flow is OFF (read only)' : 'INFO  the alerts flow is now OFF'); return true; }
      log(`STILL ON: the alerts flow is ON. The owner must turn it OFF (Power Automate > "${FLOW_NAME}" > Turn off). This script cannot and will not do it.`);
      first = false; if (d.now() >= end) return false;
      await d.sleep(every * 1000);
    }
  }

  // ------------------------------------------------------------------------------------------------ baseline
  async function baseline() {
    const key = (await get("EntityDefinitions(LogicalName='mwf_alertlog')/Keys?$select=SchemaName,KeyAttributes,EntityKeyIndexStatus")).value;
    const gate = keyGate(key); check('key', 'the alternate key index of mwf_alertlog is Active', gate.ok, gate.status);
    const c = { contracts: await count('mwf_contracts', 'mwf_contractid'), matrix: await count('mwf_approvalmatrixes', 'mwf_approvalmatrixid', 'statecode eq 0'), assignments: await count('mwf_approverassignments', 'mwf_approverassignmentid', 'statecode eq 0'), steps: await count('mwf_approvalsteps', 'mwf_approvalstepid'), obligations: await count('mwf_obligations', 'mwf_obligationid'), alertlog: await count('mwf_alertlogs', 'mwf_alertlogid') };
    check('counts', `contracts ${flags.expectContracts}, active matrix rows 110, active assignments 5, approval steps 0, obligations 0, alert log rows 0`, c.contracts === flags.expectContracts && c.matrix === 110 && c.assignments === 5 && c.steps === 0 && c.obligations === 0 && c.alertlog === 0, JSON.stringify(c));
    const family = (await get(`mwf_obligations?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${FAMILY}-')`)}`)).value.length
      + (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${FAMILY}-')`)}`)).value.length + (await get(`mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${FAMILY}-')`)}`)).value.length;
    check('rows', `no obligation, contract or counterparty of this session (${FAMILY}-...) exists`, family === 0, `${family} row(s)`);
    const flows = await flowRows();
    check('flows', 'EVERY flow row of the environment is OFF', flows.length > 0 && flows.every((f) => f.statecode === 0), flows.map((f) => `${f.name.slice(0, 26)}=${f.statecode === 0 ? 'OFF' : 'ON'}`).join('; '));
    const mine = flows.filter((f) => f.name === FLOW_NAME);
    check('flow.row', `exactly one flow row named "${FLOW_NAME}" exists`, mine.length === 1, `${mine.length} row(s)`);
    const me = (await get('WhoAmI')).UserId; const meRow = await get(`systemusers(${me})?$select=internalemailaddress`);
    check('me', 'the logged-in user has an address (every email of the window goes to this one mailbox)', !!meRow.internalemailaddress);
    try { const snap = await snapshotCounters(ioOf()); log(`INFO  counters: ${Object.values(snap.byType).map((x) => `${x.prefix}=${x.last}`).join(' ')}`); } catch (e) { outLine('counters', 'FAIL', 'the counters could not be read', e.message.slice(0, 80)); }
    return failed === 0;
  }

  // ------------------------------------------------------------------------------------------------ setup
  async function setup() {
    if (!flags.dry && !flags.countersApproved) throw new Stop(`setup consumes ONE number of the contract-number counter (contract type ${CONTRACT_TYPE}) by creating the Draft contract. Add --counters-approved (your explicit approval for this window) to run it. Nothing was written.`);
    await d.gate();
    const flows = await flowRows();
    if (!(flows.length > 0 && flows.every((f) => f.statecode === 0))) throw new Stop('Every flow must be OFF before the setup. The owner turns them off. Nothing was created.');
    if (!(await baseline())) throw new Stop('The baseline is not clean (see the lines above). Nothing was created.');
    const usd = (await get("transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0")).value;
    if (usd.length !== 1) throw new Stop(`active USD currency: expected 1, found ${usd.length}`);
    const snap = await snapshotCounters(ioOf()); const ctr = snap.byType[CONTRACT_TYPE];
    if (!ctr) throw new Stop(`no counter row for contract type ${CONTRACT_TYPE}`);
    log(`INFO  counter row to be consumed: contract type ${CONTRACT_TYPE}, prefix ${ctr.prefix}, last number ${ctr.last}; one number will be used (restored at cleanup with --counters-approved)`);
    const cpOpt = (await get("EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)")).OptionSet.Options[0].Value;
    const cp = await write('POST', 'mwf_counterparties', { mwf_name: `${FAMILY}-COUNTERPARTY (delete me)`, mwf_counterpartytype: cpOpt });
    if (!cp.ok) throw new Stop(`counterparty create failed: ${describeFailure(cp)}. Nothing else was written by this setup; run cleanup if a row exists.`);
    const con = await write('POST', 'mwf_contracts?$select=mwf_contractid', { mwf_name: `${FAMILY}-CONTRACT`, mwf_contracttype: CONTRACT_TYPE, mwf_direction: 867640001, mwf_value: 5000, 'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${cp.id})`, 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${usd[0].transactioncurrencyid})` }, { Prefer: 'return=representation' });
    if (!con.ok) throw new Stop(`contract create failed: ${describeFailure(con)}. If a number was consumed, restore it with cleanup --counters-approved --counters-before=${ctr.prefix}:${ctr.last} --counters-consumed=${ctr.prefix}:1.`);
    const contractId = con.j?.mwf_contractid || con.id;
    const baseMs = d.now(); const seeds = seedPlan(baseMs);
    log(`INFO  BASE ${clock(baseMs)} (UTC): due dates are relative to this moment; setup started`);
    const settled = await Promise.allSettled(seeds.map(async (s) => {
      const r = await write('POST', 'mwf_obligations?$select=mwf_obligationid', { mwf_name: s.name, mwf_party: PARTY['First Party'], mwf_duedate: s.dueIso, mwf_status: s.statusValue, 'mwf_Contract@odata.bind': `/mwf_contracts(${contractId})` }, { Prefer: 'return=representation' });
      if (!r.ok) throw new Stop(`obligation ${s.name} create failed: ${describeFailure(r)}`);
      return { ...s, id: r.j?.mwf_obligationid || r.id };
    }));
    const bad = settled.filter((x) => x.status === 'rejected');
    if (bad.length) throw new Stop(`${bad.length} of ${seeds.length} obligation create(s) failed, ${seeds.length - bad.length} were created. First failure: ${bad[0].reason?.message ?? bad[0].reason}. Run cleanup (nothing is cleaned up by guess).`);
    const made = settled.map((x) => x.value);
    const pre = made.find((s) => s.caseId === 'preinserted'); const preKey = keyFor(pre.id, TYPE_OVERDUE, pre.dueIso);
    const ins = await write('POST', 'mwf_alertlogs', { mwf_name: preKey, mwf_alertkey: preKey });
    if (!ins.ok) throw new Stop(`the pre-inserted alert log row failed: ${describeFailure(ins)}. Run cleanup.`);
    if (!flags.dry) {
      const back = await obligationsRead(); const byName = Object.fromEntries(back.map((o) => [o.mwf_name, o]));
      const wrong = seeds.filter((s) => !byName[s.name] || byName[s.name].mwf_status !== s.statusValue || Date.parse(byName[s.name].mwf_duedate) !== s.dueMs);
      check('seeds', `READ BACK: ${seeds.length} obligations with the planned status and the planned due date (to the second)`, back.length === seeds.length && wrong.length === 0, wrong.length ? `wrong: ${wrong.map((s) => s.name).join(', ')}` : `${back.length} of ${seeds.length}`);
      check('seeds.text', 'READ BACK: the due date text of every obligation is yyyy-MM-ddTHH:mm:ssZ (the form the flow\'s text comparison expects)', back.every((o) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(o.mwf_duedate))), back.slice(0, 1).map((o) => o.mwf_duedate).join(''));
      const rows = (await get(`mwf_alertlogs?$select=mwf_alertkey&$filter=${q(`mwf_alertkey eq '${preKey}'`)}`)).value;
      check('pre', 'READ BACK: the pre-inserted alert log row exists once (case 13)', rows.length === 1);
      const cr = await get(`mwf_contracts(${contractId})?$select=statuscode,_ownerid_value`); const me = (await get('WhoAmI')).UserId;
      check('contract', 'READ BACK: the contract is Draft and owned by the logged-in user', cr.statuscode === STATUS.Draft && String(cr._ownerid_value).toLowerCase() === String(me).toLowerCase());
      if (failed) throw new Stop('A seed was not in place after the setup. The flow is OFF. Run --mode=cleanup.');
    }
    log(`COUNTERS handed to the cleanup step: --counters-before=${ctr.prefix}:${ctr.last} --counters-consumed=${ctr.prefix}:1`);
    log('\nREADY');
    log(`BASE ${clock(baseMs)} (UTC) = the moment the seeds were written. TURN THE FLOW ON NO LATER THAN ${clock(baseMs + ARM_LIMIT_MS)} (BASE + ${ARM_LIMIT_MS / MIN}:00). Later: the timing of the due-soon case is reported INCONCLUSIVE.`);
    log(`DUE SOON obligation is due at ${clock(seeds[0].dueMs)} (BASE + ${(seeds[0].dueMs - baseMs) / MIN}:00); it becomes eligible at ${clock(seeds[0].dueMs - PARAMS.leadMinutes * MIN)}; if the flow is still ON after ${clock(seeds[0].dueMs)} it may get a second, OVERDUE alert.`);
    log(`7 OVERDUE obligations (inside the lookback until ${clock(seeds.find((s) => s.caseId === 'overduein').dueMs + PARAMS.lookbackMinutes * MIN)}), 1 pre-inserted (case 13), and the no-alert cases: outside the lookback, beyond the lead time, Disputed, Done.`);
    log('EXPECTED: 7 OVERDUE alerts (5 in the first run that sees them, 2 later) + 1 DUESOON (+1 OVERDUE for it if still ON after its due date) = 8 or 9 emails, all to your mailbox; none for the other cases. You count the emails; the script does not read your mailbox.');
    log(`The flow is ON for about ${ON_MINUTES} minutes. >>> Turn on '${FLOW_NAME}' now (the owner; no other UI activity: do not open the flow in the designer, do not save it). <<<`);
    log('NEXT: --mode=await');
    return failed === 0;
  }

  // ------------------------------------------------------------------------------------------------ await (read only)
  async function awaitWindow() {
    log('INFO  this step writes NOTHING (the seeds are all in place); the owner must not touch the UI except to turn the flow ON and, at the end, OFF.');
    let waited = 0;
    while ((await alertsFlow()).statecode !== 1) {
      if (waited === 0 || waited % 60 === 0) log('WAITING FOR THE OWNER TO TURN THE FLOW ON (read only polling every 10 s, for at most 10 minutes)');
      if (waited >= 600) { log('The flow was not turned ON within 10 minutes. Nothing was changed. Exit 10.'); return 'timeout'; }
      await d.sleep(10000); waited += 10;
    }
    const onRow = await alertsFlow();
    log(`INFO  the flow is ON, detected at ${nowIso()} (UTC)`);
    log(`ON-AT ${onRow.modifiedon} (UTC): the time the flow row was last changed = turned ON (exact); the verdict takes it with --on-at=${onRow.modifiedon}`);
    const seeds = (await obligationsRead()); const idOf = Object.fromEntries(seeds.map((o) => [o.mwf_obligationid, o.mwf_name]));
    const printed = new Set(); const start = d.now(); let lastClaim = d.now();
    const idsAtOn = Object.keys(idOf);
    const preExisting = idsAtOn.length ? (await get(`mwf_alertlogs?$select=mwf_alertkey&$filter=${q(idsAtOn.map((i) => `startswith(mwf_alertkey,'${i}')`).join(' or '))}&$top=200`)).value : [];
    for (const r of preExisting) printed.add(r.mwf_alertkey);
    log(`INFO  ${preExisting.length} alert log row(s) existed when the flow was turned ON (the pre-inserted row of case 13): they are not claims`);
    for (;;) {
      const ids = Object.keys(idOf);
      const filter = ids.map((i) => `startswith(mwf_alertkey,'${i}')`).join(' or ');
      const rows = ids.length ? (await get(`mwf_alertlogs?$select=mwf_alertkey,createdon&$filter=${q(filter)}&$top=200`)).value : [];
      for (const r of rows) if (!printed.has(r.mwf_alertkey)) { printed.add(r.mwf_alertkey); lastClaim = d.now(); log(`CLAIM  ${nowIso()}  ${idOf[String(r.mwf_alertkey).slice(0, 36)] ?? '?'}  ${String(r.mwf_alertkey).slice(37, 55)}  (row created ${r.createdon})`); }
      const expected = 8;   // 7 overdue + 1 due soon (the rows that existed at the ON are not counted)
      const done = printed.size - preExisting.length >= expected && d.now() - lastClaim >= 3 * MIN;
      if (done || d.now() - start > (ON_MINUTES + 8) * MIN) { log(done ? 'DONE: every expected alert was claimed and 3 quiet minutes passed.' : 'DONE (time limit): not every expected alert was claimed; the verdict will say which.'); break; }
      await d.sleep(15000);
    }
    log('\n=== TURN THE FLOW OFF NOW (owner) ===');
    const off = await waitForOff(300, 15);
    log(off ? 'NEXT: --mode=verdict, then --mode=cleanup.' : 'The flow is STILL ON after 5 minutes. The verdict and the cleanup will refuse until it is OFF.');
    return off;
  }

  // ------------------------------------------------------------------------------------------------ verdict (read only)
  async function runVerdict() {
    const off = await waitForOff(180, 10);
    const fl = await alertsFlow();
    const seedsRaw = await obligationsRead();
    if (!seedsRaw.length) throw new Stop('No obligation of this session exists (run --mode=setup first, or the rows were already cleaned up). Nothing was changed.');
    const seeds = seedsRaw.map((o) => ({ id: o.mwf_obligationid, name: o.mwf_name, caseId: caseOfName(o.mwf_name)?.caseId, status: Object.keys(OBLIGATION_STATUS).find((k) => OBLIGATION_STATUS[k] === o.mwf_status), dueMs: Date.parse(o.mwf_duedate), createdMs: Date.parse(o.createdon), modifiedMs: Date.parse(o.modifiedon) }));
    const ids = seeds.map((s) => s.id);
    const rowsRaw = (await get(`mwf_alertlogs?$select=mwf_alertkey,createdon&$filter=${q(ids.map((i) => `startswith(mwf_alertkey,'${i}')`).join(' or '))}&$top=500`)).value;
    const rows = rowsRaw.map((r) => ({ key: r.mwf_alertkey, createdMs: Date.parse(r.createdon) }));
    const baseMs = Math.min(...seeds.map((s) => s.createdMs));
    const reported = flags.onAt ? Date.parse(flags.onAt) : NaN;
    const earliestRun = baseMs - MIN;
    const readRuns = async () => {
      const rr = await d.call('GET', `flowruns?$filter=${q(`workflowid eq ${fl.workflowid} and starttime ge ${new Date(earliestRun).toISOString()}`)}&$orderby=starttime&$select=status,starttime,endtime&$top=500`);
      if (!rr.ok) throw new Stop(`flowruns not readable: HTTP ${rr.status}`);
      return (rr.j.value || []).map((r) => ({ startMs: Date.parse(r.starttime), endMs: r.endtime ? Date.parse(r.endtime) : null, status: r.status }));
    };
    // the run records arrive late (2026-11-03: the verdict saw 12 runs, a later read 14): read again until two reads at least RUNS_READ_GAP_MS apart agree on the count and no run is open
    let runs = await readRuns(); let reads = 1; let runsRead = { stable: false, reads, why: '' };
    for (;;) {
      await d.sleep(RUNS_READ_GAP_MS); const next = await readRuns(); reads++;
      const same = next.length === runs.length; const open = next.some((r) => RUN_OPEN.includes(r.status)); runs = next;
      if (same && !open) { runsRead = { stable: true, reads, why: '' }; break; }
      if (reads >= RUNS_READ_MAX) { runsRead = { stable: false, reads, why: `flowruns did not settle in ${reads} reads ${RUNS_READ_GAP_MS / 1000} s apart (${open ? 'a run is still Running or Waiting' : 'the number of runs kept changing'})` }; break; }
    }
    const onAtMs = Number.isFinite(reported) ? reported : (runs.length ? Math.min(...runs.map((r) => r.startMs)) - MIN : null);
    const onAtSource = Number.isFinite(reported) ? 'reported' : 'estimated from the first run';
    const offAtMs = off && fl.statecode === 0 ? Date.parse(fl.modifiedon) : null;
    const strayRaw = (await get(`mwf_alertlogs?$select=mwf_alertkey,createdon&$filter=${q(`createdon ge ${new Date(onAtMs ?? baseMs).toISOString()}`)}&$top=500`)).value;
    const stray = strayRaw.filter((r) => !ids.some((i) => String(r.mwf_alertkey ?? '').toLowerCase().startsWith(i.toLowerCase()))).map((r) => ({ key: r.mwf_alertkey ?? '', createdMs: Date.parse(r.createdon) }));
    const key = (await get("EntityDefinitions(LogicalName='mwf_alertlog')/Keys?$select=SchemaName,KeyAttributes,EntityKeyIndexStatus")).value;
    const conId = seedsRaw[0]._mwf_contract_value; const me = (await get('WhoAmI')).UserId;
    const cr = await d.call('GET', `mwf_contracts(${conId})?$select=statuscode,_ownerid_value`); const meRow = await get(`systemusers(${me})?$select=internalemailaddress`);
    const contract = cr.ok ? { found: true, status: cr.j.statuscode, ownerIsMe: String(cr.j._ownerid_value).toLowerCase() === String(me).toLowerCase() && cr.j.statuscode === STATUS.Draft, ownerHasEmail: !!meRow.internalemailaddress } : { found: false };
    const res = verdict({ seeds, rows, strayRows: stray, runs, runsRead, flow: { on: !off || fl.statecode === 1, onAtMs, onAtSource, offAtMs, baseMs }, contract, keyActive: keyGate(key).ok });
    for (const r of res) outLine(r.id, r.status, r.name, r.detail);
    const s = summarize(res);
    const inconclusive = res.filter((r) => r.status === 'INCONCLUSIVE').length;
    log(`\nVERDICT: ${s.pass} PASS, ${s.fail} FAIL, ${inconclusive} INCONCLUSIVE, ${s.obs} OBS.`);
    log("\nLINK CHECK WINDOW: obligations still exist, say 'link checked' to continue");
    return s.fail === 0 && inconclusive === 0;
  }

  // ------------------------------------------------------------------------------------------------ cleanup
  /**
   * The gate of cleanup (the only mode that accepts a missing flow): every flow row must be OFF; the alerts flow may be absent (no flow of this name exists, so nothing of this session can run:
   * treated as Off, said in one log line); two or more rows of that name refuse. Polls like waitForOff. Returns { ok, why }.
   */
  async function cleanupFlowGate(maxSeconds, every) {
    const end = d.now() + maxSeconds * 1000;
    for (;;) {
      const flows = await flowRows(); const mine = flows.filter((r) => r.name === FLOW_NAME);
      if (mine.length > 1) throw new Stop(`Expected at most one flow row named "${FLOW_NAME}", found ${mine.length}. Nothing was deleted.`);
      const alertsOn = mine.some((r) => r.statecode !== 0); const othersOn = flows.filter((r) => r.name !== FLOW_NAME && r.statecode !== 0);
      if (!alertsOn && !othersOn.length) {
        log(mine.length === 0 ? `INFO  no "${FLOW_NAME}" flow row exists: treated as Off (no flow of this session can run). Every other flow row is Off.` : 'INFO  the alerts flow is OFF and every other flow row is OFF (read only)');
        return { ok: true };
      }
      if (alertsOn) log(`STILL ON: the alerts flow is ON. The owner must turn it OFF (Power Automate > "${FLOW_NAME}" > Turn off). This script cannot and will not do it.`);
      if (othersOn.length) log(`STILL ON: another flow is ON (${othersOn.map((f) => f.name.slice(0, 40)).join('; ')}). The owner must turn it OFF; cleanup deletes nothing while any flow is ON.`);
      if (d.now() >= end) return { ok: false, why: alertsOn ? 'the alerts flow is still ON' : 'another flow is ON' };
      await d.sleep(every * 1000);
    }
  }
  async function cleanup() {
    const gate = await cleanupFlowGate(120, 10);
    if (!gate.ok) { outLine('flow', 'FAIL', `${gate.why}: nothing was deleted (turn it OFF first)`); return false; }
    if (!flags.dry && !flags.countersApproved) throw new Stop('cleanup restores the contract-number counter: add --counters-approved (your explicit approval) with --counters-before=<prefix>:<n> --counters-consumed=<prefix>:<n>. Nothing was deleted.');
    const obligations = await obligationsRead(); const ids = obligations.map((o) => o.mwf_obligationid);
    const contractsRead = (await get(`mwf_contracts?$select=mwf_contractid,mwf_name&$filter=${q(`startswith(mwf_name,'${FAMILY}-')`)}`)).value;
    let rowsToDelete = [];
    if (ids.length) rowsToDelete = (await get(`mwf_alertlogs?$select=mwf_alertlogid,mwf_alertkey&$filter=${q(ids.map((i) => `startswith(mwf_alertkey,'${i}')`).join(' or '))}&$top=500`)).value;
    if (flags.dry) { log(`DRY-RUN  would delete ${rowsToDelete.length} alert log row(s) whose key starts with the id of one of ${ids.length} seeded obligation(s), ${contractsRead.length} contract(s) (the obligations go by the cascade), the counterparty, and restore the counter.`); return true; }
    let deletedRows = 0;
    for (const r of rowsToDelete) { const x = await write('DELETE', `mwf_alertlogs(${r.mwf_alertlogid})`); if (x.ok || x.status === 404) deletedRows++; }
    log(`INFO  cleanup: ${deletedRows} of ${rowsToDelete.length} alert log row(s) deleted (each key starts with the id of an obligation THIS session created, found by its ${FAMILY}- name)`);
    const del = await deleteContracts(ioOf(), contractsRead.map((c) => c.mwf_contractid));
    log(`INFO  cleanup: ${contractsRead.length} contract(s) found, ${del.deleted} deleted, ${del.failed.length} failed (their obligations go by the cascade)`);
    for (const x of (await get(`mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${FAMILY}-')`)}`)).value) { const dd = await write('DELETE', `mwf_counterparties(${x.mwf_counterpartyid})`); log(`INFO  cleanup: counterparty delete HTTP ${dd.status}`); }
    // the counters, by the rule of lib/counter-snapshot.mjs
    const h = flags.handoff; let rs = { refused: 0, restored: 0, unchanged: 0, skipped: true };
    if (h?.before && h?.consumed) {
      const cur = await snapshotCounters(ioOf()); const fake = { set: cur.set, byType: {} }; const consumed = {};
      for (const [type, c] of Object.entries(cur.byType)) { fake.byType[type] = { id: c.id, prefix: c.prefix, last: Number(h.before[c.prefix] ?? c.last) }; consumed[type] = Number(h.consumed[c.prefix] || 0); }
      rs = await restoreCounters(ioOf(), fake, consumed);
      for (const l of rs.lines) log(`counter: ${l}`);
      log(`counters: restored ${rs.restored}, unchanged ${rs.unchanged}, refused ${rs.refused}`);
    } else log('counters NOT restored: give --counters-before=<prefix>:<n> and --counters-consumed=<prefix>:<n> (printed by setup).');
    const left = { obligations: (await obligationsRead()).length, contracts: (await get(`mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${FAMILY}-')`)}`)).value.length };
    const strays = ids.length ? (await get(`mwf_alertlogs?$select=mwf_alertlogid&$filter=${q(ids.map((i) => `startswith(mwf_alertkey,'${i}')`).join(' or '))}`)).value.length : 0;
    check('clean', `prefix ${FAMILY}-: 0 obligations, 0 contracts, 0 alert log rows of those obligations left`, left.obligations === 0 && left.contracts === 0 && strays === 0, JSON.stringify({ ...left, alertlog: strays }));
    check('clean.counts', `contracts ${flags.expectContracts}, obligations 0, alert log rows 0 (the baseline)`, (await count('mwf_contracts', 'mwf_contractid')) === flags.expectContracts && (await count('mwf_obligations', 'mwf_obligationid')) === 0 && (await count('mwf_alertlogs', 'mwf_alertlogid')) === 0);
    return failed === 0 && !del.failed.length && !rs.refused;
  }

  return { baseline, setup, awaitWindow, runVerdict, cleanup, results: () => results, failed: () => failed };
}
