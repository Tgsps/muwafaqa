#!/usr/bin/env node
/**
 * Test of the uniqueness of the alert log (ADR-011, status Proposed): does the alternate key on mwf_alertkey reject a second row with the same key,
 * and what does the server do with an empty or a null key and with concurrent inserts. Written for review. NOT RUN against any environment:
 * the tables of ADR-011 do not exist yet (scripts/add-obligation-schema.mjs has not been applied). The steps are in lib/alertlog-uniqueness.mjs and are
 * unit tested against a mocked HTTP layer only.
 *
 *   --mode=plan   (default) prints the steps. No network, no sign-in, no --env needed. Writes nothing.
 *   --mode=run    needs --env and --confirm-mutates-environment. REFUSES (exit 3, nothing written) unless the alternate key index of mwf_alertlog is Active and no
 *                 TEST-TMP-ALERT row exists. Writes only rows of mwf_alertlog whose key or name starts with TEST-TMP-ALERT-, and deletes every one of them
 *                 at the end, also after a failure. It never touches a contract, a flow or a counter.
 *   --n=<2..20>   number of concurrent inserts in step 4 (default 5)
 *
 * The HTTP status of the duplicate rejection is MEASURED and printed; it is not asserted (Learn does not document it for this error).
 * Exit 0: no FAIL and the cleanup left nothing. 1: a FAIL or a leftover. 2: refused (arguments). 3: refused (key not Active or leftover rows). 4: stopped.
 *
 * Usage:
 *   node scripts/test-alertlog-uniqueness.mjs
 *   node scripts/test-alertlog-uniqueness.mjs --mode=run --env=https://<org>.crm4.dynamics.com --auth=az --confirm-mutates-environment [--n=5]
 *
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
const argv = process.argv;
const argOfRaw = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const MODE = argOfRaw('mode') || 'plan';
if (!['plan', 'run'].includes(MODE)) { console.error('Invalid --mode=plan|run. Nothing was run.'); process.exit(2); }
const N = argOfRaw('n') === '' ? 5 : Number(argOfRaw('n'));
if (!Number.isInteger(N) || N < 2 || N > 20) { console.error('Invalid --n (an integer from 2 to 20). Nothing was run.'); process.exit(2); }

if (MODE === 'plan') {
  console.log('PLAN (offline, nothing is sent). Every row written has a key or a name that starts with TEST-TMP-ALERT-, in mwf_alertlog only.');
  console.log('  gate   read: the alternate key index must be Active (else REFUSED, nothing written); no TEST-TMP-ALERT row may exist');
  console.log('  1      insert a new key: expect success; read it back by the alternate key');
  console.log('  2      insert the same key: expect rejection with 0x80060892 in the BODY; RECORD the HTTP status (not asserted); expect one row for the key');
  console.log('  3      insert an EMPTY key twice and a NULL key twice: observations only (what the server does)');
  console.log(`  4      ${N} concurrent inserts of one fresh key: expect exactly one success; record the others (status and code)`);
  console.log('  5      cleanup: delete every row created, then sweep by the TEST-TMP-ALERT prefix; report the leftover (also after a failure)');
  console.log('Use --mode=run with --env and --confirm-mutates-environment to go further. Nothing was written.');
  process.exit(0);
}

const { parseArgs, openSession, noGuid, Stop } = await import('./lib/dv-session.mjs');
const { requireStableConnection } = await import('./lib/counter-snapshot.mjs');
const { enterCleanupPhase } = await import('./lib/resilient-fetch.mjs');
const { runUniquenessTest } = await import('./lib/alertlog-uniqueness.mjs');
const { env: ENV, auth: AUTH, has } = parseArgs();
if (!has('--confirm-mutates-environment')) {
  console.error('WARNING: --mode=run inserts and deletes TEST-TMP-ALERT rows in mwf_alertlog. Add --confirm-mutates-environment to run it on purpose. Nothing was run.');
  process.exit(2);
}

(async () => {
  try {
    const S = await openSession({ env: ENV, auth: AUTH });
    await requireStableConnection(S.call);
    // the cleanup phase of the resilient fetch is entered when the steps start their cleanup; it only lengthens the waits of reads
    const call = async (m, p, b, x) => { if (m === 'DELETE') enterCleanupPhase(); return S.call(m, p, b, x); };
    const r = await runUniquenessTest({ call, stable: () => requireStableConnection(S.call), n: N, log: (l) => console.log(noGuid(l)) });
    if (r.refused) { console.error(`\n${noGuid(r.refused)}`); process.exit(3); }
    const m = r.measured;
    console.log(`\nMEASURED: duplicate-key rejection HTTP ${m.duplicateStatus}, code ${m.duplicateCode || 'none'} (record both in ADR-011).`);
    console.log(`MEASURED: empty key ${m.empty.map((x) => (x.ok ? `accepted ${x.status}` : `rejected ${x.status}/${x.code || 'none'}`)).join(', ')}; null key ${m.nullKey.map((x) => (x.ok ? `accepted ${x.status}` : `rejected ${x.status}/${x.code || 'none'}`)).join(', ')}.`);
    console.log(`MEASURED: concurrent ${m.concurrent.map((x) => (x.ok ? `ok ${x.status}` : `${x.status}/${x.code || 'none'}`)).join(' ')}.`);
    console.log(`SUMMARY: ${r.failed} failed check(s); ${r.writes} insert(s) sent; cleanup leftover ${r.cleanup.leftover}.`);
    process.exit(r.failed || r.cleanup.leftover !== 0 ? 1 : 0);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e instanceof Stop ? e.message : e.message)}`);
    process.exit(4);
  }
})();
