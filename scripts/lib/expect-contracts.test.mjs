import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveExpectContracts, expectContractsOrExit, describeExpectContracts, contractsVerdict,
  ExpectContractsError, DEFAULT_EXPECT_CONTRACTS, EXPECT_ARG, EXPECT_ENV,
} from './expect-contracts.mjs';

const ARGV = ['node', 'script.mjs', '--mode=baseline'];

test('the default is 11 and its source is "default"', () => {
  assert.equal(DEFAULT_EXPECT_CONTRACTS, 11);
  assert.deepEqual(resolveExpectContracts(ARGV, {}), { value: 11, source: 'default', where: 'default' });
});

test('the environment variable beats the default', () => {
  assert.deepEqual(resolveExpectContracts(ARGV, { [EXPECT_ENV]: '3' }), { value: 3, source: 'environment variable', where: EXPECT_ENV });
});

test('the argument beats the environment variable and the default', () => {
  const r = resolveExpectContracts([...ARGV, `${EXPECT_ARG}=7`], { [EXPECT_ENV]: '3' });
  assert.deepEqual(r, { value: 7, source: 'argument', where: EXPECT_ARG });
});

test('zero is valid, from the argument and from the variable', () => {
  assert.equal(resolveExpectContracts([...ARGV, `${EXPECT_ARG}=0`], {}).value, 0);
  assert.equal(resolveExpectContracts(ARGV, { [EXPECT_ENV]: '0' }).value, 0);
  assert.equal(resolveExpectContracts([...ARGV, `${EXPECT_ARG}=0`], { [EXPECT_ENV]: '5' }).source, 'argument');
});

test('values that are not a whole number of 0 or more are rejected, from either place', () => {
  const bad = ['-1', '1.5', '1e2', 'abc', '', ' 3', '3 ', '+3', '007', '0x10', '1,000', 'NaN', 'Infinity', '9007199254740993', '٣'];
  for (const v of bad) {
    assert.throws(() => resolveExpectContracts([...ARGV, `${EXPECT_ARG}=${v}`], {}), ExpectContractsError, `argument ${JSON.stringify(v)}`);
    assert.throws(() => resolveExpectContracts(ARGV, { [EXPECT_ENV]: v }), ExpectContractsError, `variable ${JSON.stringify(v)}`);
  }
});

test('an invalid variable is rejected even when the argument is valid only if the argument is absent', () => {
  // the argument wins, so a bad variable is not looked at; without the argument it is an error
  assert.equal(resolveExpectContracts([...ARGV, `${EXPECT_ARG}=2`], { [EXPECT_ENV]: 'abc' }).value, 2);
  assert.throws(() => resolveExpectContracts(ARGV, { [EXPECT_ENV]: 'abc' }), ExpectContractsError);
});

test('the argument without a value, or given twice, is rejected', () => {
  assert.throws(() => resolveExpectContracts([...ARGV, EXPECT_ARG], {}), /needs a value/);
  assert.throws(() => resolveExpectContracts([...ARGV, `${EXPECT_ARG}=1`, `${EXPECT_ARG}=2`], {}), /2 times/);
});

test('a look-alike argument is not taken for the real one', () => {
  assert.equal(resolveExpectContracts([...ARGV, '--expect-contracts-extra=9', '--expect=9'], {}).source, 'default');
});

test('the error message names the place and the offending value', () => {
  assert.throws(() => resolveExpectContracts([...ARGV, `${EXPECT_ARG}=-1`], {}), (e) => e.message.includes(EXPECT_ARG) && e.message.includes('"-1"'));
  assert.throws(() => resolveExpectContracts(ARGV, { [EXPECT_ENV]: 'x' }), (e) => e.message.includes(EXPECT_ENV) && e.message.includes('"x"'));
});

test('expectContractsOrExit prints the message with "Nothing was run." and exits with 2', () => {
  const out = []; let code = null;
  expectContractsOrExit([...ARGV, `${EXPECT_ARG}=abc`], {}, (m) => out.push(m), (c) => { code = c; });
  assert.equal(code, 2);
  assert.equal(out.length, 1);
  assert.match(out[0], /whole number of 0 or more.*Nothing was run\.$/);
  assert.deepEqual(expectContractsOrExit(ARGV, {}, () => assert.fail('must not print'), () => assert.fail('must not exit')), { value: 11, source: 'default', where: 'default' });
});

test('the header line shows the value and where it came from', () => {
  assert.equal(describeExpectContracts({ value: 11, source: 'default', where: 'default' }), 'INFO  contracts expected in the starting and the final state: 11 (source: default)');
  assert.match(describeExpectContracts({ value: 0, source: 'argument', where: EXPECT_ARG }), /: 0 \(source: argument, --expect-contracts\)$/);
  assert.match(describeExpectContracts({ value: 4, source: 'environment variable', where: EXPECT_ENV }), /: 4 \(source: environment variable, MWF_EXPECT_CONTRACTS\)$/);
});

test('the verdict compares the number found and says both numbers', () => {
  const r = { value: 11, source: 'default', where: 'default' };
  assert.deepEqual(contractsVerdict(r, 11), { ok: true, text: 'contracts: expected 11 (default), found 11' });
  assert.deepEqual(contractsVerdict({ value: 0, source: 'argument', where: EXPECT_ARG }, 11), { ok: false, text: 'contracts: expected 0 (argument), found 11' });
  assert.equal(contractsVerdict({ value: 0, source: 'argument', where: EXPECT_ARG }, 0).ok, true);
});
