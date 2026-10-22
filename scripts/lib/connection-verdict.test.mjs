import test from 'node:test';
import assert from 'node:assert/strict';
import { stats, verdict } from './connection-verdict.mjs';

const ok = () => ({ dnsEnv: 'ok', dnsNeutral: 'ok', get: 'ok' });
const rows = (n, patch = {}) => Array.from({ length: n }, (_, i) => ({ ...ok(), ...(patch[i] || {}) }));

test('stats counts failures and the longest run', () => {
  const s = stats([{ x: 1 }, { x: 1 }, { x: 0 }, { x: 1 }], (r) => r.x === 1);
  assert.deepEqual(s, { failures: 3, longestRun: 2 });
});

test('all ok is accepted', () => assert.equal(verdict(rows(36)).accepted, true));

test('the neutral host failing in every cycle does not matter (the situation of 2026-10-22)', () => {
  const r = rows(36); for (const x of r) x.dnsNeutral = 'ENOENT';
  const v = verdict(r);
  assert.equal(v.accepted, true);
  assert.equal(v.dnsNeutral.failures, 36);
  assert.equal(v.any.failures, 36);
});

test('two non-consecutive GET failures are accepted', () => {
  assert.equal(verdict(rows(36, { 3: { get: 'ENOENT' }, 29: { get: 'ETIMEDOUT' } })).accepted, true);
});

test('three GET failures are refused', () => {
  assert.equal(verdict(rows(36, { 3: { get: 'E' }, 10: { get: 'E' }, 20: { get: 'E' } })).accepted, false);
});

test('two GET failures in a row are refused', () => {
  assert.equal(verdict(rows(36, { 5: { get: 'E' }, 6: { get: 'E' } })).accepted, false);
});

test('a DNS failure of the environment host counts like a GET failure, each kind on its own', () => {
  assert.equal(verdict(rows(36, { 1: { dnsEnv: 'E' }, 2: { dnsEnv: 'E' } })).accepted, false);
  assert.equal(verdict(rows(36, { 1: { dnsEnv: 'E' }, 10: { get: 'E' } })).accepted, true);
});

test('an empty window is not accepted', () => assert.equal(verdict([]).accepted, false));
