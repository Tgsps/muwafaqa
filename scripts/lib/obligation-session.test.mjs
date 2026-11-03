// Tests of the session of the obligation alerts flow against a MOCKED, stateful environment. Nothing here talks to an environment (the flow exists and is Off, but no window has been run).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FAMILY, FLOW_NAME, CASES, CASE_ORDER, PARAMS, ARM_LIMIT_MS, FIRST_SCAN_MS, MIN_MARGIN_S, ON_MINUTES, CONTRACT_TYPE, Stop,
  seedPlan, margins, keyFor, planLines, verdict, claimableAtRunStart, caseOfName, nameOf, createSession, describeFailure, maskText,
} from './obligation-session.mjs';
import { TYPE_DUE_SOON, TYPE_OVERDUE } from '../build-flow-obligation-alerts.mjs';
import { OBLIGATION_STATUS } from './obligation-schema.mjs';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const gid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADDR = ['owner', 'example.test'].join('@');   // built at runtime: the repository holds no address literal

// ---------------------------------------------------------------------------------------------------------------- pure: seeds and margins
test('the seeds: 13 obligations in 7 cases, names with the prefix, due dates RELATIVE to the base with seconds precision, the statuses of the case', () => {
  const base = Date.UTC(2027, 5, 15, 12, 0, 0, 345);   // with milliseconds: they must not leak into the due dates
  const s = seedPlan(base);
  assert.equal(s.length, 13); assert.deepEqual(CASE_ORDER.map((c) => s.filter((x) => x.caseId === c).length), [1, 7, 1, 1, 1, 1, 1]);
  for (const x of s) {
    assert.ok(x.name.startsWith(`${FAMILY}-`)); assert.match(x.dueIso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/); assert.equal(Date.parse(x.dueIso), x.dueMs); assert.equal(x.dueMs % 1000, 0);
    assert.equal(x.statusValue, OBLIGATION_STATUS[CASES[x.caseId].status]);
  }
  const at = (id, i = 0) => s.filter((x) => x.caseId === id)[i].dueMs - Math.floor(base / 1000) * 1000;
  assert.equal(at('duesoon'), 10 * MIN); assert.equal(at('overduein', 0), -8 * MIN); assert.equal(at('overduein', 6), -8 * MIN - 30000); assert.equal(at('overdueout'), -50 * MIN);
  assert.equal(at('beyondlead'), 120 * MIN); assert.equal(at('preinserted'), -9 * MIN);
  assert.deepEqual(s.filter((x) => x.caseId === 'disputed' || x.caseId === 'done').map((x) => x.status), ['Disputed', 'Done']);
  assert.equal(new Set(s.map((x) => x.name)).size, 13);
  for (const x of s) assert.deepEqual(caseOfName(x.name), { caseId: x.caseId, index: Number(x.name.split('-').pop()) - 1 });
  assert.equal(caseOfName(`${FAMILY}-CONTRACT`), null); assert.equal(caseOfName('other'), null);
});

test('every distance to a classification boundary is at least the stated margin, and the margins react to the parameters', () => {
  const m = margins();
  assert.ok(m.length >= 8); for (const x of m) assert.ok(x.seconds >= MIN_MARGIN_S, `${x.seconds}s: ${x.what}`);
  assert.equal(MIN_MARGIN_S, 90);
  assert.ok(margins({ leadMinutes: 5, lookbackMinutes: 10, intervalMinutes: 1 }).some((x) => x.seconds < MIN_MARGIN_S));   // a smaller lookback would break the margin: the test is not vacuous
  assert.deepEqual({ ...PARAMS }, { intervalMinutes: 1, leadMinutes: 5, lookbackMinutes: 30 });
});

test('the classification of every seed is stable for any scan time from the seeds until the end of the window of the worst arming time', () => {
  const base = Date.UTC(2027, 5, 15, 12, 0, 0); const seeds = seedPlan(base);
  const kind = (s, now) => (s.status !== 'Open' ? 'excluded' : s.dueMs < now - PARAMS.lookbackMinutes * MIN || s.dueMs > now + PARAMS.leadMinutes * MIN ? 'outside' : (s.dueMs < now ? 'OVERDUE' : 'DUESOON'));
  const firstScanFrom = base; const firstScanTo = base + ARM_LIMIT_MS + FIRST_SCAN_MS; const windowEnd = base + ARM_LIMIT_MS + ON_MINUTES * MIN;
  for (let now = firstScanFrom; now <= firstScanTo; now += 10000) {
    assert.equal(kind(seeds.find((s) => s.caseId === 'duesoon'), now), now < base + 5 * MIN ? 'outside' : 'DUESOON', `duesoon at +${(now - base) / 1000}s`);   // not eligible before due - lead, never OVERDUE during the first scans
    for (const s of seeds.filter((x) => x.caseId === 'overduein' || x.caseId === 'preinserted')) assert.equal(kind(s, now), 'OVERDUE');
  }
  for (let now = base; now <= windowEnd; now += 10000) {
    for (const s of seeds.filter((x) => x.caseId === 'overduein' || x.caseId === 'preinserted')) assert.equal(kind(s, now), 'OVERDUE', 'still inside the lookback to the end of the window');
    assert.equal(kind(seeds.find((s) => s.caseId === 'overdueout'), now), 'outside'); assert.equal(kind(seeds.find((s) => s.caseId === 'beyondlead'), now), 'outside');
    for (const id of ['disputed', 'done']) assert.equal(kind(seeds.find((s) => s.caseId === id), now), 'excluded');
  }
});

test('the key of a seed is the key alert-key.mjs builds (also the pre-inserted one), in lower case', () => {
  const k = keyFor('00000000-0000-4000-8000-0000000000AB', TYPE_OVERDUE, '2027-06-15T11:52:00Z');
  assert.equal(k, `00000000-0000-4000-8000-0000000000ab-${TYPE_OVERDUE}-20270615`);
});

test('the plan: offline, lists every case with expectation and observer, both controls, the margins, the counters it will consume and how they are restored, and what only the owner can read', () => {
  const t = planLines().join('\n');
  for (const id of CASE_ORDER) assert.ok(t.includes(id), id);
  for (const n of ['POSITIVE', 'positive controls', 'INCONCLUSIVE', 'MARGINS', 'LATE ON', 'EXPECTED ALERTS', 'COUNTERS', `contract type ${CONTRACT_TYPE}`, 'consumes ONE number', '--counters-approved', '29 October restore', 'never below a number that still exists', 'THE SCRIPT MEASURES', 'ONLY THE OWNER CAN READ', 'never reads it in any way', 'THE FLOW EXISTS AND IS OFF', 'Check_obligation_still_due', 'observed by']) assert.ok(t.includes(n) || t.toLowerCase().includes(n.toLowerCase()), n);
  assert.doesNotMatch(t, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|https?:/i);
});

// ---------------------------------------------------------------------------------------------------------------- the verdict (pure) on a good window and on broken ones
/** A window as it should look: the seeds, the rows of the flow in two runs, the runs, the flow ON at base + 3:00 and OFF at base + 13:00. */
function goodWindow(o = {}) {
  const base = Date.UTC(2027, 5, 15, 12, 0, 0); const plan = seedPlan(base);
  const seeds = plan.map((s, i) => ({ ...s, id: gid(i + 1), createdMs: base + 1000, modifiedMs: base + 1000 }));
  const of = (c) => seeds.filter((s) => s.caseId === c);
  const row = (s, type, at) => ({ id: gid(900 + at % 97), key: keyFor(s.id, type, iso(s.dueMs)), createdMs: at });
  const onAtMs = base + 3 * MIN;
  const runs = [{ startMs: onAtMs + 5000, endMs: onAtMs + 45000, status: 'Succeeded' }, { startMs: onAtMs + 65000, endMs: onAtMs + 105000, status: 'Succeeded' }, { startMs: onAtMs + 125000, endMs: onAtMs + 165000, status: 'Succeeded' }];
  const rows = [row(of('preinserted')[0], TYPE_OVERDUE, base + 2000)];
  of('overduein').slice(0, 5).forEach((s, i) => rows.push(row(s, TYPE_OVERDUE, onAtMs + 10000 + i * 3000)));
  of('overduein').slice(5).forEach((s, i) => rows.push(row(s, TYPE_OVERDUE, onAtMs + 70000 + i * 3000)));
  rows.push(row(of('duesoon')[0], TYPE_DUE_SOON, onAtMs + 78000));
  const w = { base, seeds, rows, runs, strayRows: [], flow: { on: false, onAtMs, onAtSource: 'reported', offAtMs: base + 13 * MIN, baseMs: base }, contract: { found: true, status: 1, ownerIsMe: true, ownerHasEmail: true }, keyActive: true, ...o };
  return w;
}
const byId = (res) => Object.fromEntries(res.map((r) => [r.id, r]));
const statuses = (res, re) => res.filter((r) => re.test(r.id)).map((r) => `${r.id}:${r.status}`);

test('a good window: no FAIL, both controls PASS, every "no alert" case PASS, 8 rows, 5 then 2, case 13 one row, the emails are the owner\'s to count', () => {
  const res = verdict(goodWindow()); const r = byId(res);
  assert.deepEqual(res.filter((x) => x.status === 'FAIL'), []);
  for (const id of ['ctl.duesoon', 'ctl.overdue', 'duesoon.one', 'overdue.each', 'no.overdueout', 'no.beyondlead', 'no.disputed', 'no.done', 'case13.row', 'keys.valid', 'keys.unique', 'rows.stray', 'rows.count', 'cap.max', 'cap.five.then.two', 'obl.untouched', 'contract.owner', 'flow.off', 'key.active']) assert.equal(r[id]?.status, 'PASS', `${id}: ${JSON.stringify(r[id])}`);
  assert.match(r['rows.count'].detail, /8 row/); assert.match(r['emails.expected'].name, /EXPECTED EMAILS = .* 8/);
  assert.match(r['case13.runs'].detail, /3 run\(s\): \{"Succeeded":3\}/);
  assert.equal(r['cap.five.then.two'].status, 'PASS'); assert.match(r['cap.five.then.two'].detail, /\{"0":5,"1":2\}/);
  assert.match(r['recipient.byeye'].name, /NOT measured/); assert.match(r.byeye.name, /BY YOUR EYE/);
});

test('POSITIVE CONTROLS: with no alert at all, both controls FAIL naming the text mismatch, and every "no alert" case is INCONCLUSIVE (OBS), never PASS', () => {
  const w = goodWindow(); w.rows = w.rows.filter((x) => x.createdMs < w.flow.onAtMs);   // only the pre-inserted row
  const r = byId(verdict(w));
  assert.equal(r['ctl.duesoon'].status, 'FAIL'); assert.equal(r['ctl.overdue'].status, 'FAIL');
  assert.match(r['ctl.duesoon'].detail, /text mismatch of the due dates in Check_obligation_still_due/);
  for (const id of ['no.overdueout', 'no.beyondlead', 'no.disputed', 'no.done']) { assert.equal(r[id].status, 'OBS', id); assert.match(r[id].detail, /INCONCLUSIVE/); }
  assert.equal(r['case13.row'].status, 'OBS'); assert.match(r['case13.row'].detail, /INCONCLUSIVE/);
  assert.equal(r['overdue.each'].status, 'OBS'); assert.equal(r['duesoon.one'].status, 'OBS');
  assert.equal(r['rows.count'].status, 'FAIL');
});

test('one control fired and the other did not: the "no alert" cases stay INCONCLUSIVE (both are needed)', () => {
  const w = goodWindow(); const one = w.seeds.find((s) => s.caseId === 'duesoon'); w.rows = w.rows.filter((x) => !x.key.startsWith(one.id));
  const r = byId(verdict(w)); assert.equal(r['ctl.duesoon'].status, 'FAIL'); assert.equal(r['ctl.overdue'].status, 'PASS'); assert.equal(r['no.done'].status, 'OBS');
  const w2 = goodWindow(); w2.rows = w2.rows.filter((x) => !w2.seeds.filter((s) => s.caseId === 'overduein').some((s) => x.key.startsWith(s.id)));
  const r2 = byId(verdict(w2)); assert.equal(r2['ctl.overdue'].status, 'FAIL'); assert.equal(r2['ctl.duesoon'].status, 'PASS'); assert.equal(r2['no.overdueout'].status, 'OBS');
});

test('an alert for a case that must not alert is a FAIL even when the controls fired: outside the lookback, beyond the lead time, Disputed, Done', () => {
  for (const id of ['overdueout', 'beyondlead', 'disputed', 'done']) {
    const w = goodWindow(); const s = w.seeds.find((x) => x.caseId === id); w.rows.push({ id: gid(777), key: keyFor(s.id, TYPE_OVERDUE, iso(s.dueMs)), createdMs: w.flow.onAtMs + 80000 });
    const r = byId(verdict(w)); assert.equal(r[`no.${id}`].status, 'FAIL', id);
  }
});

test('case 13: a row created by the flow for the pre-inserted obligation is a FAIL; a missing pre-inserted row is a FAIL (setup did not hold)', () => {
  const w = goodWindow(); const s = w.seeds.find((x) => x.caseId === 'preinserted');
  const w1 = { ...w, rows: [...w.rows, { id: gid(1), key: keyFor(s.id, TYPE_DUE_SOON, iso(s.dueMs)), createdMs: w.flow.onAtMs + 80000 }] };
  assert.equal(byId(verdict(w1))['case13.row'].status, 'FAIL');
  const w2 = { ...w, rows: w.rows.filter((x) => !x.key.startsWith(s.id)) }; assert.equal(byId(verdict(w2))['case13.row'].status, 'FAIL');
});

test('case 13 records the run outcomes: if the handled failed insert marks every run Failed, that is what the verdict prints (an observation, not a pass or fail)', () => {
  const w = goodWindow(); w.runs = w.runs.map((r) => ({ ...r, status: 'Failed' }));
  const r = byId(verdict(w)); assert.equal(r['case13.runs'].status, 'OBS'); assert.match(r['case13.runs'].detail, /\{"Failed":3\}/);
  assert.deepEqual(verdict(w).filter((x) => x.status === 'FAIL'), []);
});

test('the cap: 6 claims inside one run window FAIL; a first run with only 4 claims fails the "5 then 2" check; overlapping runs are reported and the check is not evaluated', () => {
  const w = goodWindow(); const extra = w.seeds.filter((s) => s.caseId === 'overduein')[5];
  w.rows = w.rows.map((r) => (r.key.startsWith(extra.id) ? { ...r, createdMs: w.flow.onAtMs + 20000 } : r));   // the 6th claim inside run 1
  assert.equal(byId(verdict(w))['cap.max'].status, 'FAIL'); assert.equal(byId(verdict(w))['cap.five.then.two'].status, 'FAIL');
  const w2 = goodWindow(); const fourth = w2.seeds.filter((s) => s.caseId === 'overduein')[4];
  w2.rows = w2.rows.map((r) => (r.key.startsWith(fourth.id) ? { ...r, createdMs: w2.flow.onAtMs + 75000 } : r));   // 4 in run 1, 3 in run 2
  assert.equal(byId(verdict(w2))['cap.five.then.two'].status, 'FAIL');
  const w3 = goodWindow(); w3.runs = [{ startMs: w3.flow.onAtMs + 5000, endMs: w3.flow.onAtMs + 100000, status: 'Succeeded' }, { startMs: w3.flow.onAtMs + 65000, endMs: w3.flow.onAtMs + 130000, status: 'Succeeded' }];
  const r3 = byId(verdict(w3)); assert.equal(r3['cap.overlap'].status, 'OBS'); assert.ok(r3['cap.claims.attribution']); assert.notEqual(r3['cap.five.then.two'].status, 'PASS');
});

test('a claim that lies inside no run is reported (unattributed), not hidden', () => {
  const w = goodWindow(); w.rows.push({ id: gid(55), key: keyFor(w.seeds.find((s) => s.caseId === 'duesoon').id, TYPE_OVERDUE, iso(w.seeds.find((s) => s.caseId === 'duesoon').dueMs)), createdMs: w.flow.onAtMs + 400000 });
  const r = byId(verdict(w)); assert.match(r['cap.claims.attribution'].detail, /unattributed/);
});

test('the due-soon obligation: a second OVERDUE row after its due date is an observation; two DUESOON rows or an OVERDUE row before the due date are FAIL', () => {
  const w = goodWindow(); const s = w.seeds.find((x) => x.caseId === 'duesoon');
  const withOver = { ...w, rows: [...w.rows, { id: gid(2), key: keyFor(s.id, TYPE_OVERDUE, iso(s.dueMs)), createdMs: s.dueMs + 20000 }], runs: [...w.runs, { startMs: s.dueMs + 10000, endMs: s.dueMs + 50000, status: 'Succeeded' }] };
  const r = byId(verdict(withOver)); assert.equal(r['duesoon.overdue'].status, 'OBS'); assert.match(r['duesoon.overdue'].name, /an OVERDUE row is expected/); assert.equal(r['rows.count'].status, 'PASS');
  assert.equal(byId(verdict({ ...w, rows: [...w.rows, { ...w.rows.find((x) => x.key.startsWith(s.id)) }] }))['keys.unique'].status, 'FAIL');
  const early = { ...w, rows: [...w.rows, { id: gid(3), key: keyFor(s.id, TYPE_OVERDUE, iso(s.dueMs)), createdMs: s.dueMs - 60000 }] };
  assert.equal(byId(verdict(early))['keys.valid'].status, 'FAIL');
});

test('keys and rows: a key that is not the one alert-key.mjs builds, an empty key, a stray row, an obligation written after its creation, a contract with another owner, a flow still ON, a key not Active: each FAILS on its own', () => {
  let w = goodWindow(); w.rows = w.rows.map((r, i) => (i === 3 ? { ...r, key: r.key.replace(/-\d{8}$/, '-20300101') } : r));
  assert.equal(byId(verdict(w))['keys.valid'].status, 'FAIL');
  w = goodWindow(); w.strayRows = [{ key: '', createdMs: w.flow.onAtMs + 9000 }]; assert.equal(byId(verdict(w))['rows.stray'].status, 'FAIL');
  w = goodWindow(); w.seeds[2].modifiedMs += 5000; assert.equal(byId(verdict(w))['obl.untouched'].status, 'FAIL');
  w = goodWindow(); w.contract = { ...w.contract, ownerIsMe: false }; assert.equal(byId(verdict(w))['contract.owner'].status, 'FAIL');
  w = goodWindow(); w.contract = { found: false }; assert.equal(byId(verdict(w))['contract.owner'].status, 'FAIL');
  w = goodWindow(); w.flow = { ...w.flow, on: true }; assert.equal(byId(verdict(w))['flow.off'].status, 'FAIL');
  w = goodWindow(); w.keyActive = false; assert.equal(byId(verdict(w))['key.active'].status, 'FAIL');
});

test('LATE ON: a flow turned on later than the limit is reported, and the timing of the due-soon case is INCONCLUSIVE; no on-time at all is an observation', () => {
  const w = goodWindow(); w.flow = { ...w.flow, onAtMs: w.base + ARM_LIMIT_MS + 60000 };
  const r = byId(verdict(w)); assert.equal(r['late.on'].status, 'OBS'); assert.match(r['late.on'].name, /INCONCLUSIVE/);
  const n = goodWindow(); n.flow = { ...n.flow, onAtMs: null }; assert.equal(byId(verdict(n))['on.at'].status, 'OBS');
  assert.equal(byId(verdict(goodWindow()))['late.on'], undefined);
});

test('claimableAtRunStart counts only Open, unclaimed seeds inside the window; the pre-inserted one never counts', () => {
  const w = goodWindow(); const start = w.flow.onAtMs + 5000;
  assert.equal(claimableAtRunStart({ seeds: w.seeds, rows: [], startMs: start }), 7);   // the due-soon one is not eligible yet (due - lead = base + 5:00)
  assert.equal(claimableAtRunStart({ seeds: w.seeds, rows: [], startMs: w.base + 6 * MIN }), 8);
  assert.equal(claimableAtRunStart({ seeds: w.seeds, rows: w.rows.filter((r) => r.createdMs < w.flow.onAtMs + 60000), startMs: w.flow.onAtMs + 65000 }), 2);
});

// ---------------------------------------------------------------------------------------------------------------- the REAL metadata (read from the environment on 2026-11-03/04)
const META = JSON.parse(read('./fixtures/obligation-session-metadata.json'));
const TABLE_OF_SET = Object.fromEntries(Object.entries(META.tables).map(([logical, t]) => [t.entitySet, logical]));
const ISO_SEC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SYSTEM_SET = new Set(['SystemRequired']);
/**
 * What the environment would say about a POST body, judged ONLY by the fixture (not by the mock's own assumptions): every property must be a column of the table or a navigation
 * property written as <NavigationProperty>@odata.bind (case-sensitive, pointing at the entity set the relationship references), types and Choice values must fit, and every
 * ApplicationRequired column must be present. Returns the problems (empty = accepted).
 */
function metadataProblems(path, body) {
  const set = path.split('?')[0]; const logical = TABLE_OF_SET[set]; if (!logical) return [`unknown entity set ${set}`];
  const table = META.tables[logical]; const lookups = META.lookups[logical] ?? {}; const out = []; const present = new Set();
  for (const [k, v] of Object.entries(body ?? {})) {
    if (k.endsWith('@odata.bind')) {
      const nav = k.slice(0, -'@odata.bind'.length); const l = Object.values(lookups).find((x) => x.navigationProperty === nav);
      if (!l) { out.push(`An undeclared property '${nav}' ... only navigation properties of ${logical} are allowed (${Object.values(lookups).map((x) => x.navigationProperty).join(', ')}); the name is case-sensitive`); continue; }
      const target = META.tables[l.referencedEntity]?.entitySet ?? (l.referencedEntity === 'transactioncurrency' ? 'transactioncurrencies' : null);
      if (!new RegExp(`^/${target}\\([0-9a-fA-F-]{36}\\)$`).test(String(v))) out.push(`${k} must point at /${target}(<id>), got ${maskText(v)}`);
      present.add(l.referencingAttribute); continue;
    }
    const col = table.columns[k]; if (!col) { out.push(`'${k}' is not a column of ${logical}`); continue; }
    if (SYSTEM_SET.has(col.required)) { out.push(`'${k}' is set by the system`); continue; }
    present.add(k);
    if (col.type === 'String' && typeof v !== 'string') out.push(`'${k}' must be a string`);
    if (col.type === 'Picklist') { const opts = Object.values(META.choices[`${logical}.${k}`]?.options ?? {}); if (!opts.includes(v)) out.push(`'${k}' = ${v} is not one of its Choice values (${opts.join(', ')})`); }
    if (col.type === 'Money' && typeof v !== 'number') out.push(`'${k}' must be a number`);
    if (col.type === 'DateTime' && !ISO_SEC.test(String(v))) out.push(`'${k}' must be an ISO UTC date-time to the second, got ${v}`);
    if (k === 'mwf_alertkey' && String(v).length > META.string['mwf_alertlog.mwf_alertkey'].max) out.push('mwf_alertkey is longer than its maximum length');
  }
  for (const [k, col] of Object.entries(table.columns)) if (col.required === 'ApplicationRequired' && !present.has(k)) out.push(`required column '${k}' is missing`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- a mocked, stateful environment
function fakeEnv(o = {}) {
  const env = { t: Date.UTC(2027, 5, 15, 12, 0, 0), log: [], me: gid(9000), keyStatus: 'Active', contractsBase: 11, counter: { id: gid(8000), prefix: 'MNT', last: 0 }, ids: 100,
    counterparties: new Map(), contracts: new Map(), obligations: new Map(), alertlogs: new Map(), runs: [], onTick: null, gates: 0, failPost: null, ...o };
  env.flows = o.flows ?? [{ name: FLOW_NAME, statecode: 0, workflowid: gid(7001), modifiedon: iso(env.t - 3600000) }, { name: 'Some other flow', statecode: 0, workflowid: gid(7002), modifiedon: iso(env.t - 3600000) }];
  const nid = () => gid(++env.ids);
  const ok = (j, status = 200) => ({ ok: true, status, j, text: '' });
  const nf = { ok: false, status: 404, j: null, text: '' };
  const decode = (p) => decodeURIComponent(p);
  const startsWithIds = (f) => [...f.matchAll(/startswith\(mwf_alertkey,'([^']+)'\)/g)].map((m) => m[1].toLowerCase());
  env.call = async (method, path, body, headers = {}) => {
    env.log.push({ method, path, body, headers });
    const p = decode(path);
    if (method === 'POST') {
      if (env.failPost?.(path, body)) return { ok: false, status: 500, j: { error: { message: 'boom' } }, text: '' };
      const bad = metadataProblems(path, body); if (bad.length) return { ok: false, status: 400, j: { error: { code: '0x0', message: bad.join('; ') } }, text: '' };
      if (path === 'mwf_counterparties') { const id = nid(); env.counterparties.set(id, { name: body.mwf_name }); return { ok: true, status: 204, j: null, text: '', id }; }
      if (path.startsWith('mwf_contracts')) { const id = nid(); env.counter.last++; env.contracts.set(id, { name: body.mwf_name, status: 1, owner: env.me, number: `MNT-${String(env.counter.last).padStart(4, '0')}` }); return { ok: true, status: 201, j: { mwf_contractid: id }, text: '', id }; }
      if (path.startsWith('mwf_obligations')) { const id = nid(); const c = /\(([^)]+)\)/.exec(body['mwf_Contract@odata.bind'])[1]; env.obligations.set(id, { name: body.mwf_name, status: body.mwf_status, due: body.mwf_duedate, created: iso(env.t), modified: iso(env.t), contract: c }); return { ok: true, status: 201, j: { mwf_obligationid: id }, text: '', id }; }
      if (path === 'mwf_alertlogs') {
        if ([...env.alertlogs.values()].some((r) => r.key === body.mwf_alertkey && body.mwf_alertkey)) return { ok: false, status: 412, j: { error: { code: '0x80060892', message: 'dup' } }, text: '' };
        const id = nid(); env.alertlogs.set(id, { key: body.mwf_alertkey, name: body.mwf_name, created: iso(env.t) }); return { ok: true, status: 204, j: null, text: '', id };
      }
      throw new Error(`unexpected POST ${path}`);
    }
    if (method === 'PATCH') { const m = /^mwf_contractnumbercounters\(([^)]+)\)$/.exec(path); if (m) { env.counter.last = body.mwf_lastnumber; return ok(null, 204); } const c = /^mwf_contracts\(([^)]+)\)$/.exec(path); if (c) { env.contracts.get(c[1]).status = body.statuscode; return ok(null, 204); } throw new Error(`unexpected PATCH ${path}`); }
    if (method === 'DELETE') {
      let m = /^mwf_alertlogs\(([^)]+)\)$/.exec(path); if (m) return env.alertlogs.delete(m[1]) ? ok(null, 204) : nf;
      m = /^mwf_counterparties\(([^)]+)\)$/.exec(path); if (m) return env.counterparties.delete(m[1]) ? ok(null, 204) : nf;
      m = /^mwf_contracts\(([^)]+)\)$/.exec(path); if (m) { for (const [i, o] of env.obligations) if (o.contract === m[1]) env.obligations.delete(i); return env.contracts.delete(m[1]) ? ok(null, 204) : nf; }
      throw new Error(`unexpected DELETE ${path}`);
    }
    if (method !== 'GET') throw new Error(`unexpected ${method} ${path}`);
    if (path === 'WhoAmI') return ok({ UserId: env.me });
    if (path.startsWith('systemusers(')) return ok({ internalemailaddress: o.noEmail ? null : ADDR });
    if (path.startsWith('workflows?')) return ok({ value: env.flows.map((f) => ({ ...f })) });
    if (path.startsWith('flowruns?')) return o.runsFail ? { ok: false, status: 500, j: null, text: '' } : ok({ value: env.runs.map((r) => ({ status: r.status, starttime: iso(r.startMs), endtime: r.endMs ? iso(r.endMs) : null })) });
    if (path.startsWith("EntityDefinitions(LogicalName='mwf_alertlog')/Keys")) return ok({ value: [{ SchemaName: 'mwf_AlertLogKey', KeyAttributes: ['mwf_alertkey'], EntityKeyIndexStatus: env.keyStatus }] });
    if (path.includes("LogicalName='mwf_counterparty')/Attributes")) return ok({ OptionSet: { Options: [{ Value: 867640000 }] } });
    if (path.startsWith("EntityDefinitions(LogicalName='mwf_contractnumbercounter')")) return ok({ EntitySetName: 'mwf_contractnumbercounters' });
    if (path.startsWith('mwf_contractnumbercounters?')) return ok({ value: [{ mwf_contractnumbercounterid: env.counter.id, mwf_contracttypevalue: CONTRACT_TYPE, mwf_prefix: env.counter.prefix, mwf_lastnumber: env.counter.last }] });
    if (path.startsWith('transactioncurrencies?')) return ok({ value: [{ transactioncurrencyid: gid(6000) }] });
    if (p.includes('$count=true')) {
      const n = (c) => ok({ '@odata.count': c });
      if (path.startsWith('mwf_contracts?')) return n(env.contractsBase + env.contracts.size);
      if (path.startsWith('mwf_approvalmatrixes?')) return n(o.matrix ?? 110); if (path.startsWith('mwf_approverassignments?')) return n(5); if (path.startsWith('mwf_approvalsteps?')) return n(0);
      if (path.startsWith('mwf_obligations?')) return n(env.obligations.size); if (path.startsWith('mwf_alertlogs?')) return n(env.alertlogs.size);
    }
    let m = /^mwf_contracts\(([^)]+)\)\?/.exec(path);
    if (m) { const c = env.contracts.get(m[1]); return c ? ok({ statuscode: c.status, _ownerid_value: c.owner }) : nf; }
    if (path.startsWith('mwf_contracts?')) {
      if (p.includes('startswith(mwf_contractnumber')) return ok({ value: [...env.contracts.values()].map((c) => ({ mwf_contractnumber: c.number })) });
      return ok({ value: [...env.contracts].filter(([, c]) => c.name.startsWith(`${FAMILY}-`)).map(([id, c]) => ({ mwf_contractid: id, mwf_name: c.name })) });
    }
    if (path.startsWith('mwf_counterparties?')) return ok({ value: [...env.counterparties].filter(([, c]) => c.name.startsWith(`${FAMILY}-`)).map(([id, c]) => ({ mwf_counterpartyid: id, mwf_name: c.name })) });
    if (path.startsWith('mwf_obligations?')) return ok({ value: [...env.obligations].filter(([, x]) => x.name.startsWith(`${FAMILY}-`)).map(([id, x]) => ({ mwf_obligationid: id, mwf_name: x.name, mwf_status: x.status, mwf_duedate: x.due, createdon: x.created, modifiedon: x.modified, _mwf_contract_value: x.contract })) });
    if (path.startsWith('mwf_alertlogs?')) {
      const ids = startsWithIds(p); const eq = /mwf_alertkey eq '([^']+)'/.exec(p); const since = /createdon ge ([0-9T:\-]+Z)/.exec(p);
      let rows = [...env.alertlogs].map(([id, r]) => ({ mwf_alertlogid: id, mwf_alertkey: r.key, mwf_name: r.name, createdon: r.created }));
      if (eq) rows = rows.filter((r) => r.mwf_alertkey === eq[1]); else if (ids.length) rows = rows.filter((r) => ids.some((i) => String(r.mwf_alertkey).toLowerCase().startsWith(i))); else if (since) rows = rows.filter((r) => Date.parse(r.createdon) >= Date.parse(since[1]));
      return ok({ value: rows });
    }
    throw new Error(`unexpected GET ${path}`);
  };
  const deps = (flags = {}) => ({ call: env.call, now: () => env.t, sleep: async (ms) => { env.t += ms; env.onTick?.(env); }, log: (l) => env.out.push(l), gate: async () => { env.gates++; }, flags });
  env.out = []; env.deps = deps; env.session = (flags) => createSession(deps(flags));
  env.writes = () => env.log.filter((c) => c.method !== 'GET');
  env.text = () => env.out.join('\n');
  return env;
}
const approved = { countersApproved: true, expectContracts: 11 };

// ---------------------------------------------------------------------------------------------------------------- baseline
test('baseline: a clean environment passes (key Active, 11 / 110 / 5 / 0, no obligations, no alert log rows, every flow OFF, the alerts flow exists, an address)', async () => {
  const env = fakeEnv(); const ok = await env.session(approved).baseline();
  assert.equal(ok, true, env.text()); assert.match(env.text(), /PASS +key/); assert.match(env.text(), /INFO +counters: MNT=0/);
  assert.equal(env.writes().length, 0);
});

test('baseline: each deviation fails on its own (key not Active, a contract too many, a flow ON, no alerts flow row, a row of the session, no address, matrix changed)', async () => {
  const cases = [['key not Active', { keyStatus: 'Pending' }, /FAIL +key/], ['contracts 12', { contractsBase: 12 }, /FAIL +counts/], ['matrix 109', { matrix: 109 }, /FAIL +counts/],
    ['a flow ON', { flows: [{ name: FLOW_NAME, statecode: 1, workflowid: gid(1), modifiedon: iso(0) }] }, /FAIL +flows/], ['no alerts flow row', { flows: [{ name: 'Other', statecode: 0, workflowid: gid(1), modifiedon: iso(0) }] }, /FAIL +flow\.row/], ['no address', { noEmail: true }, /FAIL +me/]];
  for (const [label, o, re] of cases) { const env = fakeEnv(o); assert.equal(await env.session(approved).baseline(), false, label); assert.match(env.text(), re, label); }
  const env = fakeEnv(); env.obligations.set(gid(1), { name: `${FAMILY}-LEFT-1`, status: 867640000, due: iso(0), created: iso(0), modified: iso(0), contract: gid(2) });
  assert.equal(await env.session(approved).baseline(), false); assert.match(env.text(), /FAIL +(rows|counts)/);
});

// ---------------------------------------------------------------------------------------------------------------- setup
test('setup refuses WITHOUT the counter approval and writes nothing; a dry run writes nothing either and prints what it would do', async () => {
  const env = fakeEnv();
  await assert.rejects(() => env.session({ expectContracts: 11 }).setup(), (e) => e instanceof Stop && /--counters-approved/.test(e.message) && /Nothing was written/.test(e.message));
  assert.equal(env.writes().length, 0); assert.equal(env.counter.last, 0);
  const dry = fakeEnv(); const ok = await dry.session({ dry: true, expectContracts: 11 }).setup();
  assert.equal(ok, true, dry.text()); assert.equal(dry.writes().length, 0); assert.match(dry.text(), /DRY-RUN +would POST mwf_obligations/); assert.equal(dry.counter.last, 0);
});

test('setup: one counterparty, ONE Draft contract (one counter number), 13 obligations with the planned due dates, the pre-inserted row of case 13; read back; READY; the hand-off', async () => {
  const env = fakeEnv(); const ok = await env.session(approved).setup();
  assert.equal(ok, true, env.text());
  assert.equal(env.counterparties.size, 1); assert.equal(env.contracts.size, 1); assert.equal(env.obligations.size, 13); assert.equal(env.alertlogs.size, 1);
  assert.equal(env.counter.last, 1);   // ONE number consumed
  const c = [...env.contracts.values()][0]; assert.equal(c.status, 1); assert.equal(c.owner, env.me);
  const base = env.t;   // the mock clock did not move: BASE = now
  const due = (name) => Date.parse([...env.obligations.values()].find((o) => o.name === name).due) - Math.floor(base / 1000) * 1000;
  assert.equal(due(nameOf('duesoon', 0)), 10 * MIN); assert.equal(due(nameOf('overdueout', 0)), -50 * MIN); assert.equal(due(nameOf('overduein', 6)), -8 * MIN - 30000);
  const ob = [...env.obligations].find(([, o]) => o.name === nameOf('preinserted', 0)); const key = [...env.alertlogs.values()][0].key;
  assert.equal(key, keyFor(ob[0], TYPE_OVERDUE, ob[1].due));
  assert.match(env.text(), /COUNTERS handed to the cleanup step: --counters-before=MNT:0 --counters-consumed=MNT:1/);
  for (const n of ['READY', 'TURN THE FLOW ON NO LATER THAN', 'EXPECTED: 7 OVERDUE alerts', 'the script does not read your mailbox', 'BASE + 10:00']) assert.ok(env.text().includes(n), n);
  assert.match(env.text(), /PASS +seeds +READ BACK: 13 obligations/); assert.match(env.text(), /PASS +pre /);
});

test('setup writes ONLY contracts, counterparties, obligations and alert log rows, never the table of flows, with the connection gate before every write', async () => {
  const env = fakeEnv(); await env.session(approved).setup();
  const w = env.writes(); assert.ok(w.length >= 16);
  assert.ok(w.every((c) => c.method === 'POST' && /^(mwf_counterparties|mwf_contracts|mwf_obligations|mwf_alertlogs)(\?|$)/.test(c.path)), JSON.stringify(w.map((c) => c.path)));
  assert.ok(!env.log.some((c) => /workflows/.test(c.path) && c.method !== 'GET'));
  assert.ok(env.gates >= w.length);   // a gate before every write
  assert.ok(w.filter((c) => c.path.startsWith('mwf_obligations')).every((c) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(c.body.mwf_duedate) && c.body['mwf_Contract@odata.bind']));
});

test('setup stops BEFORE writing when the baseline is not clean or a flow is ON, and after a failed write it says to run the cleanup', async () => {
  for (const o of [{ keyStatus: 'Failed' }, { contractsBase: 10 }, { flows: [{ name: FLOW_NAME, statecode: 1, workflowid: gid(1), modifiedon: iso(0) }] }]) {
    const env = fakeEnv(o); await assert.rejects(() => env.session(approved).setup(), Stop); assert.equal(env.writes().length, 0, JSON.stringify(Object.keys(o)));
  }
  const env = fakeEnv({ failPost: (p) => p.startsWith('mwf_obligations') }); await assert.rejects(() => env.session(approved).setup(), (e) => /Run cleanup/.test(e.message));
  const env2 = fakeEnv({ failPost: (p) => p === 'mwf_alertlogs' }); await assert.rejects(() => env2.session(approved).setup(), (e) => /pre-inserted alert log row failed/.test(e.message));
  const env3 = fakeEnv({ failPost: (p) => p.startsWith('mwf_contracts') }); await assert.rejects(() => env3.session(approved).setup(), (e) => /counters-before=MNT:0/.test(e.message));
});

// ---------------------------------------------------------------------------------------------------------------- await (read only)
test('await writes NOTHING: it waits for the ON, prints ON-AT, does not count the pre-inserted row as a claim, prints each claim, DONE, TURN THE FLOW OFF NOW, and STILL ON until it is OFF', async () => {
  const env = fakeEnv(); await env.session(approved).setup(); const before = env.writes().length;
  const idOf = Object.fromEntries([...env.obligations].map(([id, o]) => [o.name, id])); const flow = env.flows[0];
  const start = env.t; let turnedOff = false;
  env.onTick = (e) => {
    const el = e.t - start;
    if (el >= 60000 && flow.statecode === 0 && !turnedOff) { flow.statecode = 1; flow.modifiedon = iso(e.t); }   // the owner turns it ON after 1 minute
    if (flow.statecode === 1) {
      const rows = [...[0, 1, 2, 3, 4, 5, 6].map((i) => nameOf('overduein', i)), nameOf('duesoon', 0)];
      rows.forEach((n, i) => { const o = [...e.obligations.values()].find((x) => x.name === n); const k = keyFor(idOf[n], i === 7 ? TYPE_DUE_SOON : TYPE_OVERDUE, o.due); if (el >= 90000 + i * 5000 && ![...e.alertlogs.values()].some((r) => r.key === k)) e.alertlogs.set(gid(500 + i), { key: k, name: k, created: iso(e.t) }); });
      if (el >= 600000) { flow.statecode = 0; flow.modifiedon = iso(e.t); turnedOff = true; }   // the owner turns it OFF
    }
  };
  const r = await env.session(approved).awaitWindow();
  assert.equal(r, true, env.text());
  assert.equal(env.writes().length, before, 'await wrote something');
  const t = env.text();
  assert.match(t, /WAITING FOR THE OWNER TO TURN THE FLOW ON/); assert.match(t, /ON-AT \d{4}-\d{2}-\d{2}T[\d:]+Z \(UTC\)/); assert.match(t, /1 alert log row\(s\) existed when the flow was turned ON/);
  assert.equal((t.match(/^CLAIM /gm) || []).length, 8); assert.match(t, /DONE: every expected alert was claimed/); assert.match(t, /TURN THE FLOW OFF NOW/); assert.match(t, /STILL ON/);
});

test('await gives up after 10 minutes without an ON and changes nothing; a flow that stays ON after DONE ends as STILL ON (false)', async () => {
  const env = fakeEnv(); const r = await env.session(approved).awaitWindow();
  assert.equal(r, 'timeout'); assert.equal(env.writes().length, 0); assert.match(env.text(), /not turned ON within 10 minutes/);
  const on = fakeEnv(); on.flows[0].statecode = 1; on.flows[0].modifiedon = iso(on.t);
  assert.equal(await on.session(approved).awaitWindow(), false); assert.match(on.text(), /DONE \(time limit\)/); assert.match(on.text(), /STILL ON after 5 minutes/); assert.equal(on.writes().length, 0);
});

// ---------------------------------------------------------------------------------------------------------------- verdict (read only)
async function windowed(env, { claimCap = true, off = true, extraRows = () => {} } = {}) {
  await env.session(approved).setup();
  const base = Math.min(...[...env.obligations.values()].map((o) => Date.parse(o.created)));
  const idOf = Object.fromEntries([...env.obligations].map(([id, o]) => [o.name, id])); const onAt = base + 3 * MIN;
  const claim = (name, type, at) => { const o = [...env.obligations.values()].find((x) => x.name === name); const k = keyFor(idOf[name], type, o.due); env.alertlogs.set(gid(600 + env.alertlogs.size), { key: k, name: k, created: iso(at) }); };
  for (let i = 0; i < 5; i++) claim(nameOf('overduein', i), TYPE_OVERDUE, onAt + 10000 + i * 3000);
  for (let i = 5; i < 7; i++) claim(nameOf('overduein', i), TYPE_OVERDUE, onAt + 70000 + i * 1000);
  claim(nameOf('duesoon', 0), TYPE_DUE_SOON, onAt + 78000);
  extraRows(claim, onAt);
  env.runs = [{ startMs: onAt + 5000, endMs: onAt + 45000, status: 'Succeeded' }, { startMs: onAt + 65000, endMs: onAt + 105000, status: 'Succeeded' }];
  env.flows[0].statecode = off ? 0 : 1; env.flows[0].modifiedon = iso(base + 13 * MIN);
  return { base, onAt };
}

test('verdict: on a good window the mocked environment gives no FAIL, reads only, and ends with the LINK CHECK pause', async () => {
  const env = fakeEnv(); const { onAt } = await windowed(env); const before = env.writes().length;
  const ok = await env.session({ ...approved, onAt: iso(onAt) }).runVerdict();
  assert.equal(ok, true, env.text()); assert.equal(env.writes().length, before, 'the verdict wrote something');
  assert.match(env.text(), /VERDICT: \d+ PASS, 0 FAIL/); assert.match(env.text(), /LINK CHECK WINDOW: obligations still exist, say 'link checked' to continue/);
  assert.match(env.text(), /PASS +ctl\.duesoon/); assert.match(env.text(), /PASS +no\.done/); assert.match(env.text(), /PASS +cap\.five\.then\.two/);
});

test('verdict: a window with no alert at all FAILS both controls and marks every "no alert" result INCONCLUSIVE', async () => {
  const env = fakeEnv(); await env.session(approved).setup();
  const base = Math.min(...[...env.obligations.values()].map((o) => Date.parse(o.created))); env.runs = [{ startMs: base + 190000, endMs: base + 230000, status: 'Succeeded' }]; env.flows[0].modifiedon = iso(base + 13 * MIN);
  const ok = await env.session({ ...approved, onAt: iso(base + 3 * MIN) }).runVerdict();
  assert.equal(ok, false); assert.match(env.text(), /FAIL +ctl\.duesoon/); assert.match(env.text(), /FAIL +ctl\.overdue/); assert.match(env.text(), /OBS +no\.done .*INCONCLUSIVE/s);
});

test('verdict: the flow still ON is a FAIL (the verdict waits and prints STILL ON); an obligation or an alert for a no-alert case is a FAIL; a stray row is a FAIL', async () => {
  const on = fakeEnv(); await windowed(on, { off: false });
  assert.equal(await on.session(approved).runVerdict(), false); assert.match(on.text(), /STILL ON/); assert.match(on.text(), /FAIL +flow\.off/);
  const env = fakeEnv(); await windowed(env, { extraRows: (claim, onAt) => { claim(nameOf('disputed', 0), TYPE_OVERDUE, onAt + 80000); env.alertlogs.set(gid(999), { key: '', name: 'x', created: iso(onAt + 90000) }); } });
  assert.equal(await env.session(approved).runVerdict(), false); assert.match(env.text(), /FAIL +no\.disputed/); assert.match(env.text(), /FAIL +rows\.stray/);
});

test('verdict refuses to guess when there is nothing to judge (no obligation of the session), and fails loudly when the run records cannot be read', async () => {
  const env = fakeEnv(); await assert.rejects(() => env.session(approved).runVerdict(), (e) => /No obligation of this session exists/.test(e.message));
  const bad = fakeEnv({ runsFail: true }); await bad.session(approved).setup(); await assert.rejects(() => bad.session(approved).runVerdict(), (e) => /flowruns not readable/.test(e.message));
});

// ---------------------------------------------------------------------------------------------------------------- cleanup
test('cleanup refuses while the flow is ON and deletes nothing', async () => {
  const env = fakeEnv(); await env.session(approved).setup(); env.flows[0].statecode = 1; const before = env.writes().length;
  const ok = await env.session({ ...approved, handoff: { before: { MNT: 0 }, consumed: { MNT: 1 } } }).cleanup();
  assert.equal(ok, false); assert.equal(env.writes().length, before); assert.match(env.text(), /STILL ON/); assert.match(env.text(), /nothing was deleted/);
});

test('cleanup without the counter approval refuses before deleting; with it, it deletes by the ids of THIS session only, restores the counter, and leaves the baseline', async () => {
  const env = fakeEnv(); await env.session(approved).setup(); const writes = env.writes().length;
  await assert.rejects(() => env.session({ expectContracts: 11 }).cleanup(), (e) => /counters-approved/.test(e.message)); assert.equal(env.writes().length, writes);
  // a decoy: an alert log row whose key starts with an id that is NOT one of this session's obligations, and one with a legitimate-looking key
  const decoyKey = keyFor(gid(31337), TYPE_OVERDUE, '2027-01-01T00:00:00Z'); env.alertlogs.set(gid(31338), { key: decoyKey, name: decoyKey, created: iso(env.t) });
  const ok = await env.session({ ...approved, handoff: { before: { MNT: 0 }, consumed: { MNT: 1 } } }).cleanup();
  assert.equal(ok, false, 'the decoy row remains, so the final baseline (0 alert log rows) is NOT met and the cleanup says so');
  assert.match(env.text(), /FAIL +clean.counts/);
  assert.equal(env.contracts.size, 0); assert.equal(env.obligations.size, 0); assert.equal(env.counterparties.size, 0);
  assert.deepEqual([...env.alertlogs.values()].map((r) => r.key), [decoyKey], 'only rows of this session\'s obligations are deleted');
  assert.equal(env.counter.last, 0); assert.match(env.text(), /counters: restored 1/);
  assert.match(env.text(), /PASS +clean /); assert.match(env.text(), /1 of 1 alert log row\(s\) deleted/);
  assert.ok(env.writes().slice(writes).every((c) => c.method === 'DELETE' || (c.method === 'PATCH' && /^mwf_contractnumbercounters\(/.test(c.path))));
  assert.ok(!env.log.some((c) => /workflows/.test(c.path) && c.method !== 'GET'));
});

test('cleanup of a session without any foreign row ends clean: true, the counter back at its snapshot, the baseline met', async () => {
  const env = fakeEnv(); await env.session(approved).setup();
  const ok = await env.session({ ...approved, handoff: { before: { MNT: 0 }, consumed: { MNT: 1 } } }).cleanup();
  assert.equal(ok, true, env.text()); assert.equal(env.counter.last, 0); assert.equal(env.alertlogs.size, 0); assert.match(env.text(), /PASS +clean.counts/);
});

test('cleanup refuses to restore the counter when someone else used a number, and says so; the rows are still deleted', async () => {
  const env = fakeEnv(); await env.session(approved).setup(); env.counter.last = 5;   // another number was used in the meantime
  const ok = await env.session({ ...approved, handoff: { before: { MNT: 0 }, consumed: { MNT: 1 } } }).cleanup();
  assert.equal(ok, false); assert.equal(env.counter.last, 5); assert.match(env.text(), /NOT restored/); assert.equal(env.obligations.size, 0);
});

test('cleanup without the hand-off says that the counter was NOT restored (it never guesses the numbers)', async () => {
  const env = fakeEnv(); await env.session(approved).setup();
  await env.session(approved).cleanup(); assert.match(env.text(), /counters NOT restored: give --counters-before/); assert.equal(env.counter.last, 1);
});

test('a dry-run cleanup deletes nothing and states what it would delete', async () => {
  const env = fakeEnv(); await env.session(approved).setup(); const w = env.writes().length;
  assert.equal(await env.session({ dry: true, expectContracts: 11 }).cleanup(), true); assert.equal(env.writes().length, w); assert.match(env.text(), /DRY-RUN +would delete 1 alert log row/);
});

// ---------------------------------------------------------------------------------------------------------------- shape of the code
test('the code never writes to the table of flows, never reads a mailbox, never turns anything on or off, and writes only four tables', () => {
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const lib = code(read('./obligation-session.mjs')); const cli = code(read('../test-flow-obligation-alerts.mjs'));
  for (const c of [lib, cli]) {
    assert.doesNotMatch(c, /\bmessages\b|office365|Outlook|mailbox\/|\/me\/mail|SendEmail|inbox|imap|smtp/i);
    assert.doesNotMatch(c, /statecode\s*:\s*[01]\b|SetState|activate|Activat|turnOn|turn_on|\bPublish/);
    assert.doesNotMatch(c, /(write|call)\(\s*'(POST|PATCH|PUT|DELETE)'\s*,\s*[`'"]workflows/);
  }
  assert.match(lib, /WRITE_TABLES = \/\^\(mwf_contracts\|mwf_counterparties\|mwf_obligations\|mwf_alertlogs\)/);
  assert.doesNotMatch(lib.replace(/Plug|\[\^\)]/g, ''), /WRITE_TABLES[^;]*workflows/);
  assert.match(read('./obligation-session.mjs'), /NO WINDOW HAS BEEN RUN/);
  assert.match(read('./obligation-session.mjs'), /never reads a mailbox|never reads (a|your) mailbox|never read a mailbox|does NOT read|never reads it in any way/i);
});

// ---------------------------------------------------------------------------------------------------------------- the written names against the REAL metadata
test('the fixture is the real metadata: the obligation lookup is mwf_Contract (capital C), and it holds no host, no address and no id', () => {
  assert.equal(META.lookups.mwf_obligation.mwf_contract.navigationProperty, 'mwf_Contract');
  assert.equal(META.lookups.mwf_obligation.mwf_contract.relationship, 'mwf_contract_obligation');
  const text = read('./fixtures/obligation-session-metadata.json').replaceAll('@odata.bind', '');   // the only @ in the file is the name of the bind property
  assert.doesNotMatch(text, /dynamics\.com|https?:|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|@[A-Za-z0-9-]+\.[a-z]{2,}/i);
});

test('the validator judges by the fixture: the old lowercase bind is REJECTED, the real name is accepted, and a wrong column, Choice value, date format or missing required column is rejected', () => {
  const good = { mwf_name: 'x', mwf_party: 867640000, mwf_duedate: '2027-01-01T10:00:00Z', mwf_status: 867640000, 'mwf_Contract@odata.bind': `/mwf_contracts(${gid(1)})` };
  assert.deepEqual(metadataProblems('mwf_obligations?$select=mwf_obligationid', good), []);
  const old = { ...good }; delete old['mwf_Contract@odata.bind']; old['mwf_contract@odata.bind'] = good['mwf_Contract@odata.bind'];
  assert.match(metadataProblems('mwf_obligations', old).join(' '), /undeclared property 'mwf_contract'/);
  assert.match(metadataProblems('mwf_obligations', { ...good, mwf_status: 1 }).join(' '), /mwf_status/);
  assert.match(metadataProblems('mwf_obligations', { ...good, mwf_duedate: '2027-01-01' }).join(' '), /mwf_duedate/);
  assert.match(metadataProblems('mwf_obligations', { ...good, mwf_nope: 1 }).join(' '), /not a column/);
  assert.match(metadataProblems('mwf_obligations', { ...good, 'mwf_Contract@odata.bind': `/mwf_counterparties(${gid(1)})` }).join(' '), /must point at/);
  const noBind = { ...good }; delete noBind['mwf_Contract@odata.bind'];
  assert.match(metadataProblems('mwf_obligations', noBind).join(' '), /required column 'mwf_contract'/);
});

test('setup writes ONLY names and values the real metadata accepts: every POST (counterparty, contract, 13 obligations, alert log row) is valid against the fixture, and every @odata.bind name is a navigation property of the fixture', async () => {
  const env = fakeEnv(); await env.session(approved).setup();
  const posts = env.writes(); assert.equal(posts.length, 16);
  for (const w of posts) assert.deepEqual(metadataProblems(w.path, w.body), [], w.path);
  const binds = [...new Set(posts.flatMap((w) => Object.keys(w.body).filter((k) => k.endsWith('@odata.bind')).map((k) => w.path.split('?')[0] + ' ' + k)))].sort();
  assert.deepEqual(binds, ['mwf_contracts mwf_counterpartyid@odata.bind', 'mwf_contracts transactioncurrencyid@odata.bind', 'mwf_obligations mwf_Contract@odata.bind']);
  for (const b of binds) { const [set, key] = b.split(' '); const nav = key.slice(0, -'@odata.bind'.length); assert.ok(Object.values(META.lookups[TABLE_OF_SET[set]]).some((l) => l.navigationProperty === nav), b); }
});

test('regression of the failed setup: with the old lowercase bind the environment answers 400, the session stops, and the message carries the HTTP status, the error code and the message, with every id masked', async () => {
  const env = fakeEnv({ renameBind: true });
  const orig = env.call; env.call = (m, pth, body, h) => { if (m === 'POST' && pth.startsWith('mwf_obligations') && body['mwf_Contract@odata.bind']) { body = { ...body, 'mwf_contract@odata.bind': body['mwf_Contract@odata.bind'] }; delete body['mwf_Contract@odata.bind']; } return orig(m, pth, body, h); };
  let msg = ''; await assert.rejects(() => env.session(approved).setup(), (e) => { msg = e.message; return e instanceof Stop; });
  assert.match(msg, /obligation .* create failed: HTTP 400, error code 0x0, message .*undeclared property 'mwf_contract'/);
  assert.doesNotMatch(msg, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.match(msg, /Run cleanup \(nothing is cleaned up by guess\)/);
});

test('describeFailure and maskText: status, code and message are printed; GUIDs, URLs and Dataverse hosts never are; a long message is cut; a body without JSON falls back to the text', () => {
  const g = '12345678-1234-4234-8234-123456789abc';
  const host = ['orgx', 'crm4', 'dynamics', 'com'].join('.');   // built at run time: no host-like literal in the repository
  const m = describeFailure({ status: 400, j: { error: { code: '0x80048d19', message: `bad ${g} at https://${host}/api/data/v9.2/x and ${host}` } } });
  assert.equal(m, 'HTTP 400, error code 0x80048d19, message bad <id> at <url> and <host>');
  assert.equal(describeFailure({ status: 503, j: null, text: `gateway ${g}` }), 'HTTP 503, error code none, message gateway <id>');
  assert.equal(describeFailure({ status: 500, j: null, text: '' }), 'HTTP 500, error code none, message none');
  assert.ok(describeFailure({ status: 400, j: { error: { code: 'x', message: 'a'.repeat(900) } } }).length < 470);
});

test('every failed write of setup reports status, code and message (counterparty, contract, alert log row), a failed GET too, and the obligations report ALL failures counted, not only the first', async () => {
  const mk = (pred) => fakeEnv({ failPost: (p) => pred(p) });
  for (const [pred, re] of [[(p) => p === 'mwf_counterparties', /counterparty create failed: HTTP 500, error code none, message boom/], [(p) => p.startsWith('mwf_contracts'), /contract create failed: HTTP 500, error code none, message boom/], [(p) => p === 'mwf_alertlogs', /pre-inserted alert log row failed: HTTP 500, error code none, message boom/]]) {
    await assert.rejects(() => mk(pred).session(approved).setup(), (e) => re.test(e.message));
  }
  await assert.rejects(() => mk((p) => p.startsWith('mwf_obligations')).session(approved).setup(), (e) => /13 of 13 obligation create\(s\) failed, 0 were created\. First failure: obligation .* create failed: HTTP 500/.test(e.message));
  const env = fakeEnv(); const orig = env.call; env.call = (m, pth, ...r) => (m === 'GET' && pth.startsWith('transactioncurrencies') ? { ok: false, status: 403, j: { error: { code: '0x80040220', message: 'no privilege' } }, text: '' } : orig(m, pth, ...r));
  await assert.rejects(() => env.session(approved).setup(), (e) => /GET transactioncurrencies.* failed: HTTP 403, error code 0x80040220, message no privilege/.test(e.message));
});
