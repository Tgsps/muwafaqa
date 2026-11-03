/**
 * A SMALL evaluator of the subset of Power Automate expressions that scripts/build-flow-obligation-alerts.mjs generates. Pure, offline, unit tested.
 * It exists so that offline tests can compare the OUTPUT of a generated expression (the alert key, the guard, the window bounds) with scripts/lib/alert-key.mjs.
 *
 * LIMITS, read before trusting it:
 *  - It is NOT Power Automate. It proves the TEXT of an expression against the reference implementation, not the behavior of the real engine.
 *  - Only these functions exist: concat, toLower, string, formatDateTime (formats 'yyyyMMdd' and 'yyyy-MM-ddTHH:mm:ssZ' only, on ISO strings with a Z or an offset),
 *    addMinutes, ticks, length, equals, not, empty, and, or, contains, if, less, lessOrEquals, greater, greaterOrEquals, coalesce, first, variables, items, outputs.
 *    Any other function throws "unsupported function": that is deliberate, so a generated expression cannot silently use something that was never evaluated.
 *  - Strings use single quotes with '' as the escape. Property access: expr?['name'] and expr['name'].
 *  - Dates are read with Date.parse and written in UTC. ticks returns a BigInt (100 ns units since 0001-01-01, as Power Automate); only comparisons are used.
 *  - string(null) is the empty string; a missing property with ?[ ] is undefined; with [ ] on null it throws.
 * An evaluation error (a bad date, an unsupported function) is thrown as FlowEvalError; in the real engine the same expression would fail its action.
 */
export class FlowEvalError extends Error {}

function tokenize(src) {
  const out = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let s = ''; i++;
      for (;;) {
        if (i >= src.length) throw new FlowEvalError('unterminated string');
        if (src[i] === "'") { if (src[i + 1] === "'") { s += "'"; i += 2; continue; } i++; break; }
        s += src[i++];
      }
      out.push({ t: 'str', v: s }); continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] || ''))) { let j = i + 1; while (/[0-9]/.test(src[j] || '')) j++; out.push({ t: 'num', v: Number(src.slice(i, j)) }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (/[A-Za-z0-9_]/.test(src[j] || '')) j++; out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue; }
    if ('(),[]?'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new FlowEvalError(`unexpected character "${c}"`);
  }
  return out;
}

/** Parses to an AST: { k: 'str'|'num'|'lit'|'call'|'prop', ... }. */
export function parse(src) {
  const toks = tokenize(src); let p = 0;
  const peek = () => toks[p]; const take = (t) => { const x = toks[p++]; if (!x || (t && x.t !== t)) throw new FlowEvalError(`expected ${t || 'token'}`); return x; };
  function primary() {
    const x = take();
    if (x.t === 'str') return { k: 'str', v: x.v };
    if (x.t === 'num') return { k: 'num', v: x.v };
    if (x.t === 'id') {
      if (peek()?.t === '(') {
        take('('); const args = [];
        if (peek()?.t !== ')') for (;;) { args.push(expr()); if (peek()?.t === ',') { take(','); continue; } break; }
        take(')'); return { k: 'call', name: x.v, args };
      }
      if (['true', 'false', 'null'].includes(x.v)) return { k: 'lit', v: x.v === 'true' ? true : x.v === 'false' ? false : null };
      throw new FlowEvalError(`unexpected name ${x.v}`);
    }
    throw new FlowEvalError('unexpected token');
  }
  function expr() {
    let n = primary();
    for (;;) {
      if (peek()?.t === '?' && toks[p + 1]?.t === '[') { take('?'); take('['); const key = expr(); take(']'); n = { k: 'prop', obj: n, key, safe: true }; continue; }
      if (peek()?.t === '[') { take('['); const key = expr(); take(']'); n = { k: 'prop', obj: n, key, safe: false }; continue; }
      return n;
    }
  }
  const ast = expr();
  if (p !== toks.length) throw new FlowEvalError('unexpected text after the expression');
  return ast;
}

const toStr = (x) => (x === null || x === undefined ? '' : typeof x === 'string' ? x : typeof x === 'object' ? JSON.stringify(x) : String(x));
const isEmpty = (x) => x === null || x === undefined || x === '' || (Array.isArray(x) && x.length === 0) || (typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 0);
const parseDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) throw new FlowEvalError(`not an ISO date-time: ${JSON.stringify(s)}`);
  const [y, m, d] = [Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))];
  const day = new Date(Date.UTC(y, m - 1, d));   // the calendar is checked on the parts: Date.parse alone accepts 2027-02-30 in some engines
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) throw new FlowEvalError(`not a date: ${s}`);
  const ms = Date.parse(s); if (Number.isNaN(ms)) throw new FlowEvalError(`not a date: ${s}`); return ms;
};
const pad = (n, w = 2) => String(n).padStart(w, '0');
const FORMATS = {
  yyyyMMdd: (d) => `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`,
  'yyyy-MM-ddTHH:mm:ssZ': (d) => `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`,
};
const ticksOf = (s) => (BigInt(parseDate(s)) + 62135596800000n) * 10000n;
const cmp = (a, b) => { const x = typeof a === 'bigint' || typeof b === 'bigint' ? [BigInt(a), BigInt(b)] : [a, b]; return x[0] < x[1] ? -1 : x[0] > x[1] ? 1 : 0; };

function evalAst(n, ctx) {
  switch (n.k) {
    case 'str': case 'num': case 'lit': return n.v;
    case 'prop': {
      const o = evalAst(n.obj, ctx); const key = evalAst(n.key, ctx);
      if (o === null || o === undefined) { if (n.safe) return undefined; throw new FlowEvalError('property of null'); }
      return o[key];
    }
    case 'call': return call(n, ctx);
    default: throw new FlowEvalError('bad node');
  }
}
function call(n, ctx) {
  const a = n.args; const ev = (i) => evalAst(a[i], ctx);
  switch (n.name) {
    case 'if': return ev(0) ? ev(1) : ev(2);   // lazy
    case 'and': { for (let i = 0; i < a.length; i++) if (!ev(i)) return false; return true; }
    case 'or': { for (let i = 0; i < a.length; i++) if (ev(i)) return true; return false; }
    case 'coalesce': { for (let i = 0; i < a.length; i++) { const x = ev(i); if (x !== null && x !== undefined) return x; } return null; }
    default: break;
  }
  const v = a.map((x) => evalAst(x, ctx));
  switch (n.name) {
    case 'concat': return v.map(toStr).join('');
    case 'toLower': return toStr(v[0]).toLowerCase();
    case 'string': return toStr(v[0]);
    case 'formatDateTime': { const f = FORMATS[v[1]]; if (!f) throw new FlowEvalError(`unsupported format ${JSON.stringify(v[1])}`); return f(new Date(parseDate(v[0]))); }
    case 'addMinutes': return new Date(parseDate(v[0]) + Number(v[1]) * 60000).toISOString().replace(/\.(\d{3})Z$/, '.$10000Z');
    case 'ticks': return ticksOf(v[0]);
    case 'length': if (typeof v[0] === 'string' || Array.isArray(v[0])) return v[0].length; throw new FlowEvalError('length of a non-string');
    case 'equals': return v[0] === v[1] || (typeof v[0] === 'bigint' && typeof v[1] === 'bigint' && v[0] === v[1]);
    case 'not': return !v[0];
    case 'empty': return isEmpty(v[0]);
    case 'contains': if (typeof v[0] === 'string') return v[0].includes(toStr(v[1])); if (Array.isArray(v[0])) return v[0].includes(v[1]); throw new FlowEvalError('contains on a non-string');
    case 'less': return cmp(v[0], v[1]) < 0;
    case 'lessOrEquals': return cmp(v[0], v[1]) <= 0;
    case 'greater': return cmp(v[0], v[1]) > 0;
    case 'greaterOrEquals': return cmp(v[0], v[1]) >= 0;
    case 'first': return Array.isArray(v[0]) ? v[0][0] : undefined;
    case 'variables': { if (!(toStr(v[0]) in (ctx.variables || {}))) throw new FlowEvalError(`unknown variable ${v[0]}`); return ctx.variables[v[0]]; }
    case 'items': { if (!(toStr(v[0]) in (ctx.items || {}))) throw new FlowEvalError(`unknown loop ${v[0]}`); return ctx.items[v[0]]; }
    case 'outputs': { if (!(toStr(v[0]) in (ctx.outputs || {}))) throw new FlowEvalError(`unknown action ${v[0]}`); return ctx.outputs[v[0]]; }
    default: throw new FlowEvalError(`unsupported function ${n.name}`);
  }
}

/** Evaluates one expression WITHOUT its leading @. */
export const evalExpr = (text, ctx = {}) => evalAst(parse(text), ctx);

/** The text parts of a parameter string: "@expr" (whole string) or "...@{expr}..." interpolations. A string without @ is returned as it is. */
export function evalTemplate(s, ctx = {}) {
  if (typeof s !== 'string') return s;
  if (s.startsWith('@@')) return s.slice(1);
  if (s.startsWith('@') && !s.startsWith('@{')) return evalExpr(s.slice(1), ctx);
  let out = ''; let i = 0;
  for (;;) {
    const j = s.indexOf('@{', i);
    if (j < 0) { out += s.slice(i); return out; }
    out += s.slice(i, j);
    let depth = 1; let k = j + 2; let inQ = false;
    for (; k < s.length && depth > 0; k++) {
      const c = s[k];
      if (inQ) { if (c === "'") { if (s[k + 1] === "'") k++; else inQ = false; } continue; }
      if (c === "'") inQ = true; else if (c === '{') depth++; else if (c === '}') depth--;
    }
    if (depth !== 0) throw new FlowEvalError('unclosed @{');
    out += toStr(evalExpr(s.slice(j + 2, k - 1), ctx)); i = k;
  }
}

/** A condition as the generator writes it: a string expression, or { and|or: [...] }, { not: x }, { equals|less|greater|lessOrEquals|greaterOrEquals: [a, b] }. */
export function evalCondition(c, ctx = {}) {
  if (typeof c === 'string') return evalTemplate(c, ctx);
  if (typeof c === 'boolean' || typeof c === 'number') return c;
  const keys = Object.keys(c || {}); if (keys.length !== 1) throw new FlowEvalError('a condition has exactly one operator');
  const op = keys[0]; const args = c[op];
  const val = (x) => (typeof x === 'object' && x !== null ? evalCondition(x, ctx) : evalTemplate(x, ctx));
  switch (op) {
    case 'and': return args.every((x) => !!val(x));
    case 'or': return args.some((x) => !!val(x));
    case 'not': return !val(args);
    case 'equals': return val(args[0]) === val(args[1]);
    case 'less': return cmp(val(args[0]), val(args[1])) < 0;
    case 'greater': return cmp(val(args[0]), val(args[1])) > 0;
    case 'lessOrEquals': return cmp(val(args[0]), val(args[1])) <= 0;
    case 'greaterOrEquals': return cmp(val(args[0]), val(args[1])) >= 0;
    default: throw new FlowEvalError(`unsupported condition operator ${op}`);
  }
}

/** The functions this evaluator implements; the generator's check fails if an evaluated expression uses another one. */
export const SUPPORTED_FUNCTIONS = Object.freeze(['concat', 'toLower', 'string', 'formatDateTime', 'addMinutes', 'ticks', 'length', 'equals', 'not', 'empty', 'and', 'or', 'contains', 'if', 'less', 'lessOrEquals', 'greater', 'greaterOrEquals', 'coalesce', 'first', 'variables', 'items', 'outputs']);
