/**
 * `create` and `verify` of scripts/build-flow-obligation-alerts.mjs (ADR-011, docs/flow-obligation-alerts.md), with the HTTP layer injected so that they are unit tested
 * against a mocked, stateful environment (obligation-flow-deploy.test.mjs). NEITHER MODE HAS BEEN RUN AGAINST AN ENVIRONMENT.
 *
 * Rules enforced in this file (the tests prove each):
 *   - create is for the TEST variant only. It creates the flow OFF: the body carries no state, so the new row is a Draft (the state of the reminders flow's creation).
 *   - The only verbs are GET and ONE POST to `workflows` (guardedCall). There is no PUT, no PATCH, no DELETE, no second POST, no code that turns a flow on, publishes it or saves
 *     an existing one, and no replace mode: a flow of this name that already exists stops the script.
 *   - Before the POST (all read only): the connection gate, the solution (one, unmanaged), the five existing flows all OFF, no flow of this name, the baseline (11 contracts, 110 active
 *     matrix rows, 5 active assignments, 0 steps, BOTH ADR-011 tables present with 0 rows), the counters all 0, the two connection references (they must exist once, for their connector,
 *     in the solution, with a connection set: the script never creates one), the structural check.
 *   - verify reads only. It never fixes a difference.
 */
import { buildClientdata, checkClientdata, statsOf, FLOW_NAME, testVariant, SOLUTION_HEADER, createBody } from '../build-flow-obligation-alerts.mjs';
import { walk } from '../build-flow-v2.mjs';
import { readBaselineCounts } from './obligation-apply.mjs';
import { snapshotCounters } from './counter-snapshot.mjs';
import { diffDeep } from './auditing.mjs';
import { DEFAULT_OUTLOOK_REF, DEFAULT_DATAVERSE_REF } from '../build-flow-reminders.mjs';

export const EXPECTED_FLOWS = 5;   // the five flows that exist before this one (the owner's baseline)
export const SOLUTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const noGuid = (t) => String(t ?? '').replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>');
const q = encodeURIComponent;

/** Reasons to refuse `--mode=create` BEFORE any sign-in. Pure. Empty = go (a dry run needs no environment). */
export function createPreflight({ variant, solution }) {
  const why = [];
  if (variant !== 'test') why.push(`create is for the test variant only (got ${variant ? `--variant=${variant}` : 'none'}); the production variant is refused`);
  if (!solution) why.push('--solution=<unique name of the unmanaged solution> is required; there is no default');
  else if (!SOLUTION_NAME.test(solution)) why.push('--solution is not a valid solution unique name');
  return why;
}

/**
 * The only way create and verify talk to the environment. GET passes. A POST passes ONLY to `workflows`, with the flow's name, category 5, once per caller, and carries the solution
 * header. Every other method (PUT, PATCH, DELETE ...) and every other POST throws BEFORE anything is sent.
 */
export function guardedCall(call, solution) {
  if (!solution || !SOLUTION_NAME.test(solution)) throw new Error('refused: a valid solution unique name is required');
  let posts = 0;
  return async (method, path, body, headers = {}) => {
    if (method === 'GET') return call('GET', path, undefined, headers);
    if (method !== 'POST') throw new Error(`refused: ${method} is not available (only GET and the ONE POST that creates the flow row; nothing is ever changed, replaced, deleted, turned on or published)`);
    if (path !== 'workflows' || body?.name !== FLOW_NAME || body?.category !== 5) throw new Error('refused: the only POST is the creation of the workflows row of this flow');
    if (posts >= 1) throw new Error('refused: the POST that creates the flow row is sent at most once');
    posts++;
    return call('POST', path, body, { ...headers, [SOLUTION_HEADER]: solution });
  };
}

/** Every leaf path of a value ("a.b[0].c"). A string that is JSON (the clientdata) is expanded under its own key, so the list is the EXACT list of what is sent. */
export function jsonPaths(value, prefix = '', out = []) {
  if (Array.isArray(value)) { if (!value.length) out.push(`${prefix}[]`); value.forEach((x, i) => jsonPaths(x, `${prefix}[${i}]`, out)); return out; }
  if (value && typeof value === 'object') { const k = Object.keys(value); if (!k.length) out.push(`${prefix}{}`); for (const key of k) jsonPaths(value[key], prefix ? `${prefix}.${key}` : key, out); return out; }
  out.push(prefix); return out;
}
export const requestPaths = (body) => jsonPaths({ ...body, clientdata: JSON.parse(body.clientdata) });

/** What the dry run prints. Pure, offline: no network, no sign-in, nothing sent. */
export function dryRunLines({ solution, refs = {}, variant = testVariant(), host = '<ORG_HOST>' } = {}) {
  const cd = buildClientdata(variant, { outlookRef: refs.outlookRef ?? DEFAULT_OUTLOOK_REF, dataverseRef: refs.dataverseRef ?? DEFAULT_DATAVERSE_REF });
  const s = statsOf(cd); const chk = checkClientdata(cd, variant, refs); const failed = chk.results.filter((r) => !r.pass).length;
  const body = createBody(JSON.stringify(cd)); const paths = requestPaths(body);
  return [
    'DRY RUN: nothing is sent, no sign-in, no environment is read.',
    `FLOW      ${FLOW_NAME} (variant ${variant.name}: interval ${variant.intervalMinutes} min, lead ${variant.leadMinutes} min, lookback ${variant.lookbackMinutes} min)`,
    `REQUEST   ONE POST workflows (never retried), header ${SOLUTION_HEADER}: ${solution}`,
    'STATE     OFF: the body carries no state (no statecode, no statuscode), so the new row is a Draft. This script never turns a flow on, publishes it, saves an existing flow, or sends PUT, PATCH or DELETE.',
    `BINDS     shared_commondataserviceforapps -> connection reference ${refs.dataverseRef ?? DEFAULT_DATAVERSE_REF}`,
    `BINDS     shared_office365 (Office 365 Outlook) -> connection reference ${refs.outlookRef ?? DEFAULT_OUTLOOK_REF}`,
    '          (existing references of the reminders flow: if one is missing the script stops; it never creates a reference)',
    `SIZE      ${s.actions} actions, nesting depth ${s.depth} (REAL numbers from the generated definition; limits 500 and 8), clientdata ${Buffer.byteLength(JSON.stringify(cd), 'utf8')} bytes before ${host} replaces the placeholder`,
    `CHECKS    ${chk.results.length - failed} of ${chk.results.length} structural checks pass${failed ? ` (THE REAL RUN WOULD REFUSE: ${failed} failed)` : ''}`,
    'BEFORE THE POST (real run only, all read only): 3 consecutive successful reads; the solution is unmanaged; the five existing flows are all OFF; no flow named "' + FLOW_NAME + '"; contracts 11, active matrix rows 110, active assignments 5, steps 0; BOTH ADR-011 tables present with 0 rows; the counters are all 0; each of the two references exists once, for its connector, in the solution, with a connection set; the structural check passes',
    'AFTER THE POST (real run only): read back once: category 5, OFF, in the solution, the stored structure, the stored reference names, every other flow row unchanged and none ON',
    'NEVER     PUT, PATCH, DELETE, a second POST, turn on, publish, save an existing flow, create a reference, replace a flow.',
    `JSON PATHS of the request body (${paths.length} leaf paths; the clientdata string is expanded under "clientdata."): the list follows, exactly as it will be sent`,
    ...paths.map((p) => `  ${p}`),
  ];
}

const ioOf = (call) => ({ get: async (p) => { const r = await call('GET', p); return { ok: r.ok, status: r.status, json: r.j, message: String(r.j?.error?.message || '').slice(0, 200) }; } });

/**
 * @param {object} p
 * @param {Function} p.call      (method, path, body?, headers?) -> Promise<{ok,status,j,text}>   (may throw for a network error: the POST outcome is then unknown)
 * @param {string} p.solution    @param {string} p.host   the host of --env (replaces <ORG_HOST> in memory only; never printed)
 * @param {{outlookRef:string, dataverseRef:string}} [p.refs]
 * @param {number} [p.expectContracts=11]
 * @param {Function} [p.gate]    async () => void
 * @param {Function} [p.log]
 * @param {Function} [p.build]   (variant, refs) -> clientdata; for tests that need a broken definition
 * @returns {Promise<{ok:boolean, failed:number, stopped:string|null, posts:number, unknown:boolean}>}
 */
export async function runCreate({ call, solution, host, refs = {}, expectContracts = 11, gate = async () => {}, log = () => {}, build = buildClientdata }) {
  const res = { ok: false, failed: 0, stopped: null, posts: 0, unknown: false };
  const R = { outlookRef: refs.outlookRef ?? DEFAULT_OUTLOOK_REF, dataverseRef: refs.dataverseRef ?? DEFAULT_DATAVERSE_REF };
  const variant = testVariant();
  const raw = call; let c;   // the guarded caller is made inside the try: an invalid solution name is a stop, not a crash
  const check = (n, ok, d = '') => { log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  [${d}]` : ''}`); if (!ok) res.failed++; return ok; };
  const get = async (path) => { const r = await c('GET', path); if (!r.ok) throw new Error(`GET ${noGuid(path).slice(0, 80)} failed HTTP ${r.status}`); return r.j; };
  const stop = (why) => { res.stopped = why; log(`STOPPED  ${why}`); return res; };
  const flowRows = async () => (await get(`workflows?$select=name,statecode,statuscode,category,modifiedon&$filter=${q('category eq 5')}&$top=200`)).value;
  const rowOf = async () => (await get(`workflows?$select=workflowid,name,statecode,statuscode,category,modifiedon,clientdata&$filter=${q(`name eq '${FLOW_NAME}' and category eq 5`)}`)).value;
  try {
    c = guardedCall(async (m, p, b, h) => { if (m === 'POST') res.posts++; return raw(m, p, b, h); }, solution);
    await gate();
    const sol = (await get(`solutions?$filter=uniquename eq '${solution}'&$select=solutionid,ismanaged`)).value;
    if (sol.length !== 1 || sol[0].ismanaged) return stop(`solution ${solution}: expected exactly 1 unmanaged solution, found ${sol.length}${sol[0]?.ismanaged ? ' (managed)' : ''}. Nothing was written.`);
    const solId = sol[0].solutionid;
    const inSolution = async (id) => (await get(`solutioncomponents?$filter=_solutionid_value eq ${solId} and objectid eq ${id}&$select=componenttype`)).value.length >= 1;
    const before = await flowRows();
    log(`INFO  flow rows before: ${before.length}; ON: ${before.filter((r) => r.statecode === 1).length}`);
    check(`the ${EXPECTED_FLOWS} existing flows are all OFF`, before.length === EXPECTED_FLOWS && before.every((r) => r.statecode === 0), `${before.length} row(s), ${before.filter((r) => r.statecode === 1).length} ON`);
    if ((await rowOf()).length) return stop(`"${FLOW_NAME}" already exists. Nothing was created: create never modifies an existing flow and there is no replace mode in this script.`);
    check(`no flow named "${FLOW_NAME}" exists`, true);
    const counts = await readBaselineCounts(c);
    check(`contracts ${expectContracts}, active matrix rows 110, active assignments 5, approval steps 0`, counts.contracts === expectContracts && counts.matrix === 110 && counts.assignments === 5 && counts.steps === 0, JSON.stringify({ contracts: counts.contracts, matrix: counts.matrix, assignments: counts.assignments, steps: counts.steps }));
    for (const a of counts.alert) check(`${a.table} exists and holds 0 rows`, a.state === 'present' && a.count === 0, a.state === 'present' ? String(a.count) : a.state);
    const snap = await snapshotCounters(ioOf(c)); const last = Object.values(snap.byType).map((x) => x.last);
    check('the contract-number counters are all 0', last.length > 0 && last.every((n) => n === 0), `[${last.join(',')}]`);
    // the connection references: read only, never created
    const allRefs = (await get('connectionreferences?$select=connectionreferenceid,connectionreferencelogicalname,connectorid,connectionid&$top=5000')).value;
    const members = new Set((await get(`solutioncomponents?$filter=_solutionid_value eq ${solId}&$select=objectid&$top=5000`)).value.map((x) => String(x.objectid).toLowerCase()));
    for (const [connector, logical] of [['shared_commondataserviceforapps', R.dataverseRef], ['shared_office365', R.outlookRef]]) {
      const hit = allRefs.filter((r) => r.connectionreferencelogicalname === logical);
      check(`the connection reference ${logical} exists once`, hit.length === 1, `${hit.length} found`);
      if (hit.length === 1) {
        check(`${logical} is for the connector ${connector}`, String(hit[0].connectorid).endsWith(`/${connector}`));
        check(`${logical} is a component of the solution ${solution}`, members.has(String(hit[0].connectionreferenceid).toLowerCase()));
        check(`${logical} has a connection set (the value is not printed)`, !!hit[0].connectionid);
      }
    }
    log(`INFO  binds: shared_commondataserviceforapps -> ${R.dataverseRef}; shared_office365 -> ${R.outlookRef} (existing references; none is created)`);
    const cd = build(variant, R); const chk = checkClientdata(cd, variant, R);
    check('the structural check of the generated definition passes', chk.results.every((r) => r.pass), `${chk.results.filter((r) => !r.pass).map((r) => r.name).join('; ').slice(0, 200)}`);
    if (res.failed) return stop('A guard failed (see the lines above). Nothing was written.');
    log(`INFO  about to send ONE POST: ${chk.stats.actions} actions, depth ${chk.stats.depth}`);

    // THE ONE POST
    const payload = JSON.stringify(cd).split('<ORG_HOST>').join(host);
    let created;
    try { created = await c('POST', 'workflows', createBody(payload)); } catch (e) {
      res.unknown = true;
      let after = null; try { after = await rowOf(); } catch { /* not readable */ }
      log(`POST outcome UNKNOWN: ${noGuid(e.message).slice(0, 200)}. ${after ? `State read after the error: ${after.length} row(s) named "${FLOW_NAME}".` : 'State could not be read after the error either; check by hand.'} Nothing was deleted or retried.`);
      return stop('the outcome of the POST is unknown (see above)');
    }
    if (!created.ok) return stop(`POST workflows failed HTTP ${created.status} ${noGuid(created.j?.error?.message || created.text || '').slice(0, 300)}. Nothing else was done.`);
    check('POST accepted (one row)', true, `HTTP ${created.status}`);
    const rows = await rowOf();
    check('the flow exists once', rows.length === 1, `${rows.length}`);
    if (rows.length === 1) {
      const row = rows[0];
      check('category is 5 (modern flow) and the flow is OFF (statecode 0, Draft)', row.category === 5 && row.statecode === 0, `category ${row.category}, statecode ${row.statecode}, statuscode ${row.statuscode}`);
      check('the flow is a component of the solution', await inSolution(row.workflowid));
      const back = JSON.parse(row.clientdata || '{}'); const stored = JSON.parse(JSON.stringify(back).split(host).join('<ORG_HOST>'));
      const sc = checkClientdata(stored, variant, R);
      check('the structural check passes on the definition as stored by Dataverse', sc.results.every((r) => r.pass), sc.results.filter((r) => !r.pass).map((r) => r.name).join('; ').slice(0, 300));
      check('the stored definition has the same action names as the one sent', JSON.stringify(walk(back.properties?.definition?.actions).map((x) => x.name)) === JSON.stringify(chk.list.map((x) => x.name)));
      check('the stored connection references are the two given', back.properties?.connectionReferences?.shared_office365?.connection?.connectionReferenceLogicalName === R.outlookRef && back.properties?.connectionReferences?.shared_commondataserviceforapps?.connection?.connectionReferenceLogicalName === R.dataverseRef);
    }
    const afterAll = await flowRows(); const was = new Map(before.map((r) => [`${r.name}|${r.modifiedon}`, r.statecode]));
    check('every other flow row is unchanged (same modifiedon and state) and none is ON', afterAll.filter((r) => r.name !== FLOW_NAME).every((r) => was.get(`${r.name}|${r.modifiedon}`) === r.statecode) && afterAll.filter((r) => r.statecode === 1).length === 0, `${afterAll.length} row(s)`);
    res.ok = res.failed === 0;
    log(`SUMMARY: ${res.failed} failed check(s). The flow was NOT turned on and no run was started. The owner turns it on, only for a test.`);
    return res;
  } catch (e) {
    return stop(String(e.message).slice(0, 300));
  }
}

/**
 * Read only. Reports the state, the solution membership, the references, whether the stored definition equals the generated one (every difference listed, none fixed),
 * and the real action count and depth read from the STORED definition.
 */
export async function runVerify({ call, solution, host, refs = {}, log = () => {}, build = buildClientdata }) {
  const res = { ok: false, failed: 0, stopped: null, differences: [], stats: null };
  const R = { outlookRef: refs.outlookRef ?? DEFAULT_OUTLOOK_REF, dataverseRef: refs.dataverseRef ?? DEFAULT_DATAVERSE_REF };
  const variant = testVariant(); let c;
  const check = (n, ok, d = '') => { log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  [${d}]` : ''}`); if (!ok) res.failed++; return ok; };
  const get = async (path) => { const r = await c('GET', path); if (!r.ok) throw new Error(`GET ${noGuid(path).slice(0, 80)} failed HTTP ${r.status}`); return r.j; };
  try {
    c = guardedCall(call, solution);
    const sol = (await get(`solutions?$filter=uniquename eq '${solution}'&$select=solutionid,ismanaged`)).value;
    if (sol.length !== 1 || sol[0].ismanaged) { res.stopped = `solution ${solution}: expected exactly 1 unmanaged solution, found ${sol.length}`; log(`STOPPED  ${res.stopped}`); return res; }
    const rows = (await get(`workflows?$select=workflowid,name,statecode,statuscode,category,modifiedon,clientdata&$filter=${q(`name eq '${FLOW_NAME}' and category eq 5`)}`)).value;
    check('the flow exists once', rows.length === 1, `${rows.length} row(s)`);
    if (rows.length !== 1) { res.stopped = rows.length ? 'more than one row of this name' : 'the flow does not exist'; return res; }
    const row = rows[0];
    check('the flow is OFF (statecode 0): a flow that is ON is reported, never changed', row.statecode === 0, `statecode ${row.statecode}, statuscode ${row.statuscode}`);
    const inSol = (await get(`solutioncomponents?$filter=_solutionid_value eq ${sol[0].solutionid} and objectid eq ${row.workflowid}&$select=componenttype`)).value.length >= 1;
    check(`the flow is a component of the solution ${solution}`, inSol);
    const back = JSON.parse(row.clientdata || '{}'); const stored = JSON.parse(JSON.stringify(back).split(host).join('<ORG_HOST>'));
    const outlook = back.properties?.connectionReferences?.shared_office365?.connection?.connectionReferenceLogicalName;
    const dv = back.properties?.connectionReferences?.shared_commondataserviceforapps?.connection?.connectionReferenceLogicalName;
    log(`INFO  connection references bound: shared_commondataserviceforapps -> ${dv ?? 'none'}; shared_office365 -> ${outlook ?? 'none'}`);
    check('the bound references are the two given', outlook === R.outlookRef && dv === R.dataverseRef, `${dv ?? 'none'} / ${outlook ?? 'none'}`);
    check('the record link of the stored definition no longer has the placeholder', !(row.clientdata || '').includes('<ORG_HOST>'));
    res.stats = back.properties?.definition?.actions ? statsOf(stored) : null;
    check('the real action count and depth were read from the STORED definition', !!res.stats, res.stats ? `${res.stats.actions} actions, nesting depth ${res.stats.depth}` : 'no definition stored');
    if (res.stats) {
      const sc = checkClientdata(stored, variant, { outlookRef: outlook, dataverseRef: dv });
      check('the structural check passes on the stored definition', sc.results.every((r) => r.pass), sc.results.filter((r) => !r.pass).map((r) => r.name).join('; ').slice(0, 300));
    }
    const want = build(variant, R);
    res.differences = diffDeep(want, stored).map((d) => d.path);
    check('the stored definition equals the generated one (every difference is listed, none is fixed)', res.differences.length === 0, res.differences.length ? `${res.differences.length} difference(s): ${res.differences.slice(0, 12).join(', ')}${res.differences.length > 12 ? ', ...' : ''}` : 'identical');
    const all = (await get(`workflows?$select=name,statecode&$filter=${q('category eq 5')}&$top=200`)).value;
    log(`INFO  flow rows (category 5): ${all.length}; ON: ${all.filter((r) => r.statecode === 1).length}`);
    res.ok = res.failed === 0;
    return res;
  } catch (e) {
    res.stopped = String(e.message).slice(0, 300); log(`STOPPED  ${res.stopped}`); return res;
  }
}
