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
    const w = await io.patch(`${snapshot.set}(${cur.id})`, { mwf_lastnumber: snap.last });
    if (!w.ok) { out.refused++; out.lines.push(`${snap.prefix}: restore failed HTTP ${w.status} ${w.message || ''}`); continue; }
    out.restored++;
    out.lines.push(`${snap.prefix}: restored ${cur.last} -> ${snap.last}`);
  }
  return out;
}
