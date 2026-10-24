/**
 * Pure part of scripts/test-security-roles.mjs (ADR-008, behavioral test of the project roles with a Dataverse application user).
 * No network. No secret is ever stored here: the values come from the environment variables at run time and are passed in by the caller.
 */

export const ENV_NAMES = ['MWF_TEST_TENANT_ID', 'MWF_TEST_CLIENT_ID', 'MWF_TEST_CLIENT_SECRET'];
export const PREFIX = 'TEST-TMP-SEC';
/** A GUID that cannot exist: a denied write on it must answer 403 before any lookup (a 404 means the privilege check did not decide). */
export const NIL_ID = ['00000000', '0000', '0000', '0000', '000000000001'].join('-');   // built at run time: a placeholder, not an id
export const ROLE_ORDER = ['Muwafaqa Requester', 'Muwafaqa Approver', 'Muwafaqa Finance', 'Muwafaqa Admin'];

/** The names (never the values) of the variables that are not set or are empty. */
export function missingEnv(env = {}, names = ENV_NAMES) {
  return names.filter((n) => typeof env[n] !== 'string' || env[n].trim() === '');
}

/** The client credentials token request (OAuth 2.0 v2, scope = <environment url>/.default). The caller sends it; nothing here is printed. */
export function tokenRequest(tenantId, clientId, clientSecret, envUrl) {
  return {
    url: `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: `${envUrl.replace(/\/+$/, '')}/.default` }).toString(),
  };
}

/** Assign a role to a user: POST systemusers(<user>)/systemuserroles_association/$ref with the id of the role. */
export const associatePath = (userId) => `systemusers(${userId})/systemuserroles_association/$ref`;
export const associateBody = (envUrl, roleId) => ({ '@odata.id': `${envUrl.replace(/\/+$/, '')}/api/data/v9.2/roles(${roleId})` });
/**
 * Remove a role from a user: DELETE systemusers(<user>)/systemuserroles_association/$ref?$id=<absolute url of the role>. Learn documents this form ("The
 * following request also works") next to the one with the key in parentheses; the owner chose this one. A 4xx answer stops the script: no other form is tried.
 */
export const disassociatePath = (userId, roleId, envUrl) => `systemusers(${userId})/systemuserroles_association/$ref?$id=${envUrl.replace(/\/+$/, '')}/api/data/v9.2/roles(${roleId})`;

/** The roles held by the application user at the start: none or the Requester only (owner decision). */
export const startRolesOk = (held) => (held || []).every((n) => n === 'Muwafaqa Requester');
/**
 * What to do before the phase of `role`, from the roles the application user holds now: nothing other than the role of the phase may be held
 * ('stop'); the role itself is already there ('already'); none is held ('assign').
 */
export function phaseDecision(held, role) {
  const other = (held || []).filter((n) => n !== role);
  if (other.length) return { action: 'stop', reason: `the application user holds ${other.length} role(s) besides ${role}` };
  return (held || []).includes(role) ? { action: 'already' } : { action: 'assign' };
}
/** The roles to take away in the finally block: every PROJECT role that is held (a role that is not ours is never touched). */
export const rolesToRelease = (held) => (held || []).filter((n) => ROLE_ORDER.includes(n));

/**
 * A function that removes from a text: the environment URL and host, the organization name (first label of the host), every GUID, and any secret
 * value it was given (defensive: a secret must never reach the output, a file or a log).
 */
export function makeRedactor(envUrl, secrets = []) {
  const host = String(envUrl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const org = host.split('.')[0];
  const lits = [String(envUrl || ''), host, org, ...secrets].filter((s) => s && s.length >= 4);
  return (text) => {
    let t = String(text ?? '');
    for (const s of lits.sort((a, b) => b.length - a.length)) t = t.split(s).join('<redacted>');
    return t.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>');
  };
}

/**
 * Verdict of one request against its expectation.
 *   'allow'  : any 2xx passes.
 *   'deny'   : 401 or 403 passes (the privilege check refused it); a status listed in `accept` also passes (for example 400 when a plug-in rule refuses);
 *              anything else (a 2xx above all, or a 404 that does not say who refused) is a FAIL.
 * @returns {'PASS'|'FAIL'}
 */
export function judge(expect, status, accept = []) {
  if (expect === 'allow') return status >= 200 && status < 300 ? 'PASS' : 'FAIL';
  if (expect === 'deny') return status === 401 || status === 403 || accept.includes(status) ? 'PASS' : 'FAIL';
  throw new Error(`unknown expectation ${expect}`);
}

/** A denial probe on a record that cannot exist: 403 is conclusive (PASS); 404 is not (OBS: the lookup may come before the privilege check); 2xx is a FAIL. */
export function judgeProbeOnNilId(status) {
  if (status === 401 || status === 403) return 'PASS';
  if (status === 404) return 'OBS';
  return 'FAIL';
}

/** The first line of the privilege message of an error, short, for the log (the caller redacts it). */
export function shortMessage(text, max = 220) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Polls `probe()` (async, returns true when the state is reached) every `everyMs` up to `timeoutMs`; sleep is injectable for tests. */
export async function pollUntil(probe, { timeoutMs, everyMs, sleep, now = () => Date.now() }) {
  const start = now();
  for (;;) {
    if (await probe()) return { reached: true, waitedMs: now() - start };
    if (now() - start + everyMs > timeoutMs) return { reached: false, waitedMs: now() - start };
    await sleep(everyMs);
  }
}

/** The cases of a role, as short ids and titles (the plan and the report use the same list). */
export const CASES = {
  'Muwafaqa Requester': [
    ['R1', 'create a Draft with an existing Counterparty: allowed; the number is generated'],
    ['R2', 'read own contract: allowed'], ['R3', 'edit own Draft: allowed'],
    ['R4', 'submit Draft to Pending: allowed; the builder builds the steps and the USD value is frozen'],
    ['R5', 'read approval steps: denied'], ['R6', 'create a Counterparty: denied'],
    ['R7', 'delete a Draft: allowed; delete a Pending: refused'],
    ['R8', 'withdraw to Draft then delete a Draft that still has steps: observed (cascade delete without Delete on steps)'],
    ['R9', 'matrix, assignments, counter: read denied, create denied, write denied'],
    ['R10', 'header BypassBusinessLogicExecutionStepIds (and BypassBusinessLogicExecution): refused'],
    ['R11', 'a contract owned by someone else: not visible'], ['R12', 'read a Counterparty: allowed'],
  ],
  'Muwafaqa Approver': [
    ['A1', 'read contracts (owned by someone else): allowed'], ['A2', 'read the steps of a contract: allowed'], ['A3', 'read a Counterparty: allowed'],
    ['A4', 'create a contract: denied'], ['A5', 'write a contract: denied'], ['A6', 'write a step: denied'],
  ],
  'Muwafaqa Finance': [
    ['F1', 'read the matrix and the assignments: allowed'], ['F2', 'create a Counterparty: allowed'], ['F3', 'edit a Counterparty: allowed'],
    ['F4', 'delete a Counterparty: denied'], ['F5', 'write the matrix (create and edit) and the assignments: denied'], ['F6', 'counter: denied'],
    ['F7', 'read contracts: allowed; write a contract: denied'],
  ],
  'Muwafaqa Admin': [
    ['D1', 'matrix: create, edit and delete a row: allowed'], ['D2', 'assignments: edit (same value): allowed'],
    ['D3', 'counter: read, create and write: denied'], ['D4', 'contracts: read allowed; create and write denied'],
    ['D5', 'Counterparty: create, edit, delete: allowed'], ['D6', 'read the steps: allowed'],
  ],
};

/** --roles=Requester,Finance (short or full names) -> the full names in the fixed test order; empty = all four. */
export function parseRolesArg(value) {
  const v = String(value || '').trim();
  if (!v) return [...ROLE_ORDER];
  const wanted = new Set(v.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const hit = ROLE_ORDER.find((n) => n.toLowerCase() === x.toLowerCase() || n.toLowerCase() === `muwafaqa ${x.toLowerCase()}`);
    if (!hit) throw new Error(`unknown role "${x}" in --roles (use: ${ROLE_ORDER.map((n) => n.replace('Muwafaqa ', '')).join(', ')})`);
    return hit;
  }));
  return ROLE_ORDER.filter((n) => wanted.has(n));
}

/**
 * The message for the log: the redactor FIRST (the host, the organization name, every GUID and any secret become short placeholders), THEN the cut.
 * Cutting first would spend the budget on GUIDs and could leave half of an identifier behind.
 */
export function redactThenShorten(text, redact, max = 400) {
  return shortMessage(redact(String(text ?? '')), max);
}
