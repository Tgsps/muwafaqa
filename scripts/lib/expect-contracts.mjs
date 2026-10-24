// The number of contracts that the regression scripts expect to find before and after a run (K5 of docs/rebuild-runbook.md).
//
// Order of precedence: the argument --expect-contracts=N, then the environment variable MWF_EXPECT_CONTRACTS, then the default 11
// (the contracts of the current environment). Anything that is not a whole number of 0 or more is rejected with a message, never
// corrected. The other starting numbers of the scripts (110 matrix rows, 5 assignments, 0 approval steps, counters 0) are the same in a
// freshly seeded environment and stay fixed in the scripts.

export const DEFAULT_EXPECT_CONTRACTS = 11;
export const EXPECT_ARG = '--expect-contracts';
export const EXPECT_ENV = 'MWF_EXPECT_CONTRACTS';

// A whole number written in decimal, without sign, spaces, decimals, exponent or leading zeros ("0" itself is allowed).
const WHOLE = /^(0|[1-9][0-9]*)$/;

export class ExpectContractsError extends Error {}

function parse(raw, where) {
  if (typeof raw !== 'string' || !WHOLE.test(raw) || !Number.isSafeInteger(Number(raw))) {
    const shown = typeof raw === 'string' && raw.length <= 40 ? JSON.stringify(raw) : '(too long or not text)';
    throw new ExpectContractsError(`${where} must be a whole number of 0 or more (digits only, no sign, no decimals, no spaces); got ${shown}.`);
  }
  return Number(raw);
}

// Returns { value, source, where }: source is 'argument', 'environment variable' or 'default'.
export function resolveExpectContracts(argv = process.argv, env = process.env) {
  const given = argv.filter((a) => a === EXPECT_ARG || a.startsWith(`${EXPECT_ARG}=`));
  if (given.length > 1) throw new ExpectContractsError(`${EXPECT_ARG} was given ${given.length} times; give it once.`);
  if (given.length === 1) {
    const a = given[0];
    if (a === EXPECT_ARG) throw new ExpectContractsError(`${EXPECT_ARG} needs a value: ${EXPECT_ARG}=<number>.`);
    return { value: parse(a.slice(EXPECT_ARG.length + 1), EXPECT_ARG), source: 'argument', where: EXPECT_ARG };
  }
  if (Object.prototype.hasOwnProperty.call(env, EXPECT_ENV) && env[EXPECT_ENV] !== undefined) {
    return { value: parse(env[EXPECT_ENV], EXPECT_ENV), source: 'environment variable', where: EXPECT_ENV };
  }
  return { value: DEFAULT_EXPECT_CONTRACTS, source: 'default', where: 'default' };
}

// For scripts: resolve, or print the message and exit with 2 (the code the scripts use for a bad argument).
export function expectContractsOrExit(argv = process.argv, env = process.env, err = console.error, exit = process.exit) {
  try { return resolveExpectContracts(argv, env); }
  catch (e) {
    if (!(e instanceof ExpectContractsError)) throw e;
    err(`${e.message} Nothing was run.`);
    return exit(2);
  }
}

// The line printed at the start of a script that checks the starting state.
export function describeExpectContracts(r) {
  return `INFO  contracts expected in the starting and the final state: ${r.value} (source: ${r.source}${r.source === 'default' ? '' : `, ${r.where}`})`;
}

// "contracts: expected 11 (default), found 0" for the baseline and check-clean output.
export function contractsVerdict(r, found) {
  return { ok: found === r.value, text: `contracts: expected ${r.value} (${r.source}), found ${found}` };
}
