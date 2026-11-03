/**
 * The baseline of the two tables of ADR-011 (mwf_obligation, mwf_alertlog): both must hold 0 rows. The tables do not exist until
 * scripts/add-obligation-schema.mjs has been applied, so "does not exist" is reported as an observation and is NOT a failure; this keeps the
 * existing baselines (11 contracts, 110 matrix rows, 5 assignments, 0 steps) working before and after the tables exist.
 * Reads only. The `call` is the Web API caller of the session: (method, path) -> Promise<{ok,status,j}>.
 */
export const ALERT_TABLES = Object.freeze(['mwf_obligation', 'mwf_alertlog']);

/** @returns {Promise<{table:string, state:'absent'|'present'|'error', count:number|null, status?:number}[]>} */
export async function readAlertTableCounts(call) {
  const rows = [];
  for (const table of ALERT_TABLES) {
    const meta = await call('GET', `EntityDefinitions(LogicalName='${table}')?$select=EntitySetName`);
    if (meta.status === 404) { rows.push({ table, state: 'absent', count: null }); continue; }
    if (!meta.ok) { rows.push({ table, state: 'error', count: null, status: meta.status }); continue; }
    const c = await call('GET', `${meta.j.EntitySetName}?$select=${table}id&$count=true&$top=1`);
    if (!c.ok || typeof c.j?.['@odata.count'] !== 'number') { rows.push({ table, state: 'error', count: null, status: c.status }); continue; }
    rows.push({ table, state: 'present', count: c.j['@odata.count'] });
  }
  return rows;
}

/**
 * The verdict of the baseline for these tables.
 * @returns {{ok:boolean, lines:{status:'PASS'|'FAIL'|'OBS', name:string, detail:string}[]}}
 *   absent  -> OBS (not created yet; not a failure)      present with 0 rows -> PASS      present with rows -> FAIL      read error -> FAIL
 */
export function alertTablesVerdict(rows) {
  const lines = (rows || []).map((r) => {
    if (r.state === 'absent') return { status: 'OBS', name: `${r.table} does not exist yet (ADR-011 not applied); not counted`, detail: 'absent' };
    if (r.state === 'error') return { status: 'FAIL', name: `${r.table} could not be counted`, detail: `HTTP ${r.status}` };
    return { status: r.count === 0 ? 'PASS' : 'FAIL', name: `${r.table} holds 0 rows`, detail: String(r.count) };
  });
  if (lines.length !== ALERT_TABLES.length) lines.push({ status: 'FAIL', name: 'both ADR-011 tables were looked at', detail: `${lines.length} of ${ALERT_TABLES.length}` });
  return { ok: lines.every((l) => l.status !== 'FAIL'), lines };
}
