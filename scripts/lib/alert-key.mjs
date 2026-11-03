/**
 * The key of one alert (ADR-011, status Proposed): "<sourceGuid>-<TYPE>-<yyyyMMdd>". Pure builder and validator, unit tested
 * (alert-key.test.mjs). No network, no id, no address.
 *
 * The date is the DUE date of an obligation or the EXPIRY date of a contract (the date the alert is about), so a changed date gives a new
 * key and the alert is armed again. The key is the value of the alternate key of mwf_alertlog: it must never be null or empty
 * (Learn: uniqueness is not enforced on NULL) and must not hold any of the characters / \ < > * % & : ? + # (ADR-011).
 * Nothing here is a business rule about WHEN an alert is due; that is the job of the flow.
 */

export const ALERT_TYPES = Object.freeze(['OBLIGATION-DUESOON', 'OBLIGATION-OVERDUE', 'RENEWAL-T90', 'RENEWAL-T30']);
export const FORBIDDEN_CHARS = Object.freeze(['/', '\\', '<', '>', '*', '%', '&', ':', '?', '+', '#']);
export const TEST_SOURCE_PREFIX = 'TEST-TMP-ALERT-';
export const MAX_KEY_LENGTH = 100;   // the length of the column mwf_alertkey (obligation-schema.mjs); the longest valid key is 36 + 1 + 18 + 1 + 8 = 64

export class AlertKeyError extends Error {}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEST_SOURCE = /^TEST-TMP-ALERT-[A-Za-z0-9]{1,24}$/;
const KEY = /^((?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|(?:TEST-TMP-ALERT-[A-Za-z0-9]{1,24}))-(OBLIGATION-DUESOON|OBLIGATION-OVERDUE|RENEWAL-T90|RENEWAL-T30)-(\d{4})(\d{2})(\d{2})$/;

const isRealDate = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };

/** yyyyMMdd of a date given as 'yyyy-MM-dd', 'yyyyMMdd', an ISO UTC date-time ('...T..Z', the UTC date is used), or a Date (UTC date). Throws AlertKeyError. */
export function dateStamp(date) {
  let y; let m; let d;
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) throw new AlertKeyError('the date is not valid');
    y = date.getUTCFullYear(); m = date.getUTCMonth() + 1; d = date.getUTCDate();
  } else if (typeof date === 'string') {
    const x = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)?$/.exec(date) || /^(\d{4})(\d{2})(\d{2})$/.exec(date);
    if (!x) throw new AlertKeyError(`the date "${date}" is not yyyy-MM-dd, yyyyMMdd or an ISO UTC date-time`);
    y = +x[1]; m = +x[2]; d = +x[3];
  } else throw new AlertKeyError('the date is missing');
  if (!isRealDate(y, m, d)) throw new AlertKeyError('the date does not exist in the calendar');
  return `${String(y).padStart(4, '0')}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

/** The source part. A GUID is written lower case without braces. A test source (TEST-TMP-ALERT-<letters or digits>) is accepted only with allowTestSource. */
export function sourcePart(source, { allowTestSource = false } = {}) {
  if (typeof source !== 'string' || source === '') throw new AlertKeyError('the source id is missing');
  const g = source.toLowerCase();
  if (GUID.test(g)) return g;
  if (allowTestSource && TEST_SOURCE.test(source)) return source;
  throw new AlertKeyError(allowTestSource ? 'the source is neither a GUID nor TEST-TMP-ALERT-<letters or digits>' : 'the source is not a GUID');
}

/** @returns {string} the key. Throws AlertKeyError for a null or empty part, a source that is not a GUID, an unknown TYPE or a bad date. */
export function buildAlertKey({ sourceId, type, date } = {}, opts = {}) {
  if (!ALERT_TYPES.includes(type)) throw new AlertKeyError(`unknown alert type "${type}"`);
  const key = `${sourcePart(sourceId, opts)}-${type}-${dateStamp(date)}`;
  validateAlertKey(key, opts);
  return key;
}

/** Throws AlertKeyError unless the key is exactly the canonical form. Returns the key. */
export function validateAlertKey(key, { allowTestSource = false } = {}) {
  if (key === null || key === undefined) throw new AlertKeyError('the key is null');
  if (typeof key !== 'string') throw new AlertKeyError('the key is not a string');
  if (key.trim() === '') throw new AlertKeyError('the key is empty');
  for (const c of FORBIDDEN_CHARS) if (key.includes(c)) throw new AlertKeyError(`the key holds the forbidden character "${c}"`);
  if (key.length > MAX_KEY_LENGTH) throw new AlertKeyError(`the key is longer than ${MAX_KEY_LENGTH}`);
  const p = KEY.exec(key);
  if (!p) throw new AlertKeyError('the key is not <source>-<TYPE>-<yyyyMMdd>');
  if (p[1].startsWith(TEST_SOURCE_PREFIX) && !allowTestSource) throw new AlertKeyError('a test source is not allowed here');
  if (!isRealDate(+p[3], +p[4], +p[5])) throw new AlertKeyError('the date in the key does not exist in the calendar');
  return key;
}

/** { source, type, date: 'yyyyMMdd' } of a valid key. Throws AlertKeyError like validateAlertKey. */
export function parseAlertKey(key, opts = {}) {
  validateAlertKey(key, opts);
  const p = KEY.exec(key);
  return { source: p[1], type: p[2], date: `${p[3]}${p[4]}${p[5]}` };
}

/** True for a key whose source part is a test source (the rows of scripts/test-alertlog-uniqueness.mjs). */
export const isTestKey = (key) => typeof key === 'string' && key.startsWith(TEST_SOURCE_PREFIX);
