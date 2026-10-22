/**
 * Acceptance rule of the connection monitor (owner decision 2026-10-22, session of the bulk messages test), pure and unit tested.
 * The rule applies to the ENVIRONMENT only: the GET requests to the environment and the DNS lookup of the environment host
 * (at most 2 failures of the cycles for each of the two, and never two failures in a row in either). The neutral host is a diagnostic
 * value that is shown in the report but does not count for acceptance.
 * rows: [{ dnsEnv, dnsNeutral, get }] where 'ok' means success and anything else is the literal error code.
 */
export const MAX_FAILURES = 2;
export const MAX_RUN = 1;

/** { failures, longestRun } of one predicate over the rows. */
export function stats(rows, failed) {
  let failures = 0; let run = 0; let longestRun = 0;
  for (const r of rows) {
    if (failed(r)) { failures++; run++; if (run > longestRun) longestRun = run; } else run = 0;
  }
  return { failures, longestRun };
}

const within = (s) => s.failures <= MAX_FAILURES && s.longestRun <= MAX_RUN;

export function verdict(rows) {
  const dnsEnv = stats(rows, (r) => r.dnsEnv !== 'ok');
  const get = stats(rows, (r) => r.get !== 'ok');
  const dnsNeutral = stats(rows, (r) => r.dnsNeutral !== 'ok');
  const any = stats(rows, (r) => r.dnsEnv !== 'ok' || r.dnsNeutral !== 'ok' || r.get !== 'ok');
  const environment = stats(rows, (r) => r.dnsEnv !== 'ok' || r.get !== 'ok');
  return { dnsEnv, get, dnsNeutral, any, environment, accepted: rows.length > 0 && within(dnsEnv) && within(get) };
}
