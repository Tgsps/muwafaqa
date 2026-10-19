/**
 * Network resilience for the test scripts (decided 2026-10-19 after several "fetch failed" / ENOTFOUND drops of the machine's connection).
 *
 *  - GET is retried on NETWORK errors only (ENOTFOUND, EAI_AGAIN, ETIMEDOUT, ECONNRESET and a bare "fetch failed"): 5 retries after the
 *    first attempt, waiting 2, 4, 6, 8 and 10 seconds. An HTTP answer (404, 429, 500...) is never retried: it is a result.
 *  - PATCH and POST are NEVER retried: if the network fails during a write, its outcome is unknown, and a blind retry could do it twice.
 *    The error says so.
 *  - DELETE is retried only in the CLEANUP PHASE (a script calls enterCleanupPhase() when it starts cleaning up). In that phase a 404
 *    answer to a DELETE counts as success (the row is already gone). GET in the cleanup phase is more patient: 10 retries, up to 10 s apart.
 *  - Every retry is logged (method, path without query and ids, the error code, the attempt number). Never a token, a host or an id.
 *  - recheckAfterWait(): three GET requests in a row (up to 15 attempts, 4 s apart) before the first read after any wait. If the
 *    connection does not come back it throws, so the script stops without writing anything, and the message says how to clean up.
 *
 * The functions take injectable dependencies (fetch, sleep, log) so that the unit tests need no network:
 *   node --test scripts/lib/resilient-fetch.test.mjs
 */

const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT']);
export const GET_WAITS_S = [2, 4, 6, 8, 10];
export const CLEANUP_WAITS_S = [2, 4, 6, 8, 10, 10, 10, 10, 10, 10];

let cleanupPhase = false;
export function enterCleanupPhase() { cleanupPhase = true; }
export function leaveCleanupPhase() { cleanupPhase = false; }   // for a cleanup that runs in the MIDDLE of a script
export function inCleanupPhase() { return cleanupPhase; }
export function resetResilienceForTests() { cleanupPhase = false; }

const defaults = () => ({
  fetchImpl: (...a) => fetch(...a),
  sleepImpl: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (m) => console.log(m),
});

export function errorCode(e) {
  return String((e && e.cause && e.cause.code) || (e && e.code) || (e && e.message) || 'ERR');
}

/** A network-level failure (the request never produced an HTTP answer). */
export function isNetworkError(e) {
  if (!e) return false;
  const code = (e.cause && e.cause.code) || e.code;
  if (code && NETWORK_CODES.has(String(code))) return true;
  return e instanceof TypeError && /fetch failed/i.test(String(e.message));
}

export class NetworkError extends Error {
  constructor(message, { method, code, attempts, cause }) {
    super(message);
    this.name = 'NetworkError';
    this.method = method; this.code = code; this.attempts = attempts; this.cause = cause;
    this.connectionLost = true;
  }
}

const shortPath = (url) => String(url)
  .replace(/^https?:\/\/[^/]+/i, '')
  .split('?')[0]
  .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>');

export async function resilientFetch(url, init = {}, deps = {}) {
  const d = { ...defaults(), ...deps };
  const method = String(init.method || 'GET').toUpperCase();
  const headers = { ...(init.headers || {}) };
  const noRetry = headers.__noRetry === true || headers.__noRetry === 'true';
  delete headers.__noRetry;                       // an internal marker, never sent
  const init2 = { ...init, headers };

  const retryable = !noRetry && (method === 'GET' || (method === 'DELETE' && cleanupPhase));
  const waits = cleanupPhase ? CLEANUP_WAITS_S : GET_WAITS_S;
  let attempt = 0;
  for (;;) {
    attempt++;
    let res;
    try {
      res = await d.fetchImpl(url, init2);
    } catch (e) {
      const code = errorCode(e);
      if (!isNetworkError(e)) throw e;            // not a network problem: not ours to retry
      if (!retryable) {
        const why = noRetry ? 'a check that is retried by its caller' : (method === 'GET' ? '' : 'by design, a write is never retried');
        throw new NetworkError(
          `NETWORK ERROR (${code}) on ${method} ${shortPath(url)}.${method === 'GET' ? '' : ' The outcome of this request is UNKNOWN (it may or may not have been applied); it was NOT retried (' + why + '). Check the state before continuing.'}`,
          { method, code, attempts: attempt, cause: e });
      }
      if (attempt > waits.length) {
        throw new NetworkError(
          `NETWORK ERROR (${code}) on ${method} ${shortPath(url)} after ${attempt} attempts (waited ${waits.reduce((a, b) => a + b, 0)} s in total). The connection did not come back.`,
          { method, code, attempts: attempt, cause: e });
      }
      const wait = waits[attempt - 1];
      d.log(`RETRY  ${method} ${shortPath(url)} after ${code}; attempt ${attempt + 1}/${waits.length + 1} in ${wait} s`);
      await d.sleepImpl(wait * 1000);
      continue;
    }
    if (method === 'DELETE' && cleanupPhase && res.status === 404) {
      Object.defineProperty(res, 'ok', { value: true, configurable: true });   // already gone = success
      d.log(`INFO   DELETE ${shortPath(url)}: 404, already gone, counted as success${attempt > 1 ? ' (after a retry)' : ''}`);
    }
    return res;
  }
}

/**
 * Three GET requests in a row before the first read after a wait (15 attempts, 4 s apart). Throws a NetworkError with a clear
 * message (and the cleanup hint) if the connection does not come back; the caller must not write anything after that.
 * `call` is the script's call(method, path, body, extra); the checks themselves are not retried inside call().
 */
export async function recheckAfterWait(call, hint = '', { need = 3, maxAttempts = 15, pauseMs = 4000 } = {}, deps = {}) {
  const d = { ...defaults(), ...deps };
  let streak = 0; let attempts = 0; let last = '';
  while (streak < need && attempts < maxAttempts) {
    attempts++;
    try {
      const r = await call('GET', 'WhoAmI', undefined, { __noRetry: true });
      if (r.ok) streak++; else { streak = 0; last = `HTTP ${r.status}`; }
    } catch (e) { streak = 0; last = errorCode(e); }
    if (streak < need && attempts < maxAttempts) await d.sleepImpl(pauseMs);
  }
  if (streak < need) {
    throw new NetworkError(
      `CONNECTION NOT BACK after the wait: ${need} consecutive GET requests were not reached in ${attempts} attempts (last: ${last}). NOTHING was written after the wait; the script stops here. ${hint}`.trim(),
      { method: 'GET', code: last, attempts });
  }
  d.log(`INFO   connection recheck after the wait: ${need} consecutive GET requests succeeded (${attempts} attempt(s))`);
}
