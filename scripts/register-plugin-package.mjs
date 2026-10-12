#!/usr/bin/env node
/**
 * Registers the plug-in package mwf_muwafaqaplugins through the Dataverse Web API (ADR-003).
 *
 * Modes:
 *   --mode=prelim    READ ONLY. Checks the solution, the existing package/assembly/steps, the sdkmessage and
 *                    sdkmessagefilter rows, the column metadata and the live currency rates. Prints counts and pass/fail.
 *   --mode=steps-update  MUTATES. Creates the Update step on mwf_contract (PreOperation 20, synchronous, rank 1, filtering
 *                    attribute statuscode) and its PreImage "pre" (statuscode, mwf_value, transactioncurrencyid), with the
 *                    solution header. Idempotent by step name. Reads both back and reports counts and pass/fail.
 *   --mode=steps-create  MUTATES. Creates the Create step (PreOperation 20, synchronous, rank 1, no filtering, no image).
 *   --mode=package-update  MUTATES. PATCHes the content of the EXISTING pluginpackage row with --nupkg (name and version
 *                    are not sent), then reads back the package, the assembly version and the plug-in types.
 *   --mode=steps-guard  MUTATES. Creates the three ContractStateGuard steps on mwf_contract (PreValidation 10, synchronous,
 *                    rank 1): Update (filtering attributes + PreImage "pre"), Create, Delete (PreImage "pre" with statuscode).
 *                    Idempotent by step name. Solution header at creation.
 *   --mode=phase-a   MUTATES. package-update, then steps-guard, then the full read back table.
 *   --mode=readback  READ ONLY. The read back of phase-a (package, assembly, types, plug-in 1 steps, guard steps).
 *   --mode=steps-disable / --mode=steps-enable  MUTATES. Disables or enables ONLY the three ContractStateGuard steps
 *                    (PATCH statecode of the step rows). Rollback if the guard blocks everything by mistake.
 *   --mode=package   MUTATES the environment (needs --confirm-mutates-environment). Runs the preliminaries first and stops
 *                    if one fails. Then creates the pluginpackage (unless it exists) with the solution header, verifies that
 *                    the plug-in assembly and plug-in type were created, and creates the type only if it is missing.
 *                    It does NOT create steps or images (a later mode, after review).
 *
 * Usage:
 *   node scripts/register-plugin-package.mjs --mode=prelim  --env=https://<org>.crm4.dynamics.com [--auth=device|az]
 *   node scripts/register-plugin-package.mjs --mode=package --env=https://<org>.crm4.dynamics.com --nupkg=<path> --confirm-mutates-environment
 *
 * Auth: device code (default; prints a URL and a code, the token stays in memory) or --auth=az (token from `az`).
 * Idempotent by unique name. No id, address or token is printed or stored. On any HTTP error it stops and shows the error.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
const MODE = argOf('mode');
const ENV = argOf('env').replace(/\/+$/, '');
const AUTH = argOf('auth') || 'device';
const NUPKG = argOf('nupkg');
const SOLUTION = argOf('solution') || 'Muwafaqa';
const PACKAGE_UNIQUE = 'mwf_muwafaqaplugins';
const PACKAGE_VERSION = '1.0.0';
const TYPE_NAME = 'Muwafaqa.Plugins.Contract.FreezeUsdValueOnSubmission';
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // public Azure CLI client id, same as the other scripts

if (!['prelim', 'package', 'steps-update', 'steps-create', 'package-update', 'steps-guard', 'phase-a', 'readback', 'steps-disable', 'steps-enable'].includes(MODE)) { console.error('Missing or invalid --mode. Nothing was run.'); process.exit(2); }
if (!/^https:\/\/[^/]+$/.test(ENV)) { console.error('Missing or invalid --env=https://<org>.crm4.dynamics.com. Nothing was run.'); process.exit(2); }
if (!['device', 'az'].includes(AUTH)) { console.error('Invalid --auth=device|az. Nothing was run.'); process.exit(2); }
if (MODE !== 'prelim' && MODE !== 'readback') {
  if (!process.argv.includes('--confirm-mutates-environment')) {
    console.error(`WARNING: --mode=${MODE} creates records in the environment. Add --confirm-mutates-environment to run it on purpose. Nothing was run.`);
    process.exit(2);
  }
}
if (MODE === 'package' || MODE === 'package-update' || MODE === 'phase-a') {
  if (!NUPKG) { console.error('--mode=package needs --nupkg=<path to the .nupkg>. Nothing was run.'); process.exit(2); }
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

class Stop extends Error { constructor(m, code = 4) { super(m); this.code = code; } }
async function get(path) {
  const r = await fetch(`${API}/${path}`, { headers: hdr() });
  const t = await r.text();
  if (!r.ok) throw new Stop(`GET ${noGuid(path).slice(0, 80)} failed HTTP ${r.status}\n${noGuid(t).slice(0, 800)}`);
  return JSON.parse(t);
}
async function post(path, body, extra = {}) {
  const r = await fetch(`${API}/${path}`, { method: 'POST', headers: hdr(extra), body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Stop(`POST ${path} failed HTTP ${r.status}\n${noGuid(t).slice(0, 1200)}`);
  const m = /\(([0-9a-fA-F-]{36})\)/.exec(r.headers.get('OData-EntityId') || '');
  return { id: m ? m[1] : null };
}

async function patchRow(path, body) {
  const r = await fetch(`${API}/${path}`, { method: 'PATCH', headers: hdr({ 'If-Match': '*' }), body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Stop(`PATCH ${noGuid(path).slice(0, 60)} failed HTTP ${r.status}\n${noGuid(t).slice(0, 1200)}`);
}

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`); };

async function prelim() {
  const ctx = {};
  console.log('--- a. read-only preliminaries');

  const sol = (await get(`solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid,uniquename,ismanaged,version`)).value;
  check('solution exists, unmanaged', sol.length === 1 && sol[0].ismanaged === false, `count=${sol.length}${sol[0] ? `, version ${sol[0].version}` : ''}`);
  ctx.solutionId = sol[0]?.solutionid;

  const pkgs = (await get(`pluginpackages?$filter=uniquename eq '${PACKAGE_UNIQUE}'&$select=pluginpackageid,uniquename,version,name`)).value;
  check('package does not exist yet (count 0 = create, 1 = skip create)', pkgs.length <= 1, `count=${pkgs.length}${pkgs[0] ? `, version ${pkgs[0].version}` : ''}`);
  ctx.pkgId = pkgs[0]?.pluginpackageid;
  const otherPkgs = (await get(`pluginpackages?$filter=contains(uniquename,'muwafaqa') or contains(name,'Muwafaqa')&$select=uniquename`)).value;
  console.log(`INFO  packages with Muwafaqa in the name: ${otherPkgs.length}`);

  const asm = (await get(`pluginassemblies?$filter=contains(name,'Muwafaqa')&$select=name,version`)).value;
  console.log(`INFO  plug-in assemblies with Muwafaqa in the name: ${asm.length}`);

  const msgs = (await get(`sdkmessages?$filter=name eq 'Create' or name eq 'Update'&$select=sdkmessageid,name`)).value;
  const byName = (n) => msgs.filter((m) => m.name === n);
  check('sdkmessage Create (exactly 1)', byName('Create').length === 1, `count=${byName('Create').length}`);
  check('sdkmessage Update (exactly 1)', byName('Update').length === 1, `count=${byName('Update').length}`);
  for (const n of ['Create', 'Update']) {
    if (byName(n).length !== 1) continue;
    const f = (await get(`sdkmessagefilters?$filter=_sdkmessageid_value eq ${byName(n)[0].sdkmessageid} and primaryobjecttypecode eq 'mwf_contract'&$select=sdkmessagefilterid`)).value;
    check(`sdkmessagefilter ${n} on mwf_contract (exactly 1)`, f.length === 1, `count=${f.length}`);
  }

  const steps = (await get(`sdkmessageprocessingsteps?$filter=contains(name,'FreezeUsdValueOnSubmission')&$select=name`)).value;
  check('no existing step for the plug-in', steps.length === 0, `count=${steps.length}`);

  const ent = `EntityDefinitions(LogicalName='mwf_contract')/Attributes`;
  const money = await get(`${ent}(LogicalName='mwf_value')/Microsoft.Dynamics.CRM.MoneyAttributeMetadata?$select=MinValue,MaxValue,PrecisionSource,RequiredLevel`);
  console.log(`INFO  mwf_value: type Money, MinValue ${money.MinValue}, MaxValue ${money.MaxValue}, RequiredLevel ${money.RequiredLevel.Value}, PrecisionSource ${money.PrecisionSource}`);
  const cur = await get(`${ent}(LogicalName='transactioncurrencyid')?$select=RequiredLevel,AttributeType`);
  console.log(`INFO  transactioncurrencyid: ${cur.AttributeType}, RequiredLevel ${cur.RequiredLevel.Value}`);
  const frozen = await get(`${ent}(LogicalName='mwf_valueusdfrozen')/Microsoft.Dynamics.CRM.DecimalAttributeMetadata?$select=Precision,RequiredLevel`);
  check('mwf_valueusdfrozen is Decimal, precision 2, required level None', frozen.Precision === 2 && frozen.RequiredLevel.Value === 'None', `precision ${frozen.Precision}, ${frozen.RequiredLevel.Value}`);

  const cs = (await get(`transactioncurrencies?$select=isocurrencycode,exchangerate,statecode,currencyprecision&$orderby=isocurrencycode`)).value;
  console.log('INFO  live currencies (ISO, exchangerate, state, precision):');
  for (const c of cs) console.log(`        ${c.isocurrencycode}  ${c.exchangerate}  ${c.statecode === 0 ? 'active' : 'inactive'}  ${c.currencyprecision}`);
  const usd = cs.filter((c) => c.isocurrencycode === 'USD' && c.statecode === 0);
  check('exactly one active USD with rate > 0', usd.length === 1 && Number(usd[0].exchangerate) > 0, `count=${usd.length}`);

  const org = (await get(`organizations?$select=plugintracelogsetting`)).value[0];
  console.log(`INFO  plug-in trace log setting: ${org.plugintracelogsetting} (0 Off, 1 Exception, 2 All)`);
  return ctx;
}

async function packageStep(ctx) {
  console.log('\n--- b. create the plug-in package');
  const bytes = readFileSync(NUPKG);
  const sha = createHash('sha256').update(bytes).digest('hex');
  console.log(`INFO  nupkg size ${statSync(NUPKG).size} bytes, SHA-256 ${sha}`);

  let pkgId = ctx.pkgId;
  if (pkgId) {
    console.log('SKIP  package already exists (idempotent), no create');
  } else {
    const r = await post('pluginpackages', {
      name: PACKAGE_UNIQUE, uniquename: PACKAGE_UNIQUE, version: PACKAGE_VERSION, content: bytes.toString('base64'),
    }, { 'MSCRM.SolutionUniqueName': SOLUTION });
    pkgId = r.id;
    check('POST pluginpackages accepted (solution header set)', !!pkgId, '');
  }

  // assembly and type are expected to be created by the platform from the package content
  let asm = [];
  for (let i = 0; i < 20; i++) {
    asm = (await get(`pluginassemblies?$filter=_packageid_value eq ${pkgId}&$select=name,version,isolationmode,sourcetype`)).value;
    if (asm.length) break;
    await sleep(3000);
  }
  check('plug-in assembly created from the package', asm.length === 1, `count=${asm.length}${asm[0] ? `, name ${asm[0].name}, version ${asm[0].version}, isolation ${asm[0].isolationmode}` : ''}`);
  if (asm.length !== 1) throw new Stop('The plug-in assembly was not created from the package. Stopping.', 5);

  const asmId = asm[0].pluginassemblyid;
  const types = async () => (await get(`plugintypes?$filter=_pluginassemblyid_value eq ${asmId}&$select=typename,friendlyname`)).value;
  let ts = [];
  for (let i = 0; i < 10; i++) { ts = await types(); if (ts.length) break; await sleep(3000); }
  console.log(`INFO  plug-in types found: ${ts.length}${ts.length ? ` (${ts.map((t) => t.typename).join(', ')})` : ''}`);
  const have = ts.some((t) => t.typename === TYPE_NAME);
  check('plug-in type created automatically', have, have ? TYPE_NAME : 'missing');
  if (!have) {
    await post('plugintypes', { typename: TYPE_NAME, friendlyname: TYPE_NAME, name: TYPE_NAME, 'pluginassemblyid@odata.bind': `/pluginassemblies(${asmId})` });
    ts = await types();
    check('plug-in type created by this script', ts.some((t) => t.typename === TYPE_NAME), TYPE_NAME);
  }

  if (ctx.solutionId) {
    const inSol = async (objectId) => (await get(`solutioncomponents?$filter=_solutionid_value eq ${ctx.solutionId} and objectid eq ${objectId}&$select=componenttype`)).value;
    const p = await inSol(pkgId);
    check('package is a component of the solution', p.length >= 1, `count=${p.length}${p[0] ? `, componenttype ${p[0].componenttype}` : ''}`);
    const a = await inSol(asmId);
    console.log(`INFO  assembly rows in the solution components: ${a.length}${a[0] ? `, componenttype ${a[0].componenttype}` : ''}`);
  }
  console.log('\nSTOP: steps and images are not created by this mode.');
}

async function stepLookups(message) {
  const msg = (await get(`sdkmessages?$filter=name eq '${message}'&$select=sdkmessageid`)).value;
  if (msg.length !== 1) throw new Stop(`sdkmessage ${message}: expected 1, found ${msg.length}`, 3);
  const flt = (await get(`sdkmessagefilters?$filter=_sdkmessageid_value eq ${msg[0].sdkmessageid} and primaryobjecttypecode eq 'mwf_contract'&$select=sdkmessagefilterid`)).value;
  if (flt.length !== 1) throw new Stop(`sdkmessagefilter ${message} on mwf_contract: expected 1, found ${flt.length}`, 3);
  const pk = (await get(`pluginpackages?$filter=uniquename eq '${PACKAGE_UNIQUE}'&$select=pluginpackageid`)).value;
  if (pk.length !== 1) throw new Stop(`plug-in package: expected 1, found ${pk.length}`, 3);
  const as = (await get(`pluginassemblies?$filter=_packageid_value eq ${pk[0].pluginpackageid}&$select=name`)).value;
  if (as.length !== 1) throw new Stop(`plug-in assembly: expected 1, found ${as.length}`, 3);
  const ty = (await get(`plugintypes?$filter=_pluginassemblyid_value eq ${as[0].pluginassemblyid} and typename eq '${TYPE_NAME}'&$select=typename`)).value;
  if (ty.length !== 1) throw new Stop(`plug-in type: expected 1, found ${ty.length}`, 3);
  const sol = (await get(`solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid`)).value;
  if (sol.length !== 1) throw new Stop(`solution: expected 1, found ${sol.length}`, 3);
  return { messageId: msg[0].sdkmessageid, filterId: flt[0].sdkmessagefilterid, typeId: ty[0].plugintypeid, solutionId: sol[0].solutionid };
}

async function stepsStep(message) {
  const isUpdate = message === 'Update';
  console.log(`\n--- create the ${message} step${isUpdate ? ' and the PreImage' : ''}`);
  const L = await stepLookups(message);
  const stepName = `${TYPE_NAME}: ${message} of mwf_contract`;
  const existing = (await get(`sdkmessageprocessingsteps?$filter=name eq '${stepName}'&$select=name`)).value;
  let stepId = existing[0]?.sdkmessageprocessingstepid;
  if (stepId) {
    console.log('SKIP  step already exists (idempotent), no create');
  } else {
    const body = {
      name: stepName,
      description: isUpdate
        ? 'Freezes the USD value when a contract enters Pending Approval (status pass of an Update).'
        : 'Freezes the USD value when a contract is created directly as Pending Approval.',
      stage: 20, mode: 0, rank: 1, supporteddeployment: 0, asyncautodelete: false,
      'sdkmessageid@odata.bind': `/sdkmessages(${L.messageId})`,
      'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${L.filterId})`,
      'eventhandler_plugintype@odata.bind': `/plugintypes(${L.typeId})`,
    };
    if (isUpdate) body.filteringattributes = 'statuscode';
    stepId = (await post('sdkmessageprocessingsteps', body, { 'MSCRM.SolutionUniqueName': SOLUTION })).id;
    check(`POST ${message} step accepted (solution header set)`, !!stepId, '');
  }

  if (isUpdate) {
    const imgs = (await get(`sdkmessageprocessingstepimages?$filter=_sdkmessageprocessingstepid_value eq ${stepId}&$select=name`)).value;
    if (imgs.length) {
      console.log(`SKIP  image already exists (count=${imgs.length}), no create`);
    } else {
      const r = await post('sdkmessageprocessingstepimages', {
        name: 'pre', entityalias: 'pre', imagetype: 0, messagepropertyname: 'Target',
        attributes: 'statuscode,mwf_value,transactioncurrencyid',
        'sdkmessageprocessingstepid@odata.bind': `/sdkmessageprocessingsteps(${stepId})`,
      });
      check('POST PreImage accepted', !!r.id, '');
    }
  }

  const st = await get(`sdkmessageprocessingsteps(${stepId})?$select=name,stage,mode,rank,filteringattributes,statecode,statuscode,supporteddeployment,asyncautodelete`);
  const want = { stage: 20, mode: 0, rank: 1, supporteddeployment: 0, statecode: 0 };
  const okStep = Object.entries(want).every(([k, v]) => st[k] === v) && (isUpdate ? st.filteringattributes === 'statuscode' : !st.filteringattributes);
  check(`${message} step read back: stage 20, sync, rank 1, deployment server, enabled${isUpdate ? ', filtering statuscode' : ', no filtering'}`, okStep,
    `stage ${st.stage}, mode ${st.mode}, rank ${st.rank}, state ${st.statecode === 0 ? 'Enabled' : 'Disabled'}, filtering ${JSON.stringify(st.filteringattributes ?? null)}`);
  const im = (await get(`sdkmessageprocessingstepimages?$filter=_sdkmessageprocessingstepid_value eq ${stepId}&$select=name,entityalias,imagetype,attributes,messagepropertyname`)).value;
  if (isUpdate) {
    const i = im[0];
    const okImg = im.length === 1 && i.entityalias === 'pre' && i.imagetype === 0 && i.messagepropertyname === 'Target'
      && JSON.stringify(i.attributes.split(',').sort()) === JSON.stringify(['mwf_value', 'statuscode', 'transactioncurrencyid']);
    check('PreImage read back: alias pre, PreImage, Target, 3 attributes', okImg, `count=${im.length}${i ? `, attributes ${i.attributes}` : ''}`);
  } else {
    check('Create step has no image', im.length === 0, `count=${im.length}`);
  }
  const sc = (await get(`solutioncomponents?$filter=_solutionid_value eq ${L.solutionId} and objectid eq ${stepId}&$select=componenttype`)).value;
  check(`${message} step is a component of the solution`, sc.length >= 1, `count=${sc.length}${sc[0] ? `, componenttype ${sc[0].componenttype}` : ''}`);
}

// ---------------------------------------------------------------- guard release (ADR-004)
const GUARD_TYPE = 'Muwafaqa.Plugins.Contract.ContractStateGuard';
const GUARD_UPDATE_COLUMNS = 'statuscode,statecode,mwf_value,transactioncurrencyid,mwf_contracttype,mwf_direction,mwf_counterpartyid,mwf_contractnumber,mwf_valueusdfrozen';
const SORT = (csv) => csv.split(',').map((x) => x.trim()).sort().join(',');
const EXPECTED_ASSEMBLY_VERSION = '1.0.1.0';

async function getPackage() {
  const pk = (await get(`pluginpackages?$filter=uniquename eq '${PACKAGE_UNIQUE}'&$select=name,uniquename,version`)).value;
  if (pk.length !== 1) throw new Stop(`plug-in package: expected 1, found ${pk.length}`, 3);
  return pk[0];
}
async function getAssembly(pkgId) {
  const as = (await get(`pluginassemblies?$filter=_packageid_value eq ${pkgId}&$select=name,version`)).value;
  if (as.length !== 1) throw new Stop(`plug-in assembly: expected 1, found ${as.length}`, 3);
  return as[0];
}
async function getTypes(asmId) {
  return (await get(`plugintypes?$filter=_pluginassemblyid_value eq ${asmId}&$select=typename`)).value;
}

async function packageUpdate() {
  console.log('\n--- package update (PATCH content of the existing package)');
  const bytes = readFileSync(NUPKG);
  console.log(`INFO  nupkg size ${statSync(NUPKG).size} bytes, SHA-256 ${createHash('sha256').update(bytes).digest('hex')}`);
  const pk = await getPackage();
  const before = await getAssembly(pk.pluginpackageid);
  console.log(`INFO  before: package ${pk.uniquename} version ${pk.version}; assembly ${before.name} version ${before.version}`);
  await patchRow(`pluginpackages(${pk.pluginpackageid})`, { content: bytes.toString('base64') });
  check('PATCH pluginpackages accepted (content only)', true, '');
  let asm = null;
  for (let i = 0; i < 20; i++) {
    asm = await getAssembly(pk.pluginpackageid);
    if (asm.version === EXPECTED_ASSEMBLY_VERSION) break;
    await sleep(3000);
  }
  const pk2 = await getPackage();
  check('package name and version unchanged', pk2.uniquename === PACKAGE_UNIQUE && pk2.version === pk.version, `${pk2.uniquename} ${pk2.version}`);
  check(`assembly version is ${EXPECTED_ASSEMBLY_VERSION}`, asm.version === EXPECTED_ASSEMBLY_VERSION, `${asm.name} ${asm.version}`);
  const types = (await getTypes(asm.pluginassemblyid)).map((t) => t.typename).sort();
  console.log(`INFO  plug-in types: ${types.join(', ')}`);
  check('type FreezeUsdValueOnSubmission present', types.includes(TYPE_NAME), '');
  check('type ContractStateGuard present', types.includes(GUARD_TYPE), '');
}

async function guardLookups(message) {
  const L = await stepLookups(message);          // also checks package, assembly and the Freeze type
  const pk = await getPackage();
  const asm = await getAssembly(pk.pluginpackageid);
  const ty = (await get(`plugintypes?$filter=_pluginassemblyid_value eq ${asm.pluginassemblyid} and typename eq '${GUARD_TYPE}'&$select=typename`)).value;
  if (ty.length !== 1) throw new Stop(`plug-in type ${GUARD_TYPE}: expected 1, found ${ty.length}`, 3);
  return { ...L, guardTypeId: ty[0].plugintypeid };
}

async function stepsGuard() {
  console.log('\n--- register the three ContractStateGuard steps');
  for (const message of ['Update', 'Create', 'Delete']) {
    const L = await guardLookups(message);
    const stepName = `${GUARD_TYPE}: ${message} of mwf_contract`;
    const ex = (await get(`sdkmessageprocessingsteps?$filter=name eq '${stepName}'&$select=name`)).value;
    let stepId = ex[0]?.sdkmessageprocessingstepid;
    if (stepId) {
      console.log(`SKIP  ${message} step already exists (idempotent)`);
    } else {
      const body = {
        name: stepName,
        description: `Contract State Guard (ADR-004): ${message} of mwf_contract, PreValidation.`,
        stage: 10, mode: 0, rank: 1, supporteddeployment: 0, asyncautodelete: false,
        'sdkmessageid@odata.bind': `/sdkmessages(${L.messageId})`,
        'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${L.filterId})`,
        'eventhandler_plugintype@odata.bind': `/plugintypes(${L.guardTypeId})`,
      };
      if (message === 'Update') body.filteringattributes = GUARD_UPDATE_COLUMNS;
      stepId = (await post('sdkmessageprocessingsteps', body, { 'MSCRM.SolutionUniqueName': SOLUTION })).id;
      check(`POST ${message} guard step accepted (solution header set)`, !!stepId, '');
    }
    if (message === 'Update' || message === 'Delete') {
      const im = (await get(`sdkmessageprocessingstepimages?$filter=_sdkmessageprocessingstepid_value eq ${stepId}&$select=name`)).value;
      if (im.length) {
        console.log(`SKIP  ${message} image already exists (count=${im.length})`);
      } else {
        const r = await post('sdkmessageprocessingstepimages', {
          name: 'pre', entityalias: 'pre', imagetype: 0, messagepropertyname: 'Target',
          attributes: message === 'Update' ? GUARD_UPDATE_COLUMNS : 'statuscode',
          'sdkmessageprocessingstepid@odata.bind': `/sdkmessageprocessingsteps(${stepId})`,
        });
        check(`POST ${message} PreImage accepted`, !!r.id, '');
      }
    }
  }
}

async function readbackAll() {
  console.log('\n--- read back');
  const pk = await getPackage();
  const asm = await getAssembly(pk.pluginpackageid);
  const types = await getTypes(asm.pluginassemblyid);
  console.log(`package   : ${pk.name} | unique ${pk.uniquename} | version ${pk.version}`);
  console.log(`assembly  : ${asm.name} | version ${asm.version}`);
  console.log(`types     : ${types.map((t) => t.typename).sort().join(', ')}`);
  check('assembly version 1.0.1.0', asm.version === EXPECTED_ASSEMBLY_VERSION, asm.version);
  const freeze = types.find((t) => t.typename === TYPE_NAME);
  const guard = types.find((t) => t.typename === GUARD_TYPE);
  check('both plug-in types exist in the assembly', !!freeze && !!guard, '');
  const sol = (await get(`solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid`)).value[0];

  const rows = [];
  const names = [
    ['plug-in 1', `${TYPE_NAME}: Update of mwf_contract`, freeze], ['plug-in 1', `${TYPE_NAME}: Create of mwf_contract`, freeze],
    ['guard', `${GUARD_TYPE}: Update of mwf_contract`, guard], ['guard', `${GUARD_TYPE}: Create of mwf_contract`, guard],
    ['guard', `${GUARD_TYPE}: Delete of mwf_contract`, guard],
  ];
  for (const [owner, name, type] of names) {
    const st = (await get(`sdkmessageprocessingsteps?$filter=name eq '${name}'&$select=name,stage,mode,rank,filteringattributes,statecode,supporteddeployment,_eventhandler_value`)).value;
    if (st.length !== 1) { check(`${name} exists once`, false, `count=${st.length}`); continue; }
    const s0 = st[0];
    const im = (await get(`sdkmessageprocessingstepimages?$filter=_sdkmessageprocessingstepid_value eq ${s0.sdkmessageprocessingstepid}&$select=entityalias,imagetype,messagepropertyname,attributes`)).value;
    const sc = sol ? (await get(`solutioncomponents?$filter=_solutionid_value eq ${sol.solutionid} and objectid eq ${s0.sdkmessageprocessingstepid}&$select=componenttype`)).value : [];
    rows.push({
      owner, step: name.split(': ')[1], stage: s0.stage, mode: s0.mode, rank: s0.rank,
      state: s0.statecode === 0 ? 'Enabled' : 'Disabled', deployment: s0.supporteddeployment,
      filter: s0.filteringattributes ? 'yes (' + s0.filteringattributes.split(',').length + ')' : 'none',
      image: im.length ? `${im[0].entityalias}/${im[0].imagetype === 0 ? 'Pre' : im[0].imagetype}/${im[0].messagepropertyname} (${im[0].attributes.split(',').length})` : 'none',
      inSolution: sc.length ? 'yes' : 'NO',
      pointsTo: s0._eventhandler_value === type?.plugintypeid ? 'assembly type ok' : 'MISMATCH',
      _filter: s0.filteringattributes || '', _im: im[0]?.attributes || '',
    });
  }
  console.log('\nowner      step    stage mode rank state    deploy filter    image                          solution  handler');
  for (const r of rows) {
    console.log(`${r.owner.padEnd(10)} ${r.step.padEnd(7)} ${String(r.stage).padEnd(5)} ${String(r.mode).padEnd(4)} ${String(r.rank).padEnd(4)} ${r.state.padEnd(8)} ${String(r.deployment).padEnd(6)} ${r.filter.padEnd(9)} ${r.image.padEnd(30)} ${r.inSolution.padEnd(9)} ${r.pointsTo}`);
  }
  const g = (m) => rows.find((r) => r.owner === 'guard' && r.step.startsWith(m));
  check('plug-in 1 steps (Update, Create): Enabled, stage 20, pointing to the assembly',
    rows.filter((r) => r.owner === 'plug-in 1').length === 2 && rows.filter((r) => r.owner === 'plug-in 1').every((r) => r.state === 'Enabled' && r.stage === 20 && r.pointsTo === 'assembly type ok'), '');
  const gu = g('Update'), gc = g('Create'), gd = g('Delete');
  check('guard Update: stage 10, sync, rank 1, filtering and PreImage = the 9 columns', !!gu && gu.stage === 10 && gu.mode === 0 && gu.rank === 1
    && SORT(gu._filter) === SORT(GUARD_UPDATE_COLUMNS) && SORT(gu._im) === SORT(GUARD_UPDATE_COLUMNS), '');
  check('guard Create: stage 10, sync, rank 1, no filtering, no image', !!gc && gc.stage === 10 && gc.mode === 0 && gc.rank === 1 && gc.filter === 'none' && gc.image === 'none', '');
  check('guard Delete: stage 10, sync, rank 1, PreImage = statuscode only', !!gd && gd.stage === 10 && gd.mode === 0 && gd.rank === 1 && gd._im === 'statuscode', '');
  check('all five steps are solution components', rows.length === 5 && rows.every((r) => r.inSolution === 'yes'), '');
  check('guard steps point to the ContractStateGuard type', ['Update', 'Create', 'Delete'].every((m) => g(m)?.pointsTo === 'assembly type ok'), '');
}

async function setGuardState(enable) {
  console.log(`\n--- ${enable ? 'enable' : 'disable'} the ContractStateGuard steps only`);
  for (const message of ['Update', 'Create', 'Delete']) {
    const name = `${GUARD_TYPE}: ${message} of mwf_contract`;
    const st = (await get(`sdkmessageprocessingsteps?$filter=name eq '${name}'&$select=name,statecode`)).value;
    if (st.length !== 1) throw new Stop(`${name}: expected 1, found ${st.length}`, 3);
    const want = enable ? 0 : 1;
    if (st[0].statecode !== want) {
      await patchRow(`sdkmessageprocessingsteps(${st[0].sdkmessageprocessingstepid})`, enable ? { statecode: 0, statuscode: 1 } : { statecode: 1, statuscode: 2 });
    }
    const after = (await get(`sdkmessageprocessingsteps(${st[0].sdkmessageprocessingstepid})?$select=statecode`)).statecode;
    check(`${message} guard step is ${enable ? 'Enabled' : 'Disabled'}`, after === want, '');
  }
}

(async () => {
  try {
    TOKEN = AUTH === 'az'
      ? execSync(`az account get-access-token --resource ${ENV} --query accessToken -o tsv`, { encoding: 'utf8', shell: true }).trim()
      : await deviceToken();
    if (['package-update', 'steps-guard', 'phase-a', 'readback', 'steps-disable', 'steps-enable'].includes(MODE)) {
      if (MODE === 'package-update' || MODE === 'phase-a') await packageUpdate();
      if (MODE === 'steps-guard' || MODE === 'phase-a') await stepsGuard();
      if (MODE === 'steps-disable') await setGuardState(false);
      if (MODE === 'steps-enable') await setGuardState(true);
      if (['steps-guard', 'phase-a', 'readback', 'package-update'].includes(MODE)) await readbackAll();
      const badP = results.filter((r) => !r.pass).length;
      console.log(`\nSUMMARY: ${results.length - badP} passed, ${badP} failed.`);
      process.exit(badP ? 1 : 0);
    }
    if (MODE === 'steps-update' || MODE === 'steps-create') {
      await stepsStep(MODE === 'steps-update' ? 'Update' : 'Create');
      const badS = results.filter((r) => !r.pass).length;
      console.log(`\nSUMMARY: ${results.length - badS} passed, ${badS} failed.`);
      process.exit(badS ? 1 : 0);
    }
    const ctx = await prelim();
    if (MODE === 'package') {
      const failed = results.filter((r) => !r.pass);
      if (failed.length) throw new Stop(`Preliminaries failed (${failed.length}). Nothing was created.`, 3);
      await packageStep(ctx);
    }
    const bad = results.filter((r) => !r.pass).length;
    console.log(`\nSUMMARY: ${results.length - bad} passed, ${bad} failed.`);
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error(`\nSTOPPED: ${noGuid(e.message)}`);
    process.exit(e.code || 1);
  }
})();
