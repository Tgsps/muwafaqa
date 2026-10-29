// Tests of the session script of the reminders flow (scripts/test-flow-reminders.mjs): the offline plan, the refusals (all BEFORE any sign-in) and the shape of the source.
// No window is run by these tests and none of them touches an environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./test-flow-reminders.mjs', import.meta.url));
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 });

test('the plan runs offline, prints both windows, the late seeds of R4a and R4b, the real waiting, and the simulation sentence', () => {
  const r = run('--mode=plan');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^v2 simulated by seeded rows: this session does NOT prove the integration with v2/);
  assert.match(r.stdout, /WINDOW 1: R5, R3, R4A, R4B/);
  assert.match(r.stdout, /WINDOW 2: R1, R2, R6/);
  assert.match(r.stdout, /LAST \(after the contract transition\)/);
  assert.match(r.stdout, /what the flow sees when it scans it/);
  assert.match(r.stdout, /REAL time/);
  assert.match(r.stdout, /Counted as PASS only if the control of the window fired/);
});

test('the refusals come before any sign-in (exit 2): bad mode, bad window, a write without the confirmation flag, a sign-in other than az, no --env', () => {
  assert.equal(run('--mode=delete').status, 2);
  assert.equal(run('').status, 2);
  for (const mode of ['setup', 'await', 'verdict', 'cleanup']) { const r = run(`--mode=${mode}`, '--window=3'); assert.equal(r.status, 2, mode); assert.match(r.stderr, /--window=1\|2/); }
  for (const mode of ['setup', 'await', 'cleanup']) { const r = run(`--mode=${mode}`, '--window=1', '--env=https://example.invalid'); assert.equal(r.status, 2, mode); assert.match(r.stderr, /--confirm-mutates-environment/); assert.match(r.stderr, /Nothing was run/); }
  const device = run('--mode=setup', '--window=1', '--confirm-mutates-environment', '--env=https://example.invalid', '--auth=device');
  assert.equal(device.status, 2); assert.match(device.stderr, /Only --auth=az/);
  const noEnv = run('--mode=baseline'); assert.equal(noEnv.status, 2); assert.match(noEnv.stderr, /--env/);
  const noEnv2 = run('--mode=verdict', '--window=1'); assert.equal(noEnv2.status, 2);
});

test('THE SCRIPT NEVER TURNS A FLOW ON OR OFF: no write to the table of flows, no state or status written, no activation, no publish', () => {
  assert.doesNotMatch(CODE, /write\(\s*['"`](POST|PATCH|DELETE)['"`]\s*,\s*[`'"]workflows/);
  assert.doesNotMatch(CODE, /call\(\s*['"`](POST|PATCH|PUT|DELETE)['"`]\s*,\s*[`'"]workflows/);
  assert.match(CODE, /refused: this script never writes to the table of flows/);
  const stateWrites = CODE.split('\n').filter((l) => /statecode\s*:\s*[01]\b/.test(l));
  assert.deepEqual(stateWrites.map((l) => l.trim()), ['await patchContract(r4b, { statecode: 1, statuscode: STATUS.Rejected });']);   // the only state written is the state of the R4b CONTRACT (Rejected)
  assert.doesNotMatch(CODE, /SetState|activate|Activat|publish|Publish|turnOn|turn_on/);
  assert.match(SOURCE, /THE OWNER ALONE TURNS FLOWS ON AND OFF/);
});

test('every write that is not a delete goes through the write() wrapper (dry run) and only to contracts, steps and the counterparty', () => {
  const direct = [...CODE.matchAll(/S\.call(?:T)?\(\s*'(POST|PATCH|PUT|DELETE)'\s*,\s*([^,)]+)/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.ok(direct.every((d) => /^DELETE `mwf_counterparties\(/.test(d) || /^POST|PATCH/.test(d) === false), JSON.stringify(direct));
  const wrapped = [...CODE.matchAll(/write\(\s*'(POST|PATCH|DELETE)'\s*,\s*([`'][^`',]+)/g)].map((m) => m[2]);
  assert.ok(wrapped.length >= 4);
  assert.ok(wrapped.every((p) => /^[`']mwf_(contracts|counterparties|approvalsteps)/.test(p)), JSON.stringify(wrapped));
});

test('A: the Waiting seed of R4b and of R4a is the LAST write for its contract, after the contract transition, and it is read back', () => {
  const b = CODE.indexOf('patchContract(r4b, { statecode: 1, statuscode: STATUS.Rejected })');
  const bSeed = CODE.indexOf('patchStep(s4b.mwf_approvalstepid, SEED.waiting())');
  assert.ok(b > 0 && bSeed > b);
  const a1 = CODE.indexOf('patchContract(r4a, { statuscode: STATUS.Draft })');
  const a2 = CODE.indexOf('patchContract(r4a, { statuscode: STATUS.Pending })');
  const a3 = CODE.indexOf('builtSteps(r4a, 2, 2)');
  const aSeed = CODE.indexOf('patchStep(s4a[1].mwf_approvalstepid, SEED.waiting())');
  assert.ok(a1 > 0 && a2 > a1 && a3 > a2 && aSeed > a3);
  const afterSeed = CODE.slice(aSeed, CODE.indexOf("if (!DRY) {", aSeed));
  assert.doesNotMatch(afterSeed.slice(afterSeed.indexOf('\n')), /\bwrite\(|patchStep\(|patchContract\(|submit\(/);   // no other write between the seed and the read back
  const readBack = CODE.slice(aSeed);
  assert.match(readBack, /READ BACK: the contract is Pending Approval in round 2 and the step 2 of ROUND 1 is Waiting/);
  assert.match(readBack, /READ BACK: the contract is Rejected and its step is Waiting, round 1, step order 1/);
  assert.match(readBack, /A seed was not in place after the last write/);
});

test('C: the verdict and the cleanup read the state of the reminders flow themselves, print STILL ON, and the cleanup deletes nothing while it is ON', () => {
  assert.match(CODE, /STILL ON: the reminders flow is ON/);
  assert.match(CODE, /async function waitForOff/);
  assert.match(CODE, /const off = await waitForOff\(180, 10\);/);   // verdict
  const clean = CODE.slice(CODE.indexOf('async function cleanup()'));
  assert.ok(clean.indexOf('waitForOff') > 0 && clean.indexOf('waitForOff') < clean.indexOf('deleteContracts'));
  assert.match(clean, /if \(!off\) \{ out\('flow', 'FAIL'/);
});

test('E: the baseline re-reads the five assignments and fails if one resolves to another user than the logged-in one', () => {
  assert.match(CODE, /mwf_approverassignments\?\$select=mwf_approverrole,_mwf_user_value/);
  assert.match(CODE, /recipientsVerdict\(\{ assignments: asg, meId: me, meHasEmail/);
  assert.match(CODE, /check\('recipients'/);
});

test('D: the verdict prints the simulation sentence at its start and at its end', () => {
  const v = CODE.slice(CODE.indexOf('async function runVerdict()'), CODE.indexOf('async function cleanup()'));
  assert.equal((v.match(/SIMULATION_SENTENCE/g) || []).length, 2);
});

test('the script has the flow-state, cleanup and sign-in rules: az only, confirmation flag, no token or address printed', () => {
  assert.match(CODE, /argOf\('auth'\) !== 'az'/);
  assert.match(CODE, /--confirm-mutates-environment/);
  assert.doesNotMatch(CODE, /deviceToken|console\.log\([^)]*(token|password|secret)/i);
  assert.match(SOURCE, /NO WINDOW HAS BEEN RUN/);
});

test('window 2 requirements: READY prints the number and the name of R1, R2 and R6; the writes of R2 and R6 are printed with their UTC values and read back; --on-at; the late-ON rule; the link-check pause', () => {
  assert.match(CODE, /function readyReport2\(/);
  assert.match(CODE, /number \$\{of\(k\)\.mwf_contractnumber\}   name "\$\{of\(k\)\.mwf_name\}"/);
  assert.match(CODE, /SEEDED NOW: R1 step 1 mwf_decision/);
  assert.match(CODE, /R2 WILL BE WRITTEN by the await step/);
  assert.match(CODE, /R6 WILL BE WRITTEN by the await step/);
  assert.match(CODE, /TURN THE FLOW ON NO LATER THAN/);
  assert.match(CODE, /WRITE R2 /); assert.match(CODE, /WRITE R6 /); assert.match(CODE, /READBACK R6 /);
  assert.match(CODE, /ON-AT \$\{onRow\.modifiedon\}/);
  assert.match(CODE, /argOf\('on-at'\)/);
  assert.match(CODE, /READ BACK: R1 has 1 step, Waiting/); assert.match(CODE, /READ BACK: R6 has 2 steps, both Pending/);
  assert.match(CODE, /LINK CHECK WINDOW: contracts still exist, say 'link checked' to continue/);
  const plan = run('--mode=plan').stdout;
  assert.match(plan, /later than S0\+2:30 the timing of R1 and R6 cannot be judged/);
});
