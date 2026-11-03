import test from 'node:test';
import assert from 'node:assert/strict';
import { evalExpr, evalTemplate, evalCondition, parse, FlowEvalError, SUPPORTED_FUNCTIONS } from './flow-expression-eval.mjs';

const throwsEval = (fn, re) => assert.throws(fn, (e) => e instanceof FlowEvalError && (!re || re.test(e.message)));

test('literals, concat, toLower, string (null is the empty string), escaped quotes', () => {
  assert.equal(evalExpr("concat('a', '-', 'B')"), 'a-B');
  assert.equal(evalExpr("toLower('ABC-1f')"), 'abc-1f');
  assert.equal(evalExpr("string(null)"), ''); assert.equal(evalExpr("string(42)"), '42');
  assert.equal(evalExpr("concat('it''s', '')"), "it's");
  assert.equal(evalExpr("length('abcd')"), 4);
});

test('variables, items and outputs come from the context; an unknown one fails (as the real engine would)', () => {
  const ctx = { variables: { k: 'v1' }, items: { L: { id: 'X', n: { deep: 7 } } }, outputs: { A: { body: 1 } } };
  assert.equal(evalExpr("variables('k')", ctx), 'v1');
  assert.equal(evalExpr("items('L')?['id']", ctx), 'X');
  assert.equal(evalExpr("items('L')?['n']?['deep']", ctx), 7);
  assert.equal(evalExpr("items('L')?['missing']?['x']", ctx), undefined);   // safe navigation
  throwsEval(() => evalExpr("items('L')['missing']['x']", ctx), /property of null/);   // unsafe navigation on a missing value
  throwsEval(() => evalExpr("variables('nope')", ctx), /unknown variable/);
  throwsEval(() => evalExpr("items('nope')", ctx), /unknown loop/);
  throwsEval(() => evalExpr("outputs('nope')", ctx), /unknown action/);
});

test('formatDateTime: yyyyMMdd and the ISO format, in UTC; a bad date, an empty date and another format fail', () => {
  assert.equal(evalExpr("formatDateTime('2027-03-31T23:59:59Z', 'yyyyMMdd')"), '20270331');
  assert.equal(evalExpr("formatDateTime('2027-03-31T23:30:00-05:00', 'yyyyMMdd')"), '20270401');   // the UTC date of an offset time
  assert.equal(evalExpr("formatDateTime('2028-02-29T00:00:00Z', 'yyyyMMdd')"), '20280229');
  assert.equal(evalExpr("formatDateTime('2027-03-31T09:05:07Z', 'yyyy-MM-ddTHH:mm:ssZ')"), '2027-03-31T09:05:07Z');
  throwsEval(() => evalExpr("formatDateTime('', 'yyyyMMdd')"), /not an ISO date-time/);
  throwsEval(() => evalExpr("formatDateTime('2027-03-31', 'yyyyMMdd')"), /not an ISO date-time/);
  throwsEval(() => evalExpr("formatDateTime('2027-02-30T00:00:00Z', 'yyyyMMdd')"), /not a date|ISO/);
  throwsEval(() => evalExpr("formatDateTime('2027-03-31T00:00:00Z', 'dd/MM/yyyy')"), /unsupported format/);
});

test('addMinutes and ticks: the bounds of the window and the order of two dates', () => {
  assert.equal(evalExpr("formatDateTime(addMinutes('2027-06-15T12:00:00Z', -30), 'yyyy-MM-ddTHH:mm:ssZ')"), '2027-06-15T11:30:00Z');
  assert.equal(evalExpr("formatDateTime(addMinutes('2027-06-15T23:58:00Z', 5), 'yyyy-MM-ddTHH:mm:ssZ')"), '2027-06-16T00:03:00Z');
  assert.equal(evalExpr("less(ticks('2027-01-01T00:00:00Z'), ticks('2027-01-01T00:00:01Z'))"), true);
  assert.equal(evalExpr("less(ticks('2027-01-01T00:00:00Z'), ticks('2027-01-01T00:00:00Z'))"), false);
  assert.equal(evalExpr("greaterOrEquals(ticks('2027-01-01T00:00:00Z'), ticks('2027-01-01T00:00:00Z'))"), true);
  assert.equal(evalExpr("equals(ticks('2027-01-01T00:00:00Z'), ticks('2027-01-01T01:00:00+01:00'))"), true);   // the same instant
  assert.match(String(evalExpr("addMinutes('2027-06-15T12:00:00Z', 1)")), /^2027-06-15T12:01:00\.0000000Z$/);
});

test('boolean functions short-circuit; if is lazy (the unused branch is never evaluated)', () => {
  assert.equal(evalExpr("if(true, 'a', variables('never'))"), 'a');
  assert.equal(evalExpr("and(false, variables('never'))"), false);
  assert.equal(evalExpr("or(true, variables('never'))"), true);
  assert.equal(evalExpr("not(empty(''))"), false);
  assert.equal(evalExpr("empty(null)"), true); assert.equal(evalExpr("empty('x')"), false);
  assert.equal(evalExpr("contains('abc-OBLIGATION-DUESOON-2027', '-OBLIGATION-')"), true);
  assert.equal(evalExpr("coalesce(null, 'b', 'c')"), 'b');
  assert.equal(evalExpr("first(variables('arr'))", { variables: { arr: ['x', 'y'] } }), 'x');
  assert.equal(evalExpr("first(variables('arr'))", { variables: { arr: [] } }), undefined);
});

test('unsupported functions and malformed text fail loudly, never silently', () => {
  throwsEval(() => evalExpr("substring('abc', 0, 1)"), /unsupported function substring/);
  throwsEval(() => evalExpr("utcNow()"), /unsupported function utcNow/);
  throwsEval(() => evalExpr("concat('a'"), /expected/);
  throwsEval(() => evalExpr("concat('a', 'b'))"), /unexpected text/);
  throwsEval(() => evalExpr("'unterminated"), /unterminated/);
  throwsEval(() => evalExpr("a + b"), /unexpected/);
  throwsEval(() => evalExpr("length(42)"), /length of a non-string/);
  assert.throws(() => parse(''), FlowEvalError);
  assert.ok(SUPPORTED_FUNCTIONS.every((f) => typeof f === 'string') && SUPPORTED_FUNCTIONS.includes('concat') && !SUPPORTED_FUNCTIONS.includes('substring'));
});

test('evalTemplate: a whole @expression, @{...} interpolations with nested braces and quotes, text without @, @@ as a literal @', () => {
  const ctx = { variables: { a: 'A', n: 3 } };
  assert.equal(evalTemplate("@variables('a')", ctx), 'A');
  assert.equal(evalTemplate("x @{variables('a')} y @{concat('{', 'b', '}')} z", ctx), 'x A y {b} z');
  assert.equal(evalTemplate('no expression here', ctx), 'no expression here');
  assert.equal(evalTemplate('@@literal', ctx), '@literal');
  assert.equal(evalTemplate("status eq 1 and due ge @{formatDateTime(addMinutes('2027-06-15T12:00:00Z', -30), 'yyyy-MM-ddTHH:mm:ssZ')}", ctx), 'status eq 1 and due ge 2027-06-15T11:30:00Z');
  assert.equal(evalTemplate(5, ctx), 5);
  throwsEval(() => evalTemplate('a @{variables(', ctx), /unclosed/);
});

test('evalCondition: the object form the generator writes (and, or, not, equals, comparisons), with expressions and literals as operands', () => {
  const ctx = { variables: { s: 'yes', n: 4, e: '' } };
  assert.equal(evalCondition({ equals: ["@variables('s')", 'yes'] }, ctx), true);
  assert.equal(evalCondition({ equals: ["@variables('s')", 'no'] }, ctx), false);
  assert.equal(evalCondition({ greater: ["@variables('n')", 0] }, ctx), true);
  assert.equal(evalCondition({ less: ["@variables('n')", 4] }, ctx), false);
  assert.equal(evalCondition({ and: [{ equals: ["@variables('s')", 'yes'] }, { not: { equals: ["@empty(variables('e'))", false] } }] }, ctx), true);
  assert.equal(evalCondition({ or: [{ equals: [1, 2] }, { equals: ["@empty(variables('e'))", true] }] }, ctx), true);
  assert.equal(evalCondition({ and: [] }, ctx), true);
  throwsEval(() => evalCondition({ and: [], or: [] }, ctx), /exactly one operator/);
  throwsEval(() => evalCondition({ xor: [1, 1] }, ctx), /unsupported condition operator/);
});
