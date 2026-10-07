#!/usr/bin/env node
/**
 * Replaces every email address found under src/Workflows/ with <APPROVER_TEST_ACCOUNT>.
 * Prints counts only (per file and in total). It never prints the matched values.
 *
 * Run it after every `pac solution sync`, before `git add`.
 *
 * Usage:
 *   node scripts/scrub-emails.mjs [directory]     (default: src/Workflows)
 *
 * Notes:
 * - OData annotation names such as `field@OData.Community.Display.V1.FormattedValue` or `x@odata.bind`
 *   look like email addresses but are not, so a match whose domain part starts with `odata.` is left alone.
 * - A scrubbed flow file is not importable as is: the approver account must be filled in again.
 * - JSON files are re-parsed after the replacement. A parse failure is reported and the file is left
 *   scrubbed (the original is in git or can be re-synced).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PLACEHOLDER = '<APPROVER_TEST_ACCOUNT>';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const root = process.argv[2] ?? 'src/Workflows';

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

let total = 0;
let filesChanged = 0;
let problems = 0;

for (const file of walk(root)) {
  if (!/\.(json|xml)$/i.test(file)) continue;
  const buf = readFileSync(file);
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let text = buf.toString('utf8');
  if (bom) text = text.slice(1);

  let count = 0;
  const out = text.replace(EMAIL, (m) => {
    const domain = m.slice(m.indexOf('@') + 1);
    if (/^odata\./i.test(domain)) return m; // OData annotation, not an address
    count++;
    return PLACEHOLDER;
  });
  if (count === 0) continue;

  writeFileSync(file, (bom ? '﻿' : '') + out, 'utf8');
  total += count;
  filesChanged++;
  console.log(`${count} replacement(s) in ${file}`);

  if (/\.json$/i.test(file)) {
    try { JSON.parse(out); }
    catch (e) { problems++; console.log(`  WARNING: ${file} no longer parses as JSON: ${e.message}`); }
  }
}

console.log(total === 0
  ? 'No email addresses found.'
  : `Total: ${total} replacement(s) in ${filesChanged} file(s). The flow needs its approver account filled in again before import.`);
process.exit(problems ? 1 : 0);
