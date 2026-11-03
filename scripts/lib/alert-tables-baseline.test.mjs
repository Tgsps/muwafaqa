import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALERT_TABLES, readAlertTableCounts, alertTablesVerdict } from './alert-tables-baseline.mjs';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const mock = (spec) => async (method, path) => {
  assert.equal(method, 'GET');   // reads only
  for (const t of ALERT_TABLES) {
    if (path.startsWith(`EntityDefinitions(LogicalName='${t}')`)) { const s = spec[t]; return s.meta ?? (s.absent ? { ok: false, status: 404 } : { ok: true, status: 200, j: { EntitySetName: `${t}s` } }); }
    if (path.startsWith(`${t}s?`)) { const s = spec[t]; return s.count ?? { ok: true, status: 200, j: { '@odata.count': s.rows ?? 0 } }; }
  }
  throw new Error(`unexpected ${path}`);
};

test('both tables absent: two observations, no failure (the existing baselines keep working before the tables exist)', async () => {
  const v = alertTablesVerdict(await readAlertTableCounts(mock({ mwf_obligation: { absent: true }, mwf_alertlog: { absent: true } })));
  assert.equal(v.ok, true); assert.deepEqual(v.lines.map((l) => l.status), ['OBS', 'OBS']);
});

test('both tables present with 0 rows: two PASS', async () => {
  const v = alertTablesVerdict(await readAlertTableCounts(mock({ mwf_obligation: {}, mwf_alertlog: {} })));
  assert.equal(v.ok, true); assert.deepEqual(v.lines.map((l) => l.status), ['PASS', 'PASS']);
});

test('a table with rows fails; one absent and one present with 0 rows passes', async () => {
  const v = alertTablesVerdict(await readAlertTableCounts(mock({ mwf_obligation: { rows: 2 }, mwf_alertlog: {} })));
  assert.equal(v.ok, false); assert.equal(v.lines[0].status, 'FAIL'); assert.equal(v.lines[0].detail, '2');
  const m = alertTablesVerdict(await readAlertTableCounts(mock({ mwf_obligation: { absent: true }, mwf_alertlog: {} })));
  assert.equal(m.ok, true); assert.deepEqual(m.lines.map((l) => l.status), ['OBS', 'PASS']);
});

test('a read error (not 404) and a missing count are failures, never silently absent', async () => {
  const e = alertTablesVerdict(await readAlertTableCounts(mock({ mwf_obligation: { meta: { ok: false, status: 500 } }, mwf_alertlog: { count: { ok: true, status: 200, j: {} } } })));
  assert.equal(e.ok, false); assert.deepEqual(e.lines.map((l) => l.status), ['FAIL', 'FAIL']);
  assert.equal(alertTablesVerdict([]).ok, false);   // nothing was looked at
});

test('the existing counts are untouched: the baselines still expect 11 / 110 / 5 / 0 and now also call the ADR-011 baseline (read only)', () => {
  const reminders = read('../test-flow-reminders.mjs');
  assert.match(reminders, /c\.contracts === EXPECT\.value && c\.matrix === 110 && c\.assignments === 5 && c\.steps === 0/);
  assert.match(reminders, /readAlertTableCounts\(S\.call\)/); assert.match(reminders, /alertTablesVerdict/);
  const verify = read('../verify-approval-chain-schema.mjs');
  assert.match(verify, /readAlertTableCounts\(call\)/); assert.match(verify, /alertTablesVerdict/);
});
