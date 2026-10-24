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
/** Remove a role from a user: DELETE systemusers(<user>)/systemuserroles_association(<role>)/$ref. */
export const disassociatePath = (userId, roleId) => `systemusers(${userId})/systemuserroles_association(${roleId})/$ref`;

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
