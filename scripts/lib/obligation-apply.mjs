/**
 * The apply logic of scripts/add-obligation-schema.mjs (ADR-011, status Proposed), with the HTTP layer injected so that it is unit tested against a
 * mocked, stateful environment (obligation-apply.test.mjs). NOTHING here has run against an environment.
 *
 * Two stages, never in one run:
 *   tables  both tables, their columns and the lookup (no key)
 *   key     the alternate key only, then a BOUNDED poll of EntityKeyIndexStatus; stops on Failed; never starts the uniqueness test
 *
 * Rules enforced in this file (the tests prove each):
 *   - Before any write: the connection gate, the solution check (exactly one unmanaged solution of the given name), the baseline (counts). Any failure writes nothing.
 *   - The connection gate runs again before EVERY write.
 *   - Every write is a POST that carries the header MSCRM.SolutionUniqueName with the solution given as a named parameter (no default).
 *   - guardedCall: only GET and POST exist; a POST goes only to the creation endpoints of the two tables of ADR-011. There is no delete, no PUT, no PATCH.
 *   - Resumable: existing objects are READ; only what is missing is created; a difference from the expected definition is reported as DRIFT and never overwritten.
 * Property used for the key status: EntityKeyMetadata.EntityKeyIndexStatus; members Pending, InProgress, Active, Failed
 * (Microsoft Learn: .../webapi/reference/entitykeymetadata and .../webapi/reference/entitykeyindexstatus; read 2026-11-03).
 */
import { TABLES, COLUMNS, KEYS, tableBody, columnBody, lookupBody, keyBody, tableChecks, optionChecks, lookupChecks, keyGate } from './obligation-schema.mjs';
import { readAlertTableCounts, alertTablesVerdict } from './alert-tables-baseline.mjs';

export const STAGES = Object.freeze(['tables', 'key']);
export const SOLUTION_HEADER = 'MSCRM.SolutionUniqueName';
export const SOLUTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const NAMES = Object.values(TABLES).map((t) => t.logical);
const q = encodeURIComponent;

/** Reasons to refuse `--mode=apply` BEFORE any sign-in. Empty list = go. Pure. */
export function applyPreflight({ confirm, auth, stage, solution }) {
  const why = [];
  if (!confirm) why.push('--confirm-mutates-environment is missing');
  if (auth !== 'az') why.push(`--auth=az is required (got ${auth ? `--auth=${auth}` : 'no --auth'}); a device-code sign-in is not accepted for apply`);
  if (!STAGES.includes(stage)) why.push(`--stage=${STAGES.join('|')} is required (got ${stage ? `"${stage}"` : 'none'}); tables and key are never created in one run`);
  if (!solution) why.push('--solution=<unique name of the unmanaged solution> is required; there is no default');
  else if (!SOLUTION_NAME.test(solution)) why.push('--solution is not a valid solution unique name');
  return why;
}

/**
 * The only way the apply code talks to the environment. GET passes. POST passes only to a creation endpoint of the two ADR-011 tables and always carries
 * the solution header. Every other method, and every other POST target, throws before anything is sent.
 */
export function guardedCall(call, solution) {
  if (!solution || !SOLUTION_NAME.test(solution)) throw new Error('refused: a valid solution unique name is required');
  const allowedPost = [
    /^EntityDefinitions$/,
    new RegExp(`^EntityDefinitions\\(LogicalName='(${NAMES.join('|')})'\\)/(Attributes|Keys)$`),
    /^RelationshipDefinitions$/,
  ];
  return async (method, path, body, headers = {}) => {
    if (method === 'GET') return call('GET', path, undefined, headers);
    if (method !== 'POST') throw new Error(`refused: ${method} is not available to the apply code (only GET and POST; nothing is ever deleted or overwritten)`);
    if (!allowedPost.some((re) => re.test(path))) throw new Error(`refused: POST to ${path.slice(0, 80)} is not a creation endpoint of the ADR-011 tables`);
    return call('POST', path, body, { ...headers, [SOLUTION_HEADER]: solution });
  };
}

/** Counts of the baseline, read only: the same queries as scripts/test-flow-reminders.mjs plus the two ADR-011 tables. */
export async function readBaselineCounts(call) {
  const n = async (set, id, filter) => {
    const r = await call('GET', `${set}?$select=${id}&$count=true&$top=1${filter ? `&$filter=${q(filter)}` : ''}`);
    if (!r.ok || typeof r.j?.['@odata.count'] !== 'number') throw new Error(`could not count ${set} (HTTP ${r.status})`);
    return r.j['@odata.count'];
  };
  return {
    contracts: await n('mwf_contracts', 'mwf_contractid'),
    matrix: await n('mwf_approvalmatrixes', 'mwf_approvalmatrixid', 'statecode eq 0'),
    assignments: await n('mwf_approverassignments', 'mwf_approverassignmentid', 'statecode eq 0'),
    steps: await n('mwf_approvalsteps', 'mwf_approvalstepid'),
    alert: await readAlertTableCounts(call),
  };
}

/** @returns {{ok:boolean, lines:{status:string,name:string,detail:string}[]}} */
export function baselineVerdict(c, expectContracts) {
  const eq = (name, got, want) => ({ status: got === want ? 'PASS' : 'FAIL', name: `${name} ${want}`, detail: String(got) });
  const lines = [eq('contracts', c.contracts, expectContracts), eq('active matrix rows', c.matrix, 110), eq('active assignments', c.assignments, 5), eq('approval steps', c.steps, 0), ...alertTablesVerdict(c.alert).lines];
  return { ok: lines.every((l) => l.status !== 'FAIL'), lines };
}

const text = (l) => l?.LocalizedLabels?.[0]?.Label ?? l?.UserLocalizedLabel?.Label;
const isColumnMissing = (check) => check.got === 'missing' && COLUMNS.some((c) => check.name.includes(`.${c.logical}:`));

/**
 * @param {object} p
 * @param {Function} p.call            (method, path, body?, headers?) -> Promise<{ok,status,j,text}>   (never throws for an HTTP error)
 * @param {'tables'|'key'} p.stage
 * @param {string} p.solution          the unique name of the unmanaged solution (named parameter, no default)
 * @param {number} p.expectContracts   the contract count of the baseline
 * @param {Function} [p.gate]          async () => void  the connection gate; throws when the connection is not stable
 * @param {Function} [p.log]
 * @param {Function} [p.sleep]         async (ms) => void
 * @param {number} [p.pollSeconds=5] @param {number} [p.maxWaitSeconds=300]  bounds of the key poll
 * @returns {Promise<{ok:boolean, stopped:string|null, created:string[], skipped:string[], drift:string[], keyStatus:string|null, polls:number}>}
 */
export async function runApply({ call, stage, solution, expectContracts, gate = async () => {}, log = () => {}, sleep = async () => {}, pollSeconds = 5, maxWaitSeconds = 300 }) {
  const res = { ok: false, stopped: null, created: [], skipped: [], drift: [], keyStatus: null, polls: 0 };
  const stop = (why) => { res.stopped = why; log(`STOPPED  ${why}`); return res; };
  if (!STAGES.includes(stage)) return stop('--stage is required');
  const c = guardedCall(call, solution);
  const get = async (path) => c('GET', path);
  const must = async (path, what) => { const r = await get(path); if (!r.ok) throw new Error(`could not read ${what} (HTTP ${r.status})`); return r; };
  const write = async (path, body, what) => {
    await gate();   // the connection gate before EVERY write
    const w = await c('POST', path, body);
    if (!w.ok) throw new Error(`creating ${what} answered HTTP ${w.status}. Not retried, no other form is tried.`);
    res.created.push(what); log(`CREATED  ${what}`);
  };
  const drift = (line) => { res.drift.push(line); log(`DRIFT    ${line}  (not overwritten)`); };

  try {
    // ---- before any write: connection gate, solution, baseline
    await gate();
    const sol = await must(`solutions?$filter=${q(`uniquename eq '${solution}'`)}&$select=solutionid,ismanaged`, 'the solution');
    if (sol.j.value.length !== 1 || sol.j.value[0].ismanaged) return stop(`solution ${solution}: expected exactly 1 unmanaged solution, found ${sol.j.value.length}${sol.j.value[0]?.ismanaged ? ' (managed)' : ''}. Nothing was written.`);
    log(`PASS     solution ${solution} exists and is unmanaged`);
    const v = baselineVerdict(await readBaselineCounts(c), expectContracts);
    for (const l of v.lines) log(`${l.status.padEnd(4)}     baseline ${l.name} [${l.detail}]`);
    if (!v.ok) return stop('the baseline is not clean (see the lines above). Nothing was written.');

    if (stage === 'tables') await tablesStage();
    else await keyStage();
    res.ok = res.drift.length === 0 && !res.stopped;
    return res;
  } catch (e) {
    return stop(String(e.message).slice(0, 240));
  }

  async function tablesStage() {
    for (const t of Object.values(TABLES)) {
      const base = `EntityDefinitions(LogicalName='${t.logical}')`;
      let md = await get(`${base}?$select=LogicalName,OwnershipType,HasNotes,HasActivities,IsAuditEnabled`);
      if (md.status === 404) {
        await write('EntityDefinitions', tableBody(t), `table ${t.logical}`);
        for (let i = 0; i < 15 && !md.ok; i++) { await sleep(2000); md = await get(`${base}?$select=LogicalName,OwnershipType,HasNotes,HasActivities,IsAuditEnabled`); }
        if (!md.ok) throw new Error(`table ${t.logical} was created but is not readable`);
      } else if (!md.ok) throw new Error(`could not read table ${t.logical} (HTTP ${md.status})`);
      else { res.skipped.push(`table ${t.logical}`); log(`SKIP     table ${t.logical} (exists)`); }
      const attrs = (await must(`${base}/Attributes?$select=LogicalName,AttributeType,RequiredLevel,IsAuditEnabled`, `the columns of ${t.logical}`)).j.value;
      for (const ch of tableChecks(t, md.j, attrs)) if (!ch.ok && !isColumnMissing(ch)) drift(`${ch.name}: found ${ch.got}`);
      const have = new Set(attrs.map((a) => a.LogicalName));
      let rels = null;
      for (const col of COLUMNS.filter((x) => x.table === t.logical)) {
        if (!have.has(col.logical)) {
          if (col.kind === 'lookup') await write('RelationshipDefinitions', lookupBody(col), `lookup ${col.table}.${col.logical}`);
          else await write(`${base}/Attributes`, columnBody(col), `column ${col.table}.${col.logical}`);
          continue;
        }
        res.skipped.push(`${col.kind} ${col.table}.${col.logical}`); log(`SKIP     ${col.kind} ${col.table}.${col.logical} (exists)`);
        if (col.kind === 'picklist') {
          const p = await get(`${base}/Attributes(LogicalName='${col.logical}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName,DefaultFormValue&$expand=OptionSet($select=IsGlobal,Options)`);
          if (!p.ok) throw new Error(`could not read the options of ${col.logical} (HTTP ${p.status})`);
          for (const ch of optionChecks(col, p.j)) if (!ch.ok) drift(`${ch.name}: found ${ch.got}`);
        }
        if (col.kind === 'lookup') {
          rels ??= (await must(`${base}/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,CascadeConfiguration`, `the relationships of ${t.logical}`)).j.value;
          for (const ch of lookupChecks(col, rels)) if (!ch.ok) drift(`${ch.name}: found ${ch.got}`);
        }
      }
    }
  }

  async function keyStage() {
    for (const k of KEYS) {
      const base = `EntityDefinitions(LogicalName='${k.table}')`;
      const t = await get(`${base}?$select=LogicalName`);
      if (!t.ok) throw new Error(`table ${k.table} does not exist (HTTP ${t.status}); run --stage=tables first`);
      const attrs = (await must(`${base}/Attributes?$select=LogicalName,AttributeType`, `the columns of ${k.table}`)).j.value;
      for (const a of k.attributes) if (!attrs.some((x) => x.LogicalName === a && x.AttributeType === 'String')) throw new Error(`the key column ${k.table}.${a} does not exist as a String; run --stage=tables first`);
      const keysPath = `${base}/Keys?$select=SchemaName,KeyAttributes,EntityKeyIndexStatus`;
      let keys = (await must(keysPath, `the keys of ${k.table}`)).j.value;
      const found = keys.find((x) => x.SchemaName === k.schema);
      if (!found) await write(`${base}/Keys`, keyBody(k), `key ${k.schema} on (${k.attributes.join(', ')})`);
      else {
        res.skipped.push(`key ${k.schema}`); log(`SKIP     key ${k.schema} (exists)`);
        if (JSON.stringify([...(found.KeyAttributes || [])].sort()) !== JSON.stringify([...k.attributes].sort())) { drift(`key ${k.schema}: found attributes ${(found.KeyAttributes || []).join(', ')}, expected ${k.attributes.join(', ')}`); throw new Error('the key differs from the definition; it is not changed or deleted by this script'); }
      }
      // bounded poll of EntityKeyIndexStatus
      const maxPolls = Math.max(1, Math.ceil(maxWaitSeconds / pollSeconds));
      for (let i = 0; i < maxPolls; i++) {
        keys = (await must(keysPath, `the keys of ${k.table}`)).j.value;
        res.polls++;
        const g = keyGate(keys, k.schema); res.keyStatus = g.status;
        log(`POLL     ${k.schema} EntityKeyIndexStatus = ${g.status} (${i + 1} of at most ${maxPolls})`);
        if (g.ok) { log(`PASS     key ${k.schema} index Active`); return; }
        if (g.status === 'Failed') throw new Error(`the index of ${k.schema} Failed. Not retried, not reactivated by this script (ReactivateEntityKey exists on Learn); read the cause in the environment.`);
        if (i < maxPolls - 1) await sleep(pollSeconds * 1000);
      }
      throw new Error(`the index of ${k.schema} is ${res.keyStatus} after ${maxPolls} poll(s) (${maxWaitSeconds} s). Rerun --stage=key later: it only reads the status when the key exists.`);
    }
  }
}
