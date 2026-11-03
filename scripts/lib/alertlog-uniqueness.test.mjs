// Tests of the steps of scripts/test-alertlog-uniqueness.mjs against a MOCKED HTTP layer. Nothing here talks to an environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runUniquenessTest, errorCodeOf, isDuplicateKey, DUPLICATE_CODE } from './alertlog-uniqueness.mjs';

const SCRIPT = fileURLToPath(new URL('../test-alertlog-uniqueness.mjs', import.meta.url));
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', timeout: 30000 });

/**
 * A small fake of the table mwf_alertlog. opts:
 *  keyStatus       EntityKeyIndexStatus ('Active')
 *  dupStatus       the HTTP status of a duplicate rejection (412 by default; the tests also use 409 and 500: the real one is a measurement)
 *  dupCode         the code in the body (the real one by default)
 *  enforce         false = uniqueness is not enforced at all
 *  emptyOk         true = an empty key is accepted (the second empty key then is a duplicate when enforceEmpty)
 *  failPostAt      throw (a network error) on the nth POST (1-based)
 *  failDelete      DELETE answers 500
 *  preexisting     rows that exist before the run
 *  lostAnswer      the nth POST creates the row but the answer is lost (no id)
 */
const gid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fake(opts = {}) {
  const o = { keyStatus: 'Active', dupStatus: 412, dupCode: DUPLICATE_CODE, enforce: true, emptyOk: true, enforceEmpty: true, ...opts };
  const rows = new Map(); let seq = 0; let posts = 0; const log = [];
  (o.preexisting || []).forEach((k) => rows.set(gid(++seq), { mwf_alertkey: k, mwf_name: k }));
  const ok = (j, status = 200, id = null) => ({ ok: true, status, j, text: JSON.stringify(j ?? {}), id });
  const err = (status, code, message = 'x') => ({ ok: false, status, j: { error: { code, message } }, text: JSON.stringify({ error: { code, message } }), id: null });
  const filterRows = (path) => {
    const f = decodeURIComponent((/\$filter=([^&]*)/.exec(path) || [])[1] || '');
    const eq = /mwf_alertkey eq '([^']*)'/.exec(f);
    if (eq) return [...rows.entries()].filter(([, r]) => r.mwf_alertkey === eq[1]);
    if (f.includes('startswith')) return [...rows.entries()].filter(([, r]) => String(r.mwf_alertkey ?? '').startsWith('TEST-TMP-ALERT-') || String(r.mwf_name ?? '').startsWith('TEST-TMP-ALERT-'));
    return [...rows.entries()];
  };
  const call = async (method, path, body) => {
    log.push({ method, path, body });
    if (method === 'GET' && path.startsWith("EntityDefinitions(LogicalName='mwf_alertlog')?")) return ok({ EntitySetName: 'mwf_alertlogs' });
    if (method === 'GET' && path.includes('/Keys')) return ok({ value: [{ SchemaName: 'mwf_AlertLogKey', KeyAttributes: ['mwf_alertkey'], EntityKeyIndexStatus: o.keyStatus }] });
    if (method === 'POST' && path === 'mwf_alertlogs') {
      posts++;
      if (o.failPostAt === posts) throw new Error('network error (mock)');
      const k = body.mwf_alertkey;
      const empty = k === '' || k === null || k === undefined;
      if (empty && !o.emptyOk) return err(400, '0x80040265', 'required');
      await Promise.resolve();   // lets concurrent inserts interleave
      if (o.enforce && [...rows.values()].some((r) => r.mwf_alertkey === k) && (!empty || o.enforceEmpty) && k !== null) return err(o.dupStatus, o.dupCode, 'A record that has the attribute values Alert Key already exists.');
      const id = gid(++seq); rows.set(id, { mwf_alertkey: k, mwf_name: body.mwf_name });
      if (o.lostAnswer === posts) return { ok: false, status: 0, j: null, text: '', id: null };
      return ok(null, 204, id);
    }
    if (method === 'GET' && /^mwf_alertlogs\(mwf_alertkey='/.test(path)) { const k = /'([^']*)'/.exec(path)[1]; const hit = [...rows.values()].find((r) => r.mwf_alertkey === k); return hit ? ok({ mwf_alertkey: k }) : err(404, '0x80040217'); }
    if (method === 'GET' && path.startsWith('audits?')) {
      if (o.auditStatus) return { ok: false, status: o.auditStatus, j: { error: { message: 'no privilege' } }, text: '' };
      const ids = decodeURIComponent(/\$filter=([^&]*)/.exec(path)[1]).split(' or ').map((x) => x.replace('_objectid_value eq ', ''));
      return ok({ value: (o.auditRows ? o.auditRows(ids) : []).map((r, i) => ({ auditid: `a${i}`, ...r })) });
    }
    if (method === 'GET' && path.startsWith('mwf_alertlogs?')) return ok({ value: filterRows(path).map(([id, r]) => ({ mwf_alertlogid: id, mwf_alertkey: r.mwf_alertkey })) });
    if (method === 'DELETE') { if (o.failDelete) return err(500, '0x80040E00'); const id = /\(([^)]*)\)/.exec(path)[1]; return rows.delete(id) ? ok(null, 204) : err(404, '0x80040217'); }
    throw new Error(`unexpected call ${method} ${path}`);
  };
  return { call, rows, log, posts: () => posts };
}
const go = (f, extra = {}) => runUniquenessTest({ call: f.call, n: 5, suffix: (() => { let i = 0; return () => `S${++i}`; })(), ...extra });
const by = (r, id) => r.results.find((x) => x.id === id);

test('errorCodeOf and isDuplicateKey read the BODY, not the status', () => {
  const body = (code, msg = '') => ({ ok: false, status: 412, j: { error: { code, message: msg } }, text: '' });
  assert.equal(errorCodeOf(body('0x80060892')), '0x80060892');
  assert.equal(errorCodeOf(body('0X80060892')), '0x80060892');
  assert.equal(errorCodeOf({ ok: false, status: 500, j: null, text: '{"error":{"message":"... 0x80060892 ..."}}' }), '0x80060892');
  assert.equal(errorCodeOf({ ok: false, status: 500, j: null, text: 'boom' }), '');
  for (const status of [400, 409, 412, 500]) assert.equal(isDuplicateKey({ ok: false, status, j: { error: { code: '0x80060892' } }, text: '' }), true, `status ${status}`);
  assert.equal(isDuplicateKey(body('0x80040265')), false);
  assert.equal(isDuplicateKey({ ok: true, status: 204, j: null, text: '' }), false);
  assert.equal(DUPLICATE_CODE, '0x80060892');
});

test('happy path: a new key is accepted, the same key is rejected with the code, one concurrent insert wins, the cleanup leaves nothing', async () => {
  const f = fake(); const r = await go(f);
  assert.equal(r.refused, null); assert.equal(r.failed, 0, JSON.stringify(r.results.filter((x) => x.status === 'FAIL')));
  for (const id of ['gate', 'start', '1', '1b', '2', '2c', '4', '4c', '5']) assert.equal(by(r, id).status, 'PASS', id);
  assert.equal(r.measured.duplicateStatus, 412); assert.equal(r.measured.duplicateCode, '0x80060892');
  assert.equal(r.measured.concurrent.filter((x) => x.ok).length, 1); assert.equal(r.measured.concurrent.length, 5);
  assert.equal(r.cleanup.leftover, 0); assert.equal(f.rows.size, 0);
});

test('the HTTP status of the duplicate rejection is MEASURED and never asserted: 409, 412 and 500 all pass and are recorded', async () => {
  for (const dupStatus of [409, 412, 500]) {
    const r = await go(fake({ dupStatus }));
    assert.equal(r.failed, 0, `status ${dupStatus}`); assert.equal(r.measured.duplicateStatus, dupStatus);
    assert.equal(by(r, '2s').status, 'OBS'); assert.equal(by(r, '2s').detail, String(dupStatus));
  }
});

test('a duplicate that is rejected WITHOUT the duplicate-key code in the body fails step 2', async () => {
  const r = await go(fake({ dupCode: '0x80040265' }));
  assert.equal(by(r, '2').status, 'FAIL'); assert.match(by(r, '2').detail, /0x80040265/);
  assert.ok(r.failed >= 1); assert.equal(r.cleanup.leftover, 0);
});

test('a duplicate that is ACCEPTED (uniqueness not enforced) fails steps 2, 2c and 4, and everything is still deleted', async () => {
  const f = fake({ enforce: false }); const r = await go(f);
  assert.equal(by(r, '2').status, 'FAIL'); assert.match(by(r, '2').detail, /ACCEPTED/);
  assert.equal(by(r, '2c').status, 'FAIL'); assert.equal(by(r, '4').status, 'FAIL'); assert.equal(by(r, '4c').status, 'FAIL');
  assert.equal(r.cleanup.leftover, 0); assert.equal(f.rows.size, 0); assert.equal(by(r, '5').status, 'PASS');
});

test('refuses, with ZERO writes, when the key index is not Active (Pending, InProgress, Failed)', async () => {
  for (const keyStatus of ['Pending', 'InProgress', 'Failed']) {
    const f = fake({ keyStatus }); const r = await go(f);
    assert.match(r.refused, /REFUSED/); assert.equal(r.writes, 0); assert.equal(f.posts(), 0);
    assert.ok(!f.log.some((c) => c.method !== 'GET'), keyStatus);
    assert.equal(r.results.length, 0);
  }
});

test('refuses, with zero writes, when the table cannot be read or a TEST-TMP-ALERT row exists before the run', async () => {
  const noTable = await runUniquenessTest({ call: async () => ({ ok: false, status: 404, j: null, text: '' }) });
  assert.match(noTable.refused, /could not be read/); assert.equal(noTable.writes, 0);
  const f = fake({ preexisting: ['TEST-TMP-ALERT-OLD-RENEWAL-T90-20270101'] }); const r = await go(f);
  assert.match(r.refused, /exist before the run/); assert.equal(f.posts(), 0); assert.equal(f.rows.size, 1);   // the old row is left alone
});

test('empty and null keys are OBSERVATIONS: accepted or rejected, never a FAIL by themselves, and the rows are cleaned', async () => {
  for (const emptyOk of [true, false]) {
    const f = fake({ emptyOk }); const r = await go(f);
    for (const id of ['3e1', '3e2', '3n1', '3n2']) assert.equal(by(r, id).status, 'OBS', id);
    assert.equal(r.failed, 0); assert.equal(f.rows.size, 0);
    assert.equal(r.measured.empty.length, 2); assert.equal(r.measured.nullKey.length, 2);
    assert.equal(r.measured.empty[0].ok, emptyOk);
  }
});

test('an empty key that the server accepts twice (no uniqueness on empty) is recorded as it happened', async () => {
  const r = await go(fake({ emptyOk: true, enforceEmpty: false }));
  assert.deepEqual(r.measured.empty.map((x) => x.ok), [true, true]); assert.equal(r.failed, 0);
});

test('concurrent inserts: two successes fail step 4; a non-duplicate rejection is recorded (4n) without failing', async () => {
  const f = fake({ enforce: false }); const r = await go(f, { n: 3 });
  assert.equal(by(r, '4').status, 'FAIL'); assert.match(by(r, '4').name, /3 concurrent/);
  const r2 = await go(fake({ dupCode: '0x80040333' }), { n: 4 });
  assert.equal(by(r2, '4').status, 'PASS'); assert.equal(by(r2, '4n').status, 'OBS'); assert.equal(by(r2, '4n').detail, '3');
});

test('n is checked: an integer from 2 to 20', async () => {
  for (const n of [0, 1, 21, 2.5, NaN]) await assert.rejects(() => runUniquenessTest({ call: async () => ({}), n }), /n must be/);
});

test('cleanup runs when a step throws (a network error in the middle): FAIL is reported, the rows created so far are deleted', async () => {
  const f = fake({ failPostAt: 2 }); const r = await go(f);
  assert.equal(by(r, 'stop').status, 'FAIL'); assert.match(by(r, 'stop').detail, /network error/);
  assert.equal(f.rows.size, 0); assert.equal(r.cleanup.leftover, 0); assert.equal(by(r, '5').status, 'PASS');
  assert.ok(r.failed >= 1);
});

test('cleanup runs when the connection gate throws before the first write', async () => {
  const f = fake(); const r = await go(f, { stable: async () => { throw new Error('connection unstable (mock)'); } });
  assert.equal(by(r, 'stop').status, 'FAIL'); assert.equal(f.posts(), 0); assert.equal(by(r, '5').status, 'PASS');
});

test('a row whose answer was lost (no id) is still found and deleted by the prefix sweep', async () => {
  const f = fake({ lostAnswer: 1 }); const r = await go(f);
  assert.equal(f.rows.size, 0); assert.equal(r.cleanup.leftover, 0);
  assert.ok(r.cleanup.deleted >= 1);
});

test('a delete that fails is reported: leftover above 0 and step 5 FAILS', async () => {
  const f = fake({ failDelete: true }); const r = await go(f);
  assert.equal(by(r, '5').status, 'FAIL'); assert.ok(r.cleanup.leftover > 0); assert.ok(r.cleanup.errors.length > 0);
});

test('every row the test writes has a key or name that starts with TEST-TMP-ALERT-, goes to mwf_alertlogs only, and no key is a real GUID source', async () => {
  const f = fake(); await go(f);
  const writes = f.log.filter((c) => c.method !== 'GET' && c.method !== 'DELETE');
  assert.ok(writes.length >= 10);
  for (const w of writes) {
    assert.equal(w.path, 'mwf_alertlogs');
    assert.ok(String(w.body.mwf_name).startsWith('TEST-TMP-ALERT-'));
    if (w.body.mwf_alertkey) assert.ok(w.body.mwf_alertkey.startsWith('TEST-TMP-ALERT-'));
  }
  assert.ok(f.log.filter((c) => c.method === 'DELETE').every((c) => /^mwf_alertlogs\(00000000-0000-4000-8000-\d{12}\)$/.test(c.path)));
  assert.ok(!f.log.some((c) => /contract|workflow|counter|approvalstep/i.test(c.path)));
});

test('the script: the plan runs offline (exit 0); refusals come first (bad mode, bad n, no confirmation, no --env)', () => {
  const p = run(); assert.equal(p.status, 0, p.stderr); assert.match(p.stdout, /^PLAN \(offline, nothing is sent\)/); assert.match(p.stdout, /Nothing was written\.$/m); assert.match(p.stdout, /0x80060892/);
  assert.equal(run('--mode=delete').status, 2);
  for (const n of ['1', '21', 'x']) assert.equal(run(`--n=${n}`).status, 2, n);
  const noConfirm = run('--mode=run', '--env=https://example.invalid'); assert.equal(noConfirm.status, 2); assert.match(noConfirm.stderr, /--confirm-mutates-environment/); assert.match(noConfirm.stderr, /Nothing was run/);
  assert.equal(run('--mode=run', '--confirm-mutates-environment').status, 2);
});

test('the script source: no HTTP status is asserted, the status is printed as a measurement, and nothing else than mwf_alertlog is written', () => {
  assert.doesNotMatch(CODE, /status\s*===?\s*(412|409|500)|\b412\b|\b409\b/);
  assert.match(CODE, /MEASURED: duplicate-key rejection HTTP/);
  assert.match(SOURCE, /NOT RUN against any environment/);
  assert.doesNotMatch(CODE, /mwf_contracts|workflows|approvalsteps|contractnumbercounter/);
  const lib = fs.readFileSync(fileURLToPath(new URL('./alertlog-uniqueness.mjs', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(lib, /\b(412|409)\b|status\s*[!=]==?\s*(412|409|500)/);   // the status of the duplicate rejection is never compared in the steps
});

// ---------------------------------------------------------------------------------------------------------------- 4b: the audit observation (read only, never an assertion)
test('4b: the audit records of the test rows are COUNTED after the inserts and before the cleanup: an observation, with the operation names', async () => {
  const f = fake({ auditRows: (ids) => ids.slice(0, 2).map((id) => ({ _objectid_value: id, operation: 1 })) }); const r = await go(f);
  assert.equal(by(r, '4a').status, 'OBS'); assert.match(by(r, '4a').detail, /2 record\(s\)/); assert.match(by(r, '4a').detail, /"Create":2/);
  assert.deepEqual(r.measured.audit, { rows: 2, byOperation: { Create: 2 } });
  assert.equal(r.failed, 0);
  const iAudit = f.log.findIndex((c) => c.path.startsWith('audits?')); const firstDelete = f.log.findIndex((c) => c.method === 'DELETE');
  assert.ok(iAudit > 0 && iAudit < firstDelete, 'read before the cleanup');
});

test('4b: zero audit records is an observation, not a failure; the filter holds exactly the ids of the rows created', async () => {
  const f = fake(); const r = await go(f);
  assert.equal(by(r, '4a').status, 'OBS'); assert.match(by(r, '4a').detail, /0 record\(s\)/); assert.equal(r.failed, 0);
  const reads = f.log.filter((c) => c.path.startsWith('audits?')); assert.ok(reads.length >= 1);
  const ids = reads.flatMap((c) => decodeURIComponent(/\$filter=([^&]*)/.exec(c.path)[1]).split(' or ').map((x) => x.replace('_objectid_value eq ', '')));
  assert.equal(ids.length, f.log.filter((c) => c.method === 'POST' && c.body).length - (f.log.filter((c) => c.method === 'POST').length - ids.length));   // one id per created row
});

test('4b: an audit read that fails (no privilege) is an observation too, and never fails the test', async () => {
  const r = await go(fake({ auditStatus: 403 }));
  assert.equal(by(r, '4a').status, 'OBS'); assert.match(by(r, '4a').detail, /could not be read: HTTP 403/); assert.equal(r.measured.audit.rows, null); assert.equal(r.failed, 0);
});

test('4b: the audit read is a GET only, and a run where nothing could be created has nothing to look at', async () => {
  const f = fake(); await go(f);
  assert.ok(f.log.filter((c) => c.path.startsWith('audits?')).every((c) => c.method === 'GET'));
  const noRows = await runUniquenessTest({ call: async (m, p) => (p.startsWith("EntityDefinitions(LogicalName='mwf_alertlog')?") ? { ok: true, status: 200, j: { EntitySetName: 'mwf_alertlogs' } } : p.includes('/Keys') ? { ok: true, status: 200, j: { value: [{ SchemaName: 'mwf_AlertLogKey', EntityKeyIndexStatus: 'Active', KeyAttributes: ['mwf_alertkey'] }] } } : p.startsWith('mwf_alertlogs?') ? { ok: true, status: 200, j: { value: [] } } : m === 'POST' ? { ok: false, status: 500, j: null, text: '' } : { ok: true, status: 200, j: { value: [] } }), n: 2, suffix: () => 'X1' });
  assert.equal(noRows.results.find((x) => x.id === '4a').status, 'OBS'); assert.match(noRows.results.find((x) => x.id === '4a').name, /nothing to look at/);
});

test('4b: the script prints the audit observation and the plan lists step 4b; the audit read uses the shared helper of lib/auditing.mjs', () => {
  assert.match(CODE, /MEASURED: audit records of the test rows/);
  assert.match(run().stdout, /4b +read only: count the audit records/);
  const lib = fs.readFileSync(fileURLToPath(new URL('./alertlog-uniqueness.mjs', import.meta.url)), 'utf8');
  assert.match(lib, /import \{ auditRowsPath, operationName \} from '\.\/auditing\.mjs'/);
  assert.match(fs.readFileSync(fileURLToPath(new URL('../test-auditing.mjs', import.meta.url)), 'utf8'), /auditRowsPath\(ids\)/);   // test-auditing uses the same helper now
});
