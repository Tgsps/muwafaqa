#!/usr/bin/env node
/**
 * Server tests of the contract number generator (ADR-006): plug-in 3 + the guard rules for Contract Number and Contract Type.
 * FICTIONAL rows only, named TEST-TMP-NUM*. Rows are found and deleted by their Subject (mwf_name), never by number.
 *
 * What it does (all rows are Draft; the flow does not run on Draft creates, its state is read and printed anyway):
 *   T1  3 sequential creates of one type: consecutive numbers PREFIX-NNNN
 *   T2  one create of each of the other types: independent counters, the first type counter did not move
 *   T3  20 parallel creates of the SAME type, three times in a row: unique and consecutive, no HTTP error
 *   T3m 20 parallel creates, 10 of two types mixed: unique and consecutive per type, no HTTP error
 *   T4  client-supplied number on Create: rejected (HTTP 400), no row, counters unchanged. "" is accepted and a number generated
 *   T5  Contract Number change on Update: rejected
 *   T6  Contract Type change after Create (Draft): rejected, type unchanged
 *   T7  missing Contract Type on Create: rejected
 *   T8  duplicate number + rollback: the counter is set one step back (direct counter write by the script's admin account) so that the
 *       generator would issue an existing number. Expected: the create fails on the alternate key AFTER the plug-in ran, and the
 *       counter returns to its previous value (the transaction rolled back). Then the counter is set back to where it was.
 *
 * Counters are snapshotted first and restored at the end ONLY if counter == snapshot + the numbers this run consumed
 * (scripts/lib/counter-snapshot.mjs). Otherwise it refuses and reports counts only. A crash only leaves gaps.
 *
 * Usage:
 *   node scripts/test-contract-number.mjs --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment [--auth=device|az] [--rounds=3] [--only=T4,T5]
 *   node scripts/test-contract-number.mjs --env=... --mode=check-clean
 *   node scripts/test-contract-number.mjs --env=... --mode=cleanup --confirm-mutates-environment [--before=MNT:0,PRC:0,...] [--consumed=MNT:75,PRC:11,...]
 *       (after a crashed run: deletes the TEST-TMP-NUM rows by Subject, then restores the counters by the same rule as a normal run)
 *
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
import { execSync } from 'node:child_process';
import { approvalFlowState, deleteContracts } from './lib/contract-cleanup.mjs';
import { snapshotCounters, readCounters, restoreCounters, requireStableConnection } from './lib/counter-snapshot.mjs';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const ENV = argOf('env').replace(/\/+$/, '');
const AUTH = argOf('auth') || 'device';
const MODE = argOf('mode') || 'run';
const BEFORE = argOf('before');      // cleanup mode: counters before the crashed run, e.g. MNT:0,PRC:0
const CONSUMED = argOf('consumed');  // cleanup mode: numbers that run consumed, e.g. MNT:75,PRC:11
const ROUNDS = Number(argOf('rounds') || 3);
const ONLY = argOf('only');          // e.g. --only=T4,T5 runs just those tests (T5 includes T6)
const want = (id) => !ONLY || ONLY.split(',').map((x) => x.trim()).includes(id);
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id, same as the other scripts
const PREFIX = 'TEST-TMP-NUM';
const TYPES = { Maintenance: 867640000, Procurement: 867640001, Insurance: 867640002, Sales: 867640003, Services: 867640004 };
const PFX = { 867640000: 'MNT', 867640001: 'PRC', 867640002: 'INS', 867640003: 'SAL', 867640004: 'SRV' };

if (!['run', 'check-clean', 'cleanup'].includes(MODE)) { console.error('Invalid --mode=run|check-clean|cleanup. Nothing was run.'); process.exit(2); }
if (!/^https:\/\/[^/]+$/.test(ENV)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
if (!['device', 'az'].includes(AUTH)) { console.error('Invalid --auth=device|az. Nothing was run.'); process.exit(2); }
if (MODE !== 'check-clean' && !process.argv.includes('--confirm-mutates-environment')) {
  console.error(`WARNING: this test creates, updates and deletes ${PREFIX}* rows and temporarily writes the contract number counters. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
  process.exit(2);
}

const API = `${ENV}/api/data/v9.2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noGuid = (t) => String(t ?? '').replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>');
const q = encodeURIComponent;
let TOKEN;

async function form(url, f) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = null; }
  return { ok: r.ok, status: r.status, j, t };
}
async function deviceToken() {
  const base = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
  const dc = await form(`${base}/devicecode`, { client_id: CLIENT_ID, scope: `${ENV}/.default` });
  if (!dc.ok) throw new Error(`Device code request failed (HTTP ${dc.status}):\n${noGuid(dc.t)}`);
  console.log(`\nSIGN-IN URL : ${dc.j.verification_uri}\nDEVICE CODE : ${dc.j.user_code}\n(single use, ${Math.round(dc.j.expires_in / 60)} min). Waiting for sign-in...\n`);
  let iv = (dc.j.interval ?? 5) * 1000; const end = Date.now() + dc.j.expires_in * 1000;
  while (Date.now() < end) {
    await sleep(iv);
    const t = await form(`${base}/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, device_code: dc.j.device_code });
    if (t.ok) return t.j.access_token;
    const e = t.j?.error;
    if (e === 'authorization_pending') continue;
    if (e === 'slow_down') { iv += 5000; continue; }
    throw new Error(`Token request failed (HTTP ${t.status}):\n${noGuid(t.t).slice(0, 600)}`);
  }
  throw new Error('Device code expired. Rerun for a new code.');
}
const hdr = (extra = {}) => ({ Authorization: `Bearer ${TOKEN}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Content-Type': 'application/json; charset=utf-8', ...extra });
async function call(method, path, body, extra = {}) {
  const r = await fetch(`${API}/${path}`, { method, headers: hdr(extra), body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { /* not json */ }
  const m = /\(([0-9a-fA-F-]{36})\)/.exec(r.headers.get('OData-EntityId') || '');
  return { ok: r.ok, status: r.status, j, text: t, id: m ? m[1] : null };
}
class Stop extends Error {}
const must = async (method, path, body, extra) => {
  const r = await call(method, path, body, extra);
  if (!r.ok) throw new Stop(`${method} ${noGuid(path).slice(0, 90)} failed HTTP ${r.status}\n${noGuid(r.j?.error?.message || r.text).slice(0, 600)}`);
  return r;
};
const msgOf = (r) => noGuid(r.j?.error?.message || (r.ok ? '' : r.text) || '').slice(0, 300);
const io = {
  get: async (p) => { const r = await call('GET', p); return { ok: r.ok, status: r.status, json: r.j, message: msgOf(r) }; },
  patch: async (p, b) => { const r = await call('PATCH', p, b, { 'If-Match': '*' }); return { ok: r.ok, status: r.status, message: msgOf(r) }; },
  del: async (p, h) => { const r = await call('DELETE', p, undefined, h || {}); return { ok: r.ok, status: r.status, message: msgOf(r) }; },
};

// ---------------------------------------------------------------- reporting
const results = [];
const check = (id, name, ok, detail = '') => { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? `  [${detail}]` : ''}`); return ok; };
const seqOf = (n) => Number(String(n).split('-')[1]);

// ---------------------------------------------------------------- data helpers
let CP, USD;
const created = [];               // ids of every contract row this run created (committed)
const consumed = {};              // type value -> numbers consumed (committed rows)
const body = (name, type, extra = {}) => ({
  mwf_name: name, mwf_contracttype: type, mwf_direction: 867640001, mwf_value: 1000,
  'mwf_counterpartyid@odata.bind': `/mwf_counterparties(${CP})`,
  'transactioncurrencyid@odata.bind': `/transactioncurrencies(${USD})`,
  ...extra,
});
async function createContract(name, type, extra = {}) {
  const r = await call('POST', 'mwf_contracts?$select=mwf_contractnumber', body(name, type, extra), { Prefer: 'return=representation' });
  if (r.ok) {
    created.push(r.j.mwf_contractid);
    consumed[type] = (consumed[type] || 0) + 1;
  }
  return { ok: r.ok, status: r.status, number: r.j?.mwf_contractnumber, id: r.j?.mwf_contractid, message: msgOf(r) };
}
const rowCount = async () => (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value.length;
const lastOf = async (snap, type) => (await readCounters(io, snap))[type].last;

async function checkClean() {
  const a = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q("startswith(mwf_name,'TEST-TMP')")}`)).j.value.length;
  const b = (await must('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=${q("startswith(mwf_name,'TEST-TMP')")}`)).j.value.length;
  const total = (await must('GET', 'mwf_contracts?$select=mwf_contractid&$count=true&$top=1')).j['@odata.count'];
  console.log(`check-clean: TEST-TMP contracts ${a}, TEST-TMP counterparties ${b}, total contracts ${total} (expected 0, 0, 11)`);
  return { a, b, total };
}

async function printCounters() {
  const snap = await snapshotCounters(io);
  console.log('INFO  counters now: ' + Object.values(snap.byType).map((c) => `${c.prefix}=${c.last}`).join(' '));
  return snap;
}

async function cleanupOnly() {
  const rows = (await must('GET', `mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value;
  const del = await deleteContracts(io, rows.map((r) => r.mwf_contractid));
  console.log(`INFO  cleanup: ${rows.length} contract row(s) found, ${del.deleted} deleted, ${del.failed.length} failed`);
  const cps = (await must('GET', `mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value;
  for (const c of cps) {
    const used = (await must('GET', `mwf_contracts?$select=mwf_contractid&$filter=_mwf_counterpartyid_value eq ${c.mwf_counterpartyid}&$top=1`)).j.value.length;
    if (used) { console.log('INFO  counterparty still referenced, kept'); continue; }
    const d = await call('DELETE', `mwf_counterparties(${c.mwf_counterpartyid})`);
    console.log(`INFO  cleanup: counterparty delete HTTP ${d.status}`);
  }
  const snap = await printCounters();
  if (BEFORE && CONSUMED) {
    const parse = (t) => Object.fromEntries(t.split(',').map((kv) => kv.split(':')));
    const byPrefix = Object.fromEntries(Object.entries(snap.byType).map(([type, c]) => [c.prefix, type]));
    const before = parse(BEFORE); const used = parse(CONSUMED);
    const fake = { set: snap.set, byType: {} };
    const consumedByType = {};
    for (const [pfx, type] of Object.entries(byPrefix)) {
      fake.byType[type] = { id: snap.byType[type].id, prefix: pfx, last: Number(before[pfx] ?? snap.byType[type].last) };
      consumedByType[type] = Number(used[pfx] || 0);
    }
    const rs = await restoreCounters(io, fake, consumedByType);
    for (const l of rs.lines) console.log(`INFO  counter: ${l}`);
    console.log(`INFO  counters: restored ${rs.restored}, unchanged ${rs.unchanged}, refused ${rs.refused}`);
  } else {
    console.log('INFO  counters not touched (no --before/--consumed given)');
  }
  await printCounters();
  return checkClean();
}

// ---------------------------------------------------------------- the tests
async function run() {
  const flow = await approvalFlowState(io);
  console.log(`INFO  approval flow: ${flow.known ? (flow.on ? 'ON' : 'OFF') : 'state not readable'} (Draft creates do not start it)`);

  const pre = await checkClean();
  if (pre.a || pre.b) throw new Stop('TEST-TMP rows already exist. Clean them first. Nothing was created.');
  const cur = (await must('GET', "transactioncurrencies?$select=isocurrencycode&$filter=isocurrencycode eq 'USD' and statecode eq 0")).j.value;
  if (cur.length !== 1) throw new Stop(`active USD currency: expected 1, found ${cur.length}`);
  USD = cur[0].transactioncurrencyid;

  const snap = await snapshotCounters(io);
  console.log('INFO  counters before: ' + Object.values(snap.byType).map((c) => `${c.prefix}=${c.last}`).join(' '));
  const cp = await must('POST', 'mwf_counterparties', { mwf_name: `${PREFIX} Fictional Counterparty (delete me)`, mwf_counterpartytype: (await must('GET', "EntityDefinitions(LogicalName='mwf_counterparty')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)")).j.OptionSet.Options[0].Value });
  CP = cp.id;
  let stopped = null;
  try {
    const mnt = TYPES.Maintenance;
    // T1 sequential
    if (want('T1')) {
    const base1 = snap.byType[mnt].last;
    const seq = [];
    for (let i = 1; i <= 3; i++) seq.push(await createContract(`${PREFIX}-T1-${i}`, mnt));
    const want1 = [1, 2, 3].map((i) => `MNT-${String(base1 + i).padStart(4, '0')}`);
    check('T1', 'sequential creates of one type give consecutive numbers', seq.every((s) => s.ok) && JSON.stringify(seq.map((s) => s.number)) === JSON.stringify(want1),
      `${seq.map((s) => s.number).join(', ')}`);
    check('T1b', 'counter equals the last issued number', (await lastOf(snap, mnt)) === base1 + 3, `counter ${await lastOf(snap, mnt)}`);

    }
    // T2 independent counters
    if (want('T2')) {
    const others = [TYPES.Procurement, TYPES.Insurance, TYPES.Sales, TYPES.Services];
    const mntBefore = await lastOf(snap, mnt);
    const t2 = [];
    for (const t of others) t2.push(await createContract(`${PREFIX}-T2-${PFX[t]}`, t));
    const okT2 = t2.every((r, i) => r.ok && r.number === `${PFX[others[i]]}-${String(snap.byType[others[i]].last + 1).padStart(4, '0')}`);
    check('T2', 'each type has its own prefix and its own counter', okT2, t2.map((r) => r.number).join(', '));
    check('T2b', 'the Maintenance counter did not move', (await lastOf(snap, mnt)) === mntBefore, `counter ${await lastOf(snap, mnt)}`);

    }
    // T3 20 parallel, same type, ROUNDS times
    if (want('T3')) {
    for (let round = 1; round <= ROUNDS; round++) {
      const start = await lastOf(snap, mnt);
      const t0 = Date.now();
      const res = await Promise.all(Array.from({ length: 20 }, (_, i) => createContract(`${PREFIX}-T3-r${round}-${i + 1}`, mnt)));
      const ms = Date.now() - t0;
      const errs = res.filter((r) => !r.ok);
      const nums = res.filter((r) => r.ok).map((r) => seqOf(r.number)).sort((a, b) => a - b);
      const unique = new Set(nums).size === nums.length;
      const consecutive = nums.length > 0 && nums.every((n, i) => n === start + 1 + i);
      const ok = check(`T3.${round}`, '20 parallel creates of the same type: unique, consecutive, no error',
        errs.length === 0 && unique && consecutive && nums.length === 20,
        `ok ${nums.length}/20, errors ${errs.length}${errs.length ? ` (HTTP ${[...new Set(errs.map((e) => e.status))].join('/')}: ${errs[0].message.slice(0, 120)})` : ''}, unique ${unique}, consecutive ${consecutive}, range ${nums[0]}..${nums[nums.length - 1]}, ${ms} ms`);
      if (!ok) { stopped = `T3.${round}`; break; }
    }
    if (stopped) throw new Stop(`${stopped} failed. Stopped: no retry, no further parallel run.`);

    }
    // T3m mixed two types
    if (want('T3m')) {
      const a = TYPES.Maintenance; const b = TYPES.Procurement;
      const sa = await lastOf(snap, a); const sb = await lastOf(snap, b);
      const jobs = [];
      for (let i = 1; i <= 10; i++) { jobs.push(createContract(`${PREFIX}-T3m-A-${i}`, a)); jobs.push(createContract(`${PREFIX}-T3m-B-${i}`, b)); }
      const res = await Promise.all(jobs);
      const errs = res.filter((r) => !r.ok);
      const per = (p, s) => res.filter((r) => r.ok && r.number.startsWith(p + '-')).map((r) => seqOf(r.number)).sort((x, y) => x - y);
      const na = per('MNT'), nb = per('PRC');
      const good = (n, s) => n.length === 10 && new Set(n).size === 10 && n.every((v, i) => v === s + 1 + i);
      const ok = check('T3m', '20 parallel creates, 10 of two types mixed: unique and consecutive per type, no error',
        errs.length === 0 && good(na, sa) && good(nb, sb),
        `errors ${errs.length}${errs.length ? ` (HTTP ${errs[0].status}: ${errs[0].message.slice(0, 120)})` : ''}, MNT ${na[0]}..${na[na.length - 1]} (${na.length}), PRC ${nb[0]}..${nb[nb.length - 1]} (${nb.length})`);
      if (!ok) throw new Stop('T3m failed. Stopped.');
    }

    // T4 client-supplied number on Create
    if (want('T4')) {
      const before = await rowCount(); const c0 = await lastOf(snap, mnt);
      const r = await createContract(`${PREFIX}-T4-supplied`, mnt, { mwf_contractnumber: 'TEST-TMP-SUPPLIED-1' });
      check('T4', 'a client-supplied number on Create is rejected (HTTP 400) with the Create text, no row, counter unchanged',
        !r.ok && r.status === 400 && r.message.includes('Contract Number is generated by the system; leave it empty.') && !r.message.includes('cannot be changed')
        && (await rowCount()) === before && (await lastOf(snap, mnt)) === c0, `HTTP ${r.status}: ${r.message.slice(0, 140)}`);
      const e = await createContract(`${PREFIX}-T4-empty`, mnt, { mwf_contractnumber: '' });
      check('T4b', 'an empty-string number on Create is accepted and a number is generated', e.ok && /^MNT-\d{4,}$/.test(e.number || ''), `HTTP ${e.status} ${e.number || e.message.slice(0, 100)}`);
    }

    // T5 / T6 on a Draft row
    if (want('T5')) {
      const row = await createContract(`${PREFIX}-T5T6`, mnt);
      const n0 = row.number;
      const p5 = await io.patch(`mwf_contracts(${row.id})`, { mwf_contractnumber: 'MNT-9999' });
      const after5 = (await must('GET', `mwf_contracts(${row.id})?$select=mwf_contractnumber,mwf_contracttype`)).j;
      check('T5', 'changing the Contract Number on a Draft is rejected with the Update text (cannot be changed), number unchanged',
        !p5.ok && p5.status === 400 && p5.message.includes('Contract Number cannot be changed. It is generated by the system when the contract is created.') && after5.mwf_contractnumber === n0, `HTTP ${p5.status}: ${p5.message.slice(0, 120)}`);
      const p6 = await io.patch(`mwf_contracts(${row.id})`, { mwf_contracttype: TYPES.Services });
      const after6 = (await must('GET', `mwf_contracts(${row.id})?$select=mwf_contractnumber,mwf_contracttype`)).j;
      check('T6', 'changing the Contract Type of a Draft is rejected, type and number unchanged', !p6.ok && p6.status === 400 && after6.mwf_contracttype === mnt && after6.mwf_contractnumber === n0, `HTTP ${p6.status}: ${p6.message.slice(0, 120)}`);
      const p6b = await io.patch(`mwf_contracts(${row.id})`, { mwf_name: `${PREFIX}-T5T6 renamed` });
      check('T6b', 'another column of the Draft can still be edited', p6b.ok, `HTTP ${p6b.status}`);
    }

    // T7 missing type
    if (want('T7')) {
      const before = await rowCount(); const c0 = await lastOf(snap, mnt);
      const b = body(`${PREFIX}-T7-notype`, mnt); delete b.mwf_contracttype;
      const r = await call('POST', 'mwf_contracts', b);
      check('T7', 'a Create without Contract Type is rejected (HTTP 400), no row, counters unchanged',
        !r.ok && r.status === 400 && (await rowCount()) === before && (await lastOf(snap, mnt)) === c0, `HTTP ${r.status}: ${msgOf(r).slice(0, 140)}`);
    }

    // T8 duplicate number + rollback (direct counter manipulation by the script's admin account)
    if (want('T8')) {
      const t = TYPES.Sales;
      const a = await createContract(`${PREFIX}-T8-A`, t);
      const n = seqOf(a.number);
      const cId = snap.byType[t].id;
      const w = await io.patch(`${snap.set}(${cId})`, { mwf_lastnumber: n - 1 });      // the generator would issue n again
      if (!w.ok) throw new Stop(`T8 setup: could not move the counter back: HTTP ${w.status} ${w.message}`);
      const b = await createContract(`${PREFIX}-T8-B`, t);
      const after = await lastOf(snap, t);
      const dup = !b.ok && [412, 409, 400].includes(b.status) && /duplicate|already exists|key/i.test(b.message);
      check('T8', 'a duplicate number is rejected by the alternate key (the create fails AFTER the plug-in ran)', dup, `HTTP ${b.status}: ${b.message.slice(0, 160)}`);
      check('T8b', 'rollback: the failed create did not move the counter (still n-1)', after === n - 1, `counter ${after}, expected ${n - 1}`);
      const w2 = await io.patch(`${snap.set}(${cId})`, { mwf_lastnumber: n });          // put it back to where it was
      check('T8c', 'the counter was put back to the last issued number', w2.ok && (await lastOf(snap, t)) === n, `counter ${await lastOf(snap, t)}`);
    }
  } finally {
    // cleanup by Subject (mwf_name prefix), never by number
    const rows = (await must('GET', `mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value;
    const del = await deleteContracts(io, rows.map((r) => r.mwf_contractid));
    console.log(`INFO  cleanup: ${del.deleted} contract row(s) deleted, ${del.failed.length} failed`);
    if (CP) { const d = await call('DELETE', `mwf_counterparties(${CP})`); console.log(`INFO  cleanup: counterparty delete HTTP ${d.status}`); }
    const rs = await restoreCounters(io, snap, consumed);
    for (const l of rs.lines) console.log(`INFO  counter: ${l}`);
    console.log(`INFO  counters: restored ${rs.restored}, unchanged ${rs.unchanged}, refused ${rs.refused}`);
    const c = await checkClean();
    check('D', 'check-clean: 0 TEST-TMP contracts, 0 counterparties, 11 contracts', c.a === 0 && c.b === 0 && c.total === 11, `${c.a}/${c.b}/${c.total}`);
    const final = await readCounters(io, snap);
    console.log('INFO  counters after : ' + Object.values(final).map((x) => `${x.prefix}=${x.last}`).join(' ') + '  (before: ' + Object.values(snap.byType).map((x) => `${x.prefix}=${x.last}`).join(' ') + ')');
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\nSUMMARY: ${results.length - bad} passed, ${bad} failed.`);
  process.exit(bad ? 1 : 0);
}

(async () => {
  try {
    TOKEN = AUTH === 'az'
      ? execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim()
      : await deviceToken();
    await requireStableConnection(call);   // 3 GET requests in a row before any write
    if (MODE === 'check-clean') { await checkClean(); await printCounters(); }
    else if (MODE === 'cleanup') await cleanupOnly();
    else await run();
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
