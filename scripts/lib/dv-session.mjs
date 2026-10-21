/**
 * Shared plumbing for the approval-chain scripts (ADR-007): sign-in, a Web API caller, metadata label helpers.
 * Same behaviour as the older scripts, in one place. The token stays in memory and is never printed. No id, address or token is
 * written by this module. GET is retried on network errors only (scripts/lib/resilient-fetch.mjs); a write is never retried.
 */
import { execSync } from 'node:child_process';
import { resilientFetch } from './resilient-fetch.mjs';

const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id, same as the other scripts
export const noGuid = (t) => String(t ?? '').replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class Stop extends Error {}

export const label = (text) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: 1033 }] });
export const req = (v) => ({ Value: v, CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });

export function parseArgs(argv = process.argv) {
  const argOf = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
  const env = argOf('env').replace(/\/+$/, '');
  const auth = argOf('auth') || 'device';
  if (!/^https:\/\/[^/]+$/.test(env)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
  if (!['device', 'az'].includes(auth)) { console.error('Invalid --auth=device|az. Nothing was run.'); process.exit(2); }
  return { argOf, env, auth, has: (f) => argv.includes(f) };
}

async function form(url, f) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = null; }
  return { ok: r.ok, status: r.status, j, t };
}
async function deviceToken(env) {
  const base = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
  const dc = await form(`${base}/devicecode`, { client_id: CLIENT_ID, scope: `${env}/.default` });
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

/** @returns {Promise<{call:Function, must:Function, io:object, msgOf:Function}>} */
export async function openSession({ env, auth }) {
  const token = auth === 'az'
    ? execSync(`az account get-access-token --resource ${env} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim()
    : await deviceToken(env);
  const api = `${env}/api/data/v9.2`;
  const hdr = (extra = {}) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Content-Type': 'application/json; charset=utf-8', ...extra });
  const call = async (method, path, body, extra = {}) => {
    const r = await resilientFetch(`${api}/${path}`, { method, headers: hdr(extra), body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let j = null; try { j = t ? JSON.parse(t) : null; } catch { /* not json */ }
    const m = /\(([0-9a-fA-F-]{36})\)/.exec(r.headers.get('OData-EntityId') || '');
    return { ok: r.ok, status: r.status, j, text: t, id: m ? m[1] : null };
  };
  const msgOf = (r) => noGuid(r.j?.error?.message || (r.ok ? '' : r.text) || '').slice(0, 300);
  const must = async (method, path, body, extra) => {
    const r = await call(method, path, body, extra);
    if (!r.ok) throw new Stop(`${method} ${noGuid(path).slice(0, 100)} failed HTTP ${r.status}\n${msgOf(r)}`);
    return r;
  };
  const io = {
    get: async (p) => { const r = await call('GET', p); return { ok: r.ok, status: r.status, json: r.j, message: msgOf(r) }; },
    patch: async (p, b) => { const r = await call('PATCH', p, b, { 'If-Match': '*' }); return { ok: r.ok, status: r.status, message: msgOf(r) }; },
    del: async (p, h) => { const r = await call('DELETE', p, undefined, h || {}); return { ok: r.ok, status: r.status, message: msgOf(r) }; },
  };
  return { call, must, io, msgOf };
}
