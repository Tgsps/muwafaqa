#!/usr/bin/env node
/**
 * Scrubs two kinds of environment-specific values from the exported flow under src/Workflows/:
 *   1. every email address                         -> <APPROVER_TEST_ACCOUNT>
 *   2. the host of the link to a contract record   -> <ORG_HOST>
 *      (the host of https://<host>/main.aspx?etn=..., for example in WebhookApprovalCreationInput/itemLink)
 * Prints counts only (per file and in total). It never prints the matched values.
 *
 * Run it after every `pac solution sync`, before `git add`.
 *
 * Usage:
 *   node scripts/scrub-emails.mjs [directory]            (default: src/Workflows)
 *   node scripts/scrub-emails.mjs [directory] --env=https://<org>.crm4.dynamics.com
 *   node scripts/scrub-emails.mjs --self-test            (no files are read or written)
 *
 * Notes:
 * - The host is NOT written in this script. It is found by the URL pattern (the host in front of /main.aspx?etn=).
 *   With --env=<url> (the same value the other scripts take, never committed) every other occurrence of exactly that
 *   host in the scanned files is replaced too.
 * - OData annotation names such as `field@OData.Community.Display.V1.FormattedValue` or `x@odata.bind`
 *   look like email addresses but are not, so a match whose domain part starts with `odata.` is left alone.
 * - A scrubbed flow file is not importable as is: the approver account must be filled in again, and the host
 *   placeholder is not a valid link until it is replaced by the real host.
 * - Idempotent: the placeholders contain "<", so a second run finds nothing to replace.
 * - JSON files are re-parsed after the replacement. A parse failure is reported and the file is left
 *   scrubbed (the original is in git or can be re-synced).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EMAIL_PLACEHOLDER = '<APPROVER_TEST_ACCOUNT>';
const HOST_PLACEHOLDER = '<ORG_HOST>';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// the host of a link to a record page: https://<host>/main.aspx?etn=
const RECORD_LINK_HOST = /https:\/\/[A-Za-z0-9.-]+(?=\/main\.aspx\?etn=)/g;

/** Pure function: returns the scrubbed text and the counts. */
export function scrub(text, envHost = null) {
  let emails = 0;
  let hosts = 0;
  let out = text.replace(EMAIL, (m) => {
    const domain = m.slice(m.indexOf('@') + 1);
    if (/^odata\./i.test(domain)) return m; // OData annotation, not an address
    emails++;
    return EMAIL_PLACEHOLDER;
  });
  out = out.replace(RECORD_LINK_HOST, () => { hosts++; return `https://${HOST_PLACEHOLDER}`; });
  if (envHost) {
    const esc = envHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(esc, 'gi'), () => { hosts++; return HOST_PLACEHOLDER; });
  }
  return { out, emails, hosts };
}

function selfTest() {
  // Fictional values only. Nothing is printed except PASS/FAIL.
  const fakeHost = 'fictional-org.crm.example.test';
  const sample = JSON.stringify({
    itemLink: `https://${fakeHost}/main.aspx?etn=mwf_contract&pagetype=entityrecord&id=@{x}`,
    note: `see https://${fakeHost}/api/data/v9.2`,
    who: 'someone' + '@' + 'example.com', // built at run time: no email-like literal in the source
    ann: 'x@odata.bind',
  });
  const checks = [];
  const a = scrub(sample);
  checks.push(['replaces the record-link host', a.hosts === 1 && a.out.includes(`https://${HOST_PLACEHOLDER}/main.aspx?etn=`) && !a.out.includes(`${fakeHost}/main.aspx`)]);
  checks.push(['leaves a host that is not a record link (only --env replaces it)', a.out.includes(`${fakeHost}/api/data`)]);
  checks.push(['replaces the email', a.emails === 1 && !a.out.includes('someone@')]);
  checks.push(['leaves the OData annotation', a.out.includes('x@odata.bind')]);
  checks.push(['output is still valid JSON', (() => { try { JSON.parse(a.out); return true; } catch { return false; } })()]);
  const b = scrub(a.out);
  checks.push(['idempotent (second run replaces nothing)', b.hosts === 0 && b.emails === 0 && b.out === a.out]);
  const c = scrub(sample, `https://${fakeHost}`);
  checks.push(['--env replaces the other occurrence too', c.hosts === 2 && !c.out.includes('fictional-org')]);
  let bad = 0;
  for (const [n, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); if (!ok) bad++; }
  console.log(bad ? `SELF-TEST FAILED (${bad})` : `SELF-TEST OK (${checks.length} checks)`);
  process.exit(bad ? 1 : 0);
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) selfTest();

const envArg = (args.find((a) => a.startsWith('--env=')) || '').slice(6);
let envHost = null;
if (envArg) {
  try { envHost = new URL(envArg).host; } catch { console.error('Invalid --env value. Nothing was scrubbed.'); process.exit(2); }
}
const root = args.find((a) => !a.startsWith('--')) ?? 'src/Workflows';

if (!existsSync(root)) {
  console.log(`Nothing to scrub: ${root} does not exist.`);
  process.exit(0);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

let totalEmails = 0;
let totalHosts = 0;
let filesChanged = 0;
let problems = 0;

for (const file of walk(root)) {
  if (!/\.(json|xml)$/i.test(file)) continue;
  const buf = readFileSync(file);
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let text = buf.toString('utf8');
  if (bom) text = text.slice(1);

  const { out, emails, hosts } = scrub(text, envHost);
  if (emails === 0 && hosts === 0) continue;

  writeFileSync(file, (bom ? '﻿' : '') + out, 'utf8');
  totalEmails += emails;
  totalHosts += hosts;
  filesChanged++;
  console.log(`${emails} email replacement(s), ${hosts} host replacement(s) in ${file}`);

  if (/\.json$/i.test(file)) {
    try { JSON.parse(out); }
    catch (e) { problems++; console.log(`  WARNING: ${file} no longer parses as JSON: ${e.message}`); }
  }
}

console.log(totalEmails + totalHosts === 0
  ? 'No email addresses or record-link hosts found.'
  : `Total: ${totalEmails} email replacement(s) and ${totalHosts} host replacement(s) in ${filesChanged} file(s). `
    + 'The flow needs its approver account and its host filled in again before import.');
process.exit(problems ? 1 : 0);
