#!/usr/bin/env node
/**
 * READ-ONLY connection monitor, to run BEFORE a long test session (the flow-ON session requires 15 minutes without errors, a practical
 * criterion that is not statistically proven). Every <interval> seconds for <minutes> minutes it logs (i) the DNS lookup of the environment host, (ii) the DNS
 * lookup of a neutral public host, (iii) a light GET (WhoAmI) to the environment, with the literal error code on failure. It never
 * writes anything and prints no token and no host. It prints only the failures and a summary, and exits with code 1 if anything failed.
 *
 * Usage:
 *   node scripts/check-connection.mjs --env=https://<org>.crm4.dynamics.com [--minutes=15] [--interval=5] [--neutral=example.com]
 *
 * Auth: a token from `az account get-access-token` (kept in memory, never printed).
 */
import { execSync } from 'node:child_process';
import dns from 'node:dns/promises';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const ENV = argOf('env').replace(/\/+$/, '');
const MINUTES = Number(argOf('minutes') || 15);
const INTERVAL = Number(argOf('interval') || 5);
const NEUTRAL = argOf('neutral') || 'example.com';
if (!/^https:\/\/[^/]+$/.test(ENV)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
const HOST = new URL(ENV).host;
const token = execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim();

const code = (e) => String((e && e.cause && e.cause.code) || (e && e.code) || (e && e.name) || 'ERR');
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('t'), { code: 'LOOKUP_TIMEOUT_8S' })), ms))]);
const lookup = async (h) => { try { await withTimeout(dns.lookup(h), 8000); return 'ok'; } catch (e) { return code(e); } };
const get = async () => {
  const t0 = Date.now();
  try {
    const r = await fetch(`${ENV}/api/data/v9.2/WhoAmI`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    return { res: r.ok ? 'ok' : `HTTP_${r.status}`, ms: Date.now() - t0 };
  } catch (e) { return { res: code(e), ms: Date.now() - t0 }; }
};

const cycles = Math.max(1, Math.round((MINUTES * 60) / INTERVAL));
const rows = []; const start = Date.now();
console.log(`monitoring: ${cycles} cycles, one every ${INTERVAL} s (about ${MINUTES} minutes), read only`);
for (let i = 0; i < cycles; i++) {
  const t0 = Date.now();
  const [a, b, c] = await Promise.all([lookup(HOST), lookup(NEUTRAL), get()]);
  const row = { i: i + 1, s: Math.round((t0 - start) / 1000), dnsEnv: a, dnsNeutral: b, get: c.res, ms: c.ms };
  rows.push(row);
  if (a !== 'ok' || b !== 'ok' || c.res !== 'ok') console.log(`FAIL  cycle ${row.i} at +${row.s}s: dnsEnv=${a} dnsNeutral=${b} get=${c.res} (${c.ms} ms)`);
  const wait = INTERVAL * 1000 - (Date.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
const kinds = { dnsEnv: (r) => r.dnsEnv !== 'ok', dnsNeutral: (r) => r.dnsNeutral !== 'ok', get: (r) => r.get !== 'ok', any: (r) => r.dnsEnv !== 'ok' || r.dnsNeutral !== 'ok' || r.get !== 'ok' };
console.log(`\ncycles: ${rows.length} over about ${Math.round((Date.now() - start) / 1000)} s`);
let failed = 0;
for (const [k, f] of Object.entries(kinds)) {
  const bad = rows.filter(f).length; if (k === 'any') failed = bad;
  let best = { n: 0, lo: 0, hi: 0 }; let i = 0;
  while (i < rows.length) {
    if (!f(rows[i])) { i++; continue; }
    let j = i; while (j + 1 < rows.length && f(rows[j + 1])) j++;
    const n = j - i + 1; const lo = rows[j].s - rows[i].s; const prev = i > 0 ? rows[i - 1].s : rows[i].s; const next = j + 1 < rows.length ? rows[j + 1].s : rows[j].s;
    if (n > best.n) best = { n, lo, hi: next - prev };
    i = j + 1;
  }
  console.log(`${k.padEnd(11)} failures ${String(bad).padStart(3)}/${rows.length} | longest consecutive run: ${best.n} cycle(s), between ${best.lo} s and ${best.hi} s`);
}
const codes = {}; for (const r of rows) for (const v of [r.dnsEnv, r.dnsNeutral, r.get]) if (v !== 'ok') codes[v] = (codes[v] || 0) + 1;
console.log(`literal error codes seen: ${JSON.stringify(codes)}`);
const okMs = rows.filter((r) => r.get === 'ok').map((r) => r.ms).sort((x, y) => x - y);
console.log(`GET latency when ok: median ${okMs[Math.floor(okMs.length / 2)] ?? '-'} ms, max ${okMs[okMs.length - 1] ?? '-'} ms (${okMs.length} successful requests)`);
console.log(failed ? 'RESULT: the connection was NOT stable in this window.' : 'RESULT: stable in this window (0 failures).');
process.exit(failed ? 1 : 0);
