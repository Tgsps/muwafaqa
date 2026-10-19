#!/usr/bin/env node
/**
 * Generic cleanup of the rows of ONE test script, found by their Subject prefix (never by number), and the restore of the
 * contract number counters by the helper's rule. Use it when a script stopped half-way (for example the connection was lost) and
 * the script has no cleanup mode of its own. Idempotent: if nothing is left it only checks and restores the counters.
 *
 * Rows deleted: contracts whose Subject starts with the prefix (Pending: withdrawn to Draft, then deleted; In Force: the bypass
 * of the guard Delete step alone, shared helper scripts/lib/contract-cleanup.mjs) and counterparties whose name starts with it.
 * The prefix must start with TEST-TMP- (so that no real data can match). It is the prefix of ONE script: TEST-TMP-ROUND,
 * TEST-TMP-RND-1, TEST-TMP-USD, TEST-TMP-GUARD, TEST-TMP-GFLOW, TEST-TMP-CHK, TEST-TMP-TRIG, TEST-TMP-NUM.
 *
 * Counters: pass the two values the stopped script printed (--counters-before=MNT:0,PRC:0,... --counters-consumed=MNT:1).
 * They are restored only if counter == before + consumed and no contract with a higher number still exists
 * (scripts/lib/counter-snapshot.mjs); otherwise nothing is touched and the numbers are printed. Without the two values the
 * counters are not touched.
 *
 * Usage:
 *   node scripts/cleanup-test-rows.mjs --prefix=TEST-TMP-TRIG --env=https://<org>.crm4.dynamics.com --confirm-mutates-environment
 *        [--auth=az|device] [--counters-before=...] [--counters-consumed=...]
 *
 * The token stays in memory and is never printed. No id, address or token is printed or stored.
 */
import { execSync } from 'node:child_process';
import { deleteContracts } from './lib/contract-cleanup.mjs';
import { ctrIo, restoreFromArgs, requireStableConnection } from './lib/counter-snapshot.mjs';
import { resilientFetch, enterCleanupPhase } from './lib/resilient-fetch.mjs';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const PREFIX = argOf('prefix');
const ENV = argOf('env').replace(/\/+$/, '');
const AUTH = argOf('auth') || 'device';
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id, same as the other scripts

if (!/^TEST-TMP-[A-Za-z0-9-]+$/.test(PREFIX)) { console.error('Missing or invalid --prefix=TEST-TMP-<script prefix>. Nothing was run.'); process.exit(2); }
if (!/^https:\/\/[^/]+$/.test(ENV)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
if (!['device', 'az'].includes(AUTH)) { console.error('Invalid --auth=device|az. Nothing was run.'); process.exit(2); }
if (!process.argv.includes('--confirm-mutates-environment')) {
  console.error(`WARNING: this deletes the contracts and counterparties whose Subject starts with ${PREFIX} and may restore the counters. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
  process.exit(2);
}

const API = `${ENV}/api/data/v9.2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noGuid = (t) => String(t ?? '').replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>');
const q = encodeURIComponent;
let TOKEN;

async function form(url, f) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = null; }
  return { ok: r.ok, status: r.status, j, t };
}
async function deviceToken() {
  const base = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
  const dc = await form(`${base}/devicecode`, { client_id: CLIENT_ID, scope: `${ENV}/.default` });
  if (!dc.ok) throw new Error(`Device code request failed (HTTP ${dc.status}):\n${noGuid(dc.t)}`);
  console.log(`\nSIGN-IN URL : ${dc.j.verification_uri}\nDEVICE CODE : ${dc.j.user_code}\n(single use, ${Math.round(dc.j.expires_in / 60)} min). Waiting for sign-in...\n`);
  let iv = (dc.j.interval ?? 5) * 1000; const end = Date.now() + dc.j.expires_in * 1000;
  while (Date.now() < end) {
    await sleep(iv);
    const t = await form(`${base}/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, device_code: dc.j.device_code });
    if (t.ok) return t.j.access_token;
    const e = t.j?.error;
    if (e === 'authorization_pending') continue;
    if (e === 'slow_down') { iv += 5000; continue; }
    throw new Error(`Token request failed (HTTP ${t.status}):\n${noGuid(t.t).slice(0, 600)}`);
  }
  throw new Error('Device code expired. Rerun for a new code.');
}
const hdr = (extra = {}) => ({ Authorization: `Bearer ${TOKEN}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Content-Type': 'application/json; charset=utf-8', ...extra });
async function call(method, path, body, extra = {}) {
  const r = await resilientFetch(`${API}/${path}`, { method, headers: hdr(extra), body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { /* not json */ }
  return { ok: r.ok, status: r.status, j, text: t };
}
const msg = (r) => noGuid(r.j?.error?.message || (r.ok ? '' : r.text) || '').slice(0, 300);
const io = {
  get: async (p) => { const r = await call('GET', p); return { ok: r.ok, status: r.status, json: r.j, message: msg(r) }; },
  patch: async (p, b) => { const r = await call('PATCH', p, b, { 'If-Match': '*' }); return { ok: r.ok, status: r.status, message: msg(r) }; },
  del: async (p, h) => { const r = await call('DELETE', p, undefined, h || {}); return { ok: r.ok, status: r.status, message: msg(r) }; },
};

(async () => {
  try {
    TOKEN = AUTH === 'az'
      ? execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim()
      : await deviceToken();
    enterCleanupPhase();   // DELETE is retried, 404 = already gone, reads are patient
    await requireStableConnection(call);

    const rows = (await call('GET', `mwf_contracts?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value;
    console.log(`contracts found with the prefix: ${rows.length}`);
    const del = await deleteContracts(io, rows.map((r) => r.mwf_contractid));
    console.log(`contracts deleted ${del.deleted}, failed ${del.failed.length}`);
    const cps = (await call('GET', `mwf_counterparties?$select=mwf_name&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value;
    for (const c of cps) {
      const used = (await call('GET', `mwf_contracts?$select=mwf_contractid&$filter=_mwf_counterpartyid_value eq ${c.mwf_counterpartyid}&$top=1`)).j.value.length;
      if (used) { console.log('counterparty still referenced, kept'); continue; }
      const d = await call('DELETE', `mwf_counterparties(${c.mwf_counterpartyid})`);
      console.log(`counterparty delete: HTTP ${d.status}${d.ok ? '' : ' (FAILED)'}`);
    }
    if (del.failed.length) { console.log(`STOP: ${del.failed.length} contract(s) could not be deleted; the counters were not touched.`); process.exit(1); }
    const rs = await restoreFromArgs(ctrIo(call));
    const a = (await call('GET', `mwf_contracts?$select=mwf_contractid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value.length;
    const b = (await call('GET', `mwf_counterparties?$select=mwf_counterpartyid&$filter=${q(`startswith(mwf_name,'${PREFIX}')`)}`)).j.value.length;
    const total = (await call('GET', 'mwf_contracts?$select=mwf_contractid&$count=true&$top=1')).j['@odata.count'];
    console.log(`check-clean (prefix ${PREFIX}): contracts ${a}, counterparties ${b}, total contracts ${total}`);
    process.exit(a || b || rs.refused ? 1 : 0);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(4);
  }
})();
