// Unit tests of scripts/lib/resilient-fetch.mjs with injected network errors. No network, no sleeping.
//   node --test scripts/lib/resilient-fetch.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resilientFetch, recheckAfterWait, enterCleanupPhase, resetResilienceForTests, isNetworkError, NetworkError, GET_WAITS_S, CLEANUP_WAITS_S,
} from './resilient-fetch.mjs';

beforeEach(() => resetResilienceForTests());

const netErr = (code = 'ENOTFOUND') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });
const ok = (status = 200) => ({ ok: status >= 200 && status < 300, status });

function rig(script) {                        // script: array of Error (thrown) or response objects, used in order
  const calls = []; const sleeps = []; const logs = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    if (next instanceof Error) throw next;
    return { ...next };
  };
  return { calls, sleeps, logs, deps: { fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); }, log: (m) => logs.push(m) } };
}
const URL_ = 'https://env.example.test/api/data/v9.2/mwf_contracts(00000000-0000-0000-0000-00000000000a)?$select=mwf_name';

test('GET is retried after a network error and then succeeds', async () => {
  const r = rig([netErr(), netErr('EAI_AGAIN'), ok()]);
  const res = await resilientFetch(URL_, { method: 'GET', headers: { Authorization: 'Bearer SECRET' } }, r.deps);
  assert.equal(res.status, 200);
  assert.equal(r.calls.length, 3);
  assert.deepEqual(r.sleeps, [2000, 4000]);
  assert.equal(r.logs.length, 2);
});

test('GET that keeps failing stops after the 5 retries with a clear error', async () => {
  const r = rig([netErr()]);
  await assert.rejects(() => resilientFetch(URL_, { method: 'GET' }, r.deps), (e) => {
    assert.ok(e instanceof NetworkError);
    assert.equal(e.code, 'ENOTFOUND');
    assert.equal(e.attempts, 6);
    assert.equal(e.connectionLost, true);
    assert.match(e.message, /after 6 attempts/);
    return true;
  });
  assert.equal(r.calls.length, 1 + GET_WAITS_S.length);
  assert.deepEqual(r.sleeps, GET_WAITS_S.map((s) => s * 1000));
});

test('PATCH and POST are never retried, even with the same network errors', async () => {
  for (const method of ['PATCH', 'POST']) {
    const r = rig([netErr(), ok()]);
    await assert.rejects(() => resilientFetch(URL_, { method, body: '{}' }, r.deps), (e) => {
      assert.ok(e instanceof NetworkError);
      assert.match(e.message, /UNKNOWN/);
      assert.match(e.message, /NOT retried/);
      return true;
    });
    assert.equal(r.calls.length, 1, `${method} must be sent once`);
    assert.equal(r.sleeps.length, 0);
  }
});

test('PATCH and POST are not retried in the cleanup phase either', async () => {
  enterCleanupPhase();
  for (const method of ['PATCH', 'POST']) {
    const r = rig([netErr(), ok()]);
    await assert.rejects(() => resilientFetch(URL_, { method, body: '{}' }, r.deps));
    assert.equal(r.calls.length, 1);
  }
});

test('DELETE is not retried outside the cleanup phase', async () => {
  const r = rig([netErr(), ok(204)]);
  await assert.rejects(() => resilientFetch(URL_, { method: 'DELETE' }, r.deps), (e) => e instanceof NetworkError);
  assert.equal(r.calls.length, 1);
});

test('DELETE is retried in the cleanup phase', async () => {
  enterCleanupPhase();
  const r = rig([netErr(), netErr('ETIMEDOUT'), ok(204)]);
  const res = await resilientFetch(URL_, { method: 'DELETE' }, r.deps);
  assert.equal(res.status, 204);
  assert.equal(r.calls.length, 3);
});

test('cleanup phase is more patient: 10 retries', async () => {
  enterCleanupPhase();
  const r = rig([netErr()]);
  await assert.rejects(() => resilientFetch(URL_, { method: 'GET' }, r.deps));
  assert.equal(r.calls.length, 1 + CLEANUP_WAITS_S.length);
});

test('DELETE answered 404 in the cleanup phase counts as success (already gone)', async () => {
  enterCleanupPhase();
  const r = rig([ok(404)]);
  const res = await resilientFetch(URL_, { method: 'DELETE' }, r.deps);
  assert.equal(res.status, 404);
  assert.equal(res.ok, true);
});

test('a 404 after a retried DELETE (the first answer was lost) is success too', async () => {
  enterCleanupPhase();
  const r = rig([netErr(), ok(404)]);
  const res = await resilientFetch(URL_, { method: 'DELETE' }, r.deps);
  assert.equal(res.ok, true);
  assert.equal(r.calls.length, 2);
});

test('DELETE answered 404 outside the cleanup phase stays a failure', async () => {
  const r = rig([ok(404)]);
  const res = await resilientFetch(URL_, { method: 'DELETE' }, r.deps);
  assert.equal(res.ok, false);
});

test('HTTP answers are never retried (404, 429, 500 are results)', async () => {
  for (const status of [404, 429, 500, 503]) {
    const r = rig([ok(status)]);
    const res = await resilientFetch(URL_, { method: 'GET' }, r.deps);
    assert.equal(res.status, status);
    assert.equal(r.calls.length, 1);
  }
});

test('an error that is not a network error is not retried', async () => {
  const r = rig([new Error('boom')]);
  await assert.rejects(() => resilientFetch(URL_, { method: 'GET' }, r.deps), /boom/);
  assert.equal(r.calls.length, 1);
});

test('the __noRetry marker disables the retry and is not sent', async () => {
  const r = rig([netErr(), ok()]);
  await assert.rejects(() => resilientFetch(URL_, { method: 'GET', headers: { __noRetry: true, Accept: 'application/json' } }, r.deps));
  assert.equal(r.calls.length, 1);
  assert.equal('__noRetry' in r.calls[0].init.headers, false);
  assert.equal(r.calls[0].init.headers.Accept, 'application/json');
});

test('the retry log shows the method, the path and the code, never a token, a host or an id', async () => {
  const r = rig([netErr('ENOTFOUND'), ok()]);
  await resilientFetch(URL_, { method: 'GET', headers: { Authorization: 'Bearer SECRET-TOKEN' } }, r.deps);
  const text = r.logs.join('\n');
  assert.match(text, /RETRY  GET \/api\/data\/v9\.2\/mwf_contracts\(<id>\) after ENOTFOUND/);
  assert.doesNotMatch(text, /SECRET|Bearer|env\.example\.test|00000000-0000/);
  assert.doesNotMatch(text, /select/);
});

test('isNetworkError recognises the codes and a bare fetch failed, and nothing else', () => {
  for (const c of ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET']) assert.equal(isNetworkError(netErr(c)), true);
  assert.equal(isNetworkError(new TypeError('fetch failed')), true);
  assert.equal(isNetworkError(new Error('boom')), false);
  assert.equal(isNetworkError(Object.assign(new Error('x'), { code: 'EACCES' })), false);
});

// ---- recheckAfterWait
test('recheckAfterWait succeeds after a few failures (three in a row are needed)', async () => {
  const seq = [new Error('x'), { ok: true }, new Error('x'), { ok: true }, { ok: true }, { ok: true }];
  let i = 0; const methods = [];
  const call = async (m, p, b, extra) => { methods.push(m); assert.equal(extra.__noRetry, true); const n = seq[i++]; if (n instanceof Error) throw n; return n; };
  const sleeps = [];
  await recheckAfterWait(call, '', {}, { sleepImpl: async (ms) => { sleeps.push(ms); }, log: () => {} });
  assert.equal(i, 6);
  assert.deepEqual([...new Set(methods)], ['GET']);
  assert.ok(sleeps.every((s) => s === 4000));
});

test('recheckAfterWait gives up after 15 attempts, writes nothing and prints the cleanup hint', async () => {
  const methods = [];
  const call = async (m) => { methods.push(m); throw netErr(); };
  await assert.rejects(() => recheckAfterWait(call, 'Clean up with: node scripts/cleanup-test-rows.mjs --prefix=X', {}, { sleepImpl: async () => {}, log: () => {} }), (e) => {
    assert.ok(e instanceof NetworkError);
    assert.match(e.message, /CONNECTION NOT BACK/);
    assert.match(e.message, /NOTHING was written after the wait/);
    assert.match(e.message, /Clean up with: node scripts\/cleanup-test-rows\.mjs/);
    return true;
  });
  assert.equal(methods.length, 15);
  assert.deepEqual([...new Set(methods)], ['GET']);
});
