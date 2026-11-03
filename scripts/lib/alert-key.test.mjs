import test from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_TYPES, FORBIDDEN_CHARS, MAX_KEY_LENGTH, AlertKeyError, buildAlertKey, validateAlertKey, parseAlertKey, dateStamp, sourcePart, isTestKey } from './alert-key.mjs';

const G = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';   // a made-up GUID
const ok = { sourceId: G, type: 'RENEWAL-T90', date: '2027-03-31' };
const bad = (fn, re) => assert.throws(fn, (e) => e instanceof AlertKeyError && (!re || re.test(e.message)), String(re));

test('the four types, the eleven forbidden characters and the length of the column', () => {
  assert.deepEqual([...ALERT_TYPES], ['OBLIGATION-DUESOON', 'OBLIGATION-OVERDUE', 'RENEWAL-T90', 'RENEWAL-T30']);
  assert.deepEqual([...FORBIDDEN_CHARS], ['/', '\\', '<', '>', '*', '%', '&', ':', '?', '+', '#']);
  assert.equal(MAX_KEY_LENGTH, 100);
  assert.ok(Object.isFrozen(ALERT_TYPES) && Object.isFrozen(FORBIDDEN_CHARS));
});

test('the key has the form <guid>-<TYPE>-<yyyyMMdd>, for every type', () => {
  for (const type of ALERT_TYPES) assert.equal(buildAlertKey({ ...ok, type }), `${G}-${type}-20270331`);
});

test('the date: the same alert on another date is another key (the alert is armed again); the same date in several spellings is one key', () => {
  assert.notEqual(buildAlertKey(ok), buildAlertKey({ ...ok, date: '2027-04-01' }));
  const spellings = ['2027-03-31', '20270331', '2027-03-31T00:00:00Z', '2027-03-31T23:59:59Z', '2027-03-31T10:00:00.123Z', new Date(Date.UTC(2027, 2, 31, 12))];
  for (const d of spellings) assert.equal(dateStamp(d), '20270331');
  assert.equal(dateStamp(new Date(Date.UTC(2027, 2, 31, 23, 30))), '20270331');   // the UTC date, whatever the machine time zone is
});

test('a GUID is written lower case; a GUID in capitals gives the same key', () => {
  assert.equal(buildAlertKey({ ...ok, sourceId: G.toUpperCase() }), buildAlertKey(ok));
  assert.equal(sourcePart(G.toUpperCase()), G);
});

test('null, undefined and empty are rejected, in every part and as a whole key', () => {
  for (const v of [null, undefined, '']) {
    bad(() => buildAlertKey({ ...ok, sourceId: v }), /source id is missing/);
    bad(() => buildAlertKey({ ...ok, type: v }), /unknown alert type/);
    bad(() => buildAlertKey({ ...ok, date: v }), /date is missing|not yyyy/);
  }
  bad(() => validateAlertKey(null), /null/);
  bad(() => validateAlertKey(undefined), /null/);
  bad(() => validateAlertKey(''), /empty/);
  bad(() => validateAlertKey('   '), /empty/);
  bad(() => validateAlertKey(42), /not a string/);
  bad(() => buildAlertKey(), /unknown alert type/);
});

for (const c of ['/', '\\', '<', '>', '*', '%', '&', ':', '?', '+', '#']) {
  test(`the forbidden character "${c}" is rejected in a whole key and cannot enter through any part of the builder`, () => {
    const good = buildAlertKey(ok);
    bad(() => validateAlertKey(good + c), /forbidden character/);
    bad(() => validateAlertKey(c + good), /forbidden character/);
    bad(() => validateAlertKey(good.replace('RENEWAL', `REN${c}EWAL`)), /forbidden character/);
    bad(() => buildAlertKey({ ...ok, sourceId: G.slice(0, 8) + c + G.slice(9) }), /not a GUID/);
    bad(() => buildAlertKey({ ...ok, type: `RENEWAL-T90${c}` }), /unknown alert type/);
    bad(() => buildAlertKey({ ...ok, date: `2027-03-3${c}` }), /not yyyy/);
    bad(() => buildAlertKey({ ...ok, sourceId: `TEST-TMP-ALERT-A${c}` }, { allowTestSource: true }), /neither a GUID/);
  });
}

test('unknown type, another case of a type, and a type with extra text are rejected', () => {
  for (const t of ['RENEWAL-T60', 'renewal-t90', 'RENEWAL-T90 ', 'OBLIGATION', 'RENEWAL-T90-X', 'OBLIGATION-DUE-SOON']) bad(() => buildAlertKey({ ...ok, type: t }), /unknown alert type/);
});

test('bad dates: wrong shape, a day or a month that does not exist, 29 February of a non-leap year, a Date that is not valid, a number', () => {
  for (const d of ['2027-3-31', '31-03-2027', '2027/03/31', '2027-03-31T00:00:00+03:00', '2027-02-30', '2027-13-01', '2027-00-10', '2027-04-31', '2027-02-29', 'tomorrow', '2027-03-31 10:00', '2027033']) bad(() => buildAlertKey({ ...ok, date: d }), /date/);
  assert.equal(dateStamp('2028-02-29'), '20280229');   // a leap year is valid
  bad(() => dateStamp(new Date('x')), /not valid/);
  bad(() => dateStamp(20270331), /missing/);
});

test('the source must be a GUID: not a name, not a number, not a short or long hex string, not braces', () => {
  for (const s of ['abc', 'contract-1', G.slice(1), `${G}0`, `{${G}}`, '3f2504e04f8941d39a0c0305e82c3301', 'TEST-TMP-ALERT-ABC', 12345]) bad(() => buildAlertKey({ ...ok, sourceId: s }), /GUID|missing/);
});

test('a test source is accepted only with allowTestSource, and only as TEST-TMP-ALERT-<letters or digits>', () => {
  const t = { sourceId: 'TEST-TMP-ALERT-A1B2', type: 'OBLIGATION-OVERDUE', date: '2027-01-02' };
  bad(() => buildAlertKey(t), /not a GUID/);
  const k = buildAlertKey(t, { allowTestSource: true });
  assert.equal(k, 'TEST-TMP-ALERT-A1B2-OBLIGATION-OVERDUE-20270102');
  assert.equal(isTestKey(k), true); assert.equal(isTestKey(buildAlertKey(ok)), false); assert.equal(isTestKey(null), false);
  bad(() => validateAlertKey(k), /test source is not allowed/);
  assert.equal(validateAlertKey(k, { allowTestSource: true }), k);
  bad(() => buildAlertKey({ ...t, sourceId: 'TEST-TMP-ALERT-' }, { allowTestSource: true }), /neither/);
  bad(() => buildAlertKey({ ...t, sourceId: 'TEST-TMP-ALERT-a b' }, { allowTestSource: true }), /neither/);
  bad(() => buildAlertKey({ ...t, sourceId: `TEST-TMP-ALERT-${'x'.repeat(25)}` }, { allowTestSource: true }), /neither/);
});

test('validateAlertKey accepts only the canonical form: no spaces, no capitals in the GUID, no missing or extra part', () => {
  const g = buildAlertKey(ok);
  assert.equal(validateAlertKey(g), g);
  for (const k of [` ${g}`, `${g} `, g.toUpperCase(), g.replace('-RENEWAL-T90-', '-'), `${g}-X`, g.replace('20270331', '2027331'), g.replace('20270331', '20270230'), g.replace(G, 'abc'), g.replace('RENEWAL-T90', 'RENEWAL-T91')]) bad(() => validateAlertKey(k));
});

test('the longest key is shorter than the column', () => {
  const longest = buildAlertKey({ sourceId: G, type: 'OBLIGATION-DUESOON', date: '2027-12-31' });
  assert.ok(longest.length <= 64 && longest.length < MAX_KEY_LENGTH);
  const longTest = buildAlertKey({ sourceId: `TEST-TMP-ALERT-${'Z'.repeat(24)}`, type: 'OBLIGATION-DUESOON', date: '2027-12-31' }, { allowTestSource: true });
  assert.ok(longTest.length < MAX_KEY_LENGTH);
});

test('parseAlertKey returns the three parts and refuses what validateAlertKey refuses', () => {
  assert.deepEqual(parseAlertKey(buildAlertKey(ok)), { source: G, type: 'RENEWAL-T90', date: '20270331' });
  bad(() => parseAlertKey(''), /empty/);
  bad(() => parseAlertKey(null), /null/);
});

test('a key built here never holds a forbidden character, for all types and a spread of dates', () => {
  for (const type of ALERT_TYPES) {
    for (const date of ['2026-01-01', '2026-02-28', '2028-02-29', '2026-12-31']) {
      const k = buildAlertKey({ sourceId: G, type, date });
      for (const c of FORBIDDEN_CHARS) assert.ok(!k.includes(c));
      assert.ok(k.trim() === k && k.length > 0);
    }
  }
});
