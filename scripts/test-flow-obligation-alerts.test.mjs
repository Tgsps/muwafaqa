// Tests of the command line of the obligation alerts session: the offline plan, the refusals (all BEFORE any sign-in) and the shape of the source. No window is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODES, WRITES, parseCounters, refusals } from './test-flow-obligation-alerts.mjs';

const SCRIPT = fileURLToPath(new URL('./test-flow-obligation-alerts.mjs', import.meta.url));
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', timeout: 30000 });
const ENV = 'https://example.invalid';

test('the modes, and which of them write: only setup and cleanup (await and verdict read only)', () => {
  assert.deepEqual([...MODES], ['plan', 'baseline', 'setup', 'await', 'verdict', 'cleanup']);
  assert.deepEqual([...WRITES], ['setup', 'cleanup']);
});

test('plan runs offline (exit 0, no --env, no sign-in) and prints the cases, the margins and the counters it would consume; it says the flow exists and is Off, and that no window has been run', () => {
  const r = run('--mode=plan'); assert.equal(r.status, 0, r.stderr);
  for (const n of ['PLAN (offline', 'THE FLOW EXISTS AND IS OFF', 'never been turned on', 'MARGINS', 'consumes ONE number', 'preinserted', 'ONLY THE OWNER CAN READ', 'plan and baseline have been run', 'no window has been run', 'setup (WRITES)', 'cleanup (WRITES)']) assert.ok(r.stdout.includes(n), n);
  assert.equal(r.stderr, '');
});

test('the refusals come first (exit 2, before any sign-in): a bad mode, no mode, a bad auth, no confirmation, no counter approval, no hand-off, a bad time, a bad count', () => {
  for (const bad of ['--mode=delete', '--mode=', '']) { const r = run(...(bad ? [bad] : [])); assert.equal(r.status, 2, bad); assert.match(r.stderr, /Missing or invalid --mode/); assert.match(r.stderr, /Nothing was run/); }
  const noConfirm = run('--mode=setup', `--env=${ENV}`, '--counters-approved'); assert.equal(noConfirm.status, 2); assert.match(noConfirm.stderr, /--confirm-mutates-environment/);
  const noApproval = run('--mode=setup', `--env=${ENV}`, '--confirm-mutates-environment'); assert.equal(noApproval.status, 2); assert.match(noApproval.stderr, /--counters-approved/);
  const noHand = run('--mode=cleanup', `--env=${ENV}`, '--confirm-mutates-environment', '--counters-approved'); assert.equal(noHand.status, 2); assert.match(noHand.stderr, /--counters-before/);
  assert.equal(run('--mode=cleanup', `--env=${ENV}`, '--counters-approved').status, 2);   // no confirmation
  const device = run('--mode=baseline', `--env=${ENV}`, '--auth=device'); assert.equal(device.status, 2); assert.match(device.stderr, /Only --auth=az/);
  assert.equal(run('--mode=verdict', `--env=${ENV}`, '--on-at=yesterday').status, 2);
  assert.equal(run('--mode=baseline', `--env=${ENV}`, '--expect-contracts=eleven').status, 2);
  assert.equal(run('--mode=cleanup', `--env=${ENV}`, '--counters-before=MNT:x').status, 2);
});

test('refusals(): every rule on its own; read-only modes need no confirmation and no approval; a dry run needs neither', () => {
  const base = { mode: 'setup', dry: false, confirm: true, countersApproved: true, auth: 'az', onAt: '', before: null, consumed: null, expect: '' };
  assert.deepEqual(refusals(base), []);
  assert.equal(refusals({ ...base, confirm: false }).length, 1); assert.equal(refusals({ ...base, countersApproved: false }).length, 1);
  assert.equal(refusals({ ...base, confirm: false, countersApproved: false }).length, 2);
  assert.deepEqual(refusals({ ...base, mode: 'setup', dry: true, confirm: false, countersApproved: false }), []);
  for (const mode of ['baseline', 'await', 'verdict']) assert.deepEqual(refusals({ ...base, mode, confirm: false, countersApproved: false }), [], mode);
  assert.deepEqual(refusals({ ...base, mode: 'plan', auth: 'device' }), []);   // plan needs nothing
  assert.equal(refusals({ ...base, mode: 'cleanup' }).length, 1);   // no hand-off
  assert.deepEqual(refusals({ ...base, mode: 'cleanup', before: { MNT: 0 }, consumed: { MNT: 1 } }), []);
  assert.equal(refusals({ ...base, auth: 'device' }).length, 1); assert.equal(refusals({ ...base, onAt: 'nope' }).length, 1); assert.equal(refusals({ ...base, expect: '11x' }).length, 1);
  assert.equal(refusals({ ...base, mode: 'nope' }).length, 1);
});

test('parseCounters: PREFIX:number pairs; nothing for an empty value; a bad shape throws', () => {
  assert.deepEqual(parseCounters('MNT:3,PRC:0'), { MNT: 3, PRC: 0 }); assert.equal(parseCounters(''), null); assert.equal(parseCounters(undefined), null);
  for (const bad of ['MNT', 'mnt:1', 'MNT:-1', 'MNT:1.5', 'MNT:1;PRC:2', ':1']) assert.throws(() => parseCounters(bad), /bad counters value/, bad);
});

test('the source: the session never turns a flow on or off, never reads a mailbox, no token or address is printed, and it says that nothing has been run', () => {
  assert.doesNotMatch(CODE, /\bmessages\b|office365|Outlook|mailbox|SendEmail|inbox|statecode|SetState|activate|Publish|turnOn|workflows/i);
  assert.doesNotMatch(CODE, /console\.log\([^)]*(token|password|secret)/i);
  assert.match(SOURCE, /NO WINDOW HAS BEEN RUN/); assert.match(SOURCE, /THE OWNER ALONE TURNS FLOWS ON AND OFF/); assert.match(SOURCE, /never reads a mailbox/);
  assert.match(CODE, /argOf\('auth'\)|auth: argOf\('auth'\)/);
  assert.doesNotMatch(SOURCE, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);   // no address literal
});

test('no text about the obligation alerts flow still says that it does not exist, was not built, or that create and verify were never run (it was created OFF on 2026-11-03)', () => {
  const files = ['scripts/build-flow-obligation-alerts.mjs', 'scripts/lib/obligation-session.mjs', 'scripts/test-flow-obligation-alerts.mjs', 'scripts/lib/obligation-flow-deploy.mjs', 'scripts/README.md',
    'docs/flow-obligation-alerts.md', 'docs/decisions/ADR-011-obligations-and-renewal-alerts.md', 'README.md'];
  const stale = /DOES NOT EXIST YET|no flow exists|No flow exists|Only plan may run|only one that may run now|may run now|NEVER RUN|never been run|HAVE NOT BEEN RUN AGAINST|NOT RUN, the flow|written, not run|never run against an environment|before any build\.\*\*/;
  for (const f of files) {
    const text = fs.readFileSync(fileURLToPath(new URL('../' + f, import.meta.url)), 'utf8');
    // the shared README files also describe other flows: only the lines about the alerts flow (ADR-011) are judged here
    const mine = f.endsWith('README.md') ? /obligation|ADR-011|alerts flow/i : /./;
    const hit = text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => mine.test(l) && stale.test(l)).map(([i]) => i);
    assert.deepEqual(hit, [], f + ' lines ' + hit.join(','));
  }
  const plan = run('--mode=plan').stdout; assert.doesNotMatch(plan, stale); assert.match(plan, /THE FLOW EXISTS AND IS OFF/);
});
