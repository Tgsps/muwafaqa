/**
 * The steps of scripts/test-alertlog-uniqueness.mjs (ADR-011, status Proposed), with the HTTP layer injected so that they are unit tested
 * against a mock (alertlog-uniqueness.test.mjs). NOTHING here has run against an environment.
 *
 * What it checks and what it only records:
 *   (1) a new key is accepted (PASS if accepted and readable by the alternate key)
 *   (2) the same key again is rejected, and the BODY of the answer holds the error code 0x80060892 (DuplicateRecordEntityKey). The HTTP status is
 *       RECORDED as a measurement and never asserted: Learn does not document it for this error and its pages disagree for another duplicate mechanism.
 *   (3) an empty and a null key: OBSERVATIONS only (what the server does is the result; it can differ from "required")
 *   (4) N concurrent inserts of one fresh key: exactly one success (PASS), the others are recorded with status and code
 *   (5) cleanup of every row it created, in a finally block, also after a failure; a sweep by the TEST-TMP-ALERT prefix catches rows whose
 *       id was never seen (a lost answer). The leftover count is reported.
 * Every row it writes has a key or a name that starts with TEST-TMP-ALERT-. It writes to mwf_alertlog only.
 */
import { buildAlertKey, TEST_SOURCE_PREFIX } from './alert-key.mjs';
import { keyGate } from './obligation-schema.mjs';

export const DUPLICATE_CODE = '0x80060892';
export const TABLE = 'mwf_alertlog';
const q = encodeURIComponent;

/** The error code of a failed answer: the code field of the body, else the first 0x........ in the body text. Lower case, or ''. */
export function errorCodeOf(r) {
  const c = r?.j?.error?.code;
  if (typeof c === 'string' && /^0x[0-9a-f]{8}$/i.test(c)) return c.toLowerCase();
  const m = /0x[0-9a-f]{8}/i.exec(`${r?.j?.error?.message ?? ''} ${r?.text ?? ''}`);
  return m ? m[0].toLowerCase() : '';
}
/** True when the BODY of the answer carries the duplicate-key code. The status is not looked at. */
export const isDuplicateKey = (r) => !r?.ok && (errorCodeOf(r) === DUPLICATE_CODE || String(r?.j?.error?.code ?? '').toLowerCase() === DUPLICATE_CODE);

const rnd = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

/**
 * @param {object} p
 * @param {Function} p.call   (method, path, body?, headers?) -> Promise<{ok,status,j,text,id}>   (never throws for an HTTP error)
 * @param {Function} [p.stable] async () => void; the connection gate, called before the first write; may throw
 * @param {number} [p.n=5]    concurrent inserts in step 4 (2 to 20)
 * @param {Function} [p.log]  (line) => void
 * @param {Function} [p.suffix] () => string, the random part of the test source (letters and digits)
 * @returns {Promise<{refused:string|null, results:{id:string,status:'PASS'|'FAIL'|'OBS',name:string,detail:string}[], measured:object, cleanup:{deleted:number, leftover:number, errors:string[]}, failed:number, writes:number}>}
 */
export async function runUniquenessTest({ call, stable = async () => {}, n = 5, log = () => {}, suffix = rnd }) {
  if (!Number.isInteger(n) || n < 2 || n > 20) throw new Error('n must be an integer from 2 to 20');
  const results = []; const measured = { duplicateStatus: null, duplicateCode: null, empty: [], nullKey: [], concurrent: [] };
  const cleanup = { deleted: 0, leftover: 0, errors: [] };
  let failed = 0; let writes = 0;
  const out = (id, status, name, detail = '') => { if (status === 'FAIL') failed++; results.push({ id, status, name, detail }); log(`${status.padEnd(4)}  ${String(id).padEnd(5)} ${name}${detail ? `  [${detail}]` : ''}`); };
  const done = (refused) => ({ refused, results, measured, cleanup, failed, writes });
  const created = new Set();   // ids of rows created by this run

  // ---- gate: the entity set, the key must be Active, no leftover of an earlier run. Reads only.
  const meta = await call('GET', `EntityDefinitions(LogicalName='${TABLE}')?$select=EntitySetName`);
  if (!meta.ok) return done(`the table ${TABLE} could not be read (HTTP ${meta.status}); it may not exist yet`);
  const set = meta.j.EntitySetName;
  const keys = await call('GET', `EntityDefinitions(LogicalName='${TABLE}')/Keys?$select=SchemaName,KeyAttributes,EntityKeyIndexStatus`);
  if (!keys.ok) return done(`the keys of ${TABLE} could not be read (HTTP ${keys.status})`);
  const gate = keyGate(keys.j.value);
  if (!gate.ok) return done(`REFUSED: ${gate.why} (EntityKeyIndexStatus ${gate.status}). Nothing was written.`);
  out('gate', 'PASS', 'the alternate key index is Active', gate.status);
  const sweepFilter = `${q(`startswith(mwf_alertkey,'${TEST_SOURCE_PREFIX}') or startswith(mwf_name,'${TEST_SOURCE_PREFIX}')`)}`;
  const sweep = async () => {
    const r = await call('GET', `${set}?$select=mwf_alertlogid&$filter=${sweepFilter}&$top=500`);
    if (!r.ok) throw new Error(`the sweep read failed (HTTP ${r.status})`);
    return r.j.value.map((x) => x.mwf_alertlogid);
  };
  const before = await sweep();
  if (before.length) return done(`REFUSED: ${before.length} row(s) with the prefix ${TEST_SOURCE_PREFIX} exist before the run (an earlier run did not clean up). Nothing was written.`);
  out('start', 'PASS', `no ${TEST_SOURCE_PREFIX} row exists before the run`, '0');

  const post = async (body) => {
    writes++;
    const r = await call('POST', set, body);
    if (r.ok && r.id) created.add(r.id);
    return r;
  };
  const keyOf = (type, date) => buildAlertKey({ sourceId: `${TEST_SOURCE_PREFIX}${suffix()}`, type, date }, { allowTestSource: true });
  const one = (k) => ({ mwf_name: k, mwf_alertkey: k });
  const countKey = async (k) => { const r = await call('GET', `${set}?$select=mwf_alertlogid&$filter=${q(`mwf_alertkey eq '${k}'`)}`); return r.ok ? r.j.value.length : -1; };

  try {
    await stable();

    // (1) a new key
    const k1 = keyOf('RENEWAL-T90', '2027-03-31');
    const r1 = await post(one(k1));
    out('1', r1.ok ? 'PASS' : 'FAIL', 'a new key is accepted', `HTTP ${r1.status}${r1.ok ? '' : ` code ${errorCodeOf(r1) || 'none'}`}`);
    const back = await call('GET', `${set}(mwf_alertkey='${k1}')?$select=mwf_alertkey`);
    out('1b', back.ok && back.j?.mwf_alertkey === k1 ? 'PASS' : 'FAIL', 'the row is readable by its alternate key', `HTTP ${back.status}`);

    // (2) the same key again
    const r2 = await post(one(k1));
    measured.duplicateStatus = r2.status; measured.duplicateCode = errorCodeOf(r2);
    out('2', isDuplicateKey(r2) ? 'PASS' : 'FAIL', `the same key is rejected and the body holds ${DUPLICATE_CODE}`, r2.ok ? 'ACCEPTED: uniqueness is not enforced' : `code ${errorCodeOf(r2) || 'none'}`);
    out('2s', 'OBS', 'MEASURED HTTP status of the duplicate-key rejection (recorded, not asserted)', String(r2.status));
    const c1 = await countKey(k1);
    out('2c', c1 === 1 ? 'PASS' : 'FAIL', 'exactly one row holds the key afterwards', String(c1));

    // (3) an empty and a null key: observations
    for (const [label, value, bucket] of [['empty', '', measured.empty], ['null', null, measured.nullKey]]) {
      for (let i = 1; i <= 2; i++) {
        const body = { mwf_name: `${TEST_SOURCE_PREFIX}${label.toUpperCase()}-${suffix()}`, mwf_alertkey: value };
        const r = await post(body);
        bucket.push({ ok: r.ok, status: r.status, code: r.ok ? '' : errorCodeOf(r) });
        out(`3${label[0]}${i}`, 'OBS', `${label} key, insert ${i} (what the server does; not a pass or fail)`, r.ok ? `ACCEPTED HTTP ${r.status}` : `REJECTED HTTP ${r.status} code ${errorCodeOf(r) || 'none'}`);
      }
    }

    // (4) N concurrent inserts of one fresh key
    const k4 = keyOf('OBLIGATION-DUESOON', '2027-06-30');
    const rs = await Promise.all(Array.from({ length: n }, () => post(one(k4))));
    for (const r of rs) measured.concurrent.push({ ok: r.ok, status: r.status, code: r.ok ? '' : errorCodeOf(r) });
    const okCount = rs.filter((r) => r.ok).length;
    out('4', okCount === 1 ? 'PASS' : 'FAIL', `${n} concurrent inserts of one fresh key: exactly one success`, `${okCount} success(es)`);
    const others = rs.filter((r) => !r.ok);
    out('4o', 'OBS', 'the rejected concurrent inserts (status and code, recorded)', others.map((r) => `${r.status}/${errorCodeOf(r) || 'none'}`).join(' ') || 'none');
    const nonDup = others.filter((r) => !isDuplicateKey(r)).length;
    if (nonDup) out('4n', 'OBS', 'concurrent rejections whose body does NOT hold the duplicate-key code', String(nonDup));
    const c4 = await countKey(k4);
    out('4c', c4 === 1 ? 'PASS' : 'FAIL', 'exactly one row holds the concurrent key afterwards', String(c4));
  } catch (e) {
    out('stop', 'FAIL', 'the test stopped before its last step', String(e.message).slice(0, 160));
  } finally {
    // (5) cleanup: every id this run created, then a sweep by prefix; the leftover is counted
    try {
      const ids = new Set(created);
      try { for (const id of await sweep()) ids.add(id); } catch (e) { cleanup.errors.push(`sweep read: ${String(e.message).slice(0, 100)}`); }
      for (const id of ids) {
        try {
          const d = await call('DELETE', `${set}(${id})`);
          if (d.ok || d.status === 404) cleanup.deleted++; else cleanup.errors.push(`delete answered HTTP ${d.status}`);
        } catch (e) { cleanup.errors.push(`delete: ${String(e.message).slice(0, 100)}`); }
      }
      try { cleanup.leftover = (await sweep()).length; } catch (e) { cleanup.errors.push(`final sweep: ${String(e.message).slice(0, 100)}`); cleanup.leftover = -1; }
    } catch (e) { cleanup.errors.push(String(e.message).slice(0, 100)); cleanup.leftover = -1; }
    out('5', cleanup.leftover === 0 && cleanup.errors.length === 0 ? 'PASS' : 'FAIL', `cleanup: ${cleanup.deleted} row(s) deleted, no ${TEST_SOURCE_PREFIX} row left`, `leftover ${cleanup.leftover}${cleanup.errors.length ? `; ${cleanup.errors.join('; ')}` : ''}`);
  }
  return done(null);
}
