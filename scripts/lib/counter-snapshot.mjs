/**
 * Shared helper for the tests that create contracts (ADR-006). Every contract create consumes a number from the counter of
 * its type; deleting the test rows leaves gaps. This helper takes a snapshot of the counters before a test and puts them
 * back after the cleanup, ONLY if nobody else used a number in the meantime:
 *
 *     restore only if  counter now == snapshot + the numbers this test consumed
 *
 * Otherwise it refuses to restore and reports counts only. A crash in the middle of a test simply leaves gaps (allowed).
 *
 * The script that uses it passes a small `io` object:
 *   io.get(path)         -> { ok, status, json, message }
 *   io.patch(path, body) -> { ok, status, message }
 * No id, address or token is written by these helpers.
 */

const TABLE = 'mwf_contractnumbercounter';

async function setName(io) {
  const r = await io.get(`EntityDefinitions(LogicalName='${TABLE}')?$select=EntitySetName`);
  if (!r.ok) throw new Error(`could not read the counter table metadata: HTTP ${r.status} ${r.message || ''}`);
  return r.json.EntitySetName;
}

/** @returns {Promise<{set:string, byType:Object<string,{id:string,prefix:string,last:number}>}>} keyed by contract type value */
export async function snapshotCounters(io) {
  const set = await setName(io);
  const r = await io.get(`${set}?$select=mwf_contracttypevalue,mwf_prefix,mwf_lastnumber`);
  if (!r.ok) throw new Error(`could not read the counters: HTTP ${r.status} ${r.message || ''}`);
  const byType = {};
  for (const row of r.json.value) {
    byType[row.mwf_contracttypevalue] = { id: row[`${TABLE}id`], prefix: row.mwf_prefix, last: row.mwf_lastnumber };
  }
  return { set, byType };
}

/** The counters now, same shape as the snapshot. */
export async function readCounters(io, snapshot) {
  const r = await io.get(`${snapshot.set}?$select=mwf_contracttypevalue,mwf_prefix,mwf_lastnumber`);
  if (!r.ok) throw new Error(`could not read the counters: HTTP ${r.status} ${r.message || ''}`);
  const byType = {};
  for (const row of r.json.value) byType[row.mwf_contracttypevalue] = { id: row[`${TABLE}id`], prefix: row.mwf_prefix, last: row.mwf_lastnumber };
  return byType;
}

/**
 * @param consumedByType  { [typeValue]: number of numbers this test consumed (committed rows it created) }
 * @returns {Promise<{restored:number, unchanged:number, refused:number, lines:string[]}>}  counts and short lines, no ids
 */
export async function restoreCounters(io, snapshot, consumedByType) {
  const now = await readCounters(io, snapshot);
  const out = { restored: 0, unchanged: 0, refused: 0, lines: [] };
  for (const [type, snap] of Object.entries(snapshot.byType)) {
    const consumed = consumedByType[type] || 0;
    const cur = now[type];
    if (!cur) { out.refused++; out.lines.push(`${snap.prefix}: counter row not found, not restored`); continue; }
    if (cur.last === snap.last) { out.unchanged++; out.lines.push(`${snap.prefix}: unchanged at ${cur.last}`); continue; }
    if (cur.last !== snap.last + consumed) {
      out.refused++;
      out.lines.push(`${snap.prefix}: NOT restored. snapshot ${snap.last}, consumed by this test ${consumed}, now ${cur.last} (another number was used)`);
      continue;
    }
    // never restore below a number that still exists on a contract (the next create would collide on the alternate key)
    const ex = await io.get(`mwf_contracts?$select=mwf_contractnumber&$filter=${encodeURIComponent(`startswith(mwf_contractnumber,'${snap.prefix}-')`)}&$top=5000`);
    if (!ex.ok) { out.refused++; out.lines.push(`${snap.prefix}: NOT restored. could not read the existing numbers: HTTP ${ex.status}`); continue; }
    const maxExisting = Math.max(0, ...ex.json.value.map((r) => Number(String(r.mwf_contractnumber).split('-')[1]) || 0));
    if (maxExisting > snap.last) {
      out.refused++;
      out.lines.push(`${snap.prefix}: NOT restored. a contract with number suffix ${maxExisting} still exists, above the snapshot ${snap.last}`);
      continue;
    }
    const w = await io.patch(`${snapshot.set}(${cur.id})`, { mwf_lastnumber: snap.last });
    if (!w.ok) { out.refused++; out.lines.push(`${snap.prefix}: restore failed HTTP ${w.status} ${w.message || ''}`); continue; }
    out.restored++;
    out.lines.push(`${snap.prefix}: restored ${cur.last} -> ${snap.last}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Convenience layer for the test scripts (ADR-006). Each script has its own `call(method, path, body, extra)`.
//   const ctr = ctrIo(call);                    adapter for the functions above
//   trackCreate(method, path, body, ok)         one line inside call(): counts committed contract creates per type
//   ctrSnap = await snapshotCounters(ctr)       at the start of a run (after the pre-checks)
//   await restoreAfterRun(ctr, ctrSnap)         at the end of a run, AFTER the cleanup and the check-clean
// Scripts that leave rows behind for a later step (setup/part1 ... cleanup/part2, run in other processes):
//   printHandoff(ctrSnap)                       prints --counters-before=... --counters-consumed=... for the later step
//   await restoreFromArgs(ctr)                  in the cleanup step: restores from those two arguments, same rule
// ---------------------------------------------------------------------------------------------------------------
const CONSUMED = {};

export function ctrIo(call) {
  const msg = (r) => String(r.j?.error?.message || (r.ok ? '' : r.text) || '').slice(0, 200);
  return {
    get: async (p) => { const r = await call('GET', p); return { ok: r.ok, status: r.status, json: r.j, message: msg(r) }; },
    patch: async (p, b) => { const r = await call('PATCH', p, b, { 'If-Match': '*' }); return { ok: r.ok, status: r.status, message: msg(r) }; },
  };
}

export function trackCreate(method, path, body, ok) {
  if (method !== 'POST' || !ok || !body || !/^mwf_contracts(\?|$)/.test(path)) return;
  const t = body.mwf_contracttype;
  if (t !== undefined && t !== null) CONSUMED[t] = (CONSUMED[t] || 0) + 1;
}

const pfxOf = (snap, type) => snap.byType[type].prefix;
const encode = (pairs) => Object.entries(pairs).map(([k, v]) => `${k}:${v}`).join(',');

/** The two arguments of the cleanup step, as text (for messages). */
export function handoffArgs(snap) {
  const before = {}; const used = {};
  for (const [type, c] of Object.entries(snap.byType)) { before[c.prefix] = c.last; if (CONSUMED[type]) used[c.prefix] = CONSUMED[type]; }
  return `--counters-before=${encode(before)} --counters-consumed=${encode(used) || 'NONE:0'}`;
}

/** What to run if a script stops half-way (the generic cleanup by Subject prefix, with the counters of this run). */
export function cleanupHint(prefix, snap) {
  return `To clean up, run: node scripts/cleanup-test-rows.mjs --prefix=${prefix} --env=<url> --auth=az --confirm-mutates-environment${snap ? ' ' + handoffArgs(snap) : ''}`;
}

export function printHandoff(snap) {
  const before = {}; const used = {};
  for (const [type, c] of Object.entries(snap.byType)) { before[c.prefix] = c.last; if (CONSUMED[type]) used[c.prefix] = CONSUMED[type]; }
  console.log(`
COUNTERS handed to the cleanup step: --counters-before=${encode(before)} --counters-consumed=${encode(used) || 'NONE:0'}`);
}

function printRestore(rs) {
  for (const l of rs.lines) console.log(`counter: ${l}`);
  console.log(`counters: restored ${rs.restored}, unchanged ${rs.unchanged}, refused ${rs.refused}`);
}

export async function restoreAfterRun(ctr, snap) {
  const rs = await restoreCounters(ctr, snap, CONSUMED);
  printRestore(rs);
  return rs;
}

export async function restoreFromArgs(ctr, argv = process.argv) {
  const argOf = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
  const beforeStr = argOf('counters-before'); const usedStr = argOf('counters-consumed');
  const cur = await snapshotCounters(ctr);
  console.log('counters now: ' + Object.values(cur.byType).map((c) => `${c.prefix}=${c.last}`).join(' '));
  if (!beforeStr || !usedStr) {
    console.log('counters NOT restored: give --counters-before=... and --counters-consumed=... (printed by the step that created the rows).');
    return { restored: 0, unchanged: 0, refused: 0, skipped: true };
  }
  const parse = (t) => Object.fromEntries(t.split(',').filter(Boolean).map((kv) => kv.split(':')));
  const before = parse(beforeStr); const used = parse(usedStr);
  const fake = { set: cur.set, byType: {} }; const consumed = {};
  for (const [type, c] of Object.entries(cur.byType)) {
    fake.byType[type] = { id: c.id, prefix: c.prefix, last: Number(before[c.prefix] ?? c.last) };
    consumed[type] = Number(used[c.prefix] || 0);
  }
  const rs = await restoreCounters(ctr, fake, consumed);
  printRestore(rs);
  return rs;
}

// ---------------------------------------------------------------------------------------------------------------
// Connection check, first thing in every test script (before any write). The environment is reached through a network that
// has dropped before ("fetch failed"). Three GET requests in a row must succeed, otherwise the script stops with a clear
// message and NOTHING has been written. Only these READ requests are retried (a limited number of attempts); no write is
// ever retried by the helper.
// ---------------------------------------------------------------------------------------------------------------
export async function requireStableConnection(call, { need = 3, maxAttempts = 8, pauseMs = 2000 } = {}) {
  let streak = 0; let attempts = 0; let last = '';
  while (streak < need && attempts < maxAttempts) {
    attempts++;
    try {
      const r = await call('GET', 'WhoAmI', undefined, { __noRetry: true });   // the check is its own retry loop
      if (r.ok) streak++; else { streak = 0; last = `HTTP ${r.status}`; }
    } catch (e) { streak = 0; last = 'network error (fetch failed)'; }
    if (streak < need && attempts < maxAttempts) await new Promise((res) => setTimeout(res, pauseMs));
  }
  if (streak < need) {
    throw new Error(`Connection check failed: ${need} consecutive GET requests were not reached in ${attempts} attempts (last: ${last}). Nothing was written. Run the script again when the connection is stable.`);
  }
  console.log(`INFO  connection check: ${need} consecutive GET requests succeeded (${attempts} attempt(s))`);
}
