// Tests of the apply logic of scripts/add-obligation-schema.mjs against a MOCKED, stateful environment. Nothing here talks to an environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STAGES, SOLUTION_HEADER, applyPreflight, guardedCall, readBaselineCounts, baselineVerdict, runApply } from './obligation-apply.mjs';
import { TABLES, COLUMNS, KEYS } from './obligation-schema.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const SCRIPT = here('../add-obligation-schema.mjs');
const SRC_SCRIPT = fs.readFileSync(SCRIPT, 'utf8');
const SRC_LIB = fs.readFileSync(here('./obligation-apply.mjs'), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', timeout: 30000 });
const SOL = 'TestSolution';
const TYPE = { string: 'String', picklist: 'Picklist', datetime: 'DateTime', lookup: 'Lookup' };
const ODATA_TYPE = { 'Microsoft.Dynamics.CRM.StringAttributeMetadata': 'String', 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata': 'Picklist', 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata': 'DateTime', 'Microsoft.Dynamics.CRM.LookupAttributeMetadata': 'Lookup' };
const lbl = (l) => l?.LocalizedLabels?.[0]?.Label;
const opts = (options) => ({ IsGlobal: false, Options: Object.entries(options).map(([l, v]) => ({ Value: v, Label: { UserLocalizedLabel: { Label: l } } })) });

/** A stateful fake. Tables are added with addTable(); POSTs change the state, so a second run sees what the first created. */
function fakeEnv(o = {}) {
  const env = { solutions: o.solutions ?? [{ solutionid: 'sol-1', ismanaged: false }], counts: { contracts: 11, matrix: 110, assignments: 5, steps: 0, ...(o.counts || {}) }, tables: {}, log: [], keySeq: o.keySeq ?? ['Pending', 'InProgress', 'Active'], keyReads: 0, failPostAt: o.failPostAt, posts: 0 };
  const sets = (l) => `${l}s`;
  const addTable = (t, { skip = [], drift = {} } = {}) => {
    const st = { md: { LogicalName: t.logical, OwnershipType: t.ownership, HasNotes: false, HasActivities: false, IsAuditEnabled: { Value: t.audit }, EntitySetName: sets(t.logical) }, attrs: new Map(), picklists: new Map(), rels: [], keys: [], rows: 0 };
    st.attrs.set('mwf_name', { LogicalName: 'mwf_name', AttributeType: 'String', RequiredLevel: { Value: 'ApplicationRequired' }, IsAuditEnabled: { Value: t.audit } });
    for (const c of COLUMNS.filter((x) => x.table === t.logical && !skip.includes(x.logical))) {
      st.attrs.set(c.logical, { LogicalName: c.logical, AttributeType: TYPE[c.kind], RequiredLevel: { Value: c.required }, IsAuditEnabled: { Value: c.audit } });
      if (c.kind === 'picklist') st.picklists.set(c.logical, { DefaultFormValue: c.defaultValue, OptionSet: opts(c.options) });
      if (c.kind === 'lookup') st.rels.push({ ReferencingAttribute: c.logical, ReferencedEntity: c.referenced, CascadeConfiguration: { Delete: c.delete, Assign: 'NoCascade', Share: 'NoCascade', Reparent: 'NoCascade' } });
    }
    drift.apply?.(st);
    env.tables[t.logical] = st; return st;
  };
  const ok = (j) => ({ ok: true, status: 200, j, text: '' });
  const nf = { ok: false, status: 404, j: null, text: '' };
  env.call = async (method, path, body, headers = {}) => {
    env.log.push({ method, path, body, headers });
    if (method === 'POST') {
      env.posts++;
      if (env.failPostAt === env.posts) return { ok: false, status: 400, j: { error: { message: 'boom' } }, text: '' };
      if (path === 'EntityDefinitions') {
        const t = Object.values(TABLES).find((x) => x.schema === body.SchemaName); const st = addTable({ ...t }, { skip: COLUMNS.filter((c) => c.table === t.logical).map((c) => c.logical) });
        st.md.OwnershipType = body.OwnershipType; st.md.IsAuditEnabled = body.IsAuditEnabled; st.attrs.get('mwf_name').IsAuditEnabled = body.Attributes[0].IsAuditEnabled;
        return { ok: true, status: 204, j: null, text: '' };
      }
      let m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes$/.exec(path);
      if (m) {
        const st = env.tables[m[1]];
        st.attrs.set(body.LogicalName, { LogicalName: body.LogicalName, AttributeType: ODATA_TYPE[body['@odata.type']], RequiredLevel: body.RequiredLevel, IsAuditEnabled: body.IsAuditEnabled });
        if (body.OptionSet) st.picklists.set(body.LogicalName, { DefaultFormValue: body.DefaultFormValue, OptionSet: opts(Object.fromEntries(body.OptionSet.Options.map((x) => [lbl(x.Label), x.Value]))) });
        return { ok: true, status: 204, j: null, text: '' };
      }
      if (path === 'RelationshipDefinitions') {
        const st = env.tables[body.ReferencingEntity]; const lg = body.Lookup.SchemaName.toLowerCase();
        st.attrs.set(lg, { LogicalName: lg, AttributeType: 'Lookup', RequiredLevel: body.Lookup.RequiredLevel, IsAuditEnabled: body.Lookup.IsAuditEnabled });
        st.rels.push({ ReferencingAttribute: lg, ReferencedEntity: body.ReferencedEntity, CascadeConfiguration: body.CascadeConfiguration });
        return { ok: true, status: 204, j: null, text: '' };
      }
      m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Keys$/.exec(path);
      if (m) { env.tables[m[1]].keys.push({ SchemaName: body.SchemaName, KeyAttributes: body.KeyAttributes, seq: [...env.keySeq] }); return { ok: true, status: 204, j: null, text: '' }; }
      throw new Error(`unexpected POST ${path}`);
    }
    if (method !== 'GET') throw new Error(`unexpected ${method} ${path}`);
    if (path.startsWith('solutions?')) return ok({ value: env.solutions });
    const cnt = (n) => ok({ '@odata.count': n });
    if (path.startsWith('mwf_contracts?')) return cnt(env.counts.contracts);
    if (path.startsWith('mwf_approvalmatrixes?')) return cnt(env.counts.matrix);
    if (path.startsWith('mwf_approverassignments?')) return cnt(env.counts.assignments);
    if (path.startsWith('mwf_approvalsteps?')) return cnt(env.counts.steps);
    for (const [l, st] of Object.entries(env.tables)) if (path.startsWith(`${sets(l)}?`)) return cnt(st.rows);
    let m = /^EntityDefinitions\(LogicalName='([^']+)'\)(.*)$/.exec(path);
    if (!m) throw new Error(`unexpected GET ${path}`);
    const st = env.tables[m[1]]; const rest = m[2];
    if (!st) return nf;
    if (rest.startsWith('?')) return ok({ ...st.md });
    if (rest.startsWith('/Attributes?')) return ok({ value: [...st.attrs.values()] });
    m = /^\/Attributes\(LogicalName='([^']+)'\)\/Microsoft\.Dynamics\.CRM\.PicklistAttributeMetadata\?/.exec(rest);
    if (m) { const p = st.picklists.get(m[1]); return p ? ok({ LogicalName: m[1], ...p }) : nf; }
    if (rest.startsWith('/ManyToOneRelationships?')) return ok({ value: st.rels });
    if (rest.startsWith('/Keys?')) { env.keyReads++; return ok({ value: st.keys.map((k) => ({ SchemaName: k.SchemaName, KeyAttributes: k.KeyAttributes, EntityKeyIndexStatus: k.seq.length > 1 ? k.seq.shift() : k.seq[0] })) }); }
    throw new Error(`unexpected GET ${path}`);
  };
  env.addTable = addTable;
  env.addAll = (extra) => { for (const t of Object.values(TABLES)) addTable(t, extra?.[t.logical]); };
  env.posts_ = () => env.log.filter((c) => c.method === 'POST');
  env.writes = () => env.posts_().length;
  return env;
}
const go = (env, stage = 'tables', extra = {}) => { const gateCalls = { n: 0 }; const p = runApply({ call: env.call, stage, solution: SOL, expectContracts: 11, gate: async () => { gateCalls.n++; if (extra.gateFails) throw new Error('connection unstable (mock)'); }, ...extra }); return p.then((r) => ({ ...r, gateCalls })); };
const postsOf = (env) => env.posts_().map((c) => `${c.path.replace(/EntityDefinitions\(LogicalName='([^']+)'\)\//, '$1/')}${c.body?.LogicalName ? `:${c.body.LogicalName}` : c.body?.SchemaName ? `:${c.body.SchemaName}` : ''}`);

// ---------------------------------------------------------------------------------------------------------------- 1. solution membership
test('1: every POST carries the solution header with the NAMED parameter (table, columns, lookup and key), and nothing else is ever sent', async () => {
  const env = fakeEnv(); const a = await go(env, 'tables'); assert.equal(a.ok, true, JSON.stringify(a)); const b = await go(env, 'key'); assert.equal(b.ok, true, JSON.stringify(b));
  const posts = env.posts_(); assert.equal(posts.length, 2 + COLUMNS.length + KEYS.length);
  for (const p of posts) assert.equal(p.headers[SOLUTION_HEADER], SOL, p.path);
  assert.deepEqual([...new Set(env.log.map((c) => c.method))].sort(), ['GET', 'POST']);
  const other = fakeEnv(); await runApply({ call: other.call, stage: 'tables', solution: 'OtherName', expectContracts: 11 });
  assert.ok(other.posts_().every((p) => p.headers[SOLUTION_HEADER] === 'OtherName'));   // the value comes from the parameter
});

test('1: there is no default solution name: apply, plan and verify say so, and the source has no solution literal', () => {
  assert.doesNotMatch(strip(SRC_SCRIPT), /\|\|\s*'Muwafaqa'|'Muwafaqa'/);
  assert.doesNotMatch(strip(SRC_LIB), /'Muwafaqa'/);
  assert.ok(applyPreflight({ confirm: true, auth: 'az', stage: 'tables', solution: undefined }).some((x) => /solution/.test(x) && /no default/.test(x)));
  assert.ok(applyPreflight({ confirm: true, auth: 'az', stage: 'tables', solution: 'a b;c' }).some((x) => /valid solution unique name/.test(x)));
  assert.throws(() => guardedCall(async () => ({}), ''), /solution unique name is required/);
  const v = run('--mode=verify', '--env=https://example.invalid'); assert.equal(v.status, 2); assert.match(v.stderr, /--solution/);
});

test('1: the dry-run prints the solution name given (and says when none was given)', () => {
  const p = run('--stage=tables', `--solution=${SOL}`); assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, new RegExp(`Solution: ${SOL}\\.`)); assert.match(p.stdout, /MSCRM\.SolutionUniqueName/);
  assert.match(run('--stage=key').stdout, /Solution: NOT GIVEN/);
});

// ---------------------------------------------------------------------------------------------------------------- 2. resumability and drift
test('2: a fresh environment: stage tables creates both tables, the 4 + 1 columns and the lookup in order and NO key', async () => {
  const env = fakeEnv(); const r = await go(env, 'tables');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(postsOf(env), ['EntityDefinitions:mwf_Obligation', 'RelationshipDefinitions:mwf_contract_obligation', 'mwf_obligation/Attributes:mwf_party', 'mwf_obligation/Attributes:mwf_duedate', 'mwf_obligation/Attributes:mwf_status',
    'EntityDefinitions:mwf_AlertLog', 'mwf_alertlog/Attributes:mwf_alertkey']);
  assert.ok(!env.log.some((c) => /\/Keys$/.test(c.path)));
});

test('2: PARTIAL state (obligation exists with the lookup and the party only; alert log missing): a re-run creates ONLY what is missing, no POST for an existing object', async () => {
  const env = fakeEnv(); env.addTable(TABLES.obligation, { skip: ['mwf_duedate', 'mwf_status'] });
  const r = await go(env, 'tables');
  assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual(r.drift, []);
  assert.deepEqual(postsOf(env), ['mwf_obligation/Attributes:mwf_duedate', 'mwf_obligation/Attributes:mwf_status', 'EntityDefinitions:mwf_AlertLog', 'mwf_alertlog/Attributes:mwf_alertkey']);
  assert.ok(r.skipped.includes('table mwf_obligation') && r.skipped.includes('lookup mwf_obligation.mwf_contract') && r.skipped.includes('picklist mwf_obligation.mwf_party'));
});

test('2: a failure in the middle (the 3rd POST is rejected) stops the run; the next run creates exactly the rest, nothing twice', async () => {
  const env = fakeEnv({ failPostAt: 3 }); const a = await go(env, 'tables');
  assert.equal(a.ok, false); assert.match(a.stopped, /answered HTTP 400/); assert.equal(env.writes(), 3);   // not retried
  const firstRun = env.writes(); env.failPostAt = undefined;
  const b = await go(env, 'tables'); assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual(postsOf(env).slice(firstRun), ['mwf_obligation/Attributes:mwf_party', 'mwf_obligation/Attributes:mwf_duedate', 'mwf_obligation/Attributes:mwf_status', 'EntityDefinitions:mwf_AlertLog', 'mwf_alertlog/Attributes:mwf_alertkey']);
  assert.equal((await go(env, 'tables')).created.length, 0);   // and a third run creates nothing
});

test('2: a second run on a complete state sends no POST at all', async () => {
  const env = fakeEnv(); env.addAll(); const r = await go(env, 'tables');
  assert.equal(r.ok, true); assert.equal(env.writes(), 0); assert.equal(r.created.length, 0); assert.equal(r.skipped.length, 2 + COLUMNS.length);
});

test('2: DRIFT is reported and never overwritten: wrong table audit, ownership, column type, required level, audit flag, option set, default value, lookup cascade', async () => {
  const env = fakeEnv(); env.addAll({
    mwf_obligation: { skip: [], drift: { apply: (st) => {
      st.md.IsAuditEnabled = { Value: false };                                            // table audit
      st.attrs.get('mwf_duedate').AttributeType = 'String';                               // type
      st.attrs.get('mwf_party').RequiredLevel = { Value: 'None' };                        // required level
      st.attrs.get('mwf_status').IsAuditEnabled = { Value: false };                       // column audit
      st.picklists.get('mwf_status').DefaultFormValue = 867640002;                        // default
      st.picklists.get('mwf_party').OptionSet = opts({ 'First Party': 867640000 });       // options
      st.rels[0].CascadeConfiguration.Delete = 'RemoveLink';                              // cascade
    } } },
    mwf_alertlog: { drift: { apply: (st) => { st.md.OwnershipType = 'UserOwned'; } } },
  });
  const before = JSON.stringify([...env.tables.mwf_obligation.attrs]);
  const r = await go(env, 'tables');
  assert.equal(r.ok, false); assert.equal(r.stopped, null);   // reported, not a stop
  const d = r.drift.join('\n');
  for (const needle of ['table audit ON', 'mwf_duedate', 'mwf_party', 'mwf_status', 'default value', 'exactly 2 values', 'delete Cascade', 'ownership OrganizationOwned']) assert.match(d, new RegExp(needle.replace(/ /g, '\\s')), needle);
  assert.equal(env.writes(), 0);   // nothing is created, nothing is overwritten
  assert.equal(JSON.stringify([...env.tables.mwf_obligation.attrs]), before);
  assert.ok(!env.log.some((c) => ['PUT', 'PATCH', 'DELETE'].includes(c.method)));
});

test('2: drift is reported AND the missing objects are still created (missing and drifted are independent)', async () => {
  const env = fakeEnv(); env.addTable(TABLES.obligation, { skip: ['mwf_status'], drift: { apply: (st) => { st.md.IsAuditEnabled = { Value: false }; } } });
  const r = await go(env, 'tables');
  assert.equal(r.ok, false); assert.ok(r.drift.length >= 1);
  assert.ok(postsOf(env).includes('mwf_obligation/Attributes:mwf_status'));
});

// ---------------------------------------------------------------------------------------------------------------- 3. gates
test('3: preflight refuses without --confirm-mutates-environment, without --auth=az (device and none), without --stage, with a wrong stage, without --solution', () => {
  const good = { confirm: true, auth: 'az', stage: 'tables', solution: SOL };
  assert.deepEqual(applyPreflight(good), []); assert.deepEqual(applyPreflight({ ...good, stage: 'key' }), []);
  assert.ok(applyPreflight({ ...good, confirm: false }).some((x) => /--confirm-mutates-environment/.test(x)));
  for (const auth of ['device', '', undefined]) assert.ok(applyPreflight({ ...good, auth }).some((x) => /--auth=az is required/.test(x)), String(auth));
  for (const stage of ['', undefined, 'all', 'both']) assert.ok(applyPreflight({ ...good, stage }).some((x) => /--stage/.test(x)), String(stage));
  assert.ok(applyPreflight({ ...good, solution: '' }).length >= 1);
  assert.deepEqual([...STAGES], ['tables', 'key']);
});

test('3: the script refuses with exit 2 BEFORE any sign-in for each missing gate', () => {
  const base = ['--mode=apply', '--env=https://example.invalid'];
  const noConfirm = run(...base, '--auth=az', '--stage=tables', `--solution=${SOL}`); assert.equal(noConfirm.status, 2); assert.match(noConfirm.stderr, /--confirm-mutates-environment is missing/); assert.match(noConfirm.stderr, /Nothing was run/);
  const noAz = run(...base, '--auth=device', '--stage=tables', `--solution=${SOL}`, '--confirm-mutates-environment'); assert.equal(noAz.status, 2); assert.match(noAz.stderr, /--auth=az is required/);
  const noAuth = run(...base, '--stage=tables', `--solution=${SOL}`, '--confirm-mutates-environment'); assert.equal(noAuth.status, 2); assert.match(noAuth.stderr, /--auth=az is required/);
  const noStage = run(...base, '--auth=az', `--solution=${SOL}`, '--confirm-mutates-environment'); assert.equal(noStage.status, 2); assert.match(noStage.stderr, /--stage/);
  const noSol = run(...base, '--auth=az', '--stage=key', '--confirm-mutates-environment'); assert.equal(noSol.status, 2); assert.match(noSol.stderr, /--solution/);
  assert.equal(run('--mode=apply', '--stage=nonsense').status, 2);
});

test('3: the connection gate and the baseline run BEFORE the first write; the gate runs again before EVERY write', async () => {
  const env = fakeEnv(); let firstWriteAt = -1; const order = []; const call = async (m, p, b, h) => { if (m === 'POST' && firstWriteAt < 0) firstWriteAt = order.length; order.push(`${m} ${p}`); return env.call(m, p, b, h); };
  let gates = 0; const gate = async () => { gates++; order.push('GATE'); };
  const r = await runApply({ call, stage: 'tables', solution: SOL, expectContracts: 11, gate }); assert.equal(r.ok, true);
  assert.equal(order[0], 'GATE');
  const pre = order.slice(0, firstWriteAt);
  assert.ok(pre.some((x) => /^GET solutions/.test(x)), 'solution checked before the first write');
  for (const set of ['mwf_contracts', 'mwf_approvalmatrixes', 'mwf_approverassignments', 'mwf_approvalsteps']) assert.ok(pre.some((x) => x.startsWith(`GET ${set}?`)), `${set} counted before the first write`);
  assert.ok(pre.some((x) => /EntityDefinitions\(LogicalName='mwf_obligation'\)\?\$select=EntitySetName/.test(x)), 'the ADR-011 tables are looked at before the first write');
  order.forEach((x, i) => { if (/^POST /.test(x)) assert.equal(order[i - 1], 'GATE', `gate before ${x}`); });
  assert.equal(gates, 1 + env.writes());
});

test('3: a failing connection gate writes nothing (and reads nothing)', async () => {
  const env = fakeEnv(); const r = await go(env, 'tables', { gateFails: true });
  assert.equal(r.ok, false); assert.match(r.stopped, /connection unstable/); assert.equal(env.writes(), 0); assert.equal(env.log.length, 0);
});

test('3: a baseline that is not clean writes nothing: 12 contracts, 109 matrix rows, 4 assignments, 1 step, rows in an ADR-011 table', async () => {
  for (const counts of [{ contracts: 12 }, { matrix: 109 }, { assignments: 4 }, { steps: 1 }]) {
    const env = fakeEnv({ counts }); const r = await go(env, 'tables');
    assert.equal(r.ok, false, JSON.stringify(counts)); assert.match(r.stopped, /baseline is not clean/); assert.equal(env.writes(), 0);
  }
  const env = fakeEnv(); env.addAll(); env.tables.mwf_alertlog.rows = 2;
  const r = await go(env, 'tables'); assert.match(r.stopped, /baseline is not clean/); assert.equal(env.writes(), 0);
  const e2 = fakeEnv(); const r2 = await runApply({ call: e2.call, stage: 'tables', solution: SOL, expectContracts: 12 }); assert.match(r2.stopped, /baseline/); assert.equal(e2.writes(), 0);   // the expected contract count is a parameter
});

test('3: a missing or managed solution, or two of them, writes nothing', async () => {
  for (const solutions of [[], [{ solutionid: 's', ismanaged: true }], [{ solutionid: 'a', ismanaged: false }, { solutionid: 'b', ismanaged: false }]]) {
    const env = fakeEnv({ solutions }); const r = await go(env, 'tables'); assert.match(r.stopped, /expected exactly 1 unmanaged solution/); assert.equal(env.writes(), 0);
  }
});

test('3: guardedCall: DELETE, PUT, PATCH and any POST outside the creation endpoints of the two tables are refused before anything is sent', async () => {
  const sent = []; const g = guardedCall(async (m, p) => { sent.push(`${m} ${p}`); return { ok: true, status: 200, j: {} }; }, SOL);
  for (const m of ['DELETE', 'PUT', 'PATCH', 'MERGE', 'HEAD']) await assert.rejects(() => g(m, "EntityDefinitions(LogicalName='mwf_alertlog')"), /not available to the apply code/, m);
  for (const p of ['mwf_contracts', 'workflows', "EntityDefinitions(LogicalName='mwf_contract')/Attributes", "EntityDefinitions(LogicalName='mwf_approvalstep')/Keys", 'PublishXml', 'AddPrivilegesRole']) await assert.rejects(() => g('POST', p, {}), /not a creation endpoint/, p);
  assert.deepEqual(sent, []);
  await g('GET', 'solutions'); await g('POST', "EntityDefinitions(LogicalName='mwf_alertlog')/Keys", {}); await g('POST', 'RelationshipDefinitions', {});
  assert.equal(sent.length, 3);
});

test('3: the source holds no delete operation of any kind, no PUT and no PATCH, no role or privilege, and does not start the uniqueness test', () => {
  for (const code of [strip(SRC_SCRIPT), strip(SRC_LIB)]) {
    assert.doesNotMatch(code, /'DELETE'|"DELETE"|\.del\(|method:\s*'DELETE'|deleteContract|DeleteEntityKey|DeleteAttribute/i);
    assert.doesNotMatch(code, /'(PUT|PATCH)'/);
    assert.doesNotMatch(code, /roleprivilege|AddPrivilegesRole|systemuserroles/i);
    assert.doesNotMatch(code, /ReactivateEntityKey\s*['"`(]/);   // named in a message only, never called
    assert.doesNotMatch(code, /test-alertlog-uniqueness|alertlog-uniqueness\.mjs|spawn|execSync|child_process/);
  }
  assert.match(SRC_SCRIPT, /NOT RUN against any environment/);
});

// ---------------------------------------------------------------------------------------------------------------- 4. stages
test('4: stage tables never creates the key; stage key never creates a table or a column', async () => {
  const a = fakeEnv(); await go(a, 'tables'); assert.ok(!a.log.some((c) => /\/Keys$/.test(c.path) && c.method === 'POST'));
  const b = fakeEnv(); b.addAll(); const r = await go(b, 'key'); assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(postsOf(b), ['mwf_alertlog/Keys:mwf_AlertLogKey']);
});

test('4: stage key stops (no write) when a table or the key column is missing: run stage tables first', async () => {
  const none = fakeEnv(); const r1 = await go(none, 'key'); assert.match(r1.stopped, /run --stage=tables first/); assert.equal(none.writes(), 0);
  const noCol = fakeEnv(); noCol.addTable(TABLES.alertlog, { skip: ['mwf_alertkey'] }); const r2 = await go(noCol, 'key'); assert.match(r2.stopped, /mwf_alertkey does not exist as a String/); assert.equal(noCol.writes(), 0);
});

test('4: the key poll goes Pending, InProgress, Active and ends ok; EntityKeyIndexStatus is the property read', async () => {
  const env = fakeEnv(); env.addAll(); const slept = []; const lines = [];
  const r = await go(env, 'key', { sleep: async (ms) => slept.push(ms), log: (l) => lines.push(l), pollSeconds: 7 });
  assert.equal(r.ok, true); assert.equal(r.keyStatus, 'Active'); assert.equal(r.polls, 3);
  assert.deepEqual(slept, [7000, 7000]);
  assert.deepEqual(lines.filter((l) => /^POLL/.test(l)).map((l) => /= (\w+)/.exec(l)[1]), ['Pending', 'InProgress', 'Active']);
  assert.ok(env.log.filter((c) => /\/Keys\?/.test(c.path)).every((c) => /EntityKeyIndexStatus/.test(c.path)));
});

test('4: Failed stops the poll at once, is reported, and the key is not reactivated, retried or deleted', async () => {
  const env = fakeEnv({ keySeq: ['Pending', 'Failed', 'Active'] }); env.addAll(); const r = await go(env, 'key');
  assert.equal(r.ok, false); assert.equal(r.keyStatus, 'Failed'); assert.match(r.stopped, /Failed/); assert.match(r.stopped, /Not retried, not reactivated/);
  assert.equal(r.polls, 2); assert.equal(env.writes(), 1);   // only the creation of the key
});

test('4: the poll is BOUNDED: 300 s at 5 s is at most 60 polls, 10 s at 5 s is 2; a key that never gets Active ends as a stop, not a hang', async () => {
  const env = fakeEnv({ keySeq: ['Pending'] }); env.addAll(); const r = await go(env, 'key', { pollSeconds: 5, maxWaitSeconds: 10 });
  assert.equal(r.ok, false); assert.equal(r.polls, 2); assert.match(r.stopped, /is Pending after 2 poll/); assert.match(r.stopped, /Rerun --stage=key later/);
  const e2 = fakeEnv({ keySeq: ['InProgress'] }); e2.addAll(); const r2 = await go(e2, 'key'); assert.equal(r2.polls, 60);
});

test('4: an existing key is not created again; an Active one passes at once; an existing key on other columns is DRIFT and stops (it is not changed or deleted)', async () => {
  const a = fakeEnv(); a.addAll(); a.tables.mwf_alertlog.keys.push({ SchemaName: 'mwf_AlertLogKey', KeyAttributes: ['mwf_alertkey'], seq: ['Active'] });
  const ra = await go(a, 'key'); assert.equal(ra.ok, true); assert.equal(a.writes(), 0); assert.equal(ra.polls, 1);
  const b = fakeEnv(); b.addAll(); b.tables.mwf_alertlog.keys.push({ SchemaName: 'mwf_AlertLogKey', KeyAttributes: ['mwf_name'], seq: ['Active'] });
  const rb = await go(b, 'key'); assert.equal(rb.ok, false); assert.equal(rb.drift.length, 1); assert.match(rb.stopped, /not changed or deleted/); assert.equal(b.writes(), 0);
});

test('4: the plan for each stage lists only that stage, and the key stage says the uniqueness test is never started', () => {
  const t = run('--stage=tables', `--solution=${SOL}`).stdout; const k = run('--stage=key', `--solution=${SOL}`).stdout;
  assert.match(t, /TABLE mwf_obligation/); assert.match(t, /COLUMN mwf_alertlog\.mwf_alertkey/); assert.doesNotMatch(t, /\n  KEY mwf_AlertLogKey/);
  assert.match(k, /KEY mwf_AlertLogKey/); assert.doesNotMatch(k, /TABLE mwf_obligation|COLUMN /);
  assert.match(k, /uniqueness test is never started/); assert.match(k, /EntityKeyIndexStatus: Pending, InProgress, Active, Failed/);
});

// ---------------------------------------------------------------------------------------------------------------- helpers
test('baselineVerdict: the existing counts (11 / 110 / 5 / 0) pass; ADR-011 tables absent are observations; any other count fails', async () => {
  const env = fakeEnv(); const c = await readBaselineCounts(env.call);
  const v = baselineVerdict(c, 11); assert.equal(v.ok, true); assert.deepEqual(v.lines.slice(-2).map((l) => l.status), ['OBS', 'OBS']);
  assert.equal(baselineVerdict({ ...c, contracts: 10 }, 11).ok, false);
  assert.equal(baselineVerdict(c, 12).ok, false);
  env.addAll(); assert.deepEqual(baselineVerdict(await readBaselineCounts(env.call), 11).lines.slice(-2).map((l) => l.status), ['PASS', 'PASS']);
});
