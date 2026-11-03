// Tests of `create` and `verify` of the obligation alerts generator against a MOCKED, stateful environment. NOTHING here talks to an environment; neither mode has been run for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPreflight, guardedCall, jsonPaths, requestPaths, dryRunLines, runCreate, runVerify, EXPECTED_FLOWS } from './obligation-flow-deploy.mjs';
import { FLOW_NAME, SOLUTION_HEADER, createBody, buildClientdata, testVariant, productionVariant, statsOf, FLOW_DESCRIPTION } from '../build-flow-obligation-alerts.mjs';
import { DEFAULT_OUTLOOK_REF, DEFAULT_DATAVERSE_REF } from '../build-flow-reminders.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const SCRIPT = here('../build-flow-obligation-alerts.mjs');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const LIB_CODE = strip(fs.readFileSync(here('./obligation-flow-deploy.mjs'), 'utf8'));
const GEN_CODE = strip(fs.readFileSync(SCRIPT, 'utf8'));
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', timeout: 30000 });
const SOL = 'TestSolution';
const HOST = 'org-test.invalid';   // a fictitious host for the mock, never a real one
const gid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** A stateful fake of the parts of the environment that create and verify read. A POST to `workflows` creates a Draft row (statecode 0) and, with the solution header, a solution component. */
function fakeEnv(o = {}) {
  const env = { log: [], t: Date.UTC(2027, 5, 15, 12, 0, 0), flows: o.flows ?? [
    { workflowid: gid(1), name: 'Search Dynamics 365 knowledge articles', statecode: 0, statuscode: 1, category: 5, modifiedon: '2027-01-01T00:00:00Z' },
    { workflowid: gid(2), name: 'Muwafaqa - Contract Approval v2', statecode: 0, statuscode: 1, category: 5, modifiedon: '2027-01-02T00:00:00Z' },
    { workflowid: gid(3), name: 'Muwafaqa - Approval Reminders', statecode: 0, statuscode: 1, category: 5, modifiedon: '2027-01-03T00:00:00Z' },
    { workflowid: gid(4), name: 'Integrated Search API trigger flow', statecode: 0, statuscode: 1, category: 5, modifiedon: '2027-01-04T00:00:00Z' },
    { workflowid: gid(5), name: 'SLAInstanceMonitoringWarningAndExpiry', statecode: 0, statuscode: 1, category: 5, modifiedon: '2027-01-05T00:00:00Z' }],
    solutions: o.solutions ?? [{ solutionid: gid(50), ismanaged: false }],
    refs: o.refs ?? [
      { connectionreferenceid: gid(60), connectionreferencelogicalname: DEFAULT_DATAVERSE_REF, connectorid: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps', connectionid: 'c1' },
      { connectionreferenceid: gid(61), connectionreferencelogicalname: DEFAULT_OUTLOOK_REF, connectorid: '/providers/Microsoft.PowerApps/apis/shared_office365', connectionid: 'c2' }],
    components: o.components ?? new Set([gid(60), gid(61)]),
    counts: { contracts: 11, matrix: 110, assignments: 5, steps: 0, ...(o.counts || {}) },
    tables: o.tables ?? { mwf_obligation: 0, mwf_alertlog: 0 }, counters: o.counters ?? [0, 0, 0, 0, 0], failPost: o.failPost, throwPost: o.throwPost, normalize: o.normalize, ...o.extra };
  const ok = (j, status = 200) => ({ ok: true, status, j, text: '' });
  env.call = async (method, path, body, headers = {}) => {
    env.log.push({ method, path, body, headers });
    const p = decodeURIComponent(path);
    if (method === 'POST') {
      if (env.throwPost) throw new Error('fetch failed (mock)');
      if (env.failPost) return { ok: false, status: 400, j: { error: { message: 'bad (mock)' } }, text: '' };
      const id = gid(900 + env.flows.length); const stored = env.normalize ? env.normalize(body.clientdata) : body.clientdata;
      env.flows.push({ workflowid: id, name: body.name, statecode: o.createdOn ? 1 : 0, statuscode: 1, category: body.category, modifiedon: iso(env.t), clientdata: stored });
      if (headers[SOLUTION_HEADER] === SOL && !o.notInSolution) env.components.add(id);
      return { ok: true, status: 204, j: null, text: '', id };
    }
    if (method !== 'GET') throw new Error(`unexpected ${method} ${path}`);
    if (path.startsWith('solutions?')) return ok({ value: env.solutions });
    if (path.startsWith('workflows?')) { const m = /name eq '([^']+)'/.exec(p); const rows = m ? env.flows.filter((f) => f.name === m[1]) : env.flows; return ok({ value: rows.map((f) => ({ ...f })) }); }
    if (path.startsWith('solutioncomponents?')) { const obj = /objectid eq ([0-9a-f-]{36})/.exec(p); if (obj) return ok({ value: env.components.has(obj[1]) ? [{ componenttype: 29 }] : [] }); return ok({ value: [...env.components].map((objectid) => ({ objectid })) }); }
    if (path.startsWith('connectionreferences?')) return ok({ value: env.refs });
    if (path === 'WhoAmI') return ok({ UserId: gid(9) });
    if (path.startsWith("EntityDefinitions(LogicalName='mwf_obligation')") || path.startsWith("EntityDefinitions(LogicalName='mwf_alertlog')")) { const t = path.includes('mwf_obligation') ? 'mwf_obligation' : 'mwf_alertlog'; return env.tables[t] === undefined ? { ok: false, status: 404, j: null, text: '' } : ok({ EntitySetName: `${t}s` }); }
    if (path.startsWith('mwf_obligations?')) return ok({ '@odata.count': env.tables.mwf_obligation });
    if (path.startsWith('mwf_alertlogs?')) return ok({ '@odata.count': env.tables.mwf_alertlog });
    if (path.startsWith('mwf_contracts?')) return ok({ '@odata.count': env.counts.contracts });
    if (path.startsWith('mwf_approvalmatrixes?')) return ok({ '@odata.count': env.counts.matrix });
    if (path.startsWith('mwf_approverassignments?')) return ok({ '@odata.count': env.counts.assignments });
    if (path.startsWith('mwf_approvalsteps?')) return ok({ '@odata.count': env.counts.steps });
    if (path.startsWith("EntityDefinitions(LogicalName='mwf_contractnumbercounter')")) return ok({ EntitySetName: 'mwf_contractnumbercounters' });
    if (path.startsWith('mwf_contractnumbercounters?')) return ok({ value: env.counters.map((last, i) => ({ mwf_contractnumbercounterid: gid(80 + i), mwf_contracttypevalue: 867640000 + i, mwf_prefix: `P${i}`, mwf_lastnumber: last })) });
    throw new Error(`unexpected GET ${path}`);
  };
  env.out = []; env.opts = (extra = {}) => ({ call: env.call, solution: SOL, host: HOST, log: (l) => env.out.push(l), ...extra });
  env.text = () => env.out.join('\n'); env.writes = () => env.log.filter((c) => c.method !== 'GET'); env.posts = () => env.log.filter((c) => c.method === 'POST');
  return env;
}

// ---------------------------------------------------------------------------------------------------------------- guards
test('createPreflight: the test variant only, and a solution name with no default', () => {
  assert.deepEqual(createPreflight({ variant: 'test', solution: SOL }), []);
  assert.ok(createPreflight({ variant: 'production', solution: SOL }).some((x) => /test variant only/.test(x) && /production variant is refused/.test(x)));
  assert.ok(createPreflight({ variant: 'both', solution: SOL }).length >= 1); assert.ok(createPreflight({ variant: undefined, solution: SOL }).length >= 1);
  assert.ok(createPreflight({ variant: 'test', solution: '' }).some((x) => /no default/.test(x))); assert.ok(createPreflight({ variant: 'test', solution: 'a b;c' }).some((x) => /valid solution unique name/.test(x)));
});

test('guardedCall: GET passes; PUT, PATCH, DELETE and any other verb throw before anything is sent; the one POST must be this flow\'s row, carries the solution header, and is sent at most once', async () => {
  const sent = []; const g = guardedCall(async (m, p, b, h) => { sent.push({ m, p, h }); return { ok: true, status: 204, j: null }; }, SOL);
  for (const m of ['PUT', 'PATCH', 'DELETE', 'MERGE', 'HEAD']) await assert.rejects(() => g(m, 'workflows(x)', {}), /only GET and the ONE POST/, m);
  for (const [p, b] of [['mwf_alertlogs', { name: FLOW_NAME, category: 5 }], ['workflows', { name: 'Another flow', category: 5 }], ['workflows', { name: FLOW_NAME, category: 6 }], ['workflows', undefined], ['workflows(abc)/Microsoft.Dynamics.CRM.SetState', { name: FLOW_NAME, category: 5 }]]) await assert.rejects(() => g('POST', p, b), /only POST is the creation/, p);
  assert.deepEqual(sent, []);
  await g('GET', 'solutions'); await g('POST', 'workflows', { name: FLOW_NAME, category: 5 });
  assert.equal(sent.length, 2); assert.equal(sent[1].h[SOLUTION_HEADER], SOL);
  await assert.rejects(() => g('POST', 'workflows', { name: FLOW_NAME, category: 5 }), /at most once/);
  assert.throws(() => guardedCall(async () => ({}), ''), /solution unique name is required/);
});

test('the request body carries NO state (no statecode, no statuscode): the new row is a Draft, OFF; exactly the keys of the reminders flow\'s creation', () => {
  const b = createBody('{"x":1}');
  assert.deepEqual(Object.keys(b).sort(), ['category', 'clientdata', 'description', 'name', 'primaryentity', 'type']);
  assert.deepEqual([b.name, b.category, b.type, b.primaryentity, b.description], [FLOW_NAME, 5, 1, 'none', FLOW_DESCRIPTION]);
  assert.doesNotMatch(JSON.stringify(b), /statecode|statuscode/);
});

// ---------------------------------------------------------------------------------------------------------------- dry run
test('jsonPaths: leaf paths with array indexes; an empty object or array is a path of its own; requestPaths expands the clientdata string', () => {
  assert.deepEqual(jsonPaths({ a: { b: [1, { c: 2 }] }, d: 'x', e: {}, f: [] }), ['a.b[0]', 'a.b[1].c', 'd', 'e{}', 'f[]']);
  const body = createBody(JSON.stringify({ properties: { x: 1 } }));
  assert.ok(requestPaths(body).includes('clientdata.properties.x')); assert.ok(requestPaths(body).includes('name'));
});

test('the dry run prints the flow name, the solution header value, the state requested, both references, the REAL action count and depth, and the exact list of JSON paths; it sends nothing', () => {
  const t = dryRunLines({ solution: SOL }).join('\n'); const s = statsOf(buildClientdata(testVariant()));
  for (const n of [FLOW_NAME, `${SOLUTION_HEADER}: ${SOL}`, 'STATE     OFF: the body carries no state', `connection reference ${DEFAULT_DATAVERSE_REF}`, `connection reference ${DEFAULT_OUTLOOK_REF}`, `${s.actions} actions, nesting depth ${s.depth}`, 'it never creates a reference', 'NEVER     PUT, PATCH, DELETE']) assert.ok(t.includes(n), n);
  assert.match(t, /\d+ leaf paths; the clientdata string is expanded/);
  const listed = dryRunLines({ solution: SOL }).filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim());
  const body = createBody(JSON.stringify(buildClientdata(testVariant(), { outlookRef: DEFAULT_OUTLOOK_REF, dataverseRef: DEFAULT_DATAVERSE_REF })));
  assert.deepEqual(listed, requestPaths(body), 'the printed list is the list of the request');
  assert.ok(listed.includes('clientdata.properties.definition.triggers.Recurrence.recurrence.interval')); assert.ok(listed.includes('clientdata.properties.connectionReferences.shared_office365.connection.connectionReferenceLogicalName'));
  assert.doesNotMatch(t, /crm\d*\.dynamics\.com/); assert.doesNotMatch(t, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test('the dry run is OFFLINE: the command line prints it without --env or sign-in, with --solution; --dry-run wins over --confirm-mutates-environment', () => {
  const r = run('--mode=create', `--solution=${SOL}`); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^DRY RUN: nothing is sent/); assert.match(r.stdout, /Nothing was sent\./); assert.match(r.stdout, /The flow already exists \(created OFF on 2026-11-03\)/); assert.match(r.stdout, /stop at the guard 'no flow of this name exists'/);
  const both = run('--mode=create', `--solution=${SOL}`, '--confirm-mutates-environment', '--dry-run'); assert.equal(both.status, 0); assert.match(both.stdout, /^DRY RUN/);
});

test('the command line refuses before any sign-in (exit 2): production and both, no solution, a bad auth, a confirmed create without --auth=az, verify without a solution; replace does not exist', () => {
  for (const v of ['production', 'both']) { const r = run('--mode=create', `--solution=${SOL}`, `--variant=${v}`); assert.equal(r.status, 2, v); assert.match(r.stderr, /test variant only/); assert.match(r.stderr, /Nothing was run/); }
  const noSol = run('--mode=create'); assert.equal(noSol.status, 2); assert.match(noSol.stderr, /--solution=.* is required; there is no default/);
  assert.equal(run('--mode=create', '--solution=a b').status, 2);
  const noAz = run('--mode=create', `--solution=${SOL}`, '--confirm-mutates-environment', '--env=https://example.invalid'); assert.equal(noAz.status, 2); assert.match(noAz.stderr, /--auth=az is required/);
  assert.equal(run('--mode=create', `--solution=${SOL}`, '--confirm-mutates-environment', '--env=https://example.invalid', '--auth=device').status, 2);
  const vNoSol = run('--mode=verify', '--env=https://example.invalid', '--auth=az'); assert.equal(vNoSol.status, 2); assert.match(vNoSol.stderr, /no default/);
  assert.equal(run('--mode=verify', `--solution=${SOL}`, '--variant=production').status, 2);
  assert.equal(run('--mode=verify', `--solution=${SOL}`, '--env=https://example.invalid').status, 2);   // no --auth=az
  const rep = run('--mode=replace', `--solution=${SOL}`); assert.equal(rep.status, 2); assert.match(rep.stderr, /There is no replace mode/);
});

// ---------------------------------------------------------------------------------------------------------------- create
test('create on a clean mocked environment: ONE POST, only GET and that POST, the solution header, the flow OFF in the solution, both references bound and printed, every other flow unchanged', async () => {
  const env = fakeEnv(); const r = await runCreate(env.opts());
  assert.equal(r.ok, true, env.text()); assert.equal(r.failed, 0); assert.equal(r.posts, 1);
  assert.deepEqual([...new Set(env.log.map((c) => c.method))].sort(), ['GET', 'POST']);
  const post = env.posts()[0]; assert.equal(post.path, 'workflows'); assert.equal(post.headers[SOLUTION_HEADER], SOL); assert.deepEqual(Object.keys(post.body).sort(), ['category', 'clientdata', 'description', 'name', 'primaryentity', 'type']);
  assert.ok(!('statecode' in post.body) && !('statuscode' in post.body));
  const row = env.flows.find((f) => f.name === FLOW_NAME); assert.equal(row.statecode, 0); assert.ok(env.components.has(row.workflowid));
  assert.ok(!post.body.clientdata.includes('<ORG_HOST>') && post.body.clientdata.includes(HOST), 'the host replaced the placeholder in the request');
  const t = env.text();
  for (const n of [`binds: shared_commondataserviceforapps -> ${DEFAULT_DATAVERSE_REF}; shared_office365 -> ${DEFAULT_OUTLOOK_REF}`, 'POST accepted (one row)', 'the flow is OFF', 'NOT turned on', 'every other flow row is unchanged', 'contracts 11, active matrix rows 110, active assignments 5, approval steps 0', 'the contract-number counters are all 0']) assert.ok(t.includes(n) || t.includes(n.replace('the flow is OFF', 'OFF (statecode 0')), n);
  assert.ok(!t.includes(HOST), 'the host is never printed');
});

test('create never uses PUT, PATCH or DELETE and never turns a flow on: the code holds no such verb and no state change; a mocked environment records none', async () => {
  for (const code of [LIB_CODE, GEN_CODE]) { assert.doesNotMatch(code, /'(PUT|PATCH|DELETE)'/); assert.doesNotMatch(code, /statecode\s*:\s*1|SetState|PublishXml|turnOn\b|\bactivate\(|'statecode'/); }
  assert.equal((LIB_CODE.match(/'POST'/g) || []).length, 4, 'POST appears in the guard (twice), in the counter of posts and in the ONE call');
  assert.equal((LIB_CODE.match(/\bc\('POST'/g) || []).length, 1, 'exactly one call site of the POST');
  const env = fakeEnv(); await runCreate(env.opts()); assert.ok(env.writes().every((c) => c.method === 'POST' && c.path === 'workflows'));
});

test('create STOPS BEFORE the POST (zero writes) for each guard: a managed or missing solution, a flow ON, 4 or 6 existing flows, the flow already exists, contracts / matrix / assignments / steps off, a table absent or with rows, counters not 0', async () => {
  const flows = fakeEnv().flows;
  const cases = [
    ['no solution', { solutions: [] }, /expected exactly 1 unmanaged solution/], ['managed solution', { solutions: [{ solutionid: gid(50), ismanaged: true }] }, /unmanaged/],
    ['a flow ON', { flows: flows.map((f, i) => (i === 1 ? { ...f, statecode: 1 } : f)) }, /FAIL .*existing flows are all OFF/s], ['only four flows', { flows: flows.slice(0, 4) }, /FAIL .*existing flows are all OFF/s],
    ['six flows', { flows: [...flows, { ...flows[0], workflowid: gid(7), name: 'Extra' }] }, /FAIL .*existing flows are all OFF/s],
    ['the flow already exists', { flows: [...flows, { workflowid: gid(8), name: FLOW_NAME, statecode: 0, statuscode: 1, category: 5, modifiedon: iso(0) }] }, /already exists/],
    ['contracts 12', { counts: { contracts: 12 } }, /FAIL .*contracts 11/s], ['matrix 109', { counts: { matrix: 109 } }, /FAIL .*contracts 11/s], ['assignments 4', { counts: { assignments: 4 } }, /FAIL .*contracts 11/s], ['a step exists', { counts: { steps: 1 } }, /FAIL .*contracts 11/s],
    ['obligation table absent', { tables: { mwf_alertlog: 0 } }, /FAIL .*mwf_obligation exists and holds 0 rows.*absent/s], ['alert log table absent', { tables: { mwf_obligation: 0 } }, /FAIL .*mwf_alertlog exists and holds 0 rows/s],
    ['an obligation exists', { tables: { mwf_obligation: 1, mwf_alertlog: 0 } }, /FAIL .*mwf_obligation exists and holds 0 rows/s], ['an alert log row exists', { tables: { mwf_obligation: 0, mwf_alertlog: 2 } }, /FAIL .*mwf_alertlog exists and holds 0 rows/s],
    ['a counter is not 0', { counters: [0, 0, 1, 0, 0] }, /FAIL .*counters are all 0.*\[0,0,1,0,0\]/s],
  ];
  for (const [label, o, re] of cases) { const env = fakeEnv(o); const r = await runCreate(env.opts()); assert.equal(r.ok, false, label); assert.equal(env.writes().length, 0, `${label}: wrote`); assert.match(env.text(), re, label); }
});

test('create stops BEFORE the POST when a connection reference is missing, for the wrong connector, outside the solution, without a connection, or duplicated: it reports and never creates one', async () => {
  const good = fakeEnv().refs;
  const cases = [['dataverse reference missing', good.filter((r) => r.connectionreferencelogicalname !== DEFAULT_DATAVERSE_REF), new Set([gid(60), gid(61)]), new RegExp(`FAIL .*${DEFAULT_DATAVERSE_REF} exists once.*0 found`, 's')],
    ['outlook reference missing', good.filter((r) => r.connectionreferencelogicalname !== DEFAULT_OUTLOOK_REF), new Set([gid(60), gid(61)]), new RegExp(`FAIL .*${DEFAULT_OUTLOOK_REF} exists once`, 's')],
    ['wrong connector', good.map((r) => (r.connectionreferencelogicalname === DEFAULT_OUTLOOK_REF ? { ...r, connectorid: '/providers/Microsoft.PowerApps/apis/shared_other' } : r)), new Set([gid(60), gid(61)]), /FAIL .*is for the connector shared_office365/s],
    ['not in the solution', good, new Set([gid(60)]), /FAIL .*is a component of the solution/s], ['no connection set', good.map((r) => (r.connectionreferencelogicalname === DEFAULT_DATAVERSE_REF ? { ...r, connectionid: '' } : r)), new Set([gid(60), gid(61)]), /FAIL .*has a connection set/s],
    ['duplicated', [...good, { ...good[1], connectionreferenceid: gid(62) }], new Set([gid(60), gid(61), gid(62)]), /FAIL .*exists once.*2 found/s]];
  for (const [label, refs, components, re] of cases) { const env = fakeEnv({ refs, components }); const r = await runCreate(env.opts()); assert.equal(r.ok, false, label); assert.equal(env.writes().length, 0, label); assert.match(env.text(), re, label); assert.ok(!env.log.some((c) => /connectionreferences/.test(c.path) && c.method !== 'GET')); }
});

test('create stops BEFORE the POST when the structural check of the generated definition fails (a broken definition is injected)', async () => {
  const env = fakeEnv(); const r = await runCreate(env.opts({ build: (v, rf) => { const cd = buildClientdata(v, rf); cd.properties.definition.actions.Apply_to_each_obligation.runtimeConfiguration = undefined; return cd; } }));
  assert.equal(r.ok, false); assert.equal(env.writes().length, 0); assert.match(env.text(), /FAIL .*structural check of the generated definition passes/s);
});

test('create after the POST: a failed POST reports the status and does nothing else; a POST whose answer is lost reports the outcome UNKNOWN, reads the state, and never retries', async () => {
  const bad = fakeEnv({ failPost: true }); const r = await runCreate(bad.opts());
  assert.equal(r.ok, false); assert.equal(r.posts, 1); assert.match(bad.text(), /POST workflows failed HTTP 400/); assert.equal(bad.writes().length, 1);
  const lost = fakeEnv({ throwPost: true }); const u = await runCreate(lost.opts());
  assert.equal(u.unknown, true); assert.equal(u.ok, false); assert.equal(u.posts, 1); assert.match(lost.text(), /POST outcome UNKNOWN/); assert.match(lost.text(), /Nothing was deleted or retried/); assert.equal(lost.posts().length, 1);
});

test('create reports (FAIL) a row that came back ON, one that is not in the solution, and a stored definition that fails the structural check; it changes none of them', async () => {
  const on = fakeEnv({ createdOn: true }); const r1 = await runCreate(on.opts()); assert.equal(r1.ok, false); assert.match(on.text(), /FAIL .*is OFF \(statecode 0, Draft\).*statecode 1/s); assert.equal(on.writes().length, 1);
  const out = fakeEnv({ notInSolution: true }); const r2 = await runCreate(out.opts()); assert.equal(r2.ok, false); assert.match(out.text(), /FAIL .*is a component of the solution/s);
  const mangled = fakeEnv({ normalize: (cd) => { const j = JSON.parse(cd); j.properties.definition.triggers.Recurrence.recurrence.interval = 9; return JSON.stringify(j); } });
  const r3 = await runCreate(mangled.opts()); assert.equal(r3.ok, false); assert.match(mangled.text(), /FAIL .*structural check passes on the definition as stored/s);
});

test('create refuses without a valid solution name (the guard throws before any call) and the gate runs first', async () => {
  const env = fakeEnv(); const r = await runCreate(env.opts({ solution: '' })); assert.equal(r.ok, false); assert.match(r.stopped, /valid solution unique name is required/); assert.equal(env.log.length, 0);
  let gated = 0; const e2 = fakeEnv(); await runCreate(e2.opts({ gate: async () => { gated++; } })); assert.equal(gated, 1);
  const e3 = fakeEnv(); const r3 = await runCreate(e3.opts({ gate: async () => { throw new Error('connection unstable (mock)'); } })); assert.match(r3.stopped, /connection unstable/); assert.equal(e3.log.length, 0);
});

test('the number of existing flows expected before the create is five (the owner\'s baseline)', () => assert.equal(EXPECTED_FLOWS, 5));

// ---------------------------------------------------------------------------------------------------------------- verify
test('verify after a create: every check passes, the real action count and depth are read from the STORED definition, and nothing but GET is sent', async () => {
  const env = fakeEnv(); await runCreate(env.opts()); const before = env.log.length; env.out.length = 0;
  const r = await runVerify(env.opts());
  assert.equal(r.ok, true, env.text()); assert.deepEqual(r.differences, []);
  assert.deepEqual(r.stats, statsOf(buildClientdata(testVariant()))); assert.match(env.text(), /32 actions, nesting depth 5/);
  assert.ok(env.log.slice(before).every((c) => c.method === 'GET')); assert.match(env.text(), /identical/); assert.match(env.text(), /connection references bound: shared_commondataserviceforapps -> new_sharedcommondataserviceforapps_43184; shared_office365 -> mwf_sharedoffice365_reminders/);
});

test('verify REPORTS and never fixes: a flow that is ON, a missing flow, a flow outside the solution, other references, a changed definition (every difference listed), a flow with no definition', async () => {
  const base = fakeEnv(); await runCreate(base.opts());
  const on = fakeEnv(); await runCreate(on.opts()); on.flows.find((f) => f.name === FLOW_NAME).statecode = 1; on.out.length = 0; const w = on.log.length;
  assert.equal((await runVerify(on.opts())).ok, false); assert.match(on.text(), /FAIL .*is OFF \(statecode 0\).*statecode 1/s); assert.ok(on.log.slice(w).every((c) => c.method === 'GET'));
  const none = fakeEnv(); const rn = await runVerify(none.opts()); assert.equal(rn.ok, false); assert.match(none.text(), /FAIL .*exists once.*0 row/s); assert.equal(rn.stopped, 'the flow does not exist');
  const out = fakeEnv(); await runCreate(out.opts()); out.components.delete(out.flows.find((f) => f.name === FLOW_NAME).workflowid); out.out.length = 0; assert.equal((await runVerify(out.opts())).ok, false); assert.match(out.text(), /FAIL .*is a component of the solution/s);
  const other = fakeEnv(); await runCreate(other.opts()); other.out.length = 0; const r4 = await runVerify(other.opts({ refs: { outlookRef: 'mwf_other_reference', dataverseRef: DEFAULT_DATAVERSE_REF } })); assert.equal(r4.ok, false); assert.match(other.text(), /FAIL .*bound references are the two given/s);
  const changed = fakeEnv(); await runCreate(changed.opts()); const row = changed.flows.find((f) => f.name === FLOW_NAME); const j = JSON.parse(row.clientdata.split(HOST).join('<ORG_HOST>'));
  j.properties.definition.actions.Get_open_obligations.inputs.parameters.$top = 51; j.properties.definition.actions.Init_errors.inputs.variables[0].value = 3; row.clientdata = JSON.stringify(j).split('<ORG_HOST>').join(HOST); changed.out.length = 0; const w2 = changed.log.length;
  const r5 = await runVerify(changed.opts()); assert.equal(r5.ok, false); assert.equal(r5.differences.length, 2); assert.match(changed.text(), /2 difference\(s\): /); assert.ok(r5.differences.some((d) => d.endsWith('$top')) && r5.differences.some((d) => /Init_errors/.test(d))); assert.ok(changed.log.slice(w2).every((c) => c.method === 'GET'), 'a difference is never fixed');
  const empty = fakeEnv(); await runCreate(empty.opts()); empty.flows.find((f) => f.name === FLOW_NAME).clientdata = '{}'; empty.out.length = 0; const r6 = await runVerify(empty.opts()); assert.equal(r6.ok, false); assert.match(empty.text(), /FAIL .*real action count and depth.*no definition stored/s);
});

test('verify stops when the solution is not exactly one unmanaged solution, and when two rows have the name (it judges neither)', async () => {
  const env = fakeEnv({ solutions: [] }); const r = await runVerify(env.opts()); assert.equal(r.ok, false); assert.match(r.stopped, /expected exactly 1 unmanaged solution/);
  const dup = fakeEnv(); await runCreate(dup.opts()); dup.flows.push({ ...dup.flows.find((f) => f.name === FLOW_NAME), workflowid: gid(777) }); dup.out.length = 0; const r2 = await runVerify(dup.opts()); assert.equal(r2.ok, false); assert.equal(r2.stopped, 'more than one row of this name');
});

test('verify with the production variant stored differs in the interval, the lead and the lookback and says so (the stored definition is compared with the TEST variant)', async () => {
  const env = fakeEnv(); await runCreate(env.opts()); const row = env.flows.find((f) => f.name === FLOW_NAME);
  row.clientdata = JSON.stringify(buildClientdata(productionVariant({ intervalMinutes: 15, leadMinutes: 60, lookbackMinutes: 30 }))).split('<ORG_HOST>').join(HOST);
  env.out.length = 0; const r = await runVerify(env.opts()); assert.equal(r.ok, false); assert.ok(r.differences.some((d) => /recurrence\.interval/.test(d)));
});

test('the host of --env is replaced in memory only: it is never printed by create or verify', async () => {
  const env = fakeEnv(); await runCreate(env.opts()); await runVerify(env.opts()); assert.ok(!env.text().includes(HOST));
});
